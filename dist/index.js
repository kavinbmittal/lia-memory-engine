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
import { Type } from "@sinclair/typebox";
import { LiaContextEngine } from "./src/engine.js";
import { formatSearchResults } from "./src/search.js";
import { DEFAULT_CONFIG } from "./src/types.js";
const jsonSchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true },
        compactionThreshold: { type: "number", default: 0.80, minimum: 0.1, maximum: 1.0 },
        compactionModel: { type: "string", default: "anthropic/claude-haiku-4-5" },
        autoRetrieval: { type: "boolean", default: false },
        autoRetrievalTimeoutMs: { type: "number", default: 500, minimum: 100, maximum: 5000 },
        transcriptRetentionDays: { type: "number", default: 180, minimum: 1 },
        qmdPort: { type: "number", default: 8181 },
        qmdHost: { type: "string", default: "localhost" },
        qmdCollectionName: { type: "string", default: "lia-memory" },
        enableVectorSearch: { type: "boolean", default: true },
    },
};
const configSchema = {
    jsonSchema,
    parse(value) {
        return value ?? {};
    },
};
/**
 * Plugin registration function — called by OpenClaw when the plugin is loaded.
 */
function register(api) {
    // Use api.pluginConfig (pre-parsed by OpenClaw) with defaults
    const pluginConfig = (api.pluginConfig ?? {});
    const config = {
        enabled: pluginConfig.enabled ?? DEFAULT_CONFIG.enabled,
        compactionThreshold: pluginConfig.compactionThreshold ?? DEFAULT_CONFIG.compactionThreshold,
        compactionModel: pluginConfig.compactionModel ?? DEFAULT_CONFIG.compactionModel,
        autoRetrieval: pluginConfig.autoRetrieval ?? DEFAULT_CONFIG.autoRetrieval,
        autoRetrievalTimeoutMs: pluginConfig.autoRetrievalTimeoutMs ?? DEFAULT_CONFIG.autoRetrievalTimeoutMs,
        transcriptRetentionDays: pluginConfig.transcriptRetentionDays ?? DEFAULT_CONFIG.transcriptRetentionDays,
        qmdPort: pluginConfig.qmdPort ?? DEFAULT_CONFIG.qmdPort,
        qmdHost: pluginConfig.qmdHost ?? DEFAULT_CONFIG.qmdHost,
        qmdCollectionName: pluginConfig.qmdCollectionName ?? DEFAULT_CONFIG.qmdCollectionName,
        enableVectorSearch: pluginConfig.enableVectorSearch ?? DEFAULT_CONFIG.enableVectorSearch,
    };
    // Adapt PluginLogger (single string arg) to engine's logger (variadic args)
    const pluginLogger = api.logger;
    const logger = {
        info: (...args) => pluginLogger.info?.(args.map(String).join(" ")),
        warn: (...args) => pluginLogger.warn?.(args.map(String).join(" ")),
        error: (...args) => pluginLogger.error?.(args.map(String).join(" ")),
    };
    if (!config.enabled) {
        logger.info("[lia-memory-engine] Plugin disabled via config");
        return;
    }
    // Build the completeFn wrapper for LLM access.
    // Strategy: try api.completeSimple first (if exposed), then dynamically
    // import the pi-ai module (OpenClaw's internal LLM router).
    const apiAny = api;
    const completeFn = async (model, systemPrompt, userContent) => {
        // Method 1: Direct API method (if available)
        if (typeof apiAny.completeSimple === "function") {
            logger.info("[lia-memory-engine] Using api.completeSimple for LLM completion");
            return apiAny.completeSimple(model, systemPrompt, userContent);
        }
        logger.info("[lia-memory-engine] api.completeSimple not available, trying fallbacks");
        // Method 2: Dynamic import of pi-ai (OpenClaw's internal LLM router)
        try {
            const piAi = await import("@mariozechner/pi-ai");
            const completeSimple = piAi.completeSimple;
            if (typeof completeSimple === "function") {
                logger.info("[lia-memory-engine] Using @mariozechner/pi-ai for LLM completion");
                return await completeSimple(model, systemPrompt, userContent);
            }
            logger.warn("[lia-memory-engine] @mariozechner/pi-ai loaded but completeSimple not found");
        }
        catch (err) {
            logger.info(`[lia-memory-engine] @mariozechner/pi-ai not available: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Method 3: Use the Anthropic SDK directly
        try {
            const anthropic = await import("@anthropic-ai/sdk");
            // Strip provider prefix if present (e.g., "anthropic/claude-haiku-4-5" → "claude-haiku-4-5-20251001")
            const modelId = model.includes("/") ? model.split("/").slice(1).join("/") : model;
            const AnthropicClass = (anthropic.default ?? anthropic);
            const client = new AnthropicClass();
            logger.info(`[lia-memory-engine] Using @anthropic-ai/sdk for LLM completion (model: ${modelId})`);
            const response = await client.messages.create({
                model: modelId,
                max_tokens: 2048,
                system: systemPrompt,
                messages: [{ role: "user", content: userContent }],
            }, { timeout: 30_000 });
            const textBlock = response.content.find((b) => b.type === "text");
            return textBlock?.text ?? "[No response]";
        }
        catch (err) {
            logger.error(`[lia-memory-engine] @anthropic-ai/sdk failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        throw new Error("[lia-memory-engine] No LLM completion method available. " +
            "Ensure either api.completeSimple, @mariozechner/pi-ai, or @anthropic-ai/sdk is available.");
    };
    // Build workspace resolver — must resolve to the correct agent's workspace
    // based on the session key (e.g., "agent:midas:main" → midas's workspace).
    const resolveWorkspaceDir = (sessionId, sessionKey) => {
        // Extract agent ID from session key (format: "agent:{agentId}:...")
        const agentId = sessionKey ? extractAgentId(sessionKey) : undefined;
        // Look up the agent's workspace from the config's agent list
        const agentsConfig = api.config?.agents;
        const agentList = agentsConfig?.list;
        if (agentId && agentList) {
            const agent = agentList.find(a => a.id === agentId);
            if (agent && typeof agent.workspace === "string") {
                return agent.workspace;
            }
        }
        // Fallback: try the default workspace from agent config
        const defaultWorkspace = agentsConfig?.defaults;
        if (typeof defaultWorkspace?.workspace === "string") {
            return defaultWorkspace.workspace;
        }
        // Try api.resolvePath (resolves relative to the plugin's registration context)
        return api.resolvePath(".");
    };
    // Create the engine
    const engine = new LiaContextEngine(config, {
        completeFn,
        logger,
        resolveWorkspaceDir,
    });
    // Register as context engine (cast needed: our AgentMessage type is structurally
    // compatible but TypeScript sees different module origins)
    api.registerContextEngine("lia-memory-engine", (() => engine));
    logger.info("[lia-memory-engine] Registered as context engine");
    // Warn if the plugin loaded but isn't slotted as the active context engine.
    // Without the slot assignment, OpenClaw silently falls back to built-in compaction
    // and none of the engine lifecycle methods (assemble, ingest, compact, auto-flush) fire.
    const pluginsConfig = api.config?.plugins;
    const slotsConfig = pluginsConfig?.slots;
    const contextEngineSlot = slotsConfig?.contextEngine;
    if (contextEngineSlot !== "lia-memory-engine") {
        logger.warn(`[lia-memory-engine] WARNING: Plugin loaded but not assigned as context engine. ` +
            `Add "plugins.slots.contextEngine": "lia-memory-engine" to openclaw.json. ` +
            `Without this, only the memory_search tool is active — compaction, auto-flush, and auto-retrieval will not work.`);
    }
    // Register memory_search tool
    registerMemorySearchTool(api, engine);
    logger.info(`[lia-memory-engine] Plugin loaded (compaction: ${config.compactionModel}, ` +
        `threshold: ${config.compactionThreshold}, auto-retrieval: ${config.autoRetrieval}, ` +
        `qmd: ${config.qmdHost}:${config.qmdPort}, vector: ${config.enableVectorSearch})`);
}
/**
 * Register the memory_search tool with OpenClaw.
 * Allows agents to explicitly search their memory files using QMD.
 */
function registerMemorySearchTool(api, engine) {
    const logger = api.logger;
    api.registerTool({
        name: "memory_search",
        label: "Memory Search",
        description: "Search conversation history and memory files for specific topics, facts, or past discussions. " +
            "Returns matching excerpts with timestamps. Use when asked about past conversations, " +
            "or when you need to recall specific details from earlier sessions.",
        parameters: Type.Object({
            query: Type.String({ description: "Keywords, names, topics, or phrases to search for." }),
        }),
        async execute(toolCallId, params) {
            const query = String(params.query ?? "").trim();
            if (!query) {
                return {
                    content: [{ type: "text", text: "Query is required for memory search." }],
                    details: undefined,
                };
            }
            try {
                const result = await engine.search({ sessionId: "default", query });
                const formatted = formatSearchResults(result, query);
                return {
                    content: [{ type: "text", text: formatted }],
                    details: undefined,
                };
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                logger.error?.(`[lia-memory-engine] memory_search failed: ${errMsg}`);
                return {
                    content: [{ type: "text", text: `Memory search failed: ${errMsg}` }],
                    details: undefined,
                };
            }
        },
    }, { optional: true });
    logger.info?.("[lia-memory-engine] Registered memory_search tool");
}
/**
 * Extract agent ID from a session key.
 * Session keys follow the format "agent:{agentId}:{rest}",
 * e.g., "agent:midas:main" → "midas", "agent:main:cron:..." → "main".
 */
function extractAgentId(sessionKey) {
    const parts = sessionKey.split(":");
    if (parts.length >= 2 && parts[0] === "agent") {
        return parts[1];
    }
    return undefined;
}
/** Plugin default export — matches OpenClaw's expected plugin object shape. */
const liaPlugin = {
    id: "lia-memory-engine",
    name: "Lia Memory Engine",
    description: "Lia-style context engine — structured compaction, auto-flush, QMD hybrid search auto-retrieval",
    configSchema,
    register,
};
export default liaPlugin;
// Re-export configSchema for documentation / tooling purposes
export { configSchema };
//# sourceMappingURL=index.js.map