/**
 * LiaContextEngine — the core context engine implementation.
 *
 * Implements OpenClaw's ContextEngine interface with:
 * - Structured compaction via Haiku (replaces OpenClaw's built-in compaction)
 * - Auto-flush every turn to daily transcript files
 * - Auto-retrieval via BM25 on every assemble() call
 *
 * This engine owns compaction (ownsCompaction: true), meaning OpenClaw
 * will not run its own compaction when this engine is active.
 */
import type { AgentMessage, LiaConfig, LiaDependencies } from "./types.js";
/**
 * The Lia Context Engine for OpenClaw.
 *
 * Lifecycle:
 * 1. bootstrap() — called when a session starts, initializes state
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
    constructor(config: LiaConfig, deps: LiaDependencies);
    /**
     * Initialize session state and create memory directories.
     * Called when a new session starts.
     */
    bootstrap(params: {
        sessionId: string;
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
     */
    assemble(params: {
        sessionId: string;
        contextWindowTokens?: number;
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
     * After-turn hook: check if compaction is needed based on threshold.
     * Called by OpenClaw after each model turn completes.
     */
    afterTurn(params: {
        sessionId: string;
        contextWindowTokens?: number;
    }): Promise<{
        needsCompaction: boolean;
    }>;
    /**
     * Cleanup when the engine is being shut down.
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
