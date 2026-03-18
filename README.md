# Lia Memory Engine

Lia Memory Engine gives OpenClaw agents the kind of memory that actually works in practice — decisions made three sessions ago surface automatically, context doesn’t silently disappear when conversations get long, and nothing is ever lost.

## Two Parts
### 1. Compaction Upgrade: Structured Memory ###
OpenClaw’s built-in compaction throws away alot once the context gets full so your agents sometimes run around like headless chickens. Lia's Memory Engine brings a meaningful upgrade that solves this problem in a thoughtful and simple way:
- Right before compaction (set to 80% of context window), this engine will compresses the older half of messages into a summary that explicitly preserves decisions, commitments, open questions, Q&A pairs, and preferences
- This structured summarization is generated via Claude Haiku and is kept in context. You keep everything that matters
- The engine introduces auto-flush, where every message written to disk immediately so you also have a full transcript to search against, so nothing is truly gone even after compaction

### 2. QMD Memory Retrieval ###
[QMD](https://github.com/tobi/qmd) is a frame work built by Tobi Lütke. QMD isn’t a search box, it’s a full retrieval pipeline:
- BM25 keyword search
- Vector semantic search and
- LLM reranking running together on-device
The impact of this in practice is quite significant: basic search finds the memory that matches your words, QMD finds the memory that matches your intent. A query like “auth decision” will surface the conversation where you chose Supabase Auth because of RLS — not just any file that mentions authentication.

Combined together you have a powerful upgrade where OpenClaw never forgets anything. This is the engine powering [Lia](https://getlia.ai), the world's first AI Chief of Staff.

## Requirements

- Node.js 18+
- OpenClaw v2026.3.x+
- [QMD](https://github.com/tobi/qmd) — the on-device search engine that powers memory retrieval

### Linux / Railway

QMD installs [node-llama-cpp](https://github.com/withcatai/node-llama-cpp) as a dependency, which compiles llama.cpp from C++ source at install time. On macOS, Xcode command line tools include everything needed and this is invisible. On a fresh Linux container (including Railway), you need to install the build tools first:

```bash
apt-get update && apt-get install -y cmake build-essential
```

Add this to your Railway Dockerfile or `nixpacks.toml` before the `npm install` step. Without it, `npm install -g @tobilu/qmd` will fail during the native build.

## Setup

### 1. Install QMD

```bash
npm install -g @tobilu/qmd
```

First run downloads the GGUF embedding model (~400MB). This only happens once.

### 2. Install the plugin

```bash
cd ~/.openclaw/extensions
git clone <this-repo> lia-memory-engine
cd lia-memory-engine
npm install
npm run build
```

### 3. Register your memory collection

Point QMD at the directory where Lia writes transcripts. By default this is `memory/` inside your agent's workspace:

```bash
qmd collection add /path/to/your/workspace/memory --name lia-memory
```

Run this once per workspace. If you're not sure where your workspace is, check your OpenClaw config — the agent's working directory is the workspace.

### 4. Index existing transcripts

```bash
qmd embed -c lia-memory
```

If you're starting fresh with no prior transcripts, skip this — the plugin will handle it on bootstrap.

### 5. Add to OpenClaw config

In `~/.openclaw/openclaw.json`, add the minimum viable config:

```json
{
  "extensions": [
    "~/.openclaw/extensions/lia-memory-engine"
  ],
  "plugins": {
    "slots": {
      "contextEngine": "lia-memory-engine"
    },
    "entries": {
      "lia-memory-engine": {
        "enabled": true
      }
    }
  }
}
```

**The `plugins.slots.contextEngine` line is required.** Without it, the plugin installs and shows `enabled: true`, but OpenClaw silently falls back to its built-in safeguard compaction. The `memory_search` tool registers, but none of the engine lifecycle methods fire — no `assemble()`, no `ingest()`, no `compact()`, no auto-flush. There's no error or warning in older versions (v1.1+ logs a warning).

On first session start, the plugin starts the QMD daemon automatically. Models stay warm across sessions — no loading penalty after the first one.

See [Configuration](#configuration) below for all available options and recommended session settings.

### Verify it's working

After setup, confirm the plugin is actually active as the context engine:

1. **Check gateway logs on startup.** Look for:
   ```
   [lia-memory-engine] Registered as context engine
   ```
   If you see `WARNING: Plugin loaded but not assigned as context engine` instead, the slot assignment is missing — go back to step 5.

2. **Send a message, then check the transcript.** After your first message in a session, verify that `memory/daily/YYYY-MM-DD.md` exists in your workspace and contains conversation entries (format: `## HH:MM` with `**User:**` and `**Agent:**` sections). If the file doesn't exist, the engine's `ingest()` is not being called.

3. **Check `/status` output.** Compaction events should show `lia-memory-engine` as the source. If you see "safeguard mode" or no compaction source, the plugin isn't slotted.

## What it does

1. **Compaction via Haiku** — when context reaches the threshold (default 80%), splits messages at midpoint and summarizes the older half. Preserves Q&A pairs, decisions, commitments, open questions, preferences, and emotional context.

2. **Auto-flush every turn** — writes every message to `memory/daily/YYYY-MM-DD.md` immediately. Nothing is ever lost.

3. **Auto-retrieval** — on every turn, QMD runs a hybrid search (BM25 + vector + LLM reranking) using the last user message as the query. Relevant past context is injected silently before the model runs. 500ms timeout so it never blocks.

   After each message is written to the transcript, the index is updated in the background. This means messages are searchable immediately within the same session — not just from the next session onward.

4. **`memory_search` tool** — agents can explicitly search conversation history. Uses full hybrid search with HyDE reranking for maximum quality.

## How the daemon works

The plugin connects to a local QMD HTTP daemon at `localhost:8181`. On bootstrap, it checks if the daemon is running — if not, it spawns `qmd mcp --http --daemon` in the background. The daemon stays alive between sessions, keeping embedding models warm in memory.

If the daemon isn't available (QMD not installed, model not downloaded yet), the plugin falls back to QMD's CLI BM25 search. If that's also unavailable, auto-retrieval is silently skipped — the agent still works, just without memory context.

## Configuration

All options go under `plugins.entries.lia-memory-engine.config` in `openclaw.json`:

```json
"lia-memory-engine": {
  "enabled": true,
  "config": {
    "compactionThreshold": 0.80,
    "compactionModel": "anthropic/claude-haiku-4-5",
    "autoRetrieval": true,
    "autoRetrievalTimeoutMs": 500,
    "transcriptRetentionDays": 180
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the entire plugin |
| `compactionThreshold` | number | `0.80` | Fraction of context window that triggers compaction (0.1–1.0). At this threshold, the engine splits messages at the midpoint and summarizes the older half |
| `compactionModel` | string | `anthropic/claude-haiku-4-5` | Model used for compaction summarization. Must be a fast model — it runs synchronously during compaction |
| `autoRetrieval` | boolean | `true` | Automatically search memory files and inject relevant context before every model turn. Uses the last user message as the search query |
| `autoRetrievalTimeoutMs` | number | `500` | Maximum time in ms to wait for auto-retrieval results. Keeps the agent responsive — if QMD doesn't respond in time, the turn proceeds without memory context |
| `transcriptRetentionDays` | number | `180` | Days to keep daily transcript files before cleanup. Set higher if you want longer memory recall |
| `qmdHost` | string | `localhost` | QMD HTTP daemon hostname |
| `qmdPort` | number | `8181` | QMD HTTP daemon port |
| `qmdCollectionName` | string | `lia-memory` | QMD collection name. Change this if you run multiple agents with separate memory pools |
| `enableVectorSearch` | boolean | `true` | Enable vector semantic search + LLM reranking. Requires a ~400MB GGUF model download on first run. When `false`, only BM25 keyword search is used |

To disable vector search and use BM25 only (no model download required):

```json
{ "enableVectorSearch": false }
```

### Recommended: session reset policy

The plugin handles compaction (in-place summarization, no reset), but OpenClaw's session reset policy is separate. Without configuring it, sessions may reset unexpectedly and lose context that the plugin has been carefully preserving.

```json
{
  "agents": {
    "defaults": {
      "session": {
        "reset": {
          "mode": "idle",
          "idleMinutes": 10080
        }
      }
    }
  }
}
```

This sets sessions to reset only after 7 days of inactivity (10080 minutes). Since the plugin's compaction keeps context usable indefinitely, you don't need aggressive session resets.

## Architecture

```
index.ts              Plugin entry point — register(), configSchema, tool registration
src/
  engine.ts           LiaContextEngine — implements ContextEngine interface
  compact.ts          Compaction logic — midpoint split, Haiku summarization
  auto-flush.ts       Transcript formatting and daily file writes
  search.ts           Search functions — auto-retrieval and memory_search
  qmd-client.ts       QMD HTTP daemon client — hybrid search, daemon lifecycle
  types.ts            Type definitions and config defaults
```

## LLM Access

The plugin needs LLM access for compaction. It tries three methods in order:

1. `api.completeSimple()` — if exposed by OpenClaw's plugin API
2. `@mariozechner/pi-ai` — dynamic import (OpenClaw's internal LLM router)
3. `@anthropic-ai/sdk` — direct Anthropic SDK (requires `ANTHROPIC_API_KEY` env var)
