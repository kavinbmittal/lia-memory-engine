/**
 * LiaContextEngine v2 — OpenClaw owns the conversation.
 *
 * The engine never stores, replaces, or competes with OpenClaw's messages.
 * It only:
 * 1. Reads OpenClaw's messages (via params) to decide what to flush and whether to compact
 * 2. Adds memory context to the system prompt (auto-retrieval)
 * 3. Returns a compacted message array when asked (compact only — not every turn)
 *
 * This engine owns compaction (ownsCompaction: true), meaning OpenClaw
 * will not run its own compaction when this engine is active.
 *
 * QMD lifecycle:
 * - bootstrap() initializes the QMD collection and starts the daemon
 * - Daemon startup is best-effort: if QMD is not installed, search returns ""
 * - dispose() clears the client reference (daemon keeps running independently)
 */
import type { AgentMessage, LiaConfig, LiaDependencies } from "./types.js";
/**
 * The Lia Context Engine for OpenClaw.
 *
 * Lifecycle:
 * 1. bootstrap() — called when a session starts, initializes state + QMD
 * 2. assemble() — called before each model run, passes through OpenClaw's messages + auto-retrieval
 * 3. afterTurn() — called after each turn, flushes new messages to transcript, checks compaction
 * 4. compact() — called when compaction is triggered, summarizes older messages
 * 5. dispose() — called on shutdown, clears session trackers
 *
 * Note: ingest() still exists for backwards compatibility but is a no-op when
 * afterTurn() is defined (OpenClaw skips ingest in that case).
 */
export declare class LiaContextEngine {
    /** Engine metadata — tells OpenClaw we own compaction. */
    readonly info: {
        id: string;
        name: string;
        version: string;
        ownsCompaction: boolean;
    };
    private config;
    private deps;
    private sessions;
    /** QMD client — null until bootstrap() is called. */
    private qmdClient;
    /** Whether the QMD HTTP daemon is currently reachable. */
    private daemonRunning;
    constructor(config: LiaConfig, deps: LiaDependencies);
    /**
     * Initialize session state, create memory directories, and start QMD.
     * Called when a new session starts.
     *
     * QMD bootstrap is best-effort: failures are logged but do not prevent
     * the engine from functioning (search will return "" gracefully).
     */
    bootstrap(params: {
        sessionId: string;
        sessionKey?: string;
        sessionFile?: string;
        messages?: AgentMessage[];
    }): Promise<{
        ok: boolean;
    }>;
    /**
     * Ingest a new message into the session.
     * Writes to the daily transcript (auto-flush).
     *
     * Note: When afterTurn() is defined, OpenClaw calls afterTurn() INSTEAD of
     * ingest(). This method exists for backwards compatibility and edge cases.
     */
    ingest(params: {
        sessionId: string;
        message: AgentMessage;
    }): Promise<{
        ok: boolean;
    }>;
    /**
     * Assemble messages for the next model run.
     * Passes through OpenClaw's messages (never replaces them) and adds
     * auto-retrieval context as systemPromptAddition.
     */
    assemble(params: {
        sessionId: string;
        contextWindowTokens?: number;
        /** OpenClaw's current message array (reloaded from JSONL). */
        messages?: AgentMessage[];
    }): Promise<{
        messages: AgentMessage[];
        estimatedTokens: number;
        systemPromptAddition?: string;
    }>;
    /**
     * Compact the session's messages when context is getting full.
     * Operates on OpenClaw's messages (passed as params), summarizes older half
     * with a fast model, and returns the compacted result. Resets the flush counter
     * since the message array changed shape.
     */
    compact(params: {
        sessionId: string;
        sessionKey?: string;
        sessionFile?: string;
        contextWindowTokens?: number;
        tokenBudget?: number;
        /** OpenClaw's current messages to compact. */
        messages?: AgentMessage[];
        /** Force compaction regardless of threshold (e.g. manual /compact trigger). */
        force?: boolean;
        currentTokenCount?: number;
        compactionTarget?: "budget" | "threshold";
        customInstructions?: string;
        runtimeContext?: Record<string, unknown>;
    }): Promise<{
        ok: boolean;
        compacted: boolean;
        reason?: string;
        messages: AgentMessage[];
        compactedTokens: number;
        result?: {
            tokensBefore: number;
            tokensAfter?: number;
        };
    }>;
    /**
     * After-turn hook: flush new messages to transcript and check compaction threshold.
     * Called by OpenClaw after each model turn completes.
     *
     * Uses a counter (lastFlushedCount) to identify new messages — no shadow copy needed.
     */
    afterTurn(params: {
        sessionId: string;
        sessionKey?: string;
        messages?: AgentMessage[];
        prePromptMessageCount?: number;
        contextWindowTokens?: number;
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
        /** Force compaction signal — bypasses threshold check (e.g. manual /compact). */
        force?: boolean;
    }): Promise<{
        needsCompaction: boolean;
    }>;
    /**
     * Explicit memory search — called by the memory_search tool.
     * Uses full hybrid search (BM25 + vec + HyDE) for best quality.
     */
    search(params: {
        sessionId: string;
        query: string;
    }): Promise<string>;
    /**
     * Cleanup when the engine is being shut down.
     * Clears lightweight session trackers only — no message data to lose.
     */
    dispose(): Promise<void>;
    /**
     * Get existing session state or create a new one.
     * Lazily initializes if bootstrap() wasn't called first.
     */
    private getOrCreateSession;
    /**
     * Find the text content of the last user message in the array.
     * Used for auto-retrieval queries.
     */
    private findLastUserMessage;
}
