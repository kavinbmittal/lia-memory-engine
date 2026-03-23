# FEATURES — Lia Memory Engine

- Structured compaction via configurable LLM model (default: claude-haiku-4-5) — summarizes older messages while preserving Q&A structure
- Auto-flush every turn to daily transcript files — nothing lost after compaction or crash
- Auto-retrieval via QMD hybrid search (BM25 + vector + HyDE) — relevant past context injected before model runs
- memory_search tool for explicit agent queries across conversation history and memory files
- Owns compaction lifecycle — OpenClaw delegates compaction entirely to this engine
- Per-agent workspace resolution from session keys
