# QMD — Technical Reference

[QMD](https://github.com/tobi/qmd) is the on-device search engine powering Lia Memory Engine's hybrid retrieval.

## Architecture

QMD combines three retrieval strategies:

- **BM25** — keyword-based full-text search (fast, no model required)
- **Vector search** — semantic similarity via GGUF embeddings (requires model download on first run)
- **HyDE** — Hypothetical Document Embedding, generates a synthetic answer to the query then searches for similar real documents; best recall, slowest
- **LLM reranking** — after combining BM25 + vector results via Reciprocal Rank Fusion (RRF), an LLM rescores the candidates to surface the most contextually relevant result

In daemon mode (`qmd mcp --http --daemon`), models stay loaded in VRAM between requests. After initial warmup (~1s on first session), reranking adds ~100-200ms per query — fast enough to run on every auto-retrieval turn.

## System Requirements

### macOS

Xcode command line tools satisfy all native build dependencies. Nothing extra needed.

```bash
xcode-select --install  # if not already installed
```

### Linux / Railway

QMD depends on [node-llama-cpp](https://github.com/withcatai/node-llama-cpp), which compiles llama.cpp from C++ source at `npm install` time. On a fresh Linux container, this will fail silently or error during native compilation without:

```bash
apt-get update && apt-get install -y cmake build-essential
```

**Add this to your Railway Dockerfile or `nixpacks.toml` before any `npm install` step.**

Root cause: QMD's README only lists "Node >= 22" and "Homebrew SQLite (macOS)" as requirements. The cmake dependency is from node-llama-cpp and not surfaced. On macOS it's invisible because Xcode includes cmake. On Linux it's a hard failure.

## Known Constraints

| Constraint | Detail |
|---|---|
| Node >= 22 | Required by QMD (node-llama-cpp uses modern Node APIs) |
| cmake on Linux | Required for native llama.cpp compilation at install time |
| Homebrew SQLite on macOS | QMD links against the Homebrew SQLite, not the system one |
| First-run model download | `enableVectorSearch: true` triggers GGUF model download on first `qmd embed` |
| Daemon port | Default `8181` — configure via `qmdPort` in plugin config |

## Daemon Lifecycle

The plugin manages the QMD daemon automatically:

1. On `bootstrap()`, checks `GET http://localhost:8181/health`
2. If not running, spawns `qmd mcp --http --daemon` (detached — survives plugin restarts)
3. Polls `/health` for up to 10 seconds; logs a warning and falls back to CLI BM25 if it never comes up
4. On session dispose, the daemon is left running (intentional — shared across sessions)

## Fallback Behaviour

If the daemon is unavailable at search time, the plugin falls back to `qmd search` CLI (BM25 only). This is graceful — the agent still gets memory context, just without vector and reranking quality.

## Collection Setup

```bash
# Install QMD
npm install -g @tobilu/qmd

# Register the memory directory as a collection
qmd collection add /path/to/workspace/memory --name lia-memory

# Run initial embedding (required for vector search)
qmd embed -c lia-memory

# Start the daemon (plugin does this automatically, but you can run it manually)
qmd mcp --http --daemon
```
