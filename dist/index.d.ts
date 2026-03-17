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
/**
 * Plugin registration function — called by OpenClaw when the plugin is loaded.
 */
declare function register(api: any): void;
/** Plugin default export — matches OpenClaw's expected plugin object shape. */
declare const liaPlugin: {
    id: string;
    name: string;
    description: string;
    configSchema: {
        parse(value: unknown): {};
    };
    register: typeof register;
};
export default liaPlugin;
