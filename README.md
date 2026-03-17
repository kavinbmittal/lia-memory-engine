# Lia Memory Engine

OpenClaw context engine plugin that ports Lia's memory system — structured compaction, auto-flush transcripts, BM25 auto-retrieval, and a `memory_search` tool.

Replaces OpenClaw's built-in compaction with Lia's approach: when context gets full, the older half is summarized by Claude Haiku using a structured prompt that preserves Q&A structure, decisions, commitments, and emotional context. Every message is written to daily transcript files immediately, so nothing is ever lost.

## Install

```bash
cd ~/.openclaw/extensions
git clone <this-repo> lia-memory-engine
cd lia-memory-engine
npm install
npm run build
```

Then add to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "extensions": [
    "~/.openclaw/extensions/lia-memory-engine"
  ],
  "plugins": {
    "entries": {
      "lia-memory-engine": {
        "enabled": true,
        "config": {
          "compactionThreshold": 0.80,
          "compactionModel": "anthropic/claude-haiku-4-5-20251001",
          "autoRetrieval": true
        }
      }
    }
  }
}
```

## What it does

1. **Compaction via Haiku** — when context reaches the threshold (default 80%), splits messages at midpoint, summarizes the older half with Claude Haiku using a structured prompt that preserves Q&A pairs, decisions, commitments, open questions, preferences, and emotional context.

2. **Auto-flush every turn** — writes every message to `memory/daily/YYYY-MM-DD.md` as raw transcript immediately. Nothing is ever lost, even on crash or session reset.

3. **Auto-retrieval** — on every `assemble()` call, BM25 searches memory files using the last user message as query and injects relevant context into `systemPromptAddition`. 500ms timeout so it never blocks.

4. **memory_search tool** — registers a `memory_search` tool so agents can explicitly search their conversation history and memory files. Accepts `query` and optional `days` parameters.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the entire plugin |
| `compactionThreshold` | number | `0.80` | Fraction of context window that triggers compaction (0.1 - 1.0) |
| `compactionModel` | string | `anthropic/claude-haiku-4-5-20251001` | Model for compaction summarization |
| `autoRetrieval` | boolean | `true` | Auto-search memory and inject context |
| `autoRetrievalTimeoutMs` | number | `500` | Timeout for auto-retrieval search (ms) |
| `transcriptRetentionDays` | number | `180` | Days to retain daily transcript files |

## Architecture

```
index.ts              Plugin entry point — register(), configSchema, tool registration
src/
  engine.ts           LiaContextEngine — implements ContextEngine interface
  compact.ts          Compaction logic — midpoint split, Haiku summarization
  auto-flush.ts       Transcript formatting and daily file writes
  search.ts           BM25 ranking, memory search, auto-retrieval
  types.ts            Type definitions and config defaults
```

## LLM Access

The plugin needs LLM access for compaction. It tries three methods in order:

1. `api.completeSimple()` — if exposed by OpenClaw's plugin API
2. `@mariozechner/pi-ai` — dynamic import (OpenClaw's internal LLM router)
3. `@anthropic-ai/sdk` — direct Anthropic SDK (requires `ANTHROPIC_API_KEY` env var)

## Compatibility

- OpenClaw v2026.3.x+
- Node.js 18+
- TypeScript ESM
