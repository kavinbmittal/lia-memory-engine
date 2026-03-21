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
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { compactMessages, estimateMessageTokens } from "./compact.js";
import { writeTranscript } from "./auto-flush.js";
import { searchForContext, searchMemory } from "./search.js";
import { QMDClient } from "./qmd-client.js";
/**
 * Read messages from an OpenClaw session JSONL file.
 * Each line is a JSON object; we extract entries with type: "message".
 */
function readMessagesFromSessionFile(sessionFile, logger) {
    try {
        const raw = readFileSync(sessionFile, "utf-8");
        const messages = [];
        for (const line of raw.split("\n")) {
            if (!line.trim())
                continue;
            try {
                const entry = JSON.parse(line);
                if (entry.type === "message" && entry.message) {
                    messages.push(entry.message);
                }
            }
            catch {
                // Skip malformed lines
            }
        }
        logger.info(`[lia-memory-engine] Read ${messages.length} messages from session file`);
        return messages;
    }
    catch (err) {
        logger.warn(`[lia-memory-engine] Failed to read session file ${sessionFile}: ${String(err)}`);
        return [];
    }
}
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
export class LiaContextEngine {
    /** Engine metadata — tells OpenClaw we own compaction. */
    info = {
        id: "lia-memory-engine",
        name: "Lia Memory Engine",
        version: "2.0.0",
        ownsCompaction: true,
    };
    config;
    deps;
    sessions = new Map();
    /** QMD client — null until bootstrap() is called. */
    qmdClient = null;
    /** Whether the QMD HTTP daemon is currently reachable. */
    daemonRunning = false;
    constructor(config, deps) {
        this.config = config;
        this.deps = deps;
    }
    /**
     * Initialize session state, create memory directories, and start QMD.
     * Called when a new session starts.
     *
     * QMD bootstrap is best-effort: failures are logged but do not prevent
     * the engine from functioning (search will return "" gracefully).
     */
    async bootstrap(params) {
        const { sessionId, sessionKey } = params;
        let workspaceDir;
        try {
            workspaceDir = this.deps.resolveWorkspaceDir(sessionId, sessionKey);
        }
        catch (err) {
            this.deps.logger.error(`[lia-memory-engine] Failed to resolve workspace for session ${sessionId} (key: ${sessionKey}):`, err);
            return { bootstrapped: false, reason: `Failed to resolve workspace: ${err}` };
        }
        // Create memory directories if they don't exist
        let memoryDir;
        try {
            const { mkdir } = await import("node:fs/promises");
            memoryDir = join(workspaceDir, "memory");
            const dailyDir = join(memoryDir, "daily");
            await mkdir(dailyDir, { recursive: true });
        }
        catch (err) {
            this.deps.logger.warn(`[lia-memory-engine] Failed to create memory directories:`, err);
            memoryDir = join(workspaceDir, "memory");
        }
        // Lazily initialize QMD client (shared across all sessions on this engine instance)
        if (this.qmdClient === null) {
            if (this.deps.qmdClient !== undefined) {
                this.qmdClient = this.deps.qmdClient;
            }
            else {
                try {
                    this.qmdClient = new QMDClient({
                        host: this.config.qmdHost,
                        port: this.config.qmdPort,
                        collectionName: this.config.qmdCollectionName,
                        memoryDir,
                        enableVectorSearch: this.config.enableVectorSearch,
                        logger: this.deps.logger,
                    });
                }
                catch (err) {
                    this.deps.logger.warn("[lia-memory-engine] Failed to initialize QMD client:", err);
                }
            }
        }
        if (this.qmdClient !== null) {
            await this.qmdClient.ensureCollection();
            if (this.deps.qmdClient === undefined) {
                this.daemonRunning = await this.qmdClient.startDaemon();
            }
            this.qmdClient.embedBackground();
        }
        this.sessions.set(sessionId, {
            workspaceDir,
            initialized: true,
            compacting: false,
            pendingCompaction: false,
            lastFlushedCount: 0,
        });
        this.deps.logger.info(`[lia-memory-engine] Session ${sessionId} bootstrapped`);
        return { bootstrapped: true };
    }
    /**
     * Ingest a new message into the session.
     * Writes to the daily transcript (auto-flush).
     *
     * Note: When afterTurn() is defined, OpenClaw calls afterTurn() INSTEAD of
     * ingest(). This method exists for backwards compatibility and edge cases.
     */
    async ingest(params) {
        const { sessionId, message } = params;
        const session = this.getOrCreateSession(sessionId);
        // Auto-flush: write to daily transcript immediately
        if (this.config.enabled) {
            try {
                await writeTranscript(session.workspaceDir, [message]);
                this.qmdClient?.embedBackground();
            }
            catch (err) {
                this.deps.logger.error(`[lia-memory-engine] Failed to write transcript for session ${sessionId}:`, err);
            }
        }
        return { ingested: true };
    }
    /**
     * Assemble messages for the next model run.
     * Passes through OpenClaw's messages (never replaces them) and adds
     * auto-retrieval context as systemPromptAddition.
     */
    async assemble(params) {
        const { sessionId } = params;
        this.getOrCreateSession(sessionId);
        // Use OpenClaw's messages as the source of truth. If OpenClaw passes them,
        // return the same reference so the !== check in OpenClaw skips replaceMessages().
        // If not passed (shouldn't happen), return empty.
        const messages = params.messages ?? [];
        const estimatedTokens = estimateMessageTokens(messages);
        // Auto-retrieval: search memory files for relevant context
        let systemPromptAddition;
        if (this.config.enabled && this.config.autoRetrieval && messages.length > 0 && this.qmdClient !== null) {
            const lastUserMessage = this.findLastUserMessage(messages);
            if (lastUserMessage) {
                try {
                    const context = await searchForContext(this.qmdClient, lastUserMessage, this.config.autoRetrievalTimeoutMs, this.daemonRunning);
                    if (context) {
                        systemPromptAddition = `\n\n--- Relevant context from memory ---\n${context}\n--- End memory context ---`;
                    }
                }
                catch (err) {
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
     * Operates on OpenClaw's messages (passed as params), summarizes older half
     * with a fast model, and returns the compacted result. Resets the flush counter
     * since the message array changed shape.
     */
    async compact(params) {
        const { sessionId, force } = params;
        const session = this.getOrCreateSession(sessionId);
        // Use OpenClaw's messages if provided, otherwise read from session file
        let inputMessages = params.messages ?? [];
        if (inputMessages.length === 0 && params.sessionFile) {
            inputMessages = readMessagesFromSessionFile(params.sessionFile, this.deps.logger);
        }
        if (!this.config.enabled) {
            return {
                ok: true,
                compacted: false,
                reason: "engine disabled",
                messages: [...inputMessages],
                compactedTokens: estimateMessageTokens(inputMessages),
            };
        }
        // Prevent double-compaction if already in progress
        if (session.compacting) {
            this.deps.logger.warn(`[lia-memory-engine] Compaction already in progress for session ${sessionId} — skipping`);
            return {
                ok: true,
                compacted: false,
                reason: "compaction already in progress",
                messages: [...inputMessages],
                compactedTokens: estimateMessageTokens(inputMessages),
            };
        }
        if (force) {
            this.deps.logger.info(`[lia-memory-engine] Forced compaction requested for session ${sessionId}`);
        }
        session.compacting = true;
        session.pendingCompaction = false;
        this.deps.logger.info(`[lia-memory-engine] Compacting session ${sessionId} (${inputMessages.length} messages)`);
        try {
            const { compactedMessages, tokensBefore, tokensAfter } = await compactMessages(inputMessages, this.deps.completeFn, this.config.compactionModel);
            // Reset flush counter — the message array changed shape, so the old
            // position is meaningless. afterTurn() will re-flush the compacted
            // messages on the next turn (harmless append to transcript).
            session.lastFlushedCount = 0;
            this.deps.logger.info(`[lia-memory-engine] Compaction complete: ${tokensBefore} → ${tokensAfter} tokens ` +
                `(${Math.round((1 - tokensAfter / tokensBefore) * 100)}% reduction)`);
            const finalTokens = estimateMessageTokens(compactedMessages);
            return {
                ok: true,
                compacted: true,
                messages: [...compactedMessages],
                compactedTokens: finalTokens,
                result: {
                    tokensBefore,
                    tokensAfter,
                },
            };
        }
        catch (err) {
            this.deps.logger.error(`[lia-memory-engine] Compaction failed for session ${sessionId}:`, err);
            return {
                ok: false,
                compacted: false,
                reason: String(err),
                messages: [...inputMessages],
                compactedTokens: estimateMessageTokens(inputMessages),
            };
        }
        finally {
            session.compacting = false;
        }
    }
    /**
     * After-turn hook: flush new messages to transcript and check compaction threshold.
     * Called by OpenClaw after each model turn completes.
     *
     * Uses a counter (lastFlushedCount) to identify new messages — no shadow copy needed.
     */
    async afterTurn(params) {
        if (!this.config.enabled) {
            return { needsCompaction: false };
        }
        const { sessionId, sessionKey, messages, prePromptMessageCount, contextWindowTokens, tokenBudget } = params;
        const session = this.getOrCreateSession(sessionId, sessionKey);
        // Resolve workspace from runtime context if session was lazy-initialized
        if (!session.initialized && params.runtimeContext) {
            const rtWorkspace = params.runtimeContext.workspaceDir;
            if (typeof rtWorkspace === "string" && rtWorkspace.length > 0) {
                session.workspaceDir = rtWorkspace;
            }
        }
        // Auto-flush: write only new messages to daily transcript.
        // Uses lastFlushedCount as the bookmark — no message array needed.
        if (messages && typeof prePromptMessageCount === "number") {
            const conversationMessages = messages.slice(prePromptMessageCount);
            const newMessages = conversationMessages.slice(session.lastFlushedCount);
            if (newMessages.length > 0) {
                // Update counter BEFORE writing so we don't re-flush on failure retry
                session.lastFlushedCount = conversationMessages.length;
                try {
                    await writeTranscript(session.workspaceDir, newMessages);
                    this.qmdClient?.embedBackground();
                }
                catch (err) {
                    this.deps.logger.error(`[lia-memory-engine] Failed to write transcript in afterTurn for session ${sessionId}:`, err);
                }
            }
        }
        // Check compaction threshold using OpenClaw's live message snapshot
        const liveMessages = messages?.slice(prePromptMessageCount ?? 0) ?? [];
        const estimatedTokens = estimateMessageTokens(liveMessages);
        const contextWindow = tokenBudget ?? contextWindowTokens ?? 1_000_000;
        const threshold = Math.floor(contextWindow * this.config.compactionThreshold);
        const overThreshold = estimatedTokens >= threshold;
        const forced = params.force === true;
        const needsCompaction = forced || (overThreshold && !session.pendingCompaction && !session.compacting);
        if (needsCompaction) {
            session.pendingCompaction = true;
            this.deps.logger.info(`[lia-memory-engine] Compaction ${forced ? "forced" : "needed"} for session ${sessionId}: ` +
                `${estimatedTokens} tokens${forced ? " (manual trigger)" : ` >= ${threshold} threshold (${this.config.compactionThreshold * 100}% of ${contextWindow})`}`);
        }
        return { needsCompaction };
    }
    /**
     * Explicit memory search — called by the memory_search tool.
     * Uses full hybrid search (BM25 + vec + HyDE) for best quality.
     */
    async search(params) {
        if (this.qmdClient === null) {
            return "";
        }
        return searchMemory(this.qmdClient, params.query, this.daemonRunning);
    }
    /**
     * Cleanup when the engine is being shut down.
     * Clears lightweight session trackers only — no message data to lose.
     */
    async dispose() {
        this.deps.logger.info(`[lia-memory-engine] Disposing (${this.sessions.size} active sessions)`);
        this.sessions.clear();
        this.qmdClient = null;
        this.daemonRunning = false;
    }
    // ── Private helpers ─────────────────────────────────────────────────────────
    /**
     * Get existing session state or create a new one.
     * Lazily initializes if bootstrap() wasn't called first.
     */
    getOrCreateSession(sessionId, sessionKey) {
        let session = this.sessions.get(sessionId);
        if (!session) {
            let workspaceDir;
            try {
                workspaceDir = this.deps.resolveWorkspaceDir(sessionId, sessionKey);
            }
            catch {
                workspaceDir = `.`;
            }
            session = {
                workspaceDir,
                initialized: false,
                compacting: false,
                pendingCompaction: false,
                lastFlushedCount: 0,
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
                    for (const block of content) {
                        if (typeof block === "string")
                            return block;
                        if (block.type === "text" &&
                            block.text) {
                            return block.text;
                        }
                    }
                }
                continue;
            }
        }
        return null;
    }
}
//# sourceMappingURL=engine.js.map