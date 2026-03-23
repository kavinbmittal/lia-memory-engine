/**
 * Context window compaction engine.
 *
 * Ported from Lia's compact.ts. When the context window gets full,
 * splits messages at midpoint, summarizes the older half with a fast
 * model (Haiku), and replaces them with a structured summary that
 * preserves Q&A structure, decisions, commitments, and emotions.
 *
 * When the older half exceeds the model's context limit (200k tokens for
 * Haiku), it's split into chunks at user message boundaries. Each chunk
 * is summarized separately, then the summaries are combined chronologically.
 *
 * The user never sees this happen — conversations just keep going.
 */
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
/** Max tokens per chunk — 150k leaves 50k buffer for system prompt + output within Haiku's 200k limit. */
// See DECISIONS.md — compaction chunk size
const MAX_CHUNK_TOKENS = 150_000;
/**
 * Approximate token count from text length (chars / 4).
 * Fast, no API call, good enough for threshold detection (~20% margin).
 */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/**
 * Estimate token count for a single message, handling content blocks.
 */
function estimateMessageParamTokens(msg) {
    if (typeof msg.content === "string") {
        return estimateTokens(msg.content);
    }
    if (Array.isArray(msg.content)) {
        return msg.content.reduce((sum, block) => {
            if (block.type === "text")
                return sum + estimateTokens(String(block.text ?? ""));
            if (block.type === "tool_use")
                return sum + estimateTokens(JSON.stringify(block.input)) + 20;
            if (block.type === "tool_result") {
                const content = typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content);
                return sum + estimateTokens(content);
            }
            // Images, documents — rough estimate
            return sum + 500;
        }, 0);
    }
    return 100; // fallback for unknown shapes
}
/**
 * Estimate total token count for an array of messages.
 */
export function estimateMessageTokens(messages) {
    return messages.reduce((sum, msg) => sum + estimateMessageParamTokens(msg), 0);
}
/**
 * Format a message into readable text for summarization.
 */
function formatMessageText(msg) {
    const role = msg.role === "user" ? "User" : "Agent";
    const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
            ? msg.content.map((block) => extractContentText(block)).join("\n")
            : "[complex content]";
    return `${role}: ${text}`;
}
/**
 * Split messages into chunks that each fit within MAX_CHUNK_TOKENS.
 * Always splits at user message boundaries so turn pairs stay together.
 * Uses the provided countTokensFn for accurate token counts.
 * Exported for testing.
 */
export async function chunkMessages(messages, countTokensFn) {
    if (messages.length === 0)
        return [];
    // Use API-based counting if available, otherwise fall back to local estimate
    const countFn = countTokensFn ?? ((msgs) => Promise.resolve(estimateMessageTokens(msgs)));
    const chunks = [];
    let currentChunk = [];
    let currentTokens = 0;
    for (const msg of messages) {
        const msgTokens = await countFn([msg]);
        // If adding this message would exceed the limit and the chunk isn't empty,
        // start a new chunk — but only split at user message boundaries.
        if (currentTokens + msgTokens > MAX_CHUNK_TOKENS && currentChunk.length > 0 && msg.role === "user") {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }
        currentChunk.push(msg);
        currentTokens += msgTokens;
    }
    // Don't forget the last chunk
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }
    return chunks;
}
/**
 * Format a chunk of messages into a transcript string for summarization.
 * If the transcript exceeds MAX_CHUNK_TOKENS, truncate it to fit — this
 * handles the edge case where a single turn is larger than the limit.
 */
function formatChunkTranscript(messages) {
    const transcript = messages.map(formatMessageText).join("\n\n");
    const tokens = estimateTokens(transcript);
    if (tokens <= MAX_CHUNK_TOKENS)
        return transcript;
    // Truncate to fit — single oversized turn edge case
    const maxChars = MAX_CHUNK_TOKENS * 4; // reverse of estimateTokens (chars/4)
    return transcript.slice(0, maxChars) + "\n\n[... content truncated to fit context limit]";
}
/**
 * Compact messages by summarizing the older half with a fast model.
 * Splits at the midpoint (Lia's design), keeping the newer half raw.
 *
 * When the older half exceeds MAX_CHUNK_TOKENS, it's split into chunks
 * and each chunk is summarized separately. The summaries are combined
 * chronologically into a single summary message.
 *
 * @param messages - All messages in the session
 * @param completeFn - Model completion function from OpenClaw plugin API
 * @param model - Model to use for summarization (e.g. "anthropic/claude-haiku-4-5")
 * @returns Compacted messages array with summary replacing older messages
 */
export async function compactMessages(messages, completeFn, model, countTokensFn) {
    const countFn = countTokensFn ?? ((msgs) => Promise.resolve(estimateMessageTokens(msgs)));
    const tokensBefore = await countFn(messages);
    // Need at least 4 messages to make compaction worthwhile
    if (messages.length < 4) {
        return { compactedMessages: [...messages], tokensBefore, tokensAfter: tokensBefore };
    }
    // Split at midpoint — summarize older half, keep recent half verbatim
    // Note: midpoint logic uses message count, not tokens — no API call needed here
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
    // Split older half into chunks that fit within the model's context limit
    const chunks = await chunkMessages(olderHalf, countTokensFn);
    let summary;
    if (chunks.length === 1) {
        // Single chunk — same flow as before
        const transcript = formatChunkTranscript(chunks[0]);
        try {
            summary = await completeFn(model, COMPACTION_PROMPT, transcript);
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            throw new Error(`Compaction summarization failed: ${errMsg}`);
        }
    }
    else {
        // Multi-chunk — summarize each chunk sequentially, then combine
        const chunkSummaries = [];
        for (let i = 0; i < chunks.length; i++) {
            const transcript = formatChunkTranscript(chunks[i]);
            const chunkPrompt = `${COMPACTION_PROMPT}\n\nNote: This is part ${i + 1} of ${chunks.length} of a longer conversation. Preserve all details — the parts will be combined into a single summary.`;
            try {
                const chunkSummary = await completeFn(model, chunkPrompt, transcript);
                chunkSummaries.push(chunkSummary || "[Summary unavailable for this section]");
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                throw new Error(`Compaction summarization failed (chunk ${i + 1} of ${chunks.length}): ${errMsg}`);
            }
        }
        // Combine chunk summaries chronologically
        summary = chunkSummaries
            .map((s, i) => `--- Part ${i + 1} of ${chunkSummaries.length} ---\n${s}`)
            .join("\n\n");
    }
    if (!summary || summary.trim().length === 0) {
        summary = "[Summary unavailable]";
    }
    // Build compacted messages: summary as first user message, then recent half
    const summaryMessage = {
        role: "user",
        content: `[Conversation context — earlier in this session]\n\n${summary}\n\nFull transcript saved in memory — use memory_search for exact details from earlier.`,
    };
    // Need an assistant acknowledgment to maintain valid alternation
    const ackMessage = {
        role: "assistant",
        content: "Understood, I have the context from earlier in our conversation.",
    };
    const compactedMessages = [summaryMessage, ackMessage, ...recentHalf];
    const tokensAfter = await countFn(compactedMessages);
    return { compactedMessages, tokensBefore, tokensAfter };
}
//# sourceMappingURL=compact.js.map