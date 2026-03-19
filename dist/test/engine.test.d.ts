/**
 * Tests for the LiaContextEngine v2 (engine.ts).
 *
 * v2 key change: the engine no longer stores messages. OpenClaw owns the
 * conversation. The engine passes messages through, flushes new ones to
 * transcript using a counter, and compacts on demand.
 */
export {};
