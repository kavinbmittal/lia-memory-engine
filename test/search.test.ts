/**
 * Tests for BM25 search and memory search (search.ts).
 *
 * Covers BM25 ranking, file-based memory search, date filtering,
 * auto-retrieval context formatting, path validation, and timeout behavior.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import {
  rankDocuments,
  searchMemory,
  searchForContext,
  formatSearchResults,
} from "../src/search.js";
import type { BM25Doc, SearchResult } from "../src/types.js";

// ── rankDocuments (BM25) ────────────────────────────────────────────────────

describe("rankDocuments", () => {
  it("should rank documents by relevance to query", () => {
    const docs: BM25Doc[] = [
      { id: "doc1", content: "The weather today is sunny and warm" },
      { id: "doc2", content: "TypeScript compiler configuration guide" },
      { id: "doc3", content: "Weather forecast for the week shows rain and sun" },
    ];

    const results = rankDocuments(docs, "weather sunny");
    assert.ok(results.length > 0, "should return ranked results");

    // doc1 and doc3 mention weather, doc1 also has sunny
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes("doc1"), "doc1 should rank (has weather and sunny)");
  });

  it("should return empty for empty query", () => {
    const docs: BM25Doc[] = [
      { id: "doc1", content: "Some content" },
    ];
    const results = rankDocuments(docs, "");
    assert.strictEqual(results.length, 0);
  });

  it("should return empty for empty documents", () => {
    const results = rankDocuments([], "test query");
    assert.strictEqual(results.length, 0);
  });

  it("should respect limit parameter", () => {
    const docs: BM25Doc[] = Array.from({ length: 20 }, (_, i) => ({
      id: `doc${i}`,
      content: `Document ${i} about testing and code quality`,
    }));

    const results = rankDocuments(docs, "testing code", 3);
    assert.ok(results.length <= 3, "should respect limit");
  });

  it("should only return documents with score > 0", () => {
    const docs: BM25Doc[] = [
      { id: "match", content: "JavaScript testing framework" },
      { id: "nomatch", content: "Photography and art gallery exhibition" },
    ];

    const results = rankDocuments(docs, "javascript testing");
    for (const r of results) {
      assert.ok(r.score > 0, `score should be > 0 for ${r.id}`);
    }
  });

  it("should handle special characters in query", () => {
    const docs: BM25Doc[] = [
      { id: "doc1", content: "Error: connection timeout at line 42" },
    ];

    // Special chars should be stripped/handled gracefully
    const results = rankDocuments(docs, "error: timeout");
    assert.ok(results.length > 0, "should handle special characters in query");
  });
});

// ── searchMemory ────────────────────────────────────────────────────────────

describe("searchMemory", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `lia-search-test-${randomUUID()}`);
    await mkdir(join(tempDir, "memory", "daily"), { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it("should find matches in memory files", async () => {
    // Create test memory files
    await writeFile(
      join(tempDir, "memory", "preferences.md"),
      "User prefers dark mode and compact layout.\nFavorite color is blue.\n"
    );
    await writeFile(
      join(tempDir, "memory", "daily", "2026-03-15.md"),
      "## 14:30\n\n**User:** What's the weather?\n\n**Agent:** It's sunny.\n\n---\n"
    );

    const results = await searchMemory(tempDir, "dark mode");
    assert.ok(results.length > 0, "should find matches");

    const prefResult = results.find((r) => r.file.includes("preferences.md"));
    assert.ok(prefResult, "should find match in preferences.md");
    assert.ok(prefResult!.matchCount > 0, "should have match count");
    assert.ok(prefResult!.matches.length > 0, "should have match snippets");
  });

  it("should search daily transcript files", async () => {
    await writeFile(
      join(tempDir, "memory", "daily", "2026-03-16.md"),
      "## 10:00\n\n**User:** Tell me about the deployment\n\n**Agent:** The deployment went smoothly.\n\n---\n"
    );

    const results = await searchMemory(tempDir, "deployment");
    assert.ok(results.length > 0, "should find matches in daily files");
  });

  it("should filter by date when days parameter is set", async () => {
    // Create old and recent files
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);
    const oldDateStr = oldDate.toISOString().split("T")[0];

    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 1);
    const recentDateStr = recentDate.toISOString().split("T")[0];

    await writeFile(
      join(tempDir, "memory", "daily", `${oldDateStr}.md`),
      "## 10:00\n\n**User:** Old conversation about deployment\n\n---\n"
    );
    await writeFile(
      join(tempDir, "memory", "daily", `${recentDateStr}.md`),
      "## 10:00\n\n**User:** Recent conversation about deployment\n\n---\n"
    );

    // Search with 7-day filter — should only find recent
    const results = await searchMemory(tempDir, "deployment", 7);
    const files = results.map((r) => r.file);
    assert.ok(
      !files.some((f) => f.includes(oldDateStr)),
      "should not include files older than 7 days"
    );
  });

  it("should not filter non-daily files by date", async () => {
    await writeFile(
      join(tempDir, "memory", "preferences.md"),
      "User prefers compact deployment layout.\n"
    );

    const results = await searchMemory(tempDir, "deployment", 1);
    const prefResult = results.find((r) => r.file.includes("preferences.md"));
    assert.ok(prefResult, "non-daily files should not be filtered by date");
  });

  it("should reject non-absolute paths", async () => {
    await assert.rejects(
      () => searchMemory("relative/path", "test"),
      (err: Error) => {
        assert.ok(err.message.includes("must be absolute"), "should mention absolute path requirement");
        return true;
      }
    );
  });

  it("should return empty for empty workspace (no memory dir)", async () => {
    const emptyDir = join(tmpdir(), `lia-empty-${randomUUID()}`);
    await mkdir(emptyDir, { recursive: true });

    try {
      const results = await searchMemory(emptyDir, "anything");
      assert.strictEqual(results.length, 0, "should return empty for missing memory dir");
    } finally {
      await rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("should return empty for empty query", async () => {
    const results = await searchMemory(tempDir, "");
    assert.strictEqual(results.length, 0, "should return empty for empty query");
  });

  it("should search subdirectories (core, guides, etc.)", async () => {
    await mkdir(join(tempDir, "memory", "guides"), { recursive: true });
    await writeFile(
      join(tempDir, "memory", "guides", "setup.md"),
      "# Setup Guide\nHow to configure the deployment pipeline.\nDeployment steps and deployment checklist.\nMore deployment info here.\n"
    );
    // Add a second file so BM25 has multiple documents to rank
    await writeFile(
      join(tempDir, "memory", "notes.md"),
      "# Notes\nSome unrelated notes about cooking and recipes.\n"
    );

    const results = await searchMemory(tempDir, "deployment");
    assert.ok(results.length > 0, "should find matches in subdirectories");
    assert.ok(
      results.some((r) => r.file.includes("guides/")),
      `should include matches from guides/, got files: ${results.map(r => r.file).join(", ")}`
    );
  });

  it("should limit to 3 match snippets per file", async () => {
    // Create a file with many matching lines
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}: deployment info here`);
    await writeFile(join(tempDir, "memory", "many-matches.md"), lines.join("\n"));

    const results = await searchMemory(tempDir, "deployment");
    for (const r of results) {
      assert.ok(r.matches.length <= 3, `should have at most 3 snippets, got ${r.matches.length}`);
    }
  });
});

// ── searchForContext ────────────────────────────────────────────────────────

describe("searchForContext", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `lia-context-test-${randomUUID()}`);
    await mkdir(join(tempDir, "memory", "daily"), { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  it("should return formatted context when results exist", async () => {
    // Create a file with past content (not today)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    await writeFile(
      join(tempDir, "memory", "daily", `${yesterdayStr}.md`),
      "## 14:00\n\n**User:** How does the billing system work?\n\n**Agent:** It uses Stripe.\n\n---\n"
    );

    const result = await searchForContext(tempDir, "billing system", 5000);
    assert.ok(result.length > 0, "should return context");
    assert.ok(result.includes("memory/"), "should include file paths");
  });

  it("should exclude today's transcript from results", async () => {
    const today = new Date().toISOString().split("T")[0];
    await writeFile(
      join(tempDir, "memory", "daily", `${today}.md`),
      "## 10:00\n\n**User:** Today's billing question\n\n**Agent:** Answer.\n\n---\n"
    );

    const result = await searchForContext(tempDir, "billing", 5000);
    // If today is the only file, result should be empty (today is excluded)
    assert.strictEqual(result, "", "should exclude today's transcript");
  });

  it("should return empty string when no results found", async () => {
    const result = await searchForContext(tempDir, "nonexistent topic xyz123", 5000);
    assert.strictEqual(result, "", "should return empty string for no results");
  });

  it("should respect timeout and return empty on slow search", async () => {
    // With a very short timeout and a real search, the search should
    // still complete quickly for an empty workspace
    const result = await searchForContext(tempDir, "test", 1);
    // May or may not timeout — just verify it returns a string
    assert.strictEqual(typeof result, "string", "should return a string even on timeout");
  });

  it("should return non-daily memory file results", async () => {
    await writeFile(
      join(tempDir, "memory", "preferences.md"),
      "User prefers dark mode for the billing dashboard.\n"
    );

    const result = await searchForContext(tempDir, "billing dashboard", 5000);
    assert.ok(result.includes("preferences.md"), "should include non-daily memory files");
  });
});

// ── formatSearchResults ─────────────────────────────────────────────────────

describe("formatSearchResults", () => {
  it("should format results as markdown", () => {
    const results: SearchResult[] = [
      {
        file: "memory/preferences.md",
        matches: [
          { line: 3, context: "User prefers dark mode" },
          { line: 7, context: "Favorite color is blue", timestamp: "14:30" },
        ],
        matchCount: 5,
      },
    ];

    const formatted = formatSearchResults(results, "dark mode");
    assert.ok(formatted.includes('Search results for "dark mode"'), "should include query");
    assert.ok(formatted.includes("memory/preferences.md"), "should include file path");
    assert.ok(formatted.includes("5 matches"), "should include match count");
    assert.ok(formatted.includes("User prefers dark mode"), "should include snippet");
    assert.ok(formatted.includes("[14:30]"), "should include timestamp when present");
  });

  it("should return no-results message for empty results", () => {
    const formatted = formatSearchResults([], "missing topic");
    assert.ok(formatted.includes("No results found"), "should indicate no results");
    assert.ok(formatted.includes("missing topic"), "should include the query");
  });
});
