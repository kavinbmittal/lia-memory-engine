# Test Plan — Fix pi-ai LLM Completion

## Unit tests

- **pi-ai Model construction:** Given `"anthropic/claude-haiku-4-5"`, verify it splits into provider `"anthropic"` and model ID `"claude-haiku-4-5"`. Verify a Model object is built with correct `id`, `provider`, `api` fields.
- **API key resolution from config:** Given an `api.config.env` with `ANTHROPIC_API_KEY`, verify the completeFn reads it. Given no key in config, verify it falls through to Anthropic SDK fallback.
- **Fallback chain:** Mock pi-ai to throw → verify Anthropic SDK fallback is attempted. Mock both to throw → verify the final error message is clear.
- **Model without provider prefix:** Given `"claude-haiku-4-5"` (no slash), verify it still resolves correctly or falls through gracefully.

## Integration tests

- **End-to-end compaction on Railway:** Trigger compaction (push an agent past 80% context). Verify:
  - Logs show `[lia-memory-engine] Using @mariozechner/pi-ai for LLM completion`
  - Compaction completes without error
  - Context is reduced (check before/after token count in logs)

## Manual checks

- **Gateway restart:** After deploy, verify gateway logs show `Plugin loaded` with correct config.
- **Live agent conversation:** Have an agent conversation grow past threshold, confirm compaction fires and the agent continues without interruption.

## Regression risk

- **Existing Anthropic SDK fallback:** Verify it still works if pi-ai is somehow unavailable (e.g. module deleted). Should see `@anthropic-ai/sdk` log line instead.
- **Other agents unaffected:** Compaction is per-session — verify other active agent sessions don't get disrupted during deploy.
