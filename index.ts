/**
 * Lia Memory Engine — OpenClaw context engine plugin.
 *
 * Replaces OpenClaw's built-in compaction with Lia's approach:
 * 1. Structured compaction via Haiku (preserves Q&A structure)
 * 2. Auto-flush every turn to daily transcript files
 * 3. Auto-retrieval via BM25 on every assemble() call
 * 4. memory_search tool for explicit agent queries
 *
 * Usage:
 *   Install in OpenClaw extensions directory, then enable in agent config.
 *   The plugin registers itself as a context engine and a tool provider.
 */

import { LiaContextEngine } from "./src/engine.js";
import { searchMemory, formatSearchResults } from "./src/search.js";
import type { LiaConfig } from "./src/types.js";
import { DEFAULT_CONFIG } from "./src/types.js";

const configSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: true },
    compactionThreshold: { type: "number", default: 0.80, minimum: 0.1, maximum: 1.0 },
    compactionModel: { type: "string", default: "anthropic/claude-haiku-4-5" },
    autoRetrieval: { type: "boolean", default: true },
    autoRetrievalTimeoutMs: { type: "number", default: 500, minimum: 100, maximum: 5000 },
    transcriptRetentionDays: { type: "number", default: 180, minimum: 1 },
  },
};

/**
 * Plugin registration function — called by OpenClaw when the plugin is loaded.
 */
function register(api: any): void {
  // Parse config with defaults
  const pluginConfig = api.config?.plugins?.entries?.["lia-memory-engine"]?.config ?? {};
  const config: LiaConfig = {
    enabled: pluginConfig.enabled ?? DEFAULT_CONFIG.enabled,
    compactionThreshold: pluginConfig.compactionThreshold ?? DEFAULT_CONFIG.compactionThreshold,
    compactionModel: pluginConfig.compactionModel ?? DEFAULT_CONFIG.compactionModel,
    autoRetrieval: pluginConfig.autoRetrieval ?? DEFAULT_CONFIG.autoRetrieval,
    autoRetrievalTimeoutMs: pluginConfig.autoRetrievalTimeoutMs ?? DEFAULT_CONFIG.autoRetrievalTimeoutMs,
    transcriptRetentionDays: pluginConfig.transcriptRetentionDays ?? DEFAULT_CONFIG.transcriptRetentionDays,
  };

  if (!config.enabled) {
    api.log?.info?.("[lia-memory-engine] Plugin disabled via config");
    return;
  }

  // Build the completeFn wrapper for LLM access.
  // Strategy: try api.completeSimple first (if exposed), then fall back to
  // dynamically importing the pi-ai module (same pattern as Lossless Claw).
  const completeFn = async (model: string, systemPrompt: string, userContent: string): Promise<string> => {
    // Method 1: Direct API method (if available)
    if (typeof api.completeSimple === "function") {
      return api.completeSimple(model, systemPrompt, userContent);
    }

    // Method 2: Dynamic import of pi-ai (OpenClaw's internal LLM router)
    try {
      const piAi: any = await import("@mariozechner/pi-ai");
      const result: string = await piAi.completeSimple(model, systemPrompt, userContent);
      return result;
    } catch {
      // ignored — will try next method
    }

    // Method 3: Use the Anthropic SDK directly if available
    try {
      const anthropic: any = await import("@anthropic-ai/sdk");
      // Strip provider prefix if present (e.g., "anthropic/claude-haiku-4-5" → "claude-haiku-4-5-20251001")
      const modelId = model.includes("/") ? model.split("/").slice(1).join("/") : model;
      const AnthropicClass = anthropic.default ?? anthropic;
      const client = new AnthropicClass();
      const response = await client.messages.create({
        model: modelId,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user" as const, content: userContent }],
      }, { timeout: 30_000 });

      const textBlock = (response.content as any[]).find((b: any) => b.type === "text");
      return textBlock?.text ?? "[No response]";
    } catch {
      // ignored — will throw below
    }

    throw new Error(
      "[lia-memory-engine] No LLM completion method available. " +
      "Ensure either api.completeSimple, @mariozechner/pi-ai, or @anthropic-ai/sdk is available."
    );
  };

  // Build logger wrapper
  const logger = {
    info: (...args: unknown[]) => api.log?.info?.(...args),
    warn: (...args: unknown[]) => api.log?.warn?.(...args),
    error: (...args: unknown[]) => api.log?.error?.(...args),
  };

  // Build workspace resolver
  const resolveWorkspaceDir = (sessionId: string): string => {
    // Try api.resolvePath first (resolves relative to agent workspace)
    if (typeof api.resolvePath === "function") {
      return api.resolvePath(".");
    }

    // Fallback: try to get workspace from session config
    const agentConfig = api.config?.agent ?? api.config;
    if (agentConfig?.workspaceDir) {
      return agentConfig.workspaceDir;
    }
    if (agentConfig?.workspace) {
      return agentConfig.workspace;
    }

    // No valid workspace directory found — refuse to fall back to cwd (path traversal risk)
    throw new Error(
      `[lia-memory-engine] Cannot resolve workspace directory for session "${sessionId}". ` +
      `Ensure api.resolvePath or agent config workspaceDir is available.`
    );
  };

  // Create the engine
  const engine = new LiaContextEngine(config, {
    completeFn,
    logger,
    resolveWorkspaceDir,
  });

  // Register as context engine — OpenClaw expects (id, factory) signature
  if (typeof api.registerContextEngine === "function") {
    api.registerContextEngine("lia-memory-engine", () => engine);
    logger.info("[lia-memory-engine] Registered as context engine");
  } else {
    logger.warn(
      "[lia-memory-engine] api.registerContextEngine not available — " +
      "engine features (compaction, auto-flush, auto-retrieval) will not work. " +
      "Only the memory_search tool will be registered."
    );
  }

  // Register memory_search tool
  registerMemorySearchTool(api, resolveWorkspaceDir, logger);

  logger.info(
    `[lia-memory-engine] Plugin loaded (compaction: ${config.compactionModel}, ` +
    `threshold: ${config.compactionThreshold}, auto-retrieval: ${config.autoRetrieval})`
  );
}

