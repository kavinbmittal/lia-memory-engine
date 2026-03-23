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
import type { AgentMessage } from "./types.js";
/**
 * The compaction prompt from Lia — optimized for preserving conversational
 * structure rather than just "summarizing." The Q&A log format prevents
 * the agent from re-answering questions it already handled.
 */
export declare const COMPACTION_PROMPT = "Summarize this conversation history for an AI assistant's context window.\n\nCRITICAL: Preserve the question-answer structure. For each user question, note:\n1. What the user asked\n2. What you already answered (so you don't re-answer it)\n\nExample format for Q&A:\n- User asked about project cost \u2192 Already answered: $150K total, 3 installments\n- User asked who's on the team \u2192 Already answered: Sarah Chen, David Park, Maria Rodriguez, Tom Baker\n\nAlso preserve:\n- Decisions made (with exact details: numbers, names, dates)\n- Commitments and promises (who committed to what, by when)\n- Open questions (unanswered asks \u2014 things the user asked that have NOT been answered yet)\n- User preferences expressed (tone, format, style)\n- Emotional context (stress, excitement, frustration)\n- Key facts and information shared (documents, data, context)\n- Tool actions taken and their results\n\nBe specific. \"Discussed report\" is useless. \"$2.35M Q1 revenue, 15% QoQ growth, bullet format\" is useful.\n\nThe full raw transcript is saved in memory files. This summary enables the AI to continue\nthe conversation coherently \u2014 exact quotes can be recovered via memory_search if needed.\n\nWrite a concise summary with a Q&A log section first, then key facts.";
/**
 * Approximate token count from text length (chars / 4).
 * Fast, no API call, good enough for threshold detection (~20% margin).
 */
export declare function estimateTokens(text: string): number;
/**
 * Estimate total token count for an array of messages.
 */
export declare function estimateMessageTokens(messages: AgentMessage[]): number;
/**
 * Split messages into chunks that each fit within MAX_CHUNK_TOKENS.
 * Always splits at user message boundaries so turn pairs stay together.
 * Exported for testing.
 */
export declare function chunkMessages(messages: AgentMessage[]): AgentMessage[][];
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
export declare function compactMessages(messages: AgentMessage[], completeFn: (model: string, systemPrompt: string, userContent: string) => Promise<string>, model: string): Promise<{
    compactedMessages: AgentMessage[];
    tokensBefore: number;
    tokensAfter: number;
}>;
