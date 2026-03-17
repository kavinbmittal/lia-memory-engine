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
import { DEFAULT_CONFIG } from "./src/types.js";
export const id = "lia-memory-engine";
export const name = "Lia Memory Engine";
export const description = "Lia-style context engine — structured compaction, auto-flush, BM25 auto-retrieval";
/** JSON Schema for plugin configuration (mirrors openclaw.plugin.json). */
export const configSchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true },
        compactionThreshold: { type: "number", default: 0.80, minimum: 0.1, maximum: 1.0 },
        compactionModel: { type: "string", default: "anthropic/claude-haiku-4-5-20251001" },
        freshTailCount: { type: "number", default: 32, minimum: 4 },
        autoRetrieval: { type: "boolean", default: true },
        autoRetrievalTimeoutMs: { type: "number", default: 500, minimum: 100, maximum: 5000 },
        transcriptRetentionDays: { type: "number", default: 180, minimum: 1 },
    },
};
/**
 * Plugin registration function — called by OpenClaw when the plugin is loaded.
 *
 * @param api - The OpenClaw plugin API. Provides:
 *   - api.registerContextEngine(engine) — register as the context engine
 *   - api.registerTool(toolDef, options) — register agent tools
 *   - api.config — plugin and global config
 *   - api.log — structured logger
 *   - api.resolvePath(relativePath) — resolve workspace-relative paths
 *   - api.completeSimple?.(model, systemPrompt, userContent) — LLM access
 */
export default function register(api) {
    // Parse config with defaults
    const pluginConfig = api.config?.plugins?.entries?.[id]?.config ?? {};
    const config = {
        enabled: pluginConfig.enabled ?? DEFAULT_CONFIG.enabled,
        compactionThreshold: pluginConfig.compactionThreshold ?? DEFAULT_CONFIG.compactionThreshold,
        compactionModel: pluginConfig.compactionModel ?? DEFAULT_CONFIG.compactionModel,
        freshTailCount: pluginConfig.freshTailCount ?? DEFAULT_CONFIG.freshTailCount,
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
    const completeFn = async (model, systemPrompt, userContent) => {
        // Method 1: Direct API method (if available)
        if (typeof api.completeSimple === "function") {
            return api.completeSimple(model, systemPrompt, userContent);
        }
        // Method 2: Dynamic import of pi-ai (OpenClaw's internal LLM router)
        try {
            const piAi = await import("@mariozechner/pi-ai");
            const result = await piAi.completeSimple(model, systemPrompt, userContent);
            return result;
        }
        catch {
            // ignored — will try next method
        }
        // Method 3: Use the Anthropic SDK directly if available
        try {
            const anthropic = await import("@anthropic-ai/sdk");
            // Strip provider prefix if present (e.g., "anthropic/claude-haiku-4-5-20251001" → "claude-haiku-4-5-20251001")
            const modelId = model.includes("/") ? model.split("/").slice(1).join("/") : model;
            const AnthropicClass = anthropic.default ?? anthropic;
            const client = new AnthropicClass();
            const response = await client.messages.create({
                model: modelId,
                max_tokens: 2048,
                system: systemPrompt,
                messages: [{ role: "user", content: userContent }],
            }, { timeout: 30_000 });
            const textBlock = response.content.find((b) => b.type === "text");
            return textBlock?.text ?? "[No response]";
        }
        catch {
            // ignored — will throw below
        }
        throw new Error("[lia-memory-engine] No LLM completion method available. " +
            "Ensure either api.completeSimple, @mariozechner/pi-ai, or @anthropic-ai/sdk is available.");
    };
    // Build logger wrapper
    const logger = {
        info: (...args) => api.log?.info?.(...args),
        warn: (...args) => api.log?.warn?.(...args),
        error: (...args) => api.log?.error?.(...args),
    };
    // Build workspace resolver
    const resolveWorkspaceDir = (sessionId) => {
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
        // Last resort: use current working directory
        return process.cwd();
    };
    // Create the engine
    const engine = new LiaContextEngine(config, {
        completeFn,
        logger,
        resolveWorkspaceDir,
    });
    // Register as context engine
    if (typeof api.registerContextEngine === "function") {
        api.registerContextEngine(engine);
        logger.info("[lia-memory-engine] Registered as context engine");
    }
    else {
        logger.warn("[lia-memory-engine] api.registerContextEngine not available — " +
            "engine features (compaction, auto-flush, auto-retrieval) will not work. " +
            "Only the memory_search tool will be registered.");
    }
    // Register memory_search tool
    registerMemorySearchTool(api, resolveWorkspaceDir, logger);
    logger.info(`[lia-memory-engine] Plugin loaded (compaction: ${config.compactionModel}, ` +
        `threshold: ${config.compactionThreshold}, auto-retrieval: ${config.autoRetrieval})`);
}
/**
 * Register the memory_search tool with OpenClaw.
 * Allows agents to explicitly search their memory files.
 */
function registerMemorySearchTool(api, resolveWorkspaceDir, logger) {
    if (typeof api.registerTool !== "function") {
        logger.info("[lia-memory-engine] api.registerTool not available — skipping memory_search tool");
        return;
    }
    api.registerTool({
        name: "memory_search",
        description: "Search conversation history and memory files for specific topics, facts, or past discussions. " +
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
        async execute(toolCallId, params, ctx) {
            const query = String(params.query ?? "").trim();
            if (!query) {
                return {
                    content: [{ type: "text", text: "Query is required for memory search." }],
                    isError: true,
                };
            }
            const days = params.days ? Number(params.days) : undefined;
            // Resolve workspace directory from context
            let workspaceDir;
            try {
                const sessionId = ctx?.sessionKey ?? ctx?.sessionId ?? "default";
                workspaceDir = resolveWorkspaceDir(sessionId);
            }
            catch {
                workspaceDir = process.cwd();
            }
            try {
                const results = await searchMemory(workspaceDir, query, days);
                const formatted = formatSearchResults(results, query);
                return {
                    content: [{ type: "text", text: formatted }],
                    isError: false,
                };
            }
            catch (err) {
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
//# sourceMappingURL=index.js.map