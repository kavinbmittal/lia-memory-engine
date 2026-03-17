/**
 * Tests for the compaction engine (compact.ts).
 *
 * Covers token estimation, message splitting, summary format,
 * completeFn integration, and edge cases (empty, few messages, failure).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  estimateTokens,
  estimateMessageTokens,
  compactMessages,
  COMPACTION_PROMPT,
} from "../src/compact.js";
import type { AgentMessage, ContentBlock } from "../src/types.js";

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
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },        // 5 chars → ceil(5/4) = 2
      { role: "assistant", content: "world" },    // 5 chars → ceil(5/4) = 2
    ];
    assert.strictEqual(estimateMessageTokens(messages), 4);
  });

  it("should handle messages with text content blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello world" }] as ContentBlock[],
      },
    ];
    // "hello world" = 11 chars → ceil(11/4) = 3
    assert.strictEqual(estimateMessageTokens(messages), 3);
  });

  it("should handle messages with tool_use content blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "search", input: { query: "test" } },
        ] as ContentBlock[],
      },
    ];
    const result = estimateMessageTokens(messages);
    // JSON.stringify({ query: "test" }) = 16 chars → ceil(16/4) = 4, plus 20 overhead
    assert.ok(result > 0, "tool_use blocks should contribute tokens");
  });

  it("should handle messages with tool_result content blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", content: "result text here" },
        ] as ContentBlock[],
      },
    ];
    const result = estimateMessageTokens(messages);
    // "result text here" = 16 chars → ceil(16/4) = 4
    assert.strictEqual(result, 4);
  });

  it("should handle mixed content blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the result" },
          { type: "tool_use", name: "calculate", input: { x: 1 } },
        ] as ContentBlock[],
      },
    ];
    const result = estimateMessageTokens(messages);
    assert.ok(result > 0, "mixed blocks should contribute tokens");
  });

  it("should return 0 for empty messages array", () => {
    assert.strictEqual(estimateMessageTokens([]), 0);
  });

  it("should use fallback (500) for unknown block types like images", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { data: "base64..." } },
        ] as ContentBlock[],
      },
    ];
    assert.strictEqual(estimateMessageTokens(messages), 500);
  });
});

// ── compactMessages ─────────────────────────────────────────────────────────

describe("compactMessages", () => {
  /** Helper to build a sequence of alternating user/assistant messages. */
  function buildMessages(count: number): AgentMessage[] {
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < count; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"x".repeat(50)}`,
      });
    }
    return msgs;
  }

  /** Mock completeFn that returns a predictable summary. */
  const mockCompleteFn = async (
    _model: string,
    _systemPrompt: string,
    _userContent: string
  ): Promise<string> => {
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
      assert.strictEqual(
        result.compactedMessages[2].role,
        "user",
        "first message after summary+ack should be user (split on user boundary)"
      );
    }
  });

  it("should format summary message correctly", async () => {
    const messages = buildMessages(20);
    const result = await compactMessages(messages, mockCompleteFn, "test-model");

    const summaryMsg = result.compactedMessages[0];
    assert.strictEqual(summaryMsg.role, "user", "summary should be a user message");
    assert.ok(typeof summaryMsg.content === "string", "summary content should be a string");
    assert.ok(
      (summaryMsg.content as string).startsWith("[Conversation context — earlier in this session]"),
      "summary should start with the context prefix"
    );
    assert.ok(
      (summaryMsg.content as string).includes("Summary: The user discussed several topics."),
      "summary should include the completeFn result"
    );
    assert.ok(
      (summaryMsg.content as string).includes("Full transcript saved in memory"),
      "summary should include the memory note"
    );
  });

  it("should include assistant ack message after summary", async () => {
    const messages = buildMessages(20);
    const result = await compactMessages(messages, mockCompleteFn, "test-model");

    const ackMsg = result.compactedMessages[1];
    assert.strictEqual(ackMsg.role, "assistant", "ack should be an assistant message");
    assert.ok(
      (ackMsg.content as string).includes("context from earlier"),
      "ack should acknowledge the context"
    );
  });

  it("should call completeFn with correct model and prompt structure", async () => {
    let calledModel: string | undefined;
    let calledSystemPrompt: string | undefined;
    let calledUserContent: string | undefined;

    const spyCompleteFn = async (
      model: string,
      systemPrompt: string,
      userContent: string
    ): Promise<string> => {
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
    assert.ok(calledUserContent!.includes("User:"), "transcript should contain User: labels");
    assert.ok(calledUserContent!.includes("Agent:"), "transcript should contain Agent: labels");
  });

  it("should throw when completeFn fails", async () => {
    const failingCompleteFn = async (): Promise<string> => {
      throw new Error("API timeout");
    };

    const messages = buildMessages(20);
    await assert.rejects(
      () => compactMessages(messages, failingCompleteFn, "test-model"),
      (err: Error) => {
        assert.ok(err.message.includes("Compaction summarization failed"), "error message should mention compaction failure");
        assert.ok(err.message.includes("API timeout"), "error message should include original error");
        return true;
      }
    );
  });

  it("should handle empty summary from completeFn", async () => {
    const emptyCompleteFn = async (): Promise<string> => "";

    const messages = buildMessages(20);
    const result = await compactMessages(messages, emptyCompleteFn, "test-model");

    const summaryMsg = result.compactedMessages[0];
    assert.ok(
      (summaryMsg.content as string).includes("[Summary unavailable]"),
      "should use fallback text when summary is empty"
    );
  });

  it("should handle content blocks in messages during compaction", async () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] as ContentBlock[] },
      { role: "user", content: "Search for something" },
      { role: "assistant", content: [{ type: "tool_use", name: "search", input: { q: "test" } }] as ContentBlock[] },
      { role: "user", content: [{ type: "tool_result", content: "Found it" }] as ContentBlock[] },
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
