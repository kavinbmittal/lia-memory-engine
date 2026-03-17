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
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import BM25Import from "okapibm25";
// ── BM25 Ranking ────────────────────────────────────────────────────────────
/**
 * Rank documents against a query using Okapi BM25.
 * Returns documents with score > 0, sorted descending by relevance.
 */
export function rankDocuments(documents, query, limit = 10) {
    const queryTerms = query
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 0);
    if (queryTerms.length === 0 || documents.length === 0)
        return [];
    // okapibm25 default export — may be the function directly or wrapped
    const BM25 = BM25Import.default ?? BM25Import;
    if (typeof BM25 !== "function") {
        return keywordFallback(documents, queryTerms, limit);
    }
    const contents = documents.map((d) => d.content);
    let scores;
    try {
        scores = BM25(contents, queryTerms);
    }
    catch {
        return keywordFallback(documents, queryTerms, limit);
    }
    const ranked = [];
    for (let i = 0; i < scores.length; i++) {
        if (scores[i] > 0) {
            ranked.push({ id: documents[i].id, score: scores[i] });
        }
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
}
/**
 * Fallback keyword frequency ranking when BM25 is unavailable.
 */
function keywordFallback(documents, queryTerms, limit) {
    const ranked = [];
    for (const doc of documents) {
        const lower = doc.content.toLowerCase();
        let score = 0;
        for (const term of queryTerms) {
            // Count occurrences
            let idx = 0;
            while ((idx = lower.indexOf(term, idx)) !== -1) {
                score++;
                idx += term.length;
            }
        }
        if (score > 0) {
            ranked.push({ id: doc.id, score });
        }
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
}
// ── Memory Search ───────────────────────────────────────────────────────────
/**
 * Search all .md files in memory/ for relevant matches using BM25 ranking.
 * Returns top 5 files with up to 3 matches each (200-char snippets).
 *
 * @param workspaceDir - Absolute path to the agent's workspace directory
 * @param query - Search query (case-insensitive)
 * @param days - Optional limit to last N days (only affects daily/YYYY-MM-DD.md files)
 */
export async function searchMemory(workspaceDir, query, days) {
    // Validate workspaceDir is absolute to prevent path traversal
    if (!isAbsolute(workspaceDir)) {
        throw new Error(`[lia-memory-engine] workspaceDir must be absolute, got: "${workspaceDir}"`);
    }
    const memoryDir = resolve(workspaceDir, "memory");
    // Verify memoryDir is within workspaceDir (prevents path traversal via symlinks or ..)
    if (!memoryDir.startsWith(resolve(workspaceDir))) {
        throw new Error(`[lia-memory-engine] memoryDir escapes workspaceDir: "${memoryDir}"`);
    }
    // Split query into lowercase keywords for matching
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0)
        return [];
    // Date cutoff for filtering daily transcript files
    let dateCutoff = null;
    if (days && days > 0) {
        dateCutoff = new Date();
        dateCutoff.setDate(dateCutoff.getDate() - days);
    }
    const datePattern = /^(\d{4}-\d{2}-\d{2})\.md$/;
    // Read top-level memory/ files (topic files like preferences.md)
    let topLevelFiles = [];
    try {
        topLevelFiles = (await readdir(memoryDir)).filter((f) => f.endsWith(".md"));
    }
    catch (err) {
        if (err?.code !== "ENOENT")
            throw err;
    }
    // Read memory/daily/ files (daily transcripts: YYYY-MM-DD.md)
    const dailyDir = join(memoryDir, "daily");
    let dailyFiles = [];
    try {
        dailyFiles = (await readdir(dailyDir)).filter((f) => f.endsWith(".md"));
    }
    catch (err) {
        if (err?.code !== "ENOENT")
            throw err;
    }
    if (topLevelFiles.length === 0 && dailyFiles.length === 0)
        return [];
    // Apply date filter to YYYY-MM-DD.md files in daily/
    const filteredDailyFiles = dailyFiles.filter((f) => {
        if (!dateCutoff)
            return true;
        const match = f.match(datePattern);
        if (!match)
            return true;
        const fileDate = new Date(match[1]);
        return !isNaN(fileDate.getTime()) && fileDate >= dateCutoff;
    });
    // Load all file contents
    const fileContents = new Map();
    for (const file of topLevelFiles) {
        try {
            const content = await readFile(join(memoryDir, file), "utf-8");
            fileContents.set(file, content);
        }
        catch {
            continue;
        }
    }
    for (const file of filteredDailyFiles) {
        try {
            const content = await readFile(join(dailyDir, file), "utf-8");
            fileContents.set(`daily/${file}`, content);
        }
        catch {
            continue;
        }
    }
    // Also scan subdirectories (activity/, core/, guides/, gotchas/, patterns/)
    const subDirs = ["activity", "core", "guides", "gotchas", "patterns"];
    for (const subDir of subDirs) {
        const subPath = resolve(memoryDir, subDir);
        // Verify resolved path stays within memoryDir (prevents path traversal)
        if (!subPath.startsWith(memoryDir))
            continue;
        let subFiles = [];
        try {
            subFiles = (await readdir(subPath)).filter((f) => f.endsWith(".md"));
        }
        catch {
            continue;
        }
        for (const file of subFiles) {
            try {
                const content = await readFile(join(subPath, file), "utf-8");
                fileContents.set(`${subDir}/${file}`, content);
            }
            catch {
                continue;
            }
        }
    }
    // Try BM25 ranking first, fall back to keyword search on failure
    try {
        return searchMemoryBM25(fileContents, query, keywords);
    }
    catch {
        return searchMemoryKeyword(fileContents, keywords);
    }
}
/**
 * BM25-ranked search over pre-loaded file contents.
 */
function searchMemoryBM25(fileContents, query, keywords) {
    const docs = [];
    for (const [file, content] of fileContents) {
        docs.push({ id: file, content });
    }
    if (docs.length === 0)
        return [];
    const ranked = rankDocuments(docs, query, 5);
    const results = [];
    for (const { id: file, score } of ranked) {
        const content = fileContents.get(file);
        const { matches, totalMatches } = extractSnippets(content, keywords);
        results.push({
            file: `memory/${file}`,
            matches,
            matchCount: totalMatches > 0 ? totalMatches : Math.ceil(score),
        });
    }
    return results;
}
/**
 * Keyword-frequency search — fallback if BM25 fails.
 */
function searchMemoryKeyword(fileContents, keywords) {
    const results = [];
    for (const [file, content] of fileContents) {
        const { matches, totalMatches } = extractSnippets(content, keywords);
        if (totalMatches > 0) {
            results.push({
                file: `memory/${file}`,
                matches,
                matchCount: totalMatches,
            });
        }
    }
    results.sort((a, b) => b.matchCount - a.matchCount);
    return results.slice(0, 5);
}
/**
 * Extract up to 3 keyword-matching snippets from file content.
 * Each snippet is a 200-char context window around the matching line.
 */
function extractSnippets(content, keywords) {
    const lines = content.split("\n");
    const matches = [];
    let totalMatches = 0;
    for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        const matchCount = keywords.filter((kw) => lower.includes(kw)).length;
        if (matchCount === 0)
            continue;
        totalMatches += matchCount;
        if (matches.length < 3) {
            // Extract timestamp from nearby ## header if available
            let timestamp;
            for (let j = i; j >= Math.max(0, i - 5); j--) {
                const headerMatch = lines[j].match(/^## (\d{1,2}:\d{2})/);
                if (headerMatch) {
                    timestamp = headerMatch[1];
                    break;
                }
            }
            matches.push({
                line: i + 1,
                context: lines[i].slice(0, 200),
                timestamp,
            });
        }
    }
    return { matches, totalMatches };
}
// ── Auto-Retrieval ──────────────────────────────────────────────────────────
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
export async function searchForContext(workspaceDir, query, timeoutMs = 500) {
    let searchCompleted = false;
    let timerId;
    const timeout = new Promise((resolve) => {
        timerId = setTimeout(() => resolve(""), timeoutMs);
    });
    const search = (async () => {
        const results = await searchMemory(workspaceDir, query);
        // Filter out today's transcript (already in the current session)
        const today = new Date().toISOString().split("T")[0];
        const filtered = results.filter((r) => {
            const basename = r.file.replace("memory/", "");
            return basename !== `daily/${today}.md`;
        });
        if (filtered.length === 0) {
            searchCompleted = true;
            return "";
        }
        // Format as compact context block
        const sections = filtered.slice(0, 3).map((r) => {
            const snippets = r.matches.slice(0, 2).map((m) => {
                const ts = m.timestamp ? `[${m.timestamp}] ` : "";
                return `  ${ts}${m.context}`;
            }).join("\n");
            return `${r.file}:\n${snippets}`;
        });
        searchCompleted = true;
        return sections.join("\n\n");
    })();
    try {
        const result = await Promise.race([search, timeout]);
        if (!result && !searchCompleted) {
            // Timeout won the race — search was too slow
        }
        return result;
    }
    finally {
        // Clear the timer to prevent leaked handles
        if (timerId !== undefined) {
            clearTimeout(timerId);
        }
    }
}
/**
 * Format search results as readable markdown for the memory_search tool.
 */
export function formatSearchResults(results, query) {
    if (results.length === 0) {
        return `No results found for "${query}" in memory files.`;
    }
    const sections = results.map((r) => {
        const matchLines = r.matches
            .map((m) => {
            const ts = m.timestamp ? `[${m.timestamp}] ` : "";
            return `- ${ts}${m.context}`;
        })
            .join("\n");
        return `### ${r.file} (${r.matchCount} matches)\n${matchLines}`;
    });
    return `## Search results for "${query}"\n\n${sections.join("\n\n")}`;
}
//# sourceMappingURL=search.js.map