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
export declare const id = "lia-memory-engine";
export declare const name = "Lia Memory Engine";
export declare const description = "Lia-style context engine \u2014 structured compaction, auto-flush, BM25 auto-retrieval";
/** JSON Schema for plugin configuration (mirrors openclaw.plugin.json). */
export declare const configSchema: {
    type: string;
    properties: {
        enabled: {
            type: string;
            default: boolean;
        };
        compactionThreshold: {
            type: string;
            default: number;
            minimum: number;
            maximum: number;
        };
        compactionModel: {
            type: string;
            default: string;
        };
        freshTailCount: {
            type: string;
            default: number;
            minimum: number;
        };
        autoRetrieval: {
            type: string;
            default: boolean;
        };
        autoRetrievalTimeoutMs: {
            type: string;
            default: number;
            minimum: number;
            maximum: number;
        };
        transcriptRetentionDays: {
            type: string;
            default: number;
            minimum: number;
        };
    };
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
export default function register(api: any): void;
