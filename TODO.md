# TODO

## 2026-03-23-fix-pi-ai-completion

- [x] Fix completeFn in index.ts: remove dead Method 1, rewrite Method 2 to call pi-ai with proper (model, context, options) signature
- [x] Read API key from openclaw.json env config (api.config.env.ANTHROPIC_API_KEY) for both pi-ai and Anthropic SDK fallback
- [x] Update Anthropic SDK fallback (Method 3) to also read key from config
- [x] Build dist, run tests
- [ ] Update docs/technical if behavior changed
