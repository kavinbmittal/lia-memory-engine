/**
 * Tests for the QMD-backed search API (search.ts).
 *
 * Uses a mock QMDClient to test the search orchestration logic without
 * requiring a running QMD daemon or the QMD CLI to be installed.
 *
 * Covers:
 * - searchForContext: daemon path, CLI fallback, timeout, empty results
 * - searchMemory: full mode, CLI fallback, empty results
 * - formatSearchResults: markdown formatting, no-results message
 */
export {};
