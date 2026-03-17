/**
 * BM25-ranked search over workspace memory/ files.
 *
 * Ported from Lia's search.ts + bm25.ts. Scans all .md files in
 * memory/ (topic files) and memory/daily/ (transcripts), ranks by
 * BM25 relevance, returns top results with context snippets.
 *
 * Adapted for OpenClaw: uses workspaceDir instead of telegramId,
 * labels output "Agent" instead of "Lia."
 */
import type { SearchResult, BM25Doc, RankedDocument } from "./types.js";
/**
 * Rank documents against a query using Okapi BM25.
 * Returns documents with score > 0, sorted descending by relevance.
 */
export declare function rankDocuments(documents: BM25Doc[], query: string, limit?: number): RankedDocument[];
/**
 * Search all .md files in memory/ for relevant matches using BM25 ranking.
 * Returns top 5 files with up to 3 matches each (200-char snippets).
 *
 * @param workspaceDir - Absolute path to the agent's workspace directory
 * @param query - Search query (case-insensitive)
 * @param days - Optional limit to last N days (only affects daily/YYYY-MM-DD.md files)
 */
export declare function searchMemory(workspaceDir: string, query: string, days?: number): Promise<SearchResult[]>;
/**
 * Search memory for auto-retrieval context injection.
 * Returns formatted markdown string for systemPromptAddition.
 * Excludes today's transcript (already in context from the current session).
 * Enforced timeout so it never blocks the agent.
 *
 * @param workspaceDir - Absolute path to the agent's workspace directory
 * @param query - The latest user message to search for
 * @param timeoutMs - Maximum time to spend searching (default 500ms)
 */
export declare function searchForContext(workspaceDir: string, query: string, timeoutMs?: number): Promise<string>;
/**
 * Format search results as readable markdown for the memory_search tool.
 */
export declare function formatSearchResults(results: SearchResult[], query: string): string;
