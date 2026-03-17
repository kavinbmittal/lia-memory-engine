/**
 * Auto-flush: write every message to daily transcript files.
 *
 * Ported from Lia's auto-flush.ts + transcript.ts. Every conversation
 * turn is immediately written to memory/daily/YYYY-MM-DD.md as raw
 * transcript — so nothing is ever lost, even if the session resets
 * or crashes.
 *
 * Adapted for OpenClaw: uses workspaceDir instead of telegramId-based
 * workspace lookup, and labels output "Agent" instead of "Lia."
 */
import type { AgentMessage, ContentBlock } from "./types.js";
/**
 * Extract readable text from a message content block.
 * Handles text, tool_use, tool_result, and unknown block types.
 */
export declare function extractContentText(content: string | ContentBlock): string;
/**
 * Format messages as a readable markdown transcript.
 * Output: "## HH:MM\n\n**User:** text\n\n**Agent:** text\n\n---"
 */
export declare function formatTranscript(messages: AgentMessage[]): string;
/**
 * Write messages to the daily transcript file.
 * Appends to memory/daily/YYYY-MM-DD.md, creating directories as needed.
 *
 * @param workspaceDir - Absolute path to the agent's workspace directory
 * @param messages - Messages to write to the transcript
 */
export declare function writeTranscript(workspaceDir: string, messages: AgentMessage[]): Promise<void>;
