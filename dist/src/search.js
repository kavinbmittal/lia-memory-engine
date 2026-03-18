/**
 * QMD-backed search for the Lia Memory Engine.
 *
 * Replaces the hand-rolled BM25 file scanner with QMD's hybrid search
 * (BM25 + optional vector + HyDE reranking via the QMD HTTP daemon).
 *
 * All search calls are best-effort: if the daemon is down or QMD is not
 * installed, they fall back to the QMD CLI and ultimately return "".
 * The engine must never block waiting for search.
 */
// ── Auto-Retrieval ──────────────────────────────────────────────────────────
/**
 * Search memory for auto-retrieval context injection.
 * Called on every `assemble()` before a model run — must be fast.
 *
 * When the daemon is running: uses BM25-only (or hybrid if enabled) with a
 * tight timeout so it never delays the agent's response.
 *
 * When the daemon is not running: falls back to the QMD CLI (slower, but
 * still bounded — CLI has its own 3s timeout).
 *
 * Returns empty string if no results or if search fails for any reason.
 *
 * @param client         - Initialized QMDClient
 * @param query          - The last user message text to search for
 * @param timeoutMs      - Maximum ms to wait for daemon search (default 500)
 * @param daemonRunning  - Whether the QMD daemon is currently running
 */
export async function searchForContext(client, query, timeoutMs, daemonRunning) {
    if (!query.trim())
        return "";
    if (daemonRunning) {
        // Race the daemon search against a hard timeout — auto-retrieval must not
        // block the agent. If the timeout wins we just inject nothing.
        const timeout = new Promise((resolve) => setTimeout(() => resolve(""), timeoutMs));
        const search = client
            .search(query, { n: 5, full: false, timeoutMs })
            .catch(() => "");
        return Promise.race([search, timeout]);
    }
    // Daemon not running — try CLI (has its own 3s internal timeout)
    return client.searchCLI(query).catch(() => "");
}
// ── Explicit Memory Search ──────────────────────────────────────────────────
/**
 * Full memory search for explicit `memory_search` tool calls.
 * Uses full hybrid mode (BM25 + vec + HyDE) when the daemon is running and
 * vector search is enabled, giving the best result quality.
 *
 * Falls back to CLI when daemon is down.
 * Returns empty string if no results or on any error.
 *
 * @param client         - Initialized QMDClient
 * @param query          - Search query from the agent tool call
 * @param daemonRunning  - Whether the QMD daemon is currently running
 */
export async function searchMemory(client, query, daemonRunning) {
    if (!query.trim())
        return "";
    if (daemonRunning) {
        try {
            return await client.search(query, { n: 10, full: true, timeoutMs: 10000 });
        }
        catch {
            // Daemon search failed — fall through to CLI
        }
    }
    return client.searchCLI(query).catch(() => "");
}
// ── Result Formatting ───────────────────────────────────────────────────────
/**
 * Format the raw QMD result text for display in the tool response.
 *
 * QMD already returns formatted markdown from its search results, so this
 * function wraps it in a consistent header and handles the empty case.
 *
 * @param text  - Raw text returned by searchMemory or searchForContext
 * @param query - The original search query (used in headers and no-results message)
 */
export function formatSearchResults(text, query) {
    if (!text || !text.trim()) {
        return `No results found for "${query}" in memory files.`;
    }
    return `## Memory search: "${query}"\n\n${text}`;
}
//# sourceMappingURL=search.js.map