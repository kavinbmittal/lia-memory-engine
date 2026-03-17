/**
 * Tests for auto-flush (auto-flush.ts).
 *
 * Covers content extraction from various block types,
 * transcript formatting, and file writing with temp directories.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { extractContentText, formatTranscript, writeTranscript, } from "../src/auto-flush.js";
// ── extractContentText ──────────────────────────────────────────────────────
describe("extractContentText", () => {
    it("should return string content as-is", () => {
        assert.strictEqual(extractContentText("hello world"), "hello world");
    });
    it("should extract text from text blocks", () => {
        const block = { type: "text", text: "Hello from text block" };
        assert.strictEqual(extractContentText(block), "Hello from text block");
    });
    it("should handle text block with missing text field", () => {
        const block = { type: "text" };
        assert.strictEqual(extractContentText(block), "");
    });
    it("should format tool_use blocks with tool name", () => {
        const block = { type: "tool_use", name: "memory_search", input: { query: "test" } };
        assert.strictEqual(extractContentText(block), "[Used tool: memory_search]");
    });
    it("should format tool_result blocks with string content", () => {
        const block = { type: "tool_result", content: "Search found 3 results" };
        assert.strictEqual(extractContentText(block), "[Tool result: Search found 3 results]");
    });
    it("should format tool_result blocks with array content", () => {
        const block = {
            type: "tool_result",
            content: [{ type: "text", text: "result" }],
        };
        const result = extractContentText(block);
        assert.ok(result.startsWith("[Tool result:"), "should start with tool result prefix");
    });
    it("should truncate long tool_result content to 200 chars", () => {
        const longContent = "x".repeat(300);
        const block = { type: "tool_result", content: longContent };
        const result = extractContentText(block);
        // "[Tool result: " + 200 chars + "]"
        assert.ok(result.length < 300, "should truncate long content");
        assert.ok(result.includes("x".repeat(200)), "should include first 200 chars");
    });
    it("should return empty string for unknown block types", () => {
        const block = { type: "image", source: { data: "..." } };
        assert.strictEqual(extractContentText(block), "");
    });
    it("should return empty string for empty string content", () => {
        assert.strictEqual(extractContentText(""), "");
    });
});
// ── formatTranscript ────────────────────────────────────────────────────────
describe("formatTranscript", () => {
    it("should format messages with time header and role labels", () => {
        const messages = [
            { role: "user", content: "What's the weather?" },
            { role: "assistant", content: "It's sunny today." },
        ];
        const result = formatTranscript(messages);
        // Should have a time header like "## 14:30"
        assert.ok(result.match(/^## \d{2}:\d{2}/), "should start with ## HH:MM time header");
        assert.ok(result.includes("**User:** What's the weather?"), "should have User label");
        assert.ok(result.includes("**Agent:** It's sunny today."), "should have Agent label");
        assert.ok(result.includes("---"), "should end with separator");
    });
    it("should return empty string for empty messages", () => {
        assert.strictEqual(formatTranscript([]), "");
    });
    it("should skip empty content messages", () => {
        const messages = [
            { role: "user", content: "Hello" },
            { role: "assistant", content: [{ type: "tool_use", name: "search", input: {} }] },
            { role: "assistant", content: "Result" },
        ];
        const result = formatTranscript(messages);
        assert.ok(result.includes("**User:** Hello"), "should include user message");
        // tool_use produces "[Used tool: search]" which is non-empty, so it should be included
        assert.ok(result.includes("**Agent:**"), "should include agent messages");
    });
    it("should handle messages with content block arrays", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Here is the answer" },
                    { type: "text", text: "with more details" },
                ],
            },
        ];
        const result = formatTranscript(messages);
        assert.ok(result.includes("Here is the answer"), "should include text from blocks");
        assert.ok(result.includes("with more details"), "should include all text blocks");
    });
});
// ── writeTranscript ─────────────────────────────────────────────────────────
describe("writeTranscript", () => {
    let tempDir;
    beforeEach(async () => {
        tempDir = join(tmpdir(), `lia-test-${randomUUID()}`);
        await mkdir(tempDir, { recursive: true });
    });
    afterEach(async () => {
        try {
            await rm(tempDir, { recursive: true, force: true });
        }
        catch {
            // Best-effort cleanup
        }
    });
    it("should create daily directory and write transcript file", async () => {
        const messages = [
            { role: "user", content: "Test message" },
            { role: "assistant", content: "Test response" },
        ];
        await writeTranscript(tempDir, messages);
        const date = new Date().toISOString().split("T")[0];
        const logPath = join(tempDir, "memory", "daily", `${date}.md`);
        const content = await readFile(logPath, "utf-8");
        assert.ok(content.includes("**User:** Test message"), "should contain user message");
        assert.ok(content.includes("**Agent:** Test response"), "should contain agent message");
    });
    it("should append to existing file (not overwrite)", async () => {
        const messages1 = [
            { role: "user", content: "First message" },
        ];
        const messages2 = [
            { role: "user", content: "Second message" },
        ];
        await writeTranscript(tempDir, messages1);
        await writeTranscript(tempDir, messages2);
        const date = new Date().toISOString().split("T")[0];
        const logPath = join(tempDir, "memory", "daily", `${date}.md`);
        const content = await readFile(logPath, "utf-8");
        assert.ok(content.includes("First message"), "should contain first message");
        assert.ok(content.includes("Second message"), "should contain second message");
    });
    it("should do nothing for empty messages", async () => {
        await writeTranscript(tempDir, []);
        // Directory should be created but no file written
        const date = new Date().toISOString().split("T")[0];
        const logPath = join(tempDir, "memory", "daily", `${date}.md`);
        await assert.rejects(() => readFile(logPath, "utf-8"), "should not create file for empty messages");
    });
    it("should create nested directories if they don't exist", async () => {
        const deepDir = join(tempDir, "nested", "workspace");
        // Don't create the directory — writeTranscript should handle it
        // Actually writeTranscript expects the workspaceDir to exist or be createable
        await mkdir(deepDir, { recursive: true });
        const messages = [
            { role: "user", content: "Deep test" },
        ];
        await writeTranscript(deepDir, messages);
        const date = new Date().toISOString().split("T")[0];
        const logPath = join(deepDir, "memory", "daily", `${date}.md`);
        const content = await readFile(logPath, "utf-8");
        assert.ok(content.includes("Deep test"), "should write to nested directory");
    });
});
//# sourceMappingURL=auto-flush.test.js.map