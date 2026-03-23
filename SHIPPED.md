# SHIPPED

## 2026-03-23
- **feat:** Accurate token counting via Anthropic API — compaction stats, threshold checks, and chunk splitting now use real token counts instead of rough estimates
- **feat:** Chunked compaction — conversations of any length now compact successfully by splitting into 150k-token chunks
- **fix:** QMD embedding moved from fire-on-every-message to on-demand before memory_search — prevents server overload with multiple active agents
- **fix:** Compaction now works — pi-ai called with correct signature, API keys read from OpenClaw config (`115596c4`)
- **fix:** Added Anthropic SDK as direct dependency for compaction fallback (`5a6de6dc`)
