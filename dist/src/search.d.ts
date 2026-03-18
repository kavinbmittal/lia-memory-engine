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
import type { QMDClient } from "./qmd-client.js";
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
export declare function searchForContext(client: QMDClient, query: string, timeoutMs: number, daemonRunning: boolean): Promise<string>;
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
export declare function searchMemory(client: QMDClient, query: string, daemonRunning: boolean): Promise<string>;
/**
 * Format the raw QMD result text for display in the tool response.
 *
 * QMD already returns formatted markdown from its search results, so this
 * function wraps it in a consistent header and handles the empty case.
 *
 * @param text  - Raw text returned by searchMemory or searchForContext
 * @param query - The original search query (used in headers and no-results message)
 */
export declare function formatSearchResults(text: string, query: string): string;
