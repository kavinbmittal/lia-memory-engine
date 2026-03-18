/**
 * Tests for the QMD-backed search API (search.ts).
 *
 * Uses a mock QMDClient to test the search orchestration logic without
 * requiring a running QMD daemon or the QMD CLI to be installed.
 *
 * Covers:
 * - searchForContext: daemon path, CLI fallback, timeout, empty results
 * - searchMemory: full mode, CLI fallback, empty results
 * - formatSearchResults: markdown formatting, no-results message
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { searchForContext, searchMemory, formatSearchResults, } from "../src/search.js";
// ── Mock QMDClient ───────────────────────────────────────────────────────────
/**
 * Build a mock QMDClient with sensible defaults.
 * Override individual methods to simulate specific behaviors.
 */
function makeMockClient(overrides = {}) {
    return {
        search: async () => "## Results\n- Found relevant context",
        searchCLI: async () => "BM25 result from CLI",
        // Remaining methods not needed for search unit tests
        isRunning: async () => true,
        startDaemon: async () => true,
        ensureCollection: async () => { },
        embedBackground: () => { },
        ...overrides,
    };
}
// ── searchForContext ─────────────────────────────────────────────────────────
describe("searchForContext", () => {
    it("should use daemon search when daemon is running", async () => {
        let searchCalled = false;
        const client = makeMockClient({
            search: async (query, opts) => {
                searchCalled = true;
                assert.strictEqual(query, "dark mode settings");
                assert.strictEqual(opts.n, 5);
                assert.strictEqual(opts.full, false);
                return "## Results\n- dark mode preference noted";
            },
        });
        const result = await searchForContext(client, "dark mode settings", 5000, true);
        assert.ok(searchCalled, "should call client.search when daemon is running");
        assert.ok(result.includes("dark mode"), "should return search result text");
    });
    it("should fall back to CLI when daemon is not running", async () => {
        let cliCalled = false;
        let daemonCalled = false;
        const client = makeMockClient({
            search: async () => {
                daemonCalled = true;
                return "daemon result";
            },
            searchCLI: async () => {
                cliCalled = true;
                return "CLI fallback result";
            },
        });
        const result = await searchForContext(client, "test query", 5000, false);
        assert.ok(cliCalled, "should call searchCLI when daemon is not running");
        assert.ok(!daemonCalled, "should not call daemon search when daemon is not running");
        assert.strictEqual(result, "CLI fallback result");
    });
    it("should return empty string when daemon search throws", async () => {
        const client = makeMockClient({
            search: async () => {
                throw new Error("Daemon connection refused");
            },
        });
        const result = await searchForContext(client, "test query", 5000, true);
        assert.strictEqual(result, "", "should return empty string on daemon error");
    });
    it("should return empty string when CLI search throws", async () => {
        const client = makeMockClient({
            searchCLI: async () => {
                throw new Error("qmd not installed");
            },
        });
        const result = await searchForContext(client, "test query", 5000, false);
        assert.strictEqual(result, "", "should return empty string on CLI error");
    });
    it("should return empty string for blank query", async () => {
        let searchCalled = false;
        const client = makeMockClient({
            search: async () => {
                searchCalled = true;
                return "result";
            },
        });
        const result = await searchForContext(client, "   ", 5000, true);
        assert.strictEqual(result, "", "should return empty for blank query");
        assert.ok(!searchCalled, "should not call search for blank query");
    });
    it("should respect timeout and return empty when search is slow", async () => {
        const client = makeMockClient({
            search: async (_query, opts) => {
                // Simulate a search that takes longer than the timeout
                await new Promise((resolve) => setTimeout(resolve, (opts.timeoutMs ?? 5000) + 500));
                return "late result";
            },
        });
        // Use a very short timeout (10ms) — the search above will take longer
        const result = await searchForContext(client, "test query", 10, true);
        assert.strictEqual(result, "", "should return empty string when timeout wins");
    });
    it("should return empty string when search returns empty text", async () => {
        const client = makeMockClient({
            search: async () => "",
        });
        const result = await searchForContext(client, "obscure query", 5000, true);
        assert.strictEqual(result, "", "should return empty when no results");
    });
});
// ── searchMemory ─────────────────────────────────────────────────────────────
describe("searchMemory", () => {
    it("should use full mode (n=10, full=true) when daemon is running", async () => {
        let capturedOpts = {};
        const client = makeMockClient({
            search: async (_query, opts) => {
                capturedOpts = opts;
                return "## Full results\n- Item 1\n- Item 2";
            },
        });
        const result = await searchMemory(client, "billing system", true);
        assert.strictEqual(capturedOpts.n, 10, "should request 10 results");
        assert.strictEqual(capturedOpts.full, true, "should use full mode");
        assert.ok(result.includes("Full results"), "should return search text");
    });
    it("should fall back to CLI when daemon is not running", async () => {
        let cliCalled = false;
        const client = makeMockClient({
            searchCLI: async () => {
                cliCalled = true;
                return "CLI fallback for memory search";
            },
        });
        const result = await searchMemory(client, "billing system", false);
        assert.ok(cliCalled, "should call searchCLI when daemon is not running");
        assert.strictEqual(result, "CLI fallback for memory search");
    });
    it("should fall back to CLI when daemon search throws", async () => {
        let cliCalled = false;
        const client = makeMockClient({
            search: async () => {
                throw new Error("Daemon timeout");
            },
            searchCLI: async () => {
                cliCalled = true;
                return "CLI result after daemon failure";
            },
        });
        const result = await searchMemory(client, "billing system", true);
        assert.ok(cliCalled, "should fall back to CLI after daemon failure");
        assert.strictEqual(result, "CLI result after daemon failure");
    });
    it("should return empty string when CLI also fails", async () => {
        const client = makeMockClient({
            search: async () => {
                throw new Error("Daemon timeout");
            },
            searchCLI: async () => {
                throw new Error("qmd not found");
            },
        });
        const result = await searchMemory(client, "billing system", true);
        assert.strictEqual(result, "", "should return empty when both daemon and CLI fail");
    });
    it("should return empty string for blank query", async () => {
        let searchCalled = false;
        const client = makeMockClient({
            search: async () => {
                searchCalled = true;
                return "result";
            },
        });
        const result = await searchMemory(client, "", true);
        assert.strictEqual(result, "", "should return empty for blank query");
        assert.ok(!searchCalled, "should not call search for blank query");
    });
    it("should return empty string when no results found", async () => {
        const client = makeMockClient({
            search: async () => "",
        });
        const result = await searchMemory(client, "very obscure nonexistent topic", true);
        assert.strictEqual(result, "", "should return empty when search returns nothing");
    });
});
// ── formatSearchResults ──────────────────────────────────────────────────────
describe("formatSearchResults", () => {
    it("should format results with the query in the header", () => {
        const formatted = formatSearchResults("## Top matches\n- Billing system uses Stripe\n- Invoices generated weekly", "billing system");
        assert.ok(formatted.includes('Memory search: "billing system"'), "should include query in header");
        assert.ok(formatted.includes("Billing system uses Stripe"), "should include the result content");
    });
    it("should return no-results message for empty string", () => {
        const formatted = formatSearchResults("", "missing topic");
        assert.ok(formatted.includes("No results found"), "should indicate no results");
        assert.ok(formatted.includes("missing topic"), "should include the query in no-results message");
    });
    it("should return no-results message for whitespace-only string", () => {
        const formatted = formatSearchResults("   \n  ", "another query");
        assert.ok(formatted.includes("No results found"), "should treat whitespace as empty");
        assert.ok(formatted.includes("another query"), "should include query");
    });
    it("should preserve the raw QMD result text in the output", () => {
        const rawText = "## Matches\n\n**preferences.md** — User prefers dark mode\n\n**daily/2026-03-15.md** — Discussed billing.";
        const formatted = formatSearchResults(rawText, "dark mode billing");
        assert.ok(formatted.startsWith("## Memory search:"), "should start with the memory search header");
        assert.ok(formatted.includes(rawText), "should include the full raw QMD result text");
    });
});
//# sourceMappingURL=search.test.js.map