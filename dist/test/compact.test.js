/**
 * Tests for the compaction engine (compact.ts).
 *
 * Covers token estimation, message splitting, summary format,
 * completeFn integration, and edge cases (empty, few messages, failure).
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { estimateTokens, estimateMessageTokens, compactMessages, chunkMessages, COMPACTION_PROMPT, } from "../src/compact.js";
// ── estimateTokens ──────────────────────────────────────────────────────────
describe("estimateTokens", () => {
    it("should estimate tokens as ceil(length / 4)", () => {
        // 12 chars → ceil(12/4) = 3
        assert.strictEqual(estimateTokens("hello world!"), 3);
    });
    it("should return 0 for an empty string", () => {
        assert.strictEqual(estimateTokens(""), 0);
    });
    it("should handle single character", () => {
        // 1 char → ceil(1/4) = 1
        assert.strictEqual(estimateTokens("a"), 1);
    });
    it("should handle longer text", () => {
        const text = "a".repeat(100);
        assert.strictEqual(estimateTokens(text), 25);
    });
});
// ── estimateMessageTokens ───────────────────────────────────────────────────
describe("estimateMessageTokens", () => {
    it("should sum tokens for messages with string content", () => {
        const messages = [
            { role: "user", content: "hello" }, // 5 chars → ceil(5/4) = 2
            { role: "assistant", content: "world" }, // 5 chars → ceil(5/4) = 2
        ];
        assert.strictEqual(estimateMessageTokens(messages), 4);
    });
    it("should handle messages with text content blocks", () => {
        const messages = [
            {
                role: "user",
                content: [{ type: "text", text: "hello world" }],
            },
        ];
        // "hello world" = 11 chars → ceil(11/4) = 3
        assert.strictEqual(estimateMessageTokens(messages), 3);
    });
    it("should handle messages with tool_use content blocks", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "tool_use", name: "search", input: { query: "test" } },
                ],
            },
        ];
        const result = estimateMessageTokens(messages);
        // JSON.stringify({ query: "test" }) = 16 chars → ceil(16/4) = 4, plus 20 overhead
        assert.ok(result > 0, "tool_use blocks should contribute tokens");
    });
    it("should handle messages with tool_result content blocks", () => {
        const messages = [
            {
                role: "user",
                content: [
                    { type: "tool_result", content: "result text here" },
                ],
            },
        ];
        const result = estimateMessageTokens(messages);
        // "result text here" = 16 chars → ceil(16/4) = 4
        assert.strictEqual(result, 4);
    });
    it("should handle mixed content blocks", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Here is the result" },
                    { type: "tool_use", name: "calculate", input: { x: 1 } },
                ],
            },
        ];
        const result = estimateMessageTokens(messages);
        assert.ok(result > 0, "mixed blocks should contribute tokens");
    });
    it("should return 0 for empty messages array", () => {
        assert.strictEqual(estimateMessageTokens([]), 0);
    });
    it("should use fallback (500) for unknown block types like images", () => {
        const messages = [
            {
                role: "user",
                content: [
                    { type: "image", source: { data: "base64..." } },
                ],
            },
        ];
        assert.strictEqual(estimateMessageTokens(messages), 500);
    });
});
// ── compactMessages ─────────────────────────────────────────────────────────
describe("compactMessages", () => {
    /** Helper to build a sequence of alternating user/assistant messages. */
    function buildMessages(count) {
        const msgs = [];
        for (let i = 0; i < count; i++) {
            msgs.push({
                role: i % 2 === 0 ? "user" : "assistant",
                content: `Message ${i}: ${"x".repeat(50)}`,
            });
        }
        return msgs;
    }
    /** Mock completeFn that returns a predictable summary. */
    const mockCompleteFn = async (_model, _systemPrompt, _userContent) => {
        return "Summary: The user discussed several topics.";
    };
    it("should compact 20 messages using midpoint split", async () => {
        const messages = buildMessages(20);
        const result = await compactMessages(messages, mockCompleteFn, "test-model");
        // Should have summary + ack + recent messages
        assert.ok(result.compactedMessages.length < messages.length, "compacted should have fewer messages");
        assert.ok(result.compactedMessages.length > 2, "should have at least summary + ack + some messages");
        assert.ok(result.tokensAfter < result.tokensBefore, "tokens should decrease after compaction");
    });
    it("should compact even with few messages using midpoint split", async () => {
        const messages = buildMessages(6);
        const result = await compactMessages(messages, mockCompleteFn, "test-model");
        // 6 messages → midpoint at 3, splits and summarizes older half
        assert.ok(result.compactedMessages.length > 0, "should return some messages");
    });
    it("should return unchanged for fewer than 4 messages", async () => {
        const messages = buildMessages(3);
        const result = await compactMessages(messages, mockCompleteFn, "test-model");
        assert.strictEqual(result.compactedMessages.length, 3);
        assert.strictEqual(result.tokensBefore, result.tokensAfter);
    });
    it("should return unchanged for empty messages", async () => {
        const result = await compactMessages([], mockCompleteFn, "test-model");
        assert.strictEqual(result.compactedMessages.length, 0);
        assert.strictEqual(result.tokensBefore, 0);
        assert.strictEqual(result.tokensAfter, 0);
    });
    it("should split on user message boundary", async () => {
        const messages = buildMessages(20);
        const result = await compactMessages(messages, mockCompleteFn, "test-model");
        // The third message (index 2, after summary and ack) should be a user message
        // because the split happens at a user message boundary
        if (result.compactedMessages.length > 2) {
            assert.strictEqual(result.compactedMessages[2].role, "user", "first message after summary+ack should be user (split on user boundary)");
        }
    });
    it("should format summary message correctly", async () => {
        const messages = buildMessages(20);
        const result = await compactMessages(messages, mockCompleteFn, "test-model");
        const summaryMsg = result.compactedMessages[0];
        assert.strictEqual(summaryMsg.role, "user", "summary should be a user message");
        assert.ok(typeof summaryMsg.content === "string", "summary content should be a string");
        assert.ok(summaryMsg.content.startsWith("[Conversation context — earlier in this session]"), "summary should start with the context prefix");
        assert.ok(summaryMsg.content.includes("Summary: The user discussed several topics."), "summary should include the completeFn result");
        assert.ok(summaryMsg.content.includes("Full transcript saved in memory"), "summary should include the memory note");
    });
    it("should include assistant ack message after summary", async () => {
        const messages = buildMessages(20);
        const result = await compactMessages(messages, mockCompleteFn, "test-model");
        const ackMsg = result.compactedMessages[1];
        assert.strictEqual(ackMsg.role, "assistant", "ack should be an assistant message");
        assert.ok(ackMsg.content.includes("context from earlier"), "ack should acknowledge the context");
    });
    it("should call completeFn with correct model and prompt structure", async () => {
        let calledModel;
        let calledSystemPrompt;
        let calledUserContent;
        const spyCompleteFn = async (model, systemPrompt, userContent) => {
            calledModel = model;
            calledSystemPrompt = systemPrompt;
            calledUserContent = userContent;
            return "Test summary";
        };
        const messages = buildMessages(20);
        await compactMessages(messages, spyCompleteFn, "haiku-model");
        assert.strictEqual(calledModel, "haiku-model", "should pass the model to completeFn");
        assert.strictEqual(calledSystemPrompt, COMPACTION_PROMPT, "should use COMPACTION_PROMPT as system prompt");
        assert.ok(calledUserContent, "should pass transcript as user content");
        assert.ok(calledUserContent.includes("User:"), "transcript should contain User: labels");
        assert.ok(calledUserContent.includes("Agent:"), "transcript should contain Agent: labels");
    });
    it("should throw when completeFn fails", async () => {
        const failingCompleteFn = async () => {
            throw new Error("API timeout");
        };
        const messages = buildMessages(20);
        await assert.rejects(() => compactMessages(messages, failingCompleteFn, "test-model"), (err) => {
            assert.ok(err.message.includes("Compaction summarization failed"), "error message should mention compaction failure");
            assert.ok(err.message.includes("API timeout"), "error message should include original error");
            return true;
        });
    });
    it("should handle empty summary from completeFn", async () => {
        const emptyCompleteFn = async () => "";
        const messages = buildMessages(20);
        const result = await compactMessages(messages, emptyCompleteFn, "test-model");
        const summaryMsg = result.compactedMessages[0];
        assert.ok(summaryMsg.content.includes("[Summary unavailable]"), "should use fallback text when summary is empty");
    });
    it("should handle content blocks in messages during compaction", async () => {
        const messages = [
            { role: "user", content: "Hello" },
            { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
            { role: "user", content: "Search for something" },
            { role: "assistant", content: [{ type: "tool_use", name: "search", input: { q: "test" } }] },
            { role: "user", content: [{ type: "tool_result", content: "Found it" }] },
            { role: "assistant", content: "Great, here's the result" },
            { role: "user", content: "Thanks" },
            { role: "assistant", content: "You're welcome" },
            { role: "user", content: "Another question" },
            { role: "assistant", content: "Another answer" },
        ];
        const result = await compactMessages(messages, mockCompleteFn, "test-model");
        assert.ok(result.compactedMessages.length > 0, "should produce compacted messages");
    });
});
// ── chunkMessages ────────────────────────────────────────────────────────────
describe("chunkMessages", () => {
    /** Build messages where each message is approximately `charsPerMsg` characters. */
    function buildLargeMessages(count, charsPerMsg) {
        const msgs = [];
        for (let i = 0; i < count; i++) {
            msgs.push({
                role: i % 2 === 0 ? "user" : "assistant",
                content: `Message ${i}: ${"x".repeat(charsPerMsg)}`,
            });
        }
        return msgs;
    }
    it("should return 1 chunk for messages under 150k tokens", async () => {
        // 20 messages × 60 chars each = 1200 chars → ~300 tokens, well under 150k
        const messages = buildLargeMessages(20, 50);
        const chunks = await chunkMessages(messages);
        assert.strictEqual(chunks.length, 1);
        assert.strictEqual(chunks[0].length, 20);
    });
    it("should return empty array for empty input", async () => {
        const chunks = await chunkMessages([]);
        assert.strictEqual(chunks.length, 0);
    });
    it("should split into multiple chunks when exceeding 150k tokens", async () => {
        // 150k tokens = 600k chars. Create messages totaling ~900k chars → should be 2+ chunks
        // 100 messages × 9000 chars each = 900k chars → ~225k tokens → 2 chunks
        const messages = buildLargeMessages(100, 9000);
        const chunks = await chunkMessages(messages);
        assert.ok(chunks.length >= 2, `expected 2+ chunks, got ${chunks.length}`);
    });
    it("should split at user message boundaries", async () => {
        // Each chunk should start with a user message (index 0 of each chunk)
        const messages = buildLargeMessages(100, 9000);
        const chunks = await chunkMessages(messages);
        for (let i = 0; i < chunks.length; i++) {
            assert.strictEqual(chunks[i][0].role, "user", `chunk ${i} should start with a user message`);
        }
    });
    it("should keep user-assistant turn pairs together", async () => {
        // With alternating user/assistant, no chunk should end with a user message
        // (the assistant response should always follow)
        const messages = buildLargeMessages(100, 9000);
        const chunks = await chunkMessages(messages);
        for (let i = 0; i < chunks.length - 1; i++) {
            const lastMsg = chunks[i][chunks[i].length - 1];
            assert.strictEqual(lastMsg.role, "assistant", `chunk ${i} should end with an assistant message (turn pair intact)`);
        }
    });
    it("should handle a single oversized message", async () => {
        // One message that exceeds 150k tokens — should still produce 1 chunk
        const messages = [
            { role: "user", content: "x".repeat(700_000) }, // ~175k tokens
        ];
        const chunks = await chunkMessages(messages);
        assert.strictEqual(chunks.length, 1, "single message can't be split further");
    });
});
// ── multi-chunk compaction ──────────────────────────────────────────────────
describe("multi-chunk compactMessages", () => {
    it("should call completeFn multiple times for large conversations", async () => {
        let callCount = 0;
        const countingCompleteFn = async (_model, _systemPrompt, _userContent) => {
            callCount++;
            return `Summary for call ${callCount}`;
        };
        // Create messages totaling >150k tokens in the older half
        // 200 messages × 4000 chars = 800k chars → ~200k tokens
        // Midpoint = 100 messages → older half ~100k tokens... need more
        // 400 messages × 4000 chars = 1.6M chars → ~400k tokens → older half ~200k tokens → 2 chunks
        const msgs = [];
        for (let i = 0; i < 400; i++) {
            msgs.push({
                role: i % 2 === 0 ? "user" : "assistant",
                content: `Message ${i}: ${"x".repeat(4000)}`,
            });
        }
        const result = await compactMessages(msgs, countingCompleteFn, "test-model");
        assert.ok(callCount >= 2, `expected 2+ completeFn calls for chunked compaction, got ${callCount}`);
        assert.ok(result.compactedMessages.length > 0);
    });
    it("should include part N of M in chunk prompts", async () => {
        const prompts = [];
        const capturingCompleteFn = async (_model, systemPrompt, _userContent) => {
            prompts.push(systemPrompt);
            return "chunk summary";
        };
        const msgs = [];
        for (let i = 0; i < 400; i++) {
            msgs.push({
                role: i % 2 === 0 ? "user" : "assistant",
                content: `Message ${i}: ${"x".repeat(4000)}`,
            });
        }
        await compactMessages(msgs, capturingCompleteFn, "test-model");
        // Multi-chunk prompts should contain "part N of M"
        assert.ok(prompts.length >= 2, "should have multiple prompts");
        for (let i = 0; i < prompts.length; i++) {
            assert.ok(prompts[i].includes(`part ${i + 1} of ${prompts.length}`), `prompt ${i} should contain "part ${i + 1} of ${prompts.length}"`);
        }
    });
    it("should combine chunk summaries with part markers", async () => {
        let callCount = 0;
        const multiCompleteFn = async () => {
            callCount++;
            return `Summary content for chunk ${callCount}`;
        };
        const msgs = [];
        for (let i = 0; i < 400; i++) {
            msgs.push({
                role: i % 2 === 0 ? "user" : "assistant",
                content: `Message ${i}: ${"x".repeat(4000)}`,
            });
        }
        const result = await compactMessages(msgs, multiCompleteFn, "test-model");
        const summaryContent = result.compactedMessages[0].content;
        assert.ok(summaryContent.includes("Part 1 of"), "should contain Part 1 marker");
        assert.ok(summaryContent.includes("Part 2 of"), "should contain Part 2 marker");
        assert.ok(summaryContent.includes("Summary content for chunk 1"), "should contain chunk 1 summary");
        assert.ok(summaryContent.includes("Summary content for chunk 2"), "should contain chunk 2 summary");
    });
    it("should fail entirely if any chunk fails", async () => {
        let callCount = 0;
        const failOnSecondCompleteFn = async () => {
            callCount++;
            if (callCount === 2)
                throw new Error("Rate limited");
            return "chunk summary";
        };
        const msgs = [];
        for (let i = 0; i < 400; i++) {
            msgs.push({
                role: i % 2 === 0 ? "user" : "assistant",
                content: `Message ${i}: ${"x".repeat(4000)}`,
            });
        }
        await assert.rejects(() => compactMessages(msgs, failOnSecondCompleteFn, "test-model"), (err) => {
            assert.ok(err.message.includes("chunk 2 of"), "error should name the failed chunk");
            assert.ok(err.message.includes("Rate limited"), "error should include original message");
            return true;
        });
    });
    it("should produce identical output for single-chunk conversations", async () => {
        const mockFn = async () => "Single summary";
        // Small conversation — should use single-chunk path
        const msgs = [];
        for (let i = 0; i < 20; i++) {
            msgs.push({
                role: i % 2 === 0 ? "user" : "assistant",
                content: `Message ${i}: ${"x".repeat(50)}`,
            });
        }
        const result = await compactMessages(msgs, mockFn, "test-model");
        const summaryContent = result.compactedMessages[0].content;
        // Single chunk should NOT have part markers
        assert.ok(!summaryContent.includes("Part 1 of"), "single-chunk should not have part markers");
        assert.ok(summaryContent.includes("Single summary"), "should contain the summary");
    });
});
//# sourceMappingURL=compact.test.js.map