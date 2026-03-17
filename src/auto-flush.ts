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

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage, ContentBlock } from "./types.js";

/**
 * Extract readable text from a message content block.
 * Handles text, tool_use, tool_result, and unknown block types.
 */
export function extractContentText(content: string | ContentBlock): string {
  if (typeof content === "string") return content;

  const block = content as ContentBlock;
  if (block.type === "text") return (block.text as string) ?? "";
  if (block.type === "tool_use") return `[Used tool: ${block.name}]`;
  if (block.type === "tool_result") {
    const raw = typeof block.content === "string"
      ? block.content
      : JSON.stringify(block.content);
    return `[Tool result: ${raw.slice(0, 200)}]`;
  }
  return "";
}

/**
 * Extract all readable text from a message's content field.
 * Handles both plain strings and arrays of content blocks.
 */
function extractMessageText(msg: AgentMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as ContentBlock[])
      .map((block) => extractContentText(block))
      .filter(Boolean)
      .join("\n");
  }
  return "[unknown content]";
}

/**
 * Format messages as a readable markdown transcript.
 * Output: "## HH:MM\n\n**User:** text\n\n**Agent:** text\n\n---"
 */
export function formatTranscript(messages: AgentMessage[]): string {
  if (messages.length === 0) return "";

  const now = new Date();
  const time = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const lines: string[] = [`## ${time}`];

  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Agent";
    const text = extractMessageText(msg);
    // Skip empty tool-only blocks
    if (!text.trim()) continue;
    lines.push(`\n**${role}:** ${text}`);
  }

  lines.push("\n---\n");
  return lines.join("\n");
}

/**
 * Write messages to the daily transcript file.
 * Appends to memory/daily/YYYY-MM-DD.md, creating directories as needed.
 *
 * @param workspaceDir - Absolute path to the agent's workspace directory
 * @param messages - Messages to write to the transcript
 */
export async function writeTranscript(
  workspaceDir: string,
  messages: AgentMessage[]
): Promise<void> {
  if (messages.length === 0) return;

  const dailyDir = join(workspaceDir, "memory", "daily");
  await mkdir(dailyDir, { recursive: true });

  const date = new Date().toISOString().split("T")[0];
  const logPath = join(dailyDir, `${date}.md`);

  const transcript = formatTranscript(messages);
  if (transcript) {
    await appendFile(logPath, `\n${transcript}`, "utf-8");
  }
}