/**
 * Register the memory_search tool with OpenClaw.
 * Allows agents to explicitly search their memory files.
 */
function registerMemorySearchTool(
  api: any,
  resolveWorkspaceDir: (sessionId: string) => string,
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): void {
  if (typeof api.registerTool !== "function") {
    logger.info("[lia-memory-engine] api.registerTool not available — skipping memory_search tool");
    return;
  }

  api.registerTool({
    name: "memory_search",
    description:
      "Search conversation history and memory files for specific topics, facts, or past discussions. " +
      "Returns matching excerpts with timestamps. Use when asked about past conversations, " +
      "or when you need to recall specific details from earlier sessions.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords, names, topics, or phrases to search for.",
        },
        days: {
          type: "number",
          description: "Limit search to the last N days of transcripts. Omit to search all history.",
        },
      },
      required: ["query"],
    },
    async execute(toolCallId: string, params: { query: string; days?: number }, ctx?: any) {
      const query = String(params.query ?? "").trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "Query is required for memory search." }],
          isError: true,
        };
      }

      const days = params.days ? Number(params.days) : undefined;

      // Resolve workspace directory from context
      let workspaceDir: string;
      try {
        const sessionId = ctx?.sessionKey ?? ctx?.sessionId ?? "default";
        workspaceDir = resolveWorkspaceDir(sessionId);
      } catch (resolveErr) {
        const errMsg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
        return {
          content: [{ type: "text", text: `Memory search unavailable: ${errMsg}` }],
          isError: true,
        };
      }

      try {
        const results = await searchMemory(workspaceDir, query, days);
        const formatted = formatSearchResults(results, query);
        return {
          content: [{ type: "text", text: formatted }],
          isError: false,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`[lia-memory-engine] memory_search failed:`, err);
        return {
          content: [{ type: "text", text: `Memory search failed: ${errMsg}` }],
          isError: true,
        };
      }
    },
  }, { optional: true });

  logger.info("[lia-memory-engine] Registered memory_search tool");
}

/** Plugin default export — matches OpenClaw's expected plugin object shape. */
const liaPlugin = {
  id: "lia-memory-engine",
  name: "Lia Memory Engine",
  description: "Lia-style context engine — structured compaction, auto-flush, BM25 auto-retrieval",
  configSchema: {
    parse(value: unknown) {
      return value ?? {};
    },
  },
  register,
};

export default liaPlugin;
