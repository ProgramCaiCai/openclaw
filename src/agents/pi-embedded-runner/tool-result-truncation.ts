import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  hardTruncateText,
  TOOL_OUTPUT_HARD_MAX_BYTES,
  TOOL_OUTPUT_HARD_MAX_LINES,
} from "../tool-output-hard-cap.js";
import { log } from "./logger.js";

/**
 * Maximum share of the context window a single tool result should occupy.
 * This is intentionally conservative – a single tool result should not
 * consume more than 30% of the context window even without other messages.
 */
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/**
 * Hard character limit for a single tool result text block.
 * Even for the largest context windows (~2M tokens), a single tool result
 * should not exceed ~400K characters (~100K tokens).
 * This acts as a safety net when we don't know the context window size.
 */
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;

/**
 * Minimum characters to keep when truncating.
 * We always keep at least the first portion so the model understands
 * what was in the content.
 */
const MIN_KEEP_CHARS = 2_000;

/**
 * Suffix appended to truncated tool results.
 */
const TRUNCATION_SUFFIX =
  "⚠️ [Content truncated - original was too large for the model's context window. " +
  "The content above is a partial view. If you need more, request specific sections or use " +
  "offset/limit parameters to read smaller chunks.]";

/**
 * Truncate a single text string to fit within maxChars, preserving the beginning.
 * Always enforces the global hard cap (bytes + lines) as a final safety net.
 */
export function truncateToolResultText(text: string, maxChars: number): string {
  const suffixText = `\n${TRUNCATION_SUFFIX}`;
  const withinChars = text.length <= maxChars;

  let out = text;
  if (!withinChars) {
    const keepChars = Math.max(MIN_KEEP_CHARS, maxChars - suffixText.length);
    // Try to break at a newline boundary to avoid cutting mid-line
    let cutPoint = keepChars;
    const lastNewline = text.lastIndexOf("\n", keepChars);
    if (lastNewline > keepChars * 0.8) {
      cutPoint = lastNewline;
    }
    out = text.slice(0, cutPoint) + suffixText;
  }

  return hardTruncateText(out, {
    maxBytes: TOOL_OUTPUT_HARD_MAX_BYTES,
    maxLines: TOOL_OUTPUT_HARD_MAX_LINES,
    suffix: TRUNCATION_SUFFIX,
  }).text;
}

/**
 * Calculate the maximum allowed characters for a single tool result
 * based on the model's context window tokens.
 *
 * Uses a rough 4 chars ≈ 1 token heuristic (conservative for English text;
 * actual ratio varies by tokenizer).
 */
export function calculateMaxToolResultChars(contextWindowTokens: number): number {
  const maxTokens = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE);
  // Rough conversion: ~4 chars per token on average
  const maxChars = maxTokens * 4;
  return Math.min(maxChars, HARD_MAX_TOOL_RESULT_CHARS);
}

/**
 * Get the total character count of text content blocks in a tool result message.
 */
function getToolResultTextLength(msg: AgentMessage): number {
  if (!msg || (msg as { role?: string }).role !== "toolResult") {
    return 0;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return 0;
  }
  let totalLength = 0;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as TextContent).text;
      if (typeof text === "string") {
        totalLength += text.length;
      }
    }
  }
  return totalLength;
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      lines += 1;
    }
  }
  return lines;
}

function getToolResultTextMetrics(msg: AgentMessage): { bytes: number; lines: number } {
  if (!msg || (msg as { role?: string }).role !== "toolResult") {
    return { bytes: 0, lines: 0 };
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { bytes: 0, lines: 0 };
  }
  let bytes = 0;
  let lines = 0;
  let blocks = 0;
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      continue;
    }
    const text = (block as TextContent).text;
    if (typeof text !== "string" || !text) {
      continue;
    }
    blocks += 1;
    bytes += Buffer.byteLength(text, "utf8");
    lines += countLines(text);
  }
  // Approximate the bytes of joining multiple blocks with newlines.
  if (blocks > 1) {
    bytes += blocks - 1;
  }
  return { bytes, lines };
}

/**
 * Truncate a tool result message's text content blocks to fit within maxChars.
 * Returns a new message (does not mutate the original).
 */
function truncateToolResultMessage(msg: AgentMessage, maxChars: number): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      continue;
    }
    const text = (block as TextContent).text;
    if (typeof text === "string" && text) {
      texts.push(text);
    }
  }

  if (texts.length === 0) {
    return msg;
  }

  const combined = texts.join("\n");
  const truncated = truncateToolResultText(combined, maxChars);
  return { ...msg, content: [{ type: "text", text: truncated }] } as AgentMessage;
}

/**
 * Find oversized tool result entries in a session and truncate them.
 *
 * This operates on the session file by:
 * 1. Opening the session manager
 * 2. Walking the current branch to find oversized tool results
 * 3. Branching from before the first oversized tool result
 * 4. Re-appending all entries from that point with truncated tool results
 *
 * @returns Object indicating whether any truncation was performed
 */
