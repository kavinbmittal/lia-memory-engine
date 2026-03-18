/**
 * QMDClient — wraps the QMD HTTP daemon and CLI for hybrid search + LLM reranking.
 *
 * QMD (https://github.com/tobi/qmd) provides BM25, vector, and HyDE search over
 * a collection of markdown files. This client manages the daemon lifecycle and
 * exposes a clean search interface for the Lia Memory Engine.
 *
 * Daemon is best-effort: if `qmd` is not installed, all search calls return "".
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";

const execFileAsync = promisify(execFile);

/** Logger interface — matches the OpenClaw logger shape. */
interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Options for constructing a QMDClient. */
export interface QMDClientOptions {
  host: string;
  port: number;
  collectionName: string;
  /** Absolute path to the memory directory to register as a collection. */
  memoryDir: string;
  enableVectorSearch: boolean;
  logger: Logger;
}

/**
 * MCP JSON-RPC request body for the QMD `query` tool.
 * Uses the MCP protocol shape expected by `qmd mcp --http --daemon`.
 */
interface QMDMcpRequest {
  jsonrpc: "2.0";
  id: number;
  method: "tools/call";
  params: {
    name: "query";
    arguments: {
      query: string;
      n: number;
      types: string[];
      collection?: string;
    };
  };
}

/**
 * MCP JSON-RPC response shape from QMD.
 */
interface QMDMcpResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content: Array<{ type: string; text: string }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

export class QMDClient {
  private readonly host: string;
  private readonly port: number;
  private readonly collectionName: string;
  private readonly memoryDir: string;
  private readonly enableVectorSearch: boolean;
  private readonly logger: Logger;
  private readonly baseUrl: string;

  constructor(opts: QMDClientOptions) {
    // Guard: memoryDir must be absolute to prevent path injection into CLI args
    if (!isAbsolute(opts.memoryDir)) {
      throw new Error(
        `[lia-memory-engine] QMDClient memoryDir must be an absolute path, got: "${opts.memoryDir}"`
      );
    }

    this.host = opts.host;
    this.port = opts.port;
    this.collectionName = opts.collectionName;
    this.memoryDir = opts.memoryDir;
    this.enableVectorSearch = opts.enableVectorSearch;
    this.logger = opts.logger;
    this.baseUrl = `http://${this.host}:${this.port}`;
  }

