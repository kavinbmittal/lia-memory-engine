/**
 * Type definitions for the Lia Memory Engine plugin.
 *
 * These types define the plugin's configuration, dependencies,
 * and internal data structures. The OpenClaw plugin API types
 * are kept as `any` to avoid coupling to a specific SDK version.
 */
/** Default configuration values — matches openclaw.plugin.json defaults. */
export const DEFAULT_CONFIG = {
    enabled: true,
    compactionThreshold: 0.80,
    compactionModel: "anthropic/claude-haiku-4-5",
    autoRetrieval: true,
    autoRetrievalTimeoutMs: 500,
    transcriptRetentionDays: 180,
};
//# sourceMappingURL=types.js.map