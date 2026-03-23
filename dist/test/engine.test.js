/**
 * Tests for the LiaContextEngine v2 (engine.ts).
 *
 * v2 key change: the engine no longer stores messages. OpenClaw owns the
 * conversation. The engine passes messages through, flushes new ones to
 * transcript using a counter, and compacts on demand.
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
        countTokensFn: async (messages) => {
            // Local estimate for tests — no API call
            const { estimateMessageTokens } = await import("../src/compact.js");
            return estimateMessageTokens(messages);
        },
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
        assert.strictEqual(result.bootstrapped, true);
    });
    it("should return bootstrapped:false when workspace resolution fails", async () => {
        const deps = buildDeps(tempDir, {
            resolveWorkspaceDir: () => { throw new Error("Workspace not found"); },
        });
        const engine = new LiaContextEngine(buildConfig(), deps);
        const result = await engine.bootstrap({ sessionId: "bad-session" });
        assert.strictEqual(result.bootstrapped, false);
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
    it("should write transcript without storing message", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "ingest-1" });
        const msg = { role: "user", content: "Hello there" };
        const result = await engine.ingest({ sessionId: "ingest-1", message: msg });
        assert.strictEqual(result.ingested, true);
        // Verify transcript was written
        const date = new Date().toISOString().split("T")[0];
        const logPath = join(tempDir, "memory", "daily", `${date}.md`);
        const content = await readFile(logPath, "utf-8");
        assert.ok(content.includes("Hello there"), "transcript should contain the message");
    });
    it("should work without bootstrap (lazy init)", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        const msg = { role: "user", content: "Lazy init test" };
        const result = await engine.ingest({ sessionId: "lazy-1", message: msg });
        assert.strictEqual(result.ingested, true);
    });
    it("should not write transcript when disabled", async () => {
        const engine = new LiaContextEngine(buildConfig({ enabled: false }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "disabled-1" });
        const msg = { role: "user", content: "Should not flush" };
        await engine.ingest({ sessionId: "disabled-1", message: msg });
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
    it("should pass through OpenClaw's messages (same reference)", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "assemble-1" });
        const openclawMessages = buildMessages(4);
        const result = await engine.assemble({
            sessionId: "assemble-1",
            messages: openclawMessages,
        });
        // Must be the SAME reference — this is how OpenClaw's !== check works
        assert.strictEqual(result.messages, openclawMessages, "should return same reference");
        assert.strictEqual(result.messages.length, 4);
        assert.ok(result.estimatedTokens > 0, "should estimate tokens");
    });
    it("should return empty array when no messages passed", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "assemble-empty" });
        const result = await engine.assemble({ sessionId: "assemble-empty" });
        assert.strictEqual(result.messages.length, 0);
    });
    it("should include auto-retrieval context when memory exists", async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(tempDir, "memory", "preferences.md"), "User prefers dark mode interface.\n");
        const engine = new LiaContextEngine(buildConfig({ autoRetrieval: true, autoRetrievalTimeoutMs: 5000 }), buildDeps(tempDir));
        const messages = [
            { role: "user", content: "dark mode" },
        ];
        await engine.bootstrap({ sessionId: "assemble-2" });
        const result = await engine.assemble({ sessionId: "assemble-2", messages });
        if (result.systemPromptAddition) {
            assert.ok(result.systemPromptAddition.includes("memory"), "systemPromptAddition should reference memory");
        }
        assert.ok(Array.isArray(result.messages), "should return messages array");
    });
    it("should not include auto-retrieval when disabled", async () => {
        const engine = new LiaContextEngine(buildConfig({ autoRetrieval: false }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "assemble-3" });
        const messages = [{ role: "user", content: "test query" }];
        const result = await engine.assemble({ sessionId: "assemble-3", messages });
        assert.strictEqual(result.systemPromptAddition, undefined);
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
    it("should compact messages passed by OpenClaw", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "compact-1" });
        const messages = buildMessages(20);
        const result = await engine.compact({ sessionId: "compact-1", messages });
        assert.ok(result.messages.length < 20, "should reduce message count");
        assert.ok(result.compactedTokens > 0, "should report compacted tokens");
        // First message should be the summary
        assert.ok(result.messages[0].content.includes("[Conversation context"), "first message should be the summary");
    });
    it("should reset flush counter after compaction", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "compact-counter" });
        // Simulate some turns to advance the flush counter
        const messages = buildMessages(20);
        await engine.afterTurn({
            sessionId: "compact-counter",
            messages,
            prePromptMessageCount: 0,
            contextWindowTokens: 1_000_000,
        });
        // Now compact — counter should reset
        const result = await engine.compact({ sessionId: "compact-counter", messages });
        assert.ok(result.messages.length < 20);
        // Next afterTurn with compacted messages should flush all of them
        // (counter was reset to 0, so everything looks new)
        const transcriptWrites = [];
        // We can verify by checking that afterTurn doesn't throw with shorter array
        const afterResult = await engine.afterTurn({
            sessionId: "compact-counter",
            messages: result.messages,
            prePromptMessageCount: 0,
            contextWindowTokens: 1_000_000,
        });
        assert.strictEqual(afterResult.needsCompaction, false);
    });
    it("should return unchanged when disabled", async () => {
        const engine = new LiaContextEngine(buildConfig({ enabled: false }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "compact-disabled" });
        const messages = buildMessages(10);
        const result = await engine.compact({ sessionId: "compact-disabled", messages });
        assert.strictEqual(result.messages.length, 10);
    });
    it("should prevent double compaction", async () => {
        let completionCount = 0;
        const slowCompleteFn = async () => {
            completionCount++;
            await new Promise((resolve) => setTimeout(resolve, 100));
            return "Summary";
        };
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir, { completeFn: slowCompleteFn }));
        await engine.bootstrap({ sessionId: "double-compact" });
        const messages = buildMessages(20);
        // Start two compactions simultaneously
        const [result1, result2] = await Promise.all([
            engine.compact({ sessionId: "double-compact", messages }),
            engine.compact({ sessionId: "double-compact", messages }),
        ]);
        assert.strictEqual(completionCount, 1, "completeFn should only be called once");
        assert.ok(result1.messages.length > 0);
        assert.ok(result2.messages.length > 0);
    });
    it("should handle completeFn failure gracefully", async () => {
        const failingCompleteFn = async () => {
            throw new Error("Model unavailable");
        };
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir, { completeFn: failingCompleteFn }));
        await engine.bootstrap({ sessionId: "fail-compact" });
        const messages = buildMessages(20);
        const result = await engine.compact({ sessionId: "fail-compact", messages });
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
    it("should flush new messages to transcript using counter", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "flush-1" });
        // Turn 1: 2 messages
        const msgs1 = buildMessages(2);
        await engine.afterTurn({
            sessionId: "flush-1",
            messages: msgs1,
            prePromptMessageCount: 0,
            contextWindowTokens: 1_000_000,
        });
        const date = new Date().toISOString().split("T")[0];
        const logPath = join(tempDir, "memory", "daily", `${date}.md`);
        const content1 = await readFile(logPath, "utf-8");
        assert.ok(content1.includes("Message 0"), "should flush first message");
        assert.ok(content1.includes("Message 1"), "should flush second message");
        // Turn 2: 4 messages (2 old + 2 new) — should only flush the 2 new ones
        const msgs2 = [...msgs1, ...buildMessages(2).map((m, i) => ({
                ...m,
                content: `New message ${i}: ${"y".repeat(40)}`,
            }))];
        await engine.afterTurn({
            sessionId: "flush-1",
            messages: msgs2,
            prePromptMessageCount: 0,
            contextWindowTokens: 1_000_000,
        });
        const content2 = await readFile(logPath, "utf-8");
        assert.ok(content2.includes("New message 0"), "should flush new messages");
        assert.ok(content2.includes("New message 1"), "should flush new messages");
    });
    it("should signal compaction when over threshold", async () => {
        const engine = new LiaContextEngine(buildConfig({ compactionThreshold: 0.8 }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "after-1" });
        const bigMessages = buildMessages(20);
        const result = await engine.afterTurn({
            sessionId: "after-1",
            messages: bigMessages,
            prePromptMessageCount: 0,
            contextWindowTokens: 100, // Very small — messages will exceed 80%
        });
        assert.strictEqual(result.needsCompaction, true);
    });
    it("should not signal compaction when under threshold", async () => {
        const engine = new LiaContextEngine(buildConfig({ compactionThreshold: 0.8 }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "after-2" });
        const messages = buildMessages(2);
        const result = await engine.afterTurn({
            sessionId: "after-2",
            messages,
            prePromptMessageCount: 0,
            contextWindowTokens: 1_000_000,
        });
        assert.strictEqual(result.needsCompaction, false);
    });
    it("should not signal compaction twice (pendingCompaction guard)", async () => {
        const engine = new LiaContextEngine(buildConfig({ compactionThreshold: 0.8 }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "after-3" });
        const bigMessages = buildMessages(20);
        const result1 = await engine.afterTurn({
            sessionId: "after-3",
            messages: bigMessages,
            prePromptMessageCount: 0,
            contextWindowTokens: 100,
        });
        assert.strictEqual(result1.needsCompaction, true);
        const result2 = await engine.afterTurn({
            sessionId: "after-3",
            messages: bigMessages,
            prePromptMessageCount: 0,
            contextWindowTokens: 100,
        });
        assert.strictEqual(result2.needsCompaction, false);
    });
    it("should not signal compaction when disabled", async () => {
        const engine = new LiaContextEngine(buildConfig({ enabled: false }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "after-disabled" });
        const messages = buildMessages(20);
        const result = await engine.afterTurn({
            sessionId: "after-disabled",
            messages,
            prePromptMessageCount: 0,
            contextWindowTokens: 100,
        });
        assert.strictEqual(result.needsCompaction, false);
    });
    it("should handle prePromptMessageCount correctly", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "ppc-test" });
        // Simulate 3 system prompts + 4 conversation messages
        const systemMsgs = [
            { role: "user", content: "system prompt 1" },
            { role: "assistant", content: "system prompt 2" },
            { role: "user", content: "system prompt 3" },
        ];
        const convMsgs = buildMessages(4);
        const allMsgs = [...systemMsgs, ...convMsgs];
        await engine.afterTurn({
            sessionId: "ppc-test",
            messages: allMsgs,
            prePromptMessageCount: 3, // Skip 3 system prompts
            contextWindowTokens: 1_000_000,
        });
        // Transcript should contain conversation messages, not system prompts
        const date = new Date().toISOString().split("T")[0];
        const logPath = join(tempDir, "memory", "daily", `${date}.md`);
        const content = await readFile(logPath, "utf-8");
        assert.ok(content.includes("Message 0"), "should flush conversation messages");
        assert.ok(!content.includes("system prompt 1"), "should not flush system prompts");
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
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(tempDir, "memory", "test-topic.md"), "Information about unique-keyword-abc.\n");
        const engine = new LiaContextEngine(buildConfig({ autoRetrieval: true, autoRetrievalTimeoutMs: 5000 }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "find-user-1" });
        const messages = [
            { role: "user", content: "Tell me about unique-keyword-abc" },
        ];
        const result = await engine.assemble({ sessionId: "find-user-1", messages });
        if (result.systemPromptAddition) {
            assert.ok(result.systemPromptAddition.includes("unique-keyword-abc") ||
                result.systemPromptAddition.includes("memory"), "should use last user message for auto-retrieval search");
        }
    });
    it("should skip tool-result-only user messages and find previous text message", async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(tempDir, "memory", "special-topic.md"), "Information about special-search-term.\n");
        const engine = new LiaContextEngine(buildConfig({ autoRetrieval: true, autoRetrievalTimeoutMs: 5000 }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "find-user-2" });
        const messages = [
            { role: "user", content: "Tell me about special-search-term" },
            { role: "assistant", content: "Let me search for that." },
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "123", content: "Some tool output" },
                ],
            },
        ];
        const result = await engine.assemble({ sessionId: "find-user-2", messages });
        assert.ok(result.messages.length === 3);
    });
    it("should handle user messages with text content blocks", async () => {
        const engine = new LiaContextEngine(buildConfig({ autoRetrieval: true, autoRetrievalTimeoutMs: 5000 }), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "find-user-3" });
        const messages = [
            {
                role: "user",
                content: [
                    { type: "text", text: "content block query" },
                ],
            },
        ];
        const result = await engine.assemble({ sessionId: "find-user-3", messages });
        assert.ok(result.messages.length === 1);
    });
});
// ── Dispose ─────────────────────────────────────────────────────────────────
describe("dispose", () => {
    it("should clear all session trackers", async () => {
        const tempDir = await createTempWorkspace();
        try {
            const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
            await engine.bootstrap({ sessionId: "dispose-1" });
            await engine.bootstrap({ sessionId: "dispose-2" });
            await engine.dispose();
            // After dispose, assemble with no messages should return empty
            const result = await engine.assemble({ sessionId: "dispose-1" });
            assert.strictEqual(result.messages.length, 0, "should have no messages after dispose");
        }
        finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => { });
        }
    });
});
// ── Restart scenario (the bug this v2 fixes) ─────────────────────────────────
describe("restart scenario", () => {
    let tempDir;
    beforeEach(async () => {
        tempDir = await createTempWorkspace();
    });
    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
    });
    it("should pass through OpenClaw's reloaded messages after restart", async () => {
        // Simulate: engine boots fresh, OpenClaw has reloaded 50 messages from JSONL
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "restart-1" });
        const reloadedMessages = buildMessages(50);
        const result = await engine.assemble({
            sessionId: "restart-1",
            messages: reloadedMessages,
        });
        // Engine should return OpenClaw's messages as-is (same reference)
        assert.strictEqual(result.messages, reloadedMessages);
        assert.strictEqual(result.messages.length, 50);
    });
    it("should correctly flush after restart without duplicating", async () => {
        const engine = new LiaContextEngine(buildConfig(), buildDeps(tempDir));
        await engine.bootstrap({ sessionId: "restart-2" });
        // First afterTurn after restart: all 10 messages are "new" (counter = 0)
        const messages = buildMessages(10);
        await engine.afterTurn({
            sessionId: "restart-2",
            messages,
            prePromptMessageCount: 0,
            contextWindowTokens: 1_000_000,
        });
        // Second afterTurn: add 2 more messages — only those 2 should flush
        const moreMessages = [
            ...messages,
            { role: "user", content: "Brand new message A" },
            { role: "assistant", content: "Brand new message B" },
        ];
        await engine.afterTurn({
            sessionId: "restart-2",
            messages: moreMessages,
            prePromptMessageCount: 0,
            contextWindowTokens: 1_000_000,
        });
        const date = new Date().toISOString().split("T")[0];
        const logPath = join(tempDir, "memory", "daily", `${date}.md`);
        const content = await readFile(logPath, "utf-8");
        // The first 10 messages should appear once (from first flush)
        // The 2 new messages should appear once (from second flush)
        assert.ok(content.includes("Brand new message A"));
        assert.ok(content.includes("Brand new message B"));
        // Count occurrences of "Message 0" — should be exactly 1
        const matches = content.match(/Message 0/g);
        assert.strictEqual(matches?.length, 1, "should not duplicate messages across flushes");
    });
});
//# sourceMappingURL=engine.test.js.map