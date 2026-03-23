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
    // Resolve API keys from OpenClaw's config (openclaw.json → env section).
    // Keys are stored in api.config.env, not in process.env on Railway.
    const configEnv = (api.config?.env ?? {});
    // Map provider prefixes to the env var name that holds their API key.
    const PROVIDER_KEY_MAP = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        google: "GOOGLE_AI_API_KEY",
    };
    /** Look up the API key for a provider — checks openclaw.json env, then process.env. */
    function resolveApiKey(provider) {
        const envVarName = PROVIDER_KEY_MAP[provider];
        if (!envVarName)
            return undefined;
        // Prefer OpenClaw config (where keys actually live on Railway)
        const fromConfig = configEnv[envVarName];
        if (fromConfig)
            return fromConfig;
        // Fallback to process.env (local dev)
        return process.env[envVarName];
    }
    // Build the completeFn wrapper for LLM access.
    // Strategy: try pi-ai first (OpenClaw's internal LLM router), then
    // fall back to the Anthropic SDK directly.
    const completeFn = async (model, systemPrompt, userContent) => {
        // Parse "provider/model-id" format (e.g. "anthropic/claude-haiku-4-5")
        const hasPrefix = model.includes("/");
        const provider = hasPrefix ? model.split("/")[0] : "anthropic";
        const modelId = hasPrefix ? model.split("/").slice(1).join("/") : model;
        // Method 1: pi-ai — OpenClaw's internal LLM router (correct signature)
        try {
            const piAi = await import("@mariozechner/pi-ai");
            const completeSimpleFn = piAi.completeSimple;
            if (typeof completeSimpleFn === "function") {
                // Try to resolve a known model from pi-ai's registry
                const getModelFn = piAi.getModel;
                let modelObj = typeof getModelFn === "function" ? getModelFn(provider, modelId) : undefined;
                // If pi-ai doesn't know this model, construct a minimal Model object
                if (!modelObj) {
                    modelObj = {
                        id: modelId,
                        name: modelId,
                        provider,
                        api: provider === "anthropic" ? "anthropic" : provider === "openai" ? "openai" : provider,
                        reasoning: false,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 200_000,
                        maxTokens: 8_000,
                        baseUrl: "",
                    };
                }
                const apiKey = resolveApiKey(provider);
                if (!apiKey) {
                    logger.warn(`[lia-memory-engine] No API key found for provider "${provider}" — skipping pi-ai`);
                }
                else {
                    logger.info(`[lia-memory-engine] Using pi-ai for LLM completion (${provider}/${modelId})`);
                    const result = await completeSimpleFn(modelObj, {
                        systemPrompt,
                        messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
                    }, { apiKey, maxTokens: 2048, temperature: 0.2 });
                    // Extract text from pi-ai's response content array
                    const content = result?.content;
                    if (Array.isArray(content)) {
                        const textBlock = content.find((b) => b.type === "text");
                        if (textBlock && typeof textBlock.text === "string" && textBlock.text.trim()) {
                            return textBlock.text;
                        }
                    }
                    logger.warn("[lia-memory-engine] pi-ai returned empty content — falling back to Anthropic SDK");
                }
            }
            else {
                logger.warn("[lia-memory-engine] pi-ai loaded but completeSimple not found");
            }
        }
        catch (err) {
            logger.warn(`[lia-memory-engine] pi-ai failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Method 2: Anthropic SDK — direct fallback (Anthropic-only)
        try {
            const anthropic = await import("@anthropic-ai/sdk");
            const AnthropicClass = (anthropic.default ?? anthropic);
            // Read API key from config — the SDK also checks process.env.ANTHROPIC_API_KEY
            // but that's not set on Railway (keys live in openclaw.json env).
            const apiKey = resolveApiKey("anthropic");
            const client = new AnthropicClass(apiKey ? { apiKey } : undefined);
            logger.info(`[lia-memory-engine] Using Anthropic SDK for LLM completion (model: ${modelId})`);
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
            logger.error(`[lia-memory-engine] Anthropic SDK failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        throw new Error("[lia-memory-engine] No LLM completion method available. " +
            "Ensure @mariozechner/pi-ai or @anthropic-ai/sdk is available, and " +
            "that the API key is set in openclaw.json env or process.env.");
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
    // Build the countTokensFn using the Anthropic SDK's token counting API.
    // Falls back to local estimate (chars/4) if the API is unavailable.
    const countTokensFn = async (messages) => {
        // Quick exit for empty messages
        if (messages.length === 0)
            return 0;
        try {
            const anthropic = await import("@anthropic-ai/sdk");
            const AnthropicClass = (anthropic.default ?? anthropic);
            const apiKey = resolveApiKey("anthropic");
            const client = new AnthropicClass(apiKey ? { apiKey } : undefined);
            // Parse model to get just the model ID (e.g. "claude-haiku-4-5" from "anthropic/claude-haiku-4-5")
            const modelId = config.compactionModel.includes("/")
                ? config.compactionModel.split("/").slice(1).join("/")
                : config.compactionModel;
            // Convert OpenClaw message roles to Anthropic API roles.
            // OpenClaw uses "toolResult"/"toolUse" roles; Anthropic only accepts "user"/"assistant".
            const convertedMessages = messages.map(msg => {
                const role = typeof msg.role === "string" ? msg.role : "user";
                let anthropicRole;
                if (role === "assistant" || role === "toolUse") {
                    anthropicRole = "assistant";
                }
                else {
                    // "user", "toolResult", and any other role map to "user"
                    anthropicRole = "user";
                }
                // Extract text content for counting — Anthropic API expects string or content blocks
                let content;
                if (typeof msg.content === "string") {
                    content = msg.content;
                }
                else if (Array.isArray(msg.content)) {
                    content = msg.content
                        .map((block) => {
                        if (typeof block === "string")
                            return block;
                        if (block && typeof block === "object" && "text" in block)
                            return block.text;
                        if (block && typeof block === "object")
                            return JSON.stringify(block);
                        return "";
                    })
                        .join("\n");
                }
                else {
                    content = String(msg.content ?? "");
                }
                return { role: anthropicRole, content };
            });
            // Merge consecutive messages with the same role — Anthropic API requires alternating roles
            const mergedMessages = [];
            for (const msg of convertedMessages) {
                const last = mergedMessages[mergedMessages.length - 1];
                if (last && last.role === msg.role) {
                    last.content += "\n" + msg.content;
                }
                else {
                    mergedMessages.push({ ...msg });
                }
            }
            // Ensure conversation starts with user and alternates
            if (mergedMessages.length > 0 && mergedMessages[0].role !== "user") {
                mergedMessages.unshift({ role: "user", content: "(context)" });
            }
            const result = await client.messages.countTokens({
                model: modelId,
                messages: mergedMessages,
            });
            return result.input_tokens;
        }
        catch (err) {
            // Fallback to local estimate — don't let token counting failures break anything
            logger.warn(`[lia-memory-engine] Token counting API failed, using estimate: ${err instanceof Error ? err.message : String(err)}`);
            const { estimateMessageTokens } = await import("./src/compact.js");
            return estimateMessageTokens(messages);
        }
    };
    // Create the engine
    const engine = new LiaContextEngine(config, {
        completeFn,
        countTokensFn,
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