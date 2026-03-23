# TODO

## 2026-03-23-fix-pi-ai-completion

- [x] Fix completeFn in index.ts: remove dead Method 1, rewrite Method 2 to call pi-ai with proper (model, context, options) signature
- [x] Read API key from openclaw.json env config (api.config.env.ANTHROPIC_API_KEY) for both pi-ai and Anthropic SDK fallback
- [x] Update Anthropic SDK fallback (Method 3) to also read key from config
- [x] Build dist, run tests
- [ ] Update docs/technical if behavior changed

## 2026-03-23-chunked-compaction

- [ ] Add chunking logic to compact.ts — split older half into 150k-token chunks at user message boundaries
- [ ] Add multi-chunk summarization — sequential Haiku calls with "part N of M" prompt
- [ ] Handle oversized single turns — truncate content that exceeds chunk limit
- [ ] Combine chunk summaries chronologically into single summary message
- [ ] Write tests for chunking, boundaries, multi-chunk, failure, and regression
- [ ] Build and verify all tests pass
- [ ] Deferred: migrate to delegateCompactionToRuntime() when OpenClaw upgraded to v2026.3.22+
