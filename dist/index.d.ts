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
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
declare const configSchema: {
    jsonSchema: {
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
            qmdPort: {
                type: string;
                default: number;
            };
            qmdHost: {
                type: string;
                default: string;
            };
            qmdCollectionName: {
                type: string;
                default: string;
            };
            enableVectorSearch: {
                type: string;
                default: boolean;
            };
        };
    };
    parse(value: unknown): {};
};
/**
 * Plugin registration function — called by OpenClaw when the plugin is loaded.
 */
declare function register(api: OpenClawPluginApi): void;
/** Plugin default export — matches OpenClaw's expected plugin object shape. */
declare const liaPlugin: {
    id: string;
    name: string;
    description: string;
    configSchema: {
        jsonSchema: {
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
                qmdPort: {
                    type: string;
                    default: number;
                };
                qmdHost: {
                    type: string;
                    default: string;
                };
                qmdCollectionName: {
                    type: string;
                    default: string;
                };
                enableVectorSearch: {
                    type: string;
                    default: boolean;
                };
            };
        };
        parse(value: unknown): {};
    };
    register: typeof register;
};
export default liaPlugin;
export { configSchema };
