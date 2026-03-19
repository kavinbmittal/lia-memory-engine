/**
 * LiaContextEngine — the core context engine implementation.
 *
 * Implements OpenClaw's ContextEngine interface with:
 * - Structured compaction via Haiku (replaces OpenClaw's built-in compaction)
 * - Auto-flush every turn to daily transcript files
 * - Auto-retrieval via QMD hybrid search on every assemble() call
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
 * 2. ingest() — called for each new message, writes to transcript
 * 3. assemble() — called before each model run, returns messages + auto-retrieval
 * 4. afterTurn() — called after each turn, checks if compaction needed
 * 5. compact() — called when compaction is triggered
 * 6. dispose() — called on shutdown
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
     * Writes to the daily transcript (auto-flush) and stores in memory.
     */
    ingest(params: {
        sessionId: string;
        message: AgentMessage;
    }): Promise<{
        ok: boolean;
    }>;
    /**
     * Assemble messages for the next model run.
     * Returns all session messages + auto-retrieval context as systemPromptAddition.
     *
     * Auto-retrieval uses QMD search, guarded by a timeout so it never blocks the agent.
     */
    assemble(params: {
        sessionId: string;
        contextWindowTokens?: number;
        /** OpenClaw's current message array (passed by OpenClaw, reloaded from JSONL). */
        messages?: AgentMessage[];
    }): Promise<{
        messages: AgentMessage[];
        estimatedTokens: number;
        systemPromptAddition?: string;
    }>;
    /**
     * Compact the session's messages when context is getting full.
     * Summarizes older messages with a fast model, keeps recent ones verbatim.
     */
    compact(params: {
        sessionId: string;
        contextWindowTokens?: number;
    }): Promise<{
        messages: AgentMessage[];
        compactedTokens: number;
    }>;
    /**
     * After-turn hook: ingest new messages and check if compaction is needed.
     * Called by OpenClaw after each model turn completes.
     *
     * IMPORTANT: When afterTurn() is defined, OpenClaw calls it INSTEAD of
     * ingest()/ingestBatch(). So we must handle message ingestion and transcript
     * writing here, not just compaction checks.
     */
    afterTurn(params: {
        sessionId: string;
        sessionKey?: string;
        messages?: AgentMessage[];
        prePromptMessageCount?: number;
        contextWindowTokens?: number;
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
    }): Promise<{
        needsCompaction: boolean;
    }>;
    /**
     * Explicit memory search — called by the memory_search tool.
     * Uses full hybrid search (BM25 + vec + HyDE) for best quality.
     * Returns empty string if QMD client is not initialized or search fails.
     */
    search(params: {
        sessionId: string;
        query: string;
    }): Promise<string>;
    /**
     * Cleanup when the engine is being shut down.
     * The QMD daemon runs independently and is not stopped here
     * (it may be shared across plugin reloads).
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
