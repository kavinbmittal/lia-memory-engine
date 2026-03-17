/**
 * Context window compaction engine.
 *
 * Ported from Lia's compact.ts. When the context window gets full,
 * splits messages at midpoint, summarizes the older half with a fast
 * model (Haiku), and replaces them with a structured summary that
 * preserves Q&A structure, decisions, commitments, and emotions.
 *
 * The user never sees this happen — conversations just keep going.
 */

import type { AgentMessage, ContentBlock } from "./types.js";
import { extractContentText } from "./auto-flush.js";

/**
 * The compaction prompt from Lia — optimized for preserving conversational
 * structure rather than just "summarizing." The Q&A log format prevents
 * the agent from re-answering questions it already handled.
 */
export const COMPACTION_PROMPT = `Summarize this conversation history for an AI assistant's context window.

CRITICAL: Preserve the question-answer structure. For each user question, note:
1. What the user asked
2. What you already answered (so you don't re-answer it)

Example format for Q&A:
- User asked about project cost → Already answered: $150K total, 3 installments
- User asked who's on the team → Already answered: Sarah Chen, David Park, Maria Rodriguez, Tom Baker

Also preserve:
- Decisions made (with exact details: numbers, names, dates)
- Commitments and promises (who committed to what, by when)
- Open questions (unanswered asks — things the user asked that have NOT been answered yet)
- User preferences expressed (tone, format, style)
- Emotional context (stress, excitement, frustration)
- Key facts and information shared (documents, data, context)
- Tool actions taken and their results

Be specific. "Discussed report" is useless. "$2.35M Q1 revenue, 15% QoQ growth, bullet format" is useful.

The full raw transcript is saved in memory files. This summary enables the AI to continue
the conversation coherently — exact quotes can be recovered via memory_search if needed.

Write a concise summary with a Q&A log section first, then key facts.`;

const COMPACTION_TIMEOUT_MS = 30_000;

/**
 * Approximate token count from text length (chars / 4).
 * Fast, no API call, good enough for threshold detection (~20% margin).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate token count for a single message, handling content blocks.
 */
function estimateMessageParamTokens(msg: AgentMessage): number {
  if (typeof msg.content === "string") {
    return estimateTokens(msg.content);
  }
  if (Array.isArray(msg.content)) {
    return (msg.content as ContentBlock[]).reduce(
      (sum, block) => {
        if (block.type === "text") return sum + estimateTokens(String(block.text ?? ""));
        if (block.type === "tool_use") return sum + estimateTokens(JSON.stringify(block.input)) + 20;
        if (block.type === "tool_result") {
          const content = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
          return sum + estimateTokens(content);
        }
        // Images, documents — rough estimate
        return sum + 500;
      },
      0
    );
  }
  return 100; // fallback for unknown shapes
}

/**
 * Estimate total token count for an array of messages.
 */
export function estimateMessageTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageParamTokens(msg), 0);
}

/**
 * Compact messages by summarizing the older half with a fast model.
 * Splits at the midpoint (Lia's design), keeping the newer half raw.
 *
 * @param messages - All messages in the session
 * @param completeFn - Model completion function from OpenClaw plugin API
 * @param model - Model to use for summarization (e.g. "anthropic/claude-haiku-4-5")
 * @returns Compacted messages array with summary replacing older messages
 */
export async function compactMessages(
  messages: AgentMessage[],
  completeFn: (model: string, systemPrompt: string, userContent: string) => Promise<string>,
  model: string
): Promise<{
  compactedMessages: AgentMessage[];
  tokensBefore: number;
  tokensAfter: number;
}> {
  const tokensBefore = estimateMessageTokens(messages);

  // Need at least 4 messages to make compaction worthwhile
  if (messages.length < 4) {
    return { compactedMessages: [...messages], tokensBefore, tokensAfter: tokensBefore };
  }

  // Split at midpoint — summarize older half, keep recent half verbatim
  const midpoint = Math.floor(messages.length / 2);

  // Ensure we split on a user message boundary (most APIs require user-first)
  let splitIndex = midpoint;
  while (splitIndex < messages.length && messages[splitIndex].role !== "user") {
    splitIndex++;
  }
  // If we couldn't find a user message after midpoint, try before
  if (splitIndex >= messages.length) {
    splitIndex = midpoint;
    while (splitIndex > 0 && messages[splitIndex].role !== "user") {
      splitIndex--;
    }
  }
  // Edge case: if no valid split found, keep all messages
  if (splitIndex <= 0) {
    return { compactedMessages: [...messages], tokensBefore, tokensAfter: tokensBefore };
  }

  const olderHalf = messages.slice(0, splitIndex);
  const recentHalf = messages.slice(splitIndex);

  // Format older half as readable text for summarization
  const transcript = olderHalf
    .map((msg) => {
      const role = msg.role === "user" ? "User" : "Agent";
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as ContentBlock[]).map((block) => extractContentText(block)).join("\n")
          : "[complex content]";
      return `${role}: ${text}`;
    })
    .join("\n\n");

  // Call the model for summarization
  let summary: string;
  try {
    summary = await completeFn(model, COMPACTION_PROMPT, transcript);
  } catch (err) {
    // If summarization fails, fall back to keeping all messages
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Compaction summarization failed: ${errMsg}`);
  }

  if (!summary || summary.trim().length === 0) {
    summary = "[Summary unavailable]";
  }

  // Build compacted messages: summary as first user message, then recent half
  const summaryMessage: AgentMessage = {
    role: "user",
    content: `[Conversation context — earlier in this session]\n\n${summary}\n\nFull transcript saved in memory — use memory_search for exact details from earlier.`,
  };

  // Need an assistant acknowledgment to maintain valid alternation
  const ackMessage: AgentMessage = {
    role: "assistant",
    content: "Understood, I have the context from earlier in our conversation.",
  };

  const compactedMessages = [summaryMessage, ackMessage, ...recentHalf];
  const tokensAfter = estimateMessageTokens(compactedMessages);

  return { compactedMessages, tokensBefore, tokensAfter };
}
