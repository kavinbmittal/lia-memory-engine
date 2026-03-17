/**
 * Type definitions for the Lia Memory Engine plugin.
 *
 * These types define the plugin's configuration, dependencies,
 * and internal data structures. The OpenClaw plugin API types
 * are kept as `any` to avoid coupling to a specific SDK version.
 */
/** Parsed plugin configuration (from openclaw.plugin.json configSchema). */
export interface LiaConfig {
    enabled: boolean;
    compactionThreshold: number;
    compactionModel: string;
    freshTailCount: number;
    autoRetrieval: boolean;
    autoRetrievalTimeoutMs: number;
    transcriptRetentionDays: number;
}
/** Default configuration values — matches openclaw.plugin.json defaults. */
export declare const DEFAULT_CONFIG: LiaConfig;
/**
 * Injected dependencies from the OpenClaw plugin API.
 * Decouples engine internals from the specific API shape.
 */
export interface LiaDependencies {
    /**
     * Call a model for text completion. Used for compaction summarization.
     * Takes a model identifier, system prompt, and user content.
     * Returns the text response.
     */
    completeFn: (model: string, systemPrompt: string, userContent: string) => Promise<string>;
    /** Logger from the OpenClaw API. */
    logger: {
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
    };
    /**
     * Resolve workspace directory for a given session.
     * Returns the absolute path to the agent's workspace directory.
     */
    resolveWorkspaceDir: (sessionId: string) => string;
}
/**
 * A message in the agent's conversation.
 * Compatible with OpenClaw's AgentMessage type.
 */
export interface AgentMessage {
    role: "user" | "assistant";
    content: string | ContentBlock[];
}
/** Content block within a message (text, tool_use, tool_result, etc.) */
export interface ContentBlock {
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
    content?: string | ContentBlock[];
    [key: string]: unknown;
}
/** BM25 search result from memory files. */
export interface SearchMatch {
    line: number;
    context: string;
    timestamp?: string;
}
export interface SearchResult {
    file: string;
    matches: SearchMatch[];
    matchCount: number;
}
/** BM25 document for ranking. */
export interface BM25Doc {
    id: string;
    content: string;
}
export interface RankedDocument {
    id: string;
    score: number;
}
