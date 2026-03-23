# Chunked Compaction

## What This Means for Users

Compaction works for any conversation length. An agent with thousands of messages no longer fails with "prompt too long" — the older context gets summarized into a clean chronological recap, and the agent continues without losing track of what happened.

## Problem

Compaction sends the entire older half of a conversation to Haiku in a single call. When conversations exceed ~4500 messages, the older half exceeds Haiku's 200k token limit and the call fails. The agent sees "Compaction failed" and context keeps growing until it hits the hard context window limit.

## Approach

Split the older half into chunks that fit within Haiku's context limit, summarize each chunk separately, and combine the summaries chronologically.

### Why this approach

- Fixes the immediate failure with minimal change (only `compact.ts` is modified)
- No new dependencies, no architectural changes
- Scales automatically — longer conversations just produce more chunks

### Alternatives rejected

- **Cap at 150k and drop the rest:** Loses context silently. Agents would forget older parts of long conversations.
- **Delegate to OpenClaw runtime (`delegateCompactionToRuntime`):** Requires upgrading OpenClaw to v2026.3.22. Better long-term solution, but not available on current version (2026.3.13). Captured as future migration path.

## Design

### Flow

1. Compaction triggers (threshold or manual) — older half of messages selected
2. Estimate token count of older half
3. If under 150k tokens: single Haiku call (unchanged from today)
4. If over 150k tokens: split into chunks at user message boundaries
5. Summarize each chunk with Haiku — prompt includes "part N of M" for continuity
6. Combine chunk summaries in chronological order into one summary message
7. Summary message + assistant ack + recent half = compacted conversation

### Chunking rules

- **Max chunk size:** 150k tokens (50k buffer below Haiku's 200k limit for system prompt + output)
- **Split boundary:** Always split at user message boundaries — never mid-turn. A user message and its assistant response stay together.
- **Chunk prompt:** Each chunk's prompt tells Haiku it's summarizing "part N of M" of a longer conversation, so it preserves cross-chunk references where visible.

### Combined summary

- Chunk summaries are concatenated in chronological order with section markers
- The combined text becomes a single summary message (same format as today's single-call summary)
- No recursive summarization — if the combined summaries themselves are too long, that's a future concern (would require conversations of 1M+ tokens in the older half)

### Failure handling

- If any chunk fails to summarize, the entire compaction fails
- No partial compaction — conversation continues uncompacted
- Error message includes which chunk failed (e.g., "chunk 2 of 3 failed")
- Retry on next compaction trigger (same as today)

## Scope

### In scope

- Chunking logic in `compact.ts`
- Token estimation per chunk
- Sequential chunk summarization
- Combined summary assembly
- Error handling per chunk
- Tests for chunking, boundary detection, and multi-chunk summarization

### Out of scope

- Recursive summarization (summarizing summaries)
- Changing compaction threshold or model
- Migration to `delegateCompactionToRuntime()` (future — requires OpenClaw upgrade)
- Parallel chunk summarization (sequential is simpler and sufficient)
- pi-ai empty content issue (separate investigation)

## Files touched

- `src/compact.ts` — chunking logic, multi-call summarization

## Testing plan

- Unit test: conversations under 150k tokens produce 1 chunk (unchanged behavior)
- Unit test: conversations over 150k tokens produce correct number of chunks
- Unit test: chunks split at user message boundaries
- Unit test: chunk summaries combine in chronological order
- Unit test: failure in any chunk fails the entire compaction
- Integration: deploy and trigger compaction on the 9096-message session

## Key decisions

| Decision | Value | Rationale |
|----------|-------|-----------|
| Chunk size limit | 150k tokens | 50k buffer below Haiku's 200k for system prompt + output tokens |
| Split boundary | User message start | Keeps user-assistant turn pairs together for coherent summarization |
| Chunk processing | Sequential | Simpler, avoids rate limiting, sufficient for 2-4 chunks |
| Failure mode | All-or-nothing | Partial compaction would leave conversation in inconsistent state |
