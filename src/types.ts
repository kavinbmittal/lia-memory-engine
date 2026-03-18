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
  autoRetrieval: boolean;
  autoRetrievalTimeoutMs: number;
  transcriptRetentionDays: number;
  /** Port for the QMD HTTP daemon (default 8181). */
  qmdPort: number;
  /** Host for the QMD HTTP daemon (default "localhost"). */
  qmdHost: string;
  /** QMD collection name for this agent's memory (default "lia-memory"). */
  qmdCollectionName: string;
  /** Enable vector semantic search — requires GGUF model download on first run (default false). */
  enableVectorSearch: boolean;
}

/** Default configuration values — matches openclaw.plugin.json defaults. */
export const DEFAULT_CONFIG: LiaConfig = {
  enabled: true,
  compactionThreshold: 0.80,
  compactionModel: "anthropic/claude-haiku-4-5",
  autoRetrieval: true,
  autoRetrievalTimeoutMs: 500,
  transcriptRetentionDays: 180,
  qmdPort: 8181,
  qmdHost: "localhost",
  qmdCollectionName: "lia-memory",
  enableVectorSearch: true,
};

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

  /**
   * Optional QMD client override — inject for testing or custom implementations.
   * When provided, the engine uses this directly and skips daemon lifecycle.
   */
  qmdClient?: import("./qmd-client.js").QMDClient;
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