  /**
   * Check if the QMD daemon is reachable.
   * GET /health with a 1-second timeout.
   * Returns true only if the response is HTTP 200.
   */
  async isRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      return response.status === 200;
    } catch {
      // Network error, timeout, or daemon not started
      return false;
    }
  }

  /**
   * Spawn `qmd mcp --http --daemon` and wait for the health endpoint to respond.
   * Polls /health every 500ms for up to 10 seconds.
   * Returns true if the daemon started successfully, false otherwise.
   *
   * This is best-effort: if `qmd` is not installed, the spawn will fail silently
   * and this method returns false. All downstream search calls handle that gracefully.
   */
  async startDaemon(): Promise<boolean> {
    // If already running, nothing to do
    if (await this.isRunning()) {
      this.logger.info("[lia-memory-engine] QMD daemon already running");
      return true;
    }

    this.logger.info("[lia-memory-engine] Starting QMD daemon...");

    // Wait briefly (50ms) for an immediate spawn error (e.g. ENOENT when qmd is
    // not installed). This avoids polling for 10 seconds when the binary doesn't exist.
    // If the spawn succeeds (no error in 50ms), we proceed to the health poll loop.
    const spawnResult = await new Promise<{ ok: boolean }>((resolve) => {
      let settled = false;

      let child: ReturnType<typeof spawn>;
      try {
        // Detach so the daemon survives beyond this process.
        // stdio: "ignore" prevents daemon output from blocking the parent.
        child = spawn("qmd", ["mcp", "--http", "--daemon"], {
          detached: true,
          stdio: "ignore",
        });

        // unref() so the parent can exit without waiting for qmd
        child.unref();
      } catch (err) {
        this.logger.warn("[lia-memory-engine] Failed to spawn QMD daemon:", err);
        resolve({ ok: false });
        return;
      }

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          if (err.code === "ENOENT") {
            this.logger.warn(
              "[lia-memory-engine] QMD CLI not found. Install with: npm install -g @tobilu/qmd"
            );
          } else {
            this.logger.warn("[lia-memory-engine] QMD daemon spawn error:", err.message);
          }
          resolve({ ok: false });
        }
      });

      // Give the OS 50ms to fire an immediate spawn error.
      // If no error by then, assume the process started and proceed to polling.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: true });
        }
      }, 50);
    });

    if (!spawnResult.ok) {
      return false;
    }

    // Poll /health for up to 10 seconds (20 attempts × 500ms)
    const maxAttempts = 20;
    const intervalMs = 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));

      if (await this.isRunning()) {
        this.logger.info("[lia-memory-engine] QMD daemon started successfully");
        return true;
      }
    }

    this.logger.warn(
      "[lia-memory-engine] QMD daemon did not become healthy within 10 seconds — " +
      "search will fall back to CLI"
    );
    return false;
  }

  /**
   * Register the memory directory as a QMD collection.
   * Runs `qmd collection add {memoryDir} --name {collectionName}`.
   *
   * Non-fatal: logs a warning if it fails (collection may already exist,
   * or qmd may not be installed).
   */
  async ensureCollection(): Promise<void> {
    try {
      await execFileAsync("qmd", [
        "collection",
        "add",
        this.memoryDir,
        "--name",
        this.collectionName,
      ]);
      this.logger.info(
        `[lia-memory-engine] QMD collection "${this.collectionName}" registered at ${this.memoryDir}`
      );
    } catch (err) {
      // Collection likely already exists, or qmd not installed — both are fine
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[lia-memory-engine] QMD ensureCollection warning (non-fatal): ${message}`
      );
    }
  }

  /**
   * Trigger background embedding for the collection.
   * Fire-and-forget: runs `qmd embed -c {collectionName}` without awaiting.
   * Logs completion or failure when the process exits.
   */
  embedBackground(): void {
    execFileAsync("qmd", ["embed", "-c", this.collectionName])
      .then(() => {
        this.logger.info(
          `[lia-memory-engine] QMD embedding complete for collection "${this.collectionName}"`
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[lia-memory-engine] QMD embedding failed (non-fatal): ${message}`
        );
      });
  }

  /**
   * Search the QMD collection via the HTTP daemon.
   * Uses hybrid search when enableVectorSearch is true:
   *   - full=true  → ["lex","vec","hyde"] (BM25 + vector + HyDE reranking)
   *   - full=false → ["lex","vec"]        (BM25 + vector)
   *   - enableVectorSearch=false → ["lex"] (BM25 only, no model download needed)
   *
   * Throws on HTTP error or JSON-RPC error so callers can fall back to CLI.
   */
  async search(
    query: string,
    opts: { n?: number; full?: boolean; timeoutMs?: number }
  ): Promise<string> {
    const n = opts.n ?? 5;
    const full = opts.full ?? false;
    const timeoutMs = opts.timeoutMs ?? 5000;

    // Determine search types based on config
    let types: string[];
    if (this.enableVectorSearch && full) {
      types = ["lex", "vec", "hyde"];
    } else if (this.enableVectorSearch) {
      types = ["lex", "vec"];
    } else {
      types = ["lex"];
    }

    const requestBody: QMDMcpRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "query",
        arguments: {
          query,
          n,
          types,
          collection: this.collectionName,
        },
      },
    };

    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `[lia-memory-engine] QMD HTTP error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as QMDMcpResponse;

    if (data.error) {
      throw new Error(
        `[lia-memory-engine] QMD JSON-RPC error ${data.error.code}: ${data.error.message}`
      );
    }

    if (!data.result?.content) {
      return "";
    }

    // Join all text content blocks into a single string
    return data.result.content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("\n");
  }

  /**
   * Search via the QMD CLI — used when the daemon is not running.
   * Runs `qmd search <query> -c <collectionName> -n 5` with a 3-second timeout.
   * Returns stdout, or empty string if the command fails.
   *
   * Uses execFile (not exec) to prevent shell injection — query is passed as a
   * discrete argument, never interpolated into a shell string.
   */
  async searchCLI(query: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "qmd",
        ["search", query, "-c", this.collectionName, "-n", "5"],
        { timeout: 3000 }
      );
      return stdout ?? "";
    } catch {
      // qmd not installed, timeout, or no results — return empty
      return "";
    }
  }
}
