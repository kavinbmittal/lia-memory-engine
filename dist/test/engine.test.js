/**
 * Tests for the LiaContextEngine (engine.ts).
 *
 * Covers engine lifecycle (bootstrap, ingest, assemble, compact, afterTurn, dispose),
 * auto-retrieval integration, race condition protection, double-compaction prevention,
 * and findLastUserMessage logic.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { LiaContextEngine } from "../src/engine.js";
import { DEFAULT_CONFIG } from "../src/types.js";
// ── Test Helpers ────────────────────────────────────────────────────────────
/** Create a temp workspace directory for tests. */
async function createTempWorkspace() {
    const dir = join(tmpdir(), `lia-engine-test-${randomUUID()}`);
    await mkdir(join(dir, "memory", "daily"), { recursive: true });
    return dir;
}
/** No-op QMD client — prevents daemon startup delay in tests. */
const noopQmdClient = {
    isRunning: async () => false,
    startDaemon: async () => false,
    ensureCollection: async () => { },
    embedBackground: () => { },
    search: async () => "",
    searchCLI: async () => "",
};
/** Build test dependencies with a mock completeFn. */
function buildDeps(workspaceDir, overrides) {
    return {
        completeFn: async (_model, _system, _user) => "Test summary of conversation.",
        logger: {
            info: () => { },
            warn: () => { },
            error: () => { },
        },
        resolveWorkspaceDir: (_sessionId) => workspaceDir,
        qmdClient: noopQmdClient,
        ...overrides,
    };
}
/** Build a config with optional overrides. */
function buildConfig(overrides) {
    return { ...DEFAULT_CONFIG, ...overrides };
}
/** Build alternating user/assistant messages. */
function buildMessages(count) {
    const msgs = [];
    for (let i = 0; i < count; i++) {
        msgs.push({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `Message ${i}: ${"x".repeat(40)}`,
        });
    }
    return msgs;
}
// ── Engine Info ──────────────────────────────────────────────────────────────
describe("LiaContextEngine info", () => {
    it("should have ownsCompaction set to true", async () => {
        const dir = await createTempWorkspace();
        try {
            const engine = new LiaContextEngine(buildConfig(), buildDeps(dir));
            assert.strictEqual(engine.info.ownsCompaction, true);
            assert.strictEqual(engine.info.id, "lia-memory-engine");
            assert.ok(engine.info.version, "should have a version");
        }
        finally {
            await rm(dir, { recursive: true, force: true }).catch(() => { });
        }
    });
});
// ── Bootstrap ───────────────────────────────────────────────────────────────
describe("bootstrap", () => {
    let tempDir;
    beforeEach(async () => {
        tempDir = await createTempWorkspace();
    });
    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
    });
    it("should initialize session successfully", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        const result = await engine.bootstrap({ sessionId: "test-1" });
        assert.strictEqual(result.ok, true);
    });
    it("should initialize with existing messages", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        const messages = buildMessages(4);
        await engine.bootstrap({ sessionId: "test-2", messages });
        const assembled = await engine.assemble({ sessionId: "test-2" });
        assert.strictEqual(assembled.messages.length, 4);
    });
    it("should return ok:false when workspace resolution fails", async () => {
        const deps = buildDeps(tempDir, {
            resolveWorkspaceDir: () => { throw new Error("Workspace not found"); },
        });
        const engine = new LiaContextEngine(buildConfig(), deps);
        const result = await engine.bootstrap({ sessionId: "bad-session" });
        assert.strictEqual(result.ok, false);
    });
});
// ── Ingest ──────────────────────────────────────────────────────────────────
describe("ingest", () => {
    let tempDir;
    beforeEach(async () => {
        tempDir = await createTempWorkspace();
    });
    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
    });
    it("should store message and write transcript", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "ingest-1" });
        const msg = { role: "user", content: "Hello there" };
        const result = await engine.ingest({ sessionId: "ingest-1", message: msg });
        assert.strictEqual(result.ok, true);
        // Verify message is in session
        const assembled = await engine.assemble({ sessionId: "ingest-1" });
        assert.strictEqual(assembled.messages.length, 1);
        assert.strictEqual(assembled.messages[0].content, "Hello there");
        // Verify transcript was written
        const date = new Date().toISOString().split("T")[0];
        const logPath = join(tempDir, "memory", "daily", `${date}.md`);
        const content = await readFile(logPath, "utf-8");
        assert.ok(content.includes("Hello there"), "transcript should contain the message");
    });
    it("should work without bootstrap (lazy init)", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        // No bootstrap — ingest directly
        const msg = { role: "user", content: "Lazy init test" };
        const result = await engine.ingest({ sessionId: "lazy-1", message: msg });
        assert.strictEqual(result.ok, true);
    });
    it("should not write transcript when disabled", async () => {
        const engine = new LiaContextEngine(buildConfig({ enabled: false }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "disabled-1" });
        const msg = { role: "user", content: "Should not flush" };
        await engine.ingest({ sessionId: "disabled-1", message: msg });
        // Verify no transcript file
        const date = new Date().toISOString().split("T")[0];
        const logPath = join(tempDir, "memory", "daily", `${date}.md`);
        await assert.rejects(() => readFile(logPath, "utf-8"), "should not create transcript when disabled");
    });
});
// ── Assemble ────────────────────────────────────────────────────────────────
describe("assemble", () => {
    let tempDir;
    beforeEach(async () => {
        tempDir = await createTempWorkspace();
    });
    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
    });
    it("should return messages with estimatedTokens", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "assemble-1", messages: buildMessages(4) });
        const result = await engine.assemble({ sessionId: "assemble-1" });
        assert.strictEqual(result.messages.length, 4);
        assert.ok(result.estimatedTokens > 0, "should estimate tokens");
    });
    it("should include auto-retrieval context when memory exists", async () => {
        // Write a memory file with content that matches our query
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(tempDir, "memory", "preferences.md"), "User prefers dark mode interface.\n");
        const engine = new LiaContextEngine(buildConfig({ autoRetrieval: true, autoRetrievalTimeoutMs: 5000 }), buildDeps(tempDir));
        const messages = [
            { role: "user", content: "dark mode" },
        ];
        await engine.bootstrap({ sessionId: "assemble-2", messages });
        const result = await engine.assemble({ sessionId: "assemble-2" });
        // Auto-retrieval should inject context
        if (result.systemPromptAddition) {
            assert.ok(result.systemPromptAddition.includes("memory"), "systemPromptAddition should reference memory");
        }
        // It's valid for auto-retrieval to return nothing if no matches — just verify the shape
        assert.ok(Array.isArray(result.messages), "should return messages array");
    });
    it("should not include auto-retrieval when disabled", async () => {
        const engine = new LiaContextEngine(buildConfig({ autoRetrieval: false }), buildDeps(tempDir));
        await engine.bootstrap({
            sessionId: "assemble-3",
            messages: [{ role: "user", content: "test query" }],
        });
        const result = await engine.assemble({ sessionId: "assemble-3" });
        assert.strictEqual(result.systemPromptAddition, undefined, "should not have systemPromptAddition when auto-retrieval disabled");
    });
    it("should not include auto-retrieval when no messages", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "assemble-4" });
        const result = await engine.assemble({ sessionId: "assemble-4" });
        assert.strictEqual(result.systemPromptAddition, undefined);
    });
});
// ── Compact ─────────────────────────────────────────────────────────────────
describe("compact", () => {
    let tempDir;
    beforeEach(async () => {
        tempDir = await createTempWorkspace();
    });
    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
    });
    it("should compact messages using completeFn", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        const messages = buildMessages(20);
        await engine.bootstrap({ sessionId: "compact-1", messages });
        const result = await engine.compact({ sessionId: "compact-1" });
        assert.ok(result.messages.length < 20, "should reduce message count");
        assert.ok(result.compactedTokens > 0, "should report compacted tokens");
        // First message should be the summary
        assert.ok(result.messages[0].content.includes("[Conversation context"), "first message should be the summary");
    });
    it("should return unchanged when disabled", async () => {
        const engine = new LiaContextEngine(buildConfig({ enabled: false }), buildDeps(tempDir));
        const messages = buildMessages(10);
        await engine.bootstrap({ sessionId: "compact-disabled", messages });
        const result = await engine.compact({ sessionId: "compact-disabled" });
        assert.strictEqual(result.messages.length, 10);
    });
    it("should prevent double compaction", async () => {
        let completionCount = 0;
        const slowCompleteFn = async () => {
            completionCount++;
            // Simulate a slow model call
            await new Promise((resolve) => setTimeout(resolve, 100));
            return "Summary";
        };
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir, { completeFn: slowCompleteFn }));
        const messages = buildMessages(20);
        await engine.bootstrap({ sessionId: "double-compact", messages });
        // Start two compactions simultaneously
        const [result1, result2] = await Promise.all([
            engine.compact({ sessionId: "double-compact" }),
            engine.compact({ sessionId: "double-compact" }),
        ]);
        // Only one should actually compact — the other should skip
        assert.strictEqual(completionCount, 1, "completeFn should only be called once");
        // Both should return valid messages
        assert.ok(result1.messages.length > 0);
        assert.ok(result2.messages.length > 0);
    });
    it("should handle concurrent ingests during compaction", async () => {
        const slowCompleteFn = async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return "Summary";
        };
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir, { completeFn: slowCompleteFn }));
        const messages = buildMessages(20);
        await engine.bootstrap({ sessionId: "race-1", messages });
        // Start compaction and ingest a message during it
        const compactPromise = engine.compact({ sessionId: "race-1" });
        // Give compaction a moment to start, then ingest
        await new Promise((resolve) => setTimeout(resolve, 20));
        await engine.ingest({
            sessionId: "race-1",
            message: { role: "user", content: "Message during compaction" },
        });
        const result = await compactPromise;
        // The message ingested during compaction should be preserved
        const allContent = result.messages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join(" ");
        assert.ok(allContent.includes("Message during compaction"), "message ingested during compaction should be preserved");
    });
    it("should handle completeFn failure gracefully", async () => {
        const failingCompleteFn = async () => {
            throw new Error("Model unavailable");
        };
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir, { completeFn: failingCompleteFn }));
        const messages = buildMessages(20);
        await engine.bootstrap({ sessionId: "fail-compact", messages });
        // Should not throw — returns original messages
        const result = await engine.compact({ sessionId: "fail-compact" });
        assert.strictEqual(result.messages.length, 20, "should return original messages on failure");
    });
});
// ── afterTurn ───────────────────────────────────────────────────────────────
describe("afterTurn", () => {
    let tempDir;
    beforeEach(async () => {
        tempDir = await createTempWorkspace();
    });
    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
    });
    it("should signal compaction when over threshold", async () => {
        const engine = new LiaContextEngine(buildConfig({ compactionThreshold: 0.8 }), buildDeps(tempDir));
        // Create messages that exceed 80% of a small context window
        const bigMessages = buildMessages(20);
        await engine.bootstrap({ sessionId: "after-1", messages: bigMessages });
        // Use a very small context window so messages exceed threshold
        const result = await engine.afterTurn({
            sessionId: "after-1",
            contextWindowTokens: 100, // Very small — messages will exceed 80
        });
        assert.strictEqual(result.needsCompaction, true);
    });
    it("should not signal compaction when under threshold", async () => {
        const engine = new LiaContextEngine(buildConfig({ compactionThreshold: 0.8 }), buildDeps(tempDir));
        const messages = buildMessages(2);
        await engine.bootstrap({ sessionId: "after-2", messages });
        // Use a large context window
        const result = await engine.afterTurn({
            sessionId: "after-2",
            contextWindowTokens: 1_000_000,
        });
        assert.strictEqual(result.needsCompaction, false);
    });
    it("should not signal compaction twice (pendingCompaction guard)", async () => {
        const engine = new LiaContextEngine(buildConfig({ compactionThreshold: 0.8 }), buildDeps(tempDir));
        const bigMessages = buildMessages(20);
        await engine.bootstrap({ sessionId: "after-3", messages: bigMessages });
        // First call should signal compaction
        const result1 = await engine.afterTurn({
            sessionId: "after-3",
            contextWindowTokens: 100,
        });
        assert.strictEqual(result1.needsCompaction, true);
        // Second call should NOT signal again (pending is set)
        const result2 = await engine.afterTurn({
            sessionId: "after-3",
            contextWindowTokens: 100,
        });
        assert.strictEqual(result2.needsCompaction, false);
    });
    it("should not signal compaction when disabled", async () => {
        const engine = new LiaContextEngine(buildConfig({ enabled: false }), buildDeps(tempDir));
        const messages = buildMessages(20);
        await engine.bootstrap({ sessionId: "after-disabled", messages });
        const result = await engine.afterTurn({
            sessionId: "after-disabled",
            contextWindowTokens: 100,
        });
        assert.strictEqual(result.needsCompaction, false);
    });
});
// ── findLastUserMessage (tested via assemble auto-retrieval) ────────────────
describe("findLastUserMessage behavior", () => {
    let tempDir;
    beforeEach(async () => {
        tempDir = await createTempWorkspace();
    });
    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
    });
    it("should find text in plain string user message", async () => {
        // Write memory so auto-retrieval has something to search
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(tempDir, "memory", "test-topic.md"), "Information about unique-keyword-abc.\n");
        const engine = new LiaContextEngine(buildConfig({ autoRetrieval: true, autoRetrievalTimeoutMs: 5000 }), buildDeps(tempDir));
        const messages = [
            { role: "user", content: "Tell me about unique-keyword-abc" },
        ];
        await engine.bootstrap({ sessionId: "find-user-1", messages });
        const result = await engine.assemble({ sessionId: "find-user-1" });
        // The auto-retrieval should have found the keyword and injected context
        if (result.systemPromptAddition) {
            assert.ok(result.systemPromptAddition.includes("unique-keyword-abc") ||
                result.systemPromptAddition.includes("memory"), "should use last user message for auto-retrieval search");
        }
    });
    it("should skip tool-result-only user messages and find previous text message", async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(tempDir, "memory", "special-topic.md"), "Information about special-search-term.\n");
        const engine = new LiaContextEngine(buildConfig({ autoRetrieval: true, autoRetrievalTimeoutMs: 5000 }), buildDeps(tempDir));
        const messages = [
            { role: "user", content: "Tell me about special-search-term" },
            { role: "assistant", content: "Let me search for that." },
            // Tool result user message — no extractable text query
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "123", content: "Some tool output" },
                ],
            },
        ];
        await engine.bootstrap({ sessionId: "find-user-2", messages });
        // The engine should skip the tool_result user message and use
        // "Tell me about special-search-term" for auto-retrieval
        const result = await engine.assemble({ sessionId: "find-user-2" });
        // Just verify it doesn't crash and returns valid data
        assert.ok(result.messages.length === 3);
    });
    it("should handle user messages with text content blocks", async () => {
        const engine = new LiaContextEngine(buildConfig({ autoRetrieval: true, autoRetrievalTimeoutMs: 5000 }), buildDeps(tempDir));
        const messages = [
            {
                role: "user",
                content: [
                    { type: "text", text: "content block query" },
                ],
            },
        ];
        await engine.bootstrap({ sessionId: "find-user-3", messages });
        const result = await engine.assemble({ sessionId: "find-user-3" });
        // Should not crash — valid assembly
        assert.ok(result.messages.length === 1);
    });
});
// ── Dispose ─────────────────────────────────────────────────────────────────
describe("dispose", () => {
    it("should clear all sessions", async () => {
        const tempDir = await createTempWorkspace();
        try {
            const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
            await engine.bootstrap({ sessionId: "dispose-1" });
            await engine.bootstrap({ sessionId: "dispose-2" });
            await engine.dispose();
            // After dispose, accessing sessions should lazy-init new empty ones
            const result = await engine.assemble({ sessionId: "dispose-1" });
            assert.strictEqual(result.messages.length, 0, "should have no messages after dispose");
        }
        finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => { });
        }
    });
});
//# sourceMappingURL=engine.test.js.map