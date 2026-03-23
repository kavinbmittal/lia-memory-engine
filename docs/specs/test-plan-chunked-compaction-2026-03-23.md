# Test Plan: Chunked Compaction

## Unit Tests

### Chunking logic
- Messages under 150k tokens produce 1 chunk (single call, unchanged behavior)
- Messages at exactly 150k tokens produce 1 chunk (boundary condition)
- Messages at 200k tokens produce 2 chunks
- Messages at 450k tokens produce 3 chunks
- Each chunk respects the 150k token limit

### Chunk boundaries
- Chunks always split at user message boundaries (never mid-turn)
- A user message and its following assistant response stay in the same chunk
- Edge case: single turn exceeds 150k tokens — content is truncated to fit

### Chunk summarization
- Each chunk's prompt includes "part N of M" context
- Chunk summaries combine in chronological order
- Combined summary uses section markers between chunks
- Single-chunk case produces identical output to current behavior (regression)

### Failure handling
- If chunk 1 of 3 fails, entire compaction fails with "chunk 1 of 3 failed"
- If chunk 3 of 3 fails, entire compaction fails with "chunk 3 of 3 failed"
- completeFn returning empty string for a chunk is handled (fallback text)
- No partial compaction state — messages array unchanged on failure

### Regression
- Conversations with < 4 messages return unchanged (existing behavior)
- Split-at-midpoint logic unchanged for conversations under 150k tokens
- Summary message format unchanged (same prefix, same ack message)
- Token estimates before/after are accurate

## Integration Test

- Deploy to Railway and trigger compaction on the 9096-message session (207k tokens in older half)
- Verify compaction succeeds (was failing with "prompt too long")
- Verify the summary is coherent and chronological
- Verify the agent can continue the conversation after compaction

## Manual Checks

- Review the combined summary output for coherence — automated tests can verify structure but not quality
- Confirm Railway logs show "chunk N of M" progress during compaction

## Regression Risk

- Existing compaction behavior for short conversations (under 150k tokens) — verify with existing test suite (84 tests)
- Token estimation accuracy — existing estimateTokens / estimateMessageTokens tests cover this
