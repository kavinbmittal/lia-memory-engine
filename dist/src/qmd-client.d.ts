/**
 * QMDClient — wraps the QMD HTTP daemon and CLI for hybrid search + LLM reranking.
 *
 * QMD (https://github.com/tobi/qmd) provides BM25, vector, and HyDE search over
 * a collection of markdown files. This client manages the daemon lifecycle and
 * exposes a clean search interface for the Lia Memory Engine.
 *
 * Daemon is best-effort: if `qmd` is not installed, all search calls return "".
 */
/** Logger interface — matches the OpenClaw logger shape. */
interface Logger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}
/** Options for constructing a QMDClient. */
export interface QMDClientOptions {
    host: string;
    port: number;
    collectionName: string;
    /** Absolute path to the memory directory to register as a collection. */
    memoryDir: string;
    enableVectorSearch: boolean;
    logger: Logger;
}
export declare class QMDClient {
    private readonly host;
    private readonly port;
    private readonly collectionName;
    private readonly memoryDir;
    private readonly enableVectorSearch;
    private readonly logger;
    private readonly baseUrl;
    constructor(opts: QMDClientOptions);
    /**
     * Check if the QMD daemon is reachable.
     * GET /health with a 1-second timeout.
     * Returns true only if the response is HTTP 200.
     */
    isRunning(): Promise<boolean>;
    /**
     * Spawn `qmd mcp --http --daemon` and wait for the health endpoint to respond.
     * Polls /health every 500ms for up to 10 seconds.
     * Returns true if the daemon started successfully, false otherwise.
     *
     * This is best-effort: if `qmd` is not installed, the spawn will fail silently
     * and this method returns false. All downstream search calls handle that gracefully.
     */
    startDaemon(): Promise<boolean>;
    /**
     * Register the memory directory as a QMD collection.
     * Runs `qmd collection add {memoryDir} --name {collectionName}`.
     *
     * Non-fatal: logs a warning if it fails (collection may already exist,
     * or qmd may not be installed).
     */
    ensureCollection(): Promise<void>;
    /**
     * Trigger background embedding for the collection.
     * Fire-and-forget: runs `qmd embed -c {collectionName}` without awaiting.
     * Logs completion or failure when the process exits.
     */
    embedBackground(): void;
    /**
     * Search the QMD collection via the HTTP daemon.
     * Uses hybrid search when enableVectorSearch is true:
     *   - full=true  → ["lex","vec","hyde"] (BM25 + vector + HyDE reranking)
     *   - full=false → ["lex","vec"]        (BM25 + vector)
     *   - enableVectorSearch=false → ["lex"] (BM25 only, no model download needed)
     *
     * Throws on HTTP error or JSON-RPC error so callers can fall back to CLI.
     */
    search(query: string, opts: {
        n?: number;
        full?: boolean;
        timeoutMs?: number;
    }): Promise<string>;
    /**
     * Search via the QMD CLI — used when the daemon is not running.
     * Runs `qmd search <query> -c <collectionName> -n 5` with a 3-second timeout.
     * Returns stdout, or empty string if the command fails.
     *
     * Uses execFile (not exec) to prevent shell injection — query is passed as a
     * discrete argument, never interpolated into a shell string.
     */
    searchCLI(query: string): Promise<string>;
}
export {};
