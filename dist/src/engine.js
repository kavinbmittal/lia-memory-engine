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
import { compactMessages, estimateMessageTokens } from "./compact.js";
import { writeTranscript } from "./auto-flush.js";
import { searchForContext } from "./search.js";
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
export class LiaContextEngine {
    /** Engine metadata — tells OpenClaw we own compaction. */
    info = {
        id: "lia-memory-engine",
        name: "Lia Memory Engine",
        version: "1.0.0",
        ownsCompaction: true,
    };
    config;
    deps;
    sessions = new Map();
    constructor(config, deps) {
        this.config = config;
        this.deps = deps;
    }
    /**
     * Initialize session state and create memory directories.
     * Called when a new session starts.
     */
    async bootstrap(params) {
        const { sessionId, messages } = params;
        let workspaceDir;
        try {
            workspaceDir = this.deps.resolveWorkspaceDir(sessionId);
        }
        catch (err) {
            this.deps.logger.error(`[lia-memory-engine] Failed to resolve workspace for session ${sessionId}:`, err);
            return { ok: false };
        }
        // Create memory directories if they don't exist
        try {
            const { mkdir } = await import("node:fs/promises");
            const { join } = await import("node:path");
            const memoryDir = join(workspaceDir, "memory");
            const dailyDir = join(memoryDir, "daily");
            await mkdir(dailyDir, { recursive: true });
        }
        catch (err) {
            this.deps.logger.warn(`[lia-memory-engine] Failed to create memory directories:`, err);
            // Non-fatal — directories may already exist or will be created on first write
        }
        this.sessions.set(sessionId, {
            messages: messages ? [...messages] : [],
            workspaceDir,
            initialized: true,
            compacting: false,
            pendingCompaction: false,
            messageCountAtCompactStart: 0,
        });
        this.deps.logger.info(`[lia-memory-engine] Session ${sessionId} bootstrapped (${messages?.length ?? 0} initial messages)`);
        return { ok: true };
    }
    /**
     * Ingest a new message into the session.
     * Writes to the daily transcript (auto-flush) and stores in memory.
     */
    async ingest(params) {
        const { sessionId, message } = params;
        const session = this.getOrCreateSession(sessionId);
        // Store the message in the session buffer
        session.messages.push(message);
        // Auto-flush: write to daily transcript immediately
        if (this.config.enabled) {
            try {
                await writeTranscript(session.workspaceDir, [message]);
            }
            catch (err) {
                // Log but don't fail — transcript write is best-effort
                this.deps.logger.error(`[lia-memory-engine] Failed to write transcript for session ${sessionId}:`, err);
            }
        }
        return { ok: true };
    }
    /**
     * Assemble messages for the next model run.
     * Returns all session messages + auto-retrieval context as systemPromptAddition.
     */
    async assemble(params) {
        const { sessionId } = params;
        const session = this.getOrCreateSession(sessionId);
        const messages = [...session.messages];
        const estimatedTokens = estimateMessageTokens(messages);
        // Auto-retrieval: search memory files for relevant context
        let systemPromptAddition;
        if (this.config.enabled && this.config.autoRetrieval && messages.length > 0) {
            // Use the last user message as the search query
            const lastUserMessage = this.findLastUserMessage(messages);
            if (lastUserMessage) {
                try {
                    const context = await searchForContext(session.workspaceDir, lastUserMessage, this.config.autoRetrievalTimeoutMs);
                    if (context) {
                        systemPromptAddition = `\n\n--- Relevant context from memory ---\n${context}\n--- End memory context ---`;
                    }
                }
                catch (err) {
                    // Auto-retrieval failure is non-fatal
                    this.deps.logger.warn(`[lia-memory-engine] Auto-retrieval failed for session ${sessionId}:`, err);
                }
            }
        }
        return {
            messages,
            estimatedTokens,
            systemPromptAddition,
        };
    }
    /**
     * Compact the session's messages when context is getting full.
     * Summarizes older messages with a fast model, keeps recent ones verbatim.
     */
    async compact(params) {
        const { sessionId } = params;
        const session = this.getOrCreateSession(sessionId);
        if (!this.config.enabled) {
            return {
                messages: [...session.messages],
                compactedTokens: estimateMessageTokens(session.messages),
            };
        }
        // Prevent double-compaction if already in progress
        if (session.compacting) {
            this.deps.logger.warn(`[lia-memory-engine] Compaction already in progress for session ${sessionId} — skipping`);
            return {
                messages: [...session.messages],
                compactedTokens: estimateMessageTokens(session.messages),
            };
        }
        session.compacting = true;
        session.pendingCompaction = false;
        // Snapshot message count so we can detect concurrent ingests
        const messageCountAtStart = session.messages.length;
        session.messageCountAtCompactStart = messageCountAtStart;
        this.deps.logger.info(`[lia-memory-engine] Compacting session ${sessionId} (${session.messages.length} messages)`);
        try {
            // Compact only the messages that existed when we started
            const messagesToCompact = session.messages.slice(0, messageCountAtStart);
            const { compactedMessages, tokensBefore, tokensAfter } = await compactMessages(messagesToCompact, this.deps.completeFn, this.config.compactionModel);
            // Append any messages that were ingested during compaction
            const concurrentMessages = session.messages.slice(messageCountAtStart);
            const finalMessages = [...compactedMessages, ...concurrentMessages];
            // Update session with compacted messages + any concurrent ingests
            session.messages = finalMessages;
            if (concurrentMessages.length > 0) {
                this.deps.logger.info(`[lia-memory-engine] ${concurrentMessages.length} messages ingested during compaction — appended to result`);
            }
            this.deps.logger.info(`[lia-memory-engine] Compaction complete: ${tokensBefore} → ${tokensAfter} tokens ` +
                `(${Math.round((1 - tokensAfter / tokensBefore) * 100)}% reduction)`);
            const finalTokens = estimateMessageTokens(finalMessages);
            return {
                messages: [...finalMessages],
                compactedTokens: finalTokens,
            };
        }
        catch (err) {
            this.deps.logger.error(`[lia-memory-engine] Compaction failed for session ${sessionId}:`, err);
            // Return current messages unchanged on failure
            return {
                messages: [...session.messages],
                compactedTokens: estimateMessageTokens(session.messages),
            };
        }
        finally {
            session.compacting = false;
        }
    }
    /**
     * After-turn hook: check if compaction is needed based on threshold.
     * Called by OpenClaw after each model turn completes.
     */
    async afterTurn(params) {
        if (!this.config.enabled) {
            return { needsCompaction: false };
        }
        const { sessionId, contextWindowTokens } = params;
        const session = this.getOrCreateSession(sessionId);
        const estimatedTokens = estimateMessageTokens(session.messages);
        const contextWindow = contextWindowTokens ?? 1_000_000; // Default 1M
        const threshold = Math.floor(contextWindow * this.config.compactionThreshold);
        const overThreshold = estimatedTokens >= threshold;
        // Only signal compaction if not already pending or in progress
        const needsCompaction = overThreshold && !session.pendingCompaction && !session.compacting;
        if (needsCompaction) {
            session.pendingCompaction = true;
            this.deps.logger.info(`[lia-memory-engine] Compaction needed for session ${sessionId}: ` +
                `${estimatedTokens} tokens >= ${threshold} threshold (${this.config.compactionThreshold * 100}% of ${contextWindow})`);
        }
        return { needsCompaction };
    }
    /**
     * Cleanup when the engine is being shut down.
     */
    async dispose() {
        this.deps.logger.info(`[lia-memory-engine] Disposing (${this.sessions.size} active sessions)`);
        this.sessions.clear();
    }
    // ── Private helpers ─────────────────────────────────────────────────────────
    /**
     * Get existing session state or create a new one.
     * Lazily initializes if bootstrap() wasn't called first.
     */
    getOrCreateSession(sessionId) {
        let session = this.sessions.get(sessionId);
        if (!session) {
            let workspaceDir;
            try {
                workspaceDir = this.deps.resolveWorkspaceDir(sessionId);
            }
            catch {
                // Fallback to a reasonable default if resolution fails
                workspaceDir = `.`;
            }
            session = {
                messages: [],
                workspaceDir,
                initialized: false,
                compacting: false,
                pendingCompaction: false,
                messageCountAtCompactStart: 0,
            };
            this.sessions.set(sessionId, session);
            this.deps.logger.warn(`[lia-memory-engine] Session ${sessionId} accessed before bootstrap — lazy-initialized`);
        }
        return session;
    }
    /**
     * Find the text content of the last user message in the array.
     * Used for auto-retrieval queries.
     */
    findLastUserMessage(messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") {
                const content = messages[i].content;
                if (typeof content === "string")
                    return content;
                if (Array.isArray(content)) {
                    // Find first text block
                    for (const block of content) {
                        if (typeof block === "string")
                            return block;
                        if (block.type === "text" && block.text) {
                            return block.text;
                        }
                    }
                }
                // No extractable text in this user message (e.g. tool-result-only turn)
                // — keep iterating backward to find a previous user message with text
                continue;
            }
        }
        return null;
    }
}
//# sourceMappingURL=engine.js.map