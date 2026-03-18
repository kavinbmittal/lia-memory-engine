# Lessons

Append after any correction, silent failure discovered, or architectural decision.
Graduate stable patterns into CLAUDE.md. This file = recent patterns being validated.

---

## 2026-03-18 — QMD cmake dependency on Linux

**Constraint:** `npm install -g @tobilu/qmd` fails on fresh Linux containers (including Railway) without `cmake` and `build-essential` installed first.

**Root cause:** QMD depends on node-llama-cpp, which compiles llama.cpp from C++ source at install time. On macOS, Xcode command line tools include cmake so it's invisible. On Linux it's a hard build failure with a cryptic error.

**Rule:** Any npm package that vendors native C++ compilation (node-llama-cpp, better-sqlite3, sharp, canvas, etc.) needs Linux build deps (`cmake build-essential`) added to Railway Dockerfile / nixpacks.toml before the npm install step. Check for `node-gyp`, `cmake-js`, or `bindings` in the dep tree.

**Documented in:** `docs/technical/qmd.md`

---

## 2026-03-18 — QMD index freshness during long sessions

**Constraint:** QMD only indexes new transcript files when `qmd embed` is explicitly run. The plugin runs this at `bootstrap()` only, so messages written during a session are invisible to search until the next session starts.

**Rule:** After any auto-flush write, call `qmd embedBackground()` to keep the index current. For long-running sessions this is the difference between the agent finding a decision made an hour ago vs. only finding it tomorrow.

**Status:** Fixed — `embedBackground()` now called after each transcript write.