export async function truncateOversizedToolResultsInSession(params: {
  sessionFile: string;
  contextWindowTokens: number;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  const { sessionFile, contextWindowTokens } = params;
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);

  try {
    const sessionManager = SessionManager.open(sessionFile);
    const branch = sessionManager.getBranch();

    if (branch.length === 0) {
      return { truncated: false, truncatedCount: 0, reason: "empty session" };
    }

    // Find oversized tool result entries and their indices in the branch
    const oversizedIndices: number[] = [];
    for (let i = 0; i < branch.length; i++) {
      const entry = branch[i];
      if (entry.type !== "message") {
        continue;
      }
      const msg = entry.message;
      if ((msg as { role?: string }).role !== "toolResult") {
        continue;
      }
      const textLength = getToolResultTextLength(msg);
      const metrics = getToolResultTextMetrics(msg);
      const hardOversize =
        metrics.bytes > TOOL_OUTPUT_HARD_MAX_BYTES || metrics.lines > TOOL_OUTPUT_HARD_MAX_LINES;
      if (textLength > maxChars || hardOversize) {
        oversizedIndices.push(i);
        log.info(
          `[tool-result-truncation] Found oversized tool result: ` +
            `entry=${entry.id} chars=${textLength} bytes=${metrics.bytes} lines=${metrics.lines} ` +
            `maxChars=${maxChars} hardMaxBytes=${TOOL_OUTPUT_HARD_MAX_BYTES} hardMaxLines=${TOOL_OUTPUT_HARD_MAX_LINES} ` +
            `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
        );
      }
    }

    if (oversizedIndices.length === 0) {
      return { truncated: false, truncatedCount: 0, reason: "no oversized tool results" };
    }

    // Branch from the parent of the first oversized entry
    const firstOversizedIdx = oversizedIndices[0];
    const firstOversizedEntry = branch[firstOversizedIdx];
    const branchFromId = firstOversizedEntry.parentId;

    if (!branchFromId) {
      // The oversized entry is the root - very unusual but handle it
      sessionManager.resetLeaf();
    } else {
      sessionManager.branch(branchFromId);
    }

    // Re-append all entries from the first oversized one onwards,
    // with truncated tool results
    const oversizedSet = new Set(oversizedIndices);
    let truncatedCount = 0;

    for (let i = firstOversizedIdx; i < branch.length; i++) {
      const entry = branch[i];

      if (entry.type === "message") {
        let message = entry.message;

        if (oversizedSet.has(i)) {
          message = truncateToolResultMessage(message, maxChars);
          truncatedCount++;
          const newLength = getToolResultTextLength(message);
          log.info(
            `[tool-result-truncation] Truncated tool result: ` +
              `originalEntry=${entry.id} newChars=${newLength} ` +
              `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
          );
        }

        // appendMessage expects Message | CustomMessage | BashExecutionMessage
        sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
      } else if (entry.type === "compaction") {
        sessionManager.appendCompaction(
          entry.summary,
          entry.firstKeptEntryId,
          entry.tokensBefore,
          entry.details,
          entry.fromHook,
        );
      } else if (entry.type === "thinking_level_change") {
        sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
      } else if (entry.type === "model_change") {
        sessionManager.appendModelChange(entry.provider, entry.modelId);
      } else if (entry.type === "custom") {
        sessionManager.appendCustomEntry(entry.customType, entry.data);
      } else if (entry.type === "custom_message") {
        sessionManager.appendCustomMessageEntry(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
        );
      } else if (entry.type === "branch_summary") {
        // Preserve branch summaries so context from abandoned paths is not lost.
        // The fromId reference may be stale after rewrite, but the summary text
        // is the critical piece for LLM context.
        sessionManager.branchWithSummary(null, entry.summary, entry.details, entry.fromHook);
      } else if (entry.type === "label") {
        // Preserve labels. The targetId may reference an old entry ID after rewrite,
        // but retaining the label is better than silently discarding it.
        if (entry.label) {
          sessionManager.appendLabelChange(entry.targetId, entry.label);
        }
      } else if (entry.type === "session_info") {
        if (entry.name) {
          sessionManager.appendSessionInfo(entry.name);
        }
      }
    }

    log.info(
      `[tool-result-truncation] Truncated ${truncatedCount} tool result(s) in session ` +
        `(contextWindow=${contextWindowTokens} maxChars=${maxChars}) ` +
        `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
    );

    return { truncated: true, truncatedCount };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  }
}

/**
 * Truncate oversized tool results in an array of messages (in-memory).
 * Returns a new array with truncated messages.
 *
 * This is used as a pre-emptive guard before sending messages to the LLM,
 * without modifying the session file.
 */
export function truncateOversizedToolResultsInMessages(
  messages: AgentMessage[],
  contextWindowTokens: number,
): { messages: AgentMessage[]; truncatedCount: number } {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  let truncatedCount = 0;

  const result = messages.map((msg) => {
    if ((msg as { role?: string }).role !== "toolResult") {
      return msg;
    }
    if (!isOversizedToolResult(msg, contextWindowTokens)) {
      return msg;
    }
    truncatedCount++;
    return truncateToolResultMessage(msg, maxChars);
  });

  return { messages: result, truncatedCount };
}

/**
 * Check if a tool result message exceeds the size limit for a given context window.
 */
export function isOversizedToolResult(msg: AgentMessage, contextWindowTokens: number): boolean {
  if ((msg as { role?: string }).role !== "toolResult") {
    return false;
  }
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  const textLength = getToolResultTextLength(msg);
  if (textLength > maxChars) {
    return true;
  }

  // Global hard cap (fixed) - protects overflow recovery paths regardless of context size.
  const metrics = getToolResultTextMetrics(msg);
  return metrics.bytes > TOOL_OUTPUT_HARD_MAX_BYTES || metrics.lines > TOOL_OUTPUT_HARD_MAX_LINES;
}

/**
 * Estimate whether the session likely has oversized tool results that caused
 * a context overflow. Used as a heuristic to decide whether to attempt
 * tool result truncation before giving up.
 */
export function sessionLikelyHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
}): boolean {
  const { messages, contextWindowTokens } = params;

  for (const msg of messages) {
    if (isOversizedToolResult(msg, contextWindowTokens)) {
      return true;
    }
  }

  return false;
}
