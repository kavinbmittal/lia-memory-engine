/**
 * Lia Memory Engine — OpenClaw context engine plugin.
 *
 * Replaces OpenClaw's built-in compaction with Lia's approach:
 * 1. Structured compaction via Haiku (preserves Q&A structure)
 * 2. Auto-flush every turn to daily transcript files
 * 3. Auto-retrieval via QMD hybrid search on every assemble() call
 * 4. memory_search tool for explicit agent queries
 *
 * Search is powered by QMD (https://github.com/tobi/qmd) running as an HTTP
 * daemon. If QMD is not installed, search returns empty strings gracefully.
 *
 * Usage:
 *   Install in OpenClaw extensions directory, then enable in agent config.
 *   The plugin registers itself as a context engine and a tool provider.
 */

import { LiaContextEngine } from "./src/engine.js";
import { formatSearchResults } from "./src/search.js";
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
    qmdPort: { type: "number", default: 8181 },
    qmdHost: { type: "string", default: "localhost" },
    qmdCollectionName: { type: "string", default: "lia-memory" },
    enableVectorSearch: { type: "boolean", default: false },
  },
};

/**
 * Plugin registration function — called by OpenClaw when the plugin is loaded.
 */
function register(api: unknown): void {
  const typedApi = api as Record<string, unknown>;

  // Parse config with defaults
  const pluginsConfig = (typedApi.config as Record<string, unknown> | undefined)?.plugins as Record<string, unknown> | undefined;
  const pluginsEntries = pluginsConfig?.entries as Record<string, unknown> | undefined;
  const pluginEntry = pluginsEntries?.["lia-memory-engine"] as Record<string, unknown> | undefined;
  const pluginConfig: Record<string, unknown> = (pluginEntry?.config as Record<string, unknown> | undefined) ?? {};

  const config: LiaConfig = {
    enabled: (pluginConfig.enabled as boolean | undefined) ?? DEFAULT_CONFIG.enabled,
    compactionThreshold: (pluginConfig.compactionThreshold as number | undefined) ?? DEFAULT_CONFIG.compactionThreshold,
    compactionModel: (pluginConfig.compactionModel as string | undefined) ?? DEFAULT_CONFIG.compactionModel,
    autoRetrieval: (pluginConfig.autoRetrieval as boolean | undefined) ?? DEFAULT_CONFIG.autoRetrieval,
    autoRetrievalTimeoutMs: (pluginConfig.autoRetrievalTimeoutMs as number | undefined) ?? DEFAULT_CONFIG.autoRetrievalTimeoutMs,
    transcriptRetentionDays: (pluginConfig.transcriptRetentionDays as number | undefined) ?? DEFAULT_CONFIG.transcriptRetentionDays,
    qmdPort: (pluginConfig.qmdPort as number | undefined) ?? DEFAULT_CONFIG.qmdPort,
    qmdHost: (pluginConfig.qmdHost as string | undefined) ?? DEFAULT_CONFIG.qmdHost,
    qmdCollectionName: (pluginConfig.qmdCollectionName as string | undefined) ?? DEFAULT_CONFIG.qmdCollectionName,
    enableVectorSearch: (pluginConfig.enableVectorSearch as boolean | undefined) ?? DEFAULT_CONFIG.enableVectorSearch,
  };

  const log = typedApi.log as Record<string, (...args: unknown[]) => void> | undefined;

  if (!config.enabled) {
    log?.info?.("[lia-memory-engine] Plugin disabled via config");
    return;
  }

  // Build the completeFn wrapper for LLM access.
  // Strategy: try api.completeSimple first (if exposed), then fall back to
  // dynamically importing the pi-ai module (same pattern as Lossless Claw).
  const completeFn = async (model: string, systemPrompt: string, userContent: string): Promise<string> => {
    // Method 1: Direct API method (if available)
    if (typeof typedApi.completeSimple === "function") {
      return (typedApi.completeSimple as (m: string, s: string, u: string) => Promise<string>)(model, systemPrompt, userContent);
    }

    // Method 2: Dynamic import of pi-ai (OpenClaw's internal LLM router)
    try {
      const piAi = await import("@mariozechner/pi-ai") as Record<string, unknown>;
      const completeSimple = piAi.completeSimple as ((m: string, s: string, u: string) => Promise<string>) | undefined;
      if (typeof completeSimple === "function") {
        return await completeSimple(model, systemPrompt, userContent);
      }
    } catch {
      // ignored — will try next method
    }

    // Method 3: Use the Anthropic SDK directly if available
    try {
      const anthropic = await import("@anthropic-ai/sdk") as Record<string, unknown>;
      // Strip provider prefix if present (e.g., "anthropic/claude-haiku-4-5" → "claude-haiku-4-5-20251001")
      const modelId = model.includes("/") ? model.split("/").slice(1).join("/") : model;
      const AnthropicClass = (anthropic.default ?? anthropic) as new () => {
        messages: {
          create: (opts: {
            model: string;
            max_tokens: number;
            system: string;
            messages: Array<{ role: "user"; content: string }>;
          }, reqOpts: { timeout: number }) => Promise<{ content: Array<{ type: string; text?: string }> }>;
        };
      };
      const client = new AnthropicClass();
      const response = await client.messages.create({
        model: modelId,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user" as const, content: userContent }],
      }, { timeout: 30_000 });

      const textBlock = response.content.find((b) => b.type === "text");
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
    info: (...args: unknown[]) => log?.info?.(...args),
    warn: (...args: unknown[]) => log?.warn?.(...args),
    error: (...args: unknown[]) => log?.error?.(...args),
  };

  // Build workspace resolver
  const resolveWorkspaceDir = (sessionId: string): string => {
    // Try api.resolvePath first (resolves relative to agent workspace)
    if (typeof typedApi.resolvePath === "function") {
      return (typedApi.resolvePath as (p: string) => string)(".");
    }

    // Fallback: try to get workspace from session config
    const agentConfig = (typedApi.config as Record<string, unknown> | undefined)?.agent as Record<string, unknown> | undefined
      ?? typedApi.config as Record<string, unknown> | undefined;

    if (typeof agentConfig?.workspaceDir === "string") {
      return agentConfig.workspaceDir;
    }
    if (typeof agentConfig?.workspace === "string") {
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
  if (typeof typedApi.registerContextEngine === "function") {
    (typedApi.registerContextEngine as (id: string, factory: () => LiaContextEngine) => void)(
      "lia-memory-engine",
      () => engine
    );
    logger.info("[lia-memory-engine] Registered as context engine");
  } else {
    logger.warn(
      "[lia-memory-engine] api.registerContextEngine not available — " +
      "engine features (compaction, auto-flush, auto-retrieval) will not work. " +
      "Only the memory_search tool will be registered."
    );
  }

  // Warn if the plugin loaded but isn't slotted as the active context engine.
  // Without the slot assignment, OpenClaw silently falls back to built-in compaction
  // and none of the engine lifecycle methods (assemble, ingest, compact, auto-flush) fire.
  const slotsConfig = pluginsConfig?.slots as Record<string, unknown> | undefined;
  const contextEngineSlot = slotsConfig?.contextEngine as string | undefined;
  if (contextEngineSlot !== "lia-memory-engine") {
    logger.warn(
      `[lia-memory-engine] WARNING: Plugin loaded but not assigned as context engine. ` +
      `Add "plugins.slots.contextEngine": "lia-memory-engine" to openclaw.json. ` +
      `Without this, only the memory_search tool is active — compaction, auto-flush, and auto-retrieval will not work.`
    );
  }

  // Register memory_search tool
  registerMemorySearchTool(typedApi, engine, logger);

  logger.info(
    `[lia-memory-engine] Plugin loaded (compaction: ${config.compactionModel}, ` +
    `threshold: ${config.compactionThreshold}, auto-retrieval: ${config.autoRetrieval}, ` +
    `qmd: ${config.qmdHost}:${config.qmdPort}, vector: ${config.enableVectorSearch})`
  );
}

/**
 * Register the memory_search tool with OpenClaw.
 * Allows agents to explicitly search their memory files using QMD.
 */
function registerMemorySearchTool(
  api: Record<string, unknown>,
  engine: LiaContextEngine,
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): void {
  if (typeof api.registerTool !== "function") {
    logger.info("[lia-memory-engine] api.registerTool not available — skipping memory_search tool");
    return;
  }

  (api.registerTool as (tool: unknown, opts: unknown) => void)({
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
      },
      required: ["query"],
    },
    async execute(toolCallId: string, params: { query: string }, ctx?: Record<string, unknown>) {
      const query = String(params.query ?? "").trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "Query is required for memory search." }],
          isError: true,
        };
      }

      try {
        const sessionId = String(ctx?.sessionKey ?? ctx?.sessionId ?? "default");
        const result = await engine.search({ sessionId, query });
        const formatted = formatSearchResults(result, query);
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
  description: "Lia-style context engine — structured compaction, auto-flush, QMD hybrid search auto-retrieval",
  configSchema: {
    parse(value: unknown) {
      return value ?? {};
    },
  },
  register,
};

export default liaPlugin;

// Re-export configSchema for documentation / tooling purposes
export { configSchema };
