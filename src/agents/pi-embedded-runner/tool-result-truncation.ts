import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentContextPruningConfig } from "../../config/types.agent-defaults.js";
import { log } from "./logger.js";

type ResolvedToolResultPruningSettings = {
  minPrunableToolChars: number;
  softTrim: { maxChars: number; headChars: number; tailChars: number };
};

const DEFAULT_SETTINGS: ResolvedToolResultPruningSettings = {
  minPrunableToolChars: 4000,
  softTrim: { maxChars: 2000, headChars: 800, tailChars: 800 },
};

function resolveToolResultPruningSettings(
  raw?: AgentContextPruningConfig,
): ResolvedToolResultPruningSettings {
  const rawMin = raw?.minPrunableToolChars;
  const minPrunableToolChars =
    typeof rawMin === "number" && Number.isFinite(rawMin)
      ? Math.max(0, Math.floor(rawMin))
      : DEFAULT_SETTINGS.minPrunableToolChars;

  const rawMaxChars = raw?.softTrim?.maxChars;
  const rawHeadChars = raw?.softTrim?.headChars;
  const rawTailChars = raw?.softTrim?.tailChars;
  const softTrim = {
    maxChars:
      typeof rawMaxChars === "number" && Number.isFinite(rawMaxChars)
        ? Math.max(0, Math.floor(rawMaxChars))
        : DEFAULT_SETTINGS.softTrim.maxChars,
    headChars:
      typeof rawHeadChars === "number" && Number.isFinite(rawHeadChars)
        ? Math.max(0, Math.floor(rawHeadChars))
        : DEFAULT_SETTINGS.softTrim.headChars,
    tailChars:
      typeof rawTailChars === "number" && Number.isFinite(rawTailChars)
        ? Math.max(0, Math.floor(rawTailChars))
        : DEFAULT_SETTINGS.softTrim.tailChars,
  };

  return { minPrunableToolChars, softTrim };
}

function asText(text: string): TextContent {
  return { type: "text", text };
}

function collectTextSegments(content: ReadonlyArray<TextContent | ImageContent>): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
  if (parts.length === 0) {
    return 0;
  }
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  len += Math.max(0, parts.length - 1);
  return len;
}

function takeHeadFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  let out = "";
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += "\n";
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

function takeTailFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push("\n");
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join("");
}

function hasImageBlocks(content: ReadonlyArray<TextContent | ImageContent>): boolean {
  for (const block of content) {
    if (block.type === "image") {
      return true;
    }
  }
  return false;
}

function getToolResultJoinedTextLength(msg: AgentMessage): number {
  if (!msg || (msg as { role?: string }).role !== "toolResult") {
    return 0;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return 0;
  }
  const typed = content as Array<TextContent | ImageContent>;
  if (hasImageBlocks(typed)) {
    return 0;
  }
  const parts = collectTextSegments(typed);
  return estimateJoinedTextLength(parts);
}

function pruneToolResultMessage(params: {
  msg: AgentMessage;
  settings: ResolvedToolResultPruningSettings;
}): { next: AgentMessage; changed: boolean; rawLen: number } {
  const { msg, settings } = params;
  if ((msg as { role?: string }).role !== "toolResult") {
    return { next: msg, changed: false, rawLen: 0 };
  }

  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return { next: msg, changed: false, rawLen: 0 };
  }

  const typed = content as Array<TextContent | ImageContent>;
  if (hasImageBlocks(typed)) {
    return { next: msg, changed: false, rawLen: 0 };
  }

  const parts = collectTextSegments(typed);
  const rawLen = estimateJoinedTextLength(parts);
  if (rawLen <= settings.minPrunableToolChars) {
    return { next: msg, changed: false, rawLen };
  }

  const maxChars = Math.max(0, settings.softTrim.maxChars);
  if (maxChars === 0) {
    return { next: msg, changed: false, rawLen };
  }

  const sep = "\n...\n";
  let headBudget = Math.max(0, settings.softTrim.headChars);
  let tailBudget = Math.max(0, settings.softTrim.tailChars);

  const sepLen = headBudget > 0 && tailBudget > 0 ? sep.length : 0;
  if (headBudget + tailBudget + sepLen > maxChars) {
    const available = Math.max(0, maxChars - sepLen);
    const half = Math.floor(available / 2);
    headBudget = Math.min(headBudget, half);
    tailBudget = Math.min(tailBudget, available - headBudget);
  }

  if (headBudget === 0 || tailBudget === 0) {
    const available = maxChars;
    headBudget = Math.min(Math.max(0, settings.softTrim.headChars), available);
    tailBudget = Math.min(Math.max(0, settings.softTrim.tailChars), available - headBudget);
  }

  const head = headBudget > 0 ? takeHeadFromJoinedText(parts, headBudget) : "";
  const tail = tailBudget > 0 ? takeTailFromJoinedText(parts, tailBudget) : "";

  let trimmed = "";
  if (head && tail) {
    trimmed = `${head}${sep}${tail}`;
  } else {
    trimmed = head || tail;
  }

  if (trimmed.length > maxChars) {
    trimmed = trimmed.slice(0, maxChars);
  }

  const next: ToolResultMessage = {
    ...(msg as unknown as ToolResultMessage),
    content: [asText(trimmed)],
  };
  return { next: next as unknown as AgentMessage, changed: true, rawLen };
}

// --- EXPORTED FUNCTIONS ---

/**
 * Pre-compaction rewrite: prune oversized tool results in a session transcript.
 * Uses the contextPruning config (softTrim head+tail), not the execution-time hard cap.
 */
export async function truncateOversizedToolResultsInSession(params: {
  sessionFile: string;
  contextWindowTokens: number;
  contextPruning?: AgentContextPruningConfig;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  const { sessionFile } = params;
  const settings = resolveToolResultPruningSettings(params.contextPruning);

  try {
    const sessionManager = SessionManager.open(sessionFile);
    const branch = sessionManager.getBranch();

    if (branch.length === 0) {
      return { truncated: false, truncatedCount: 0, reason: "empty session" };
    }

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
      const rawLen = getToolResultJoinedTextLength(msg);
      if (rawLen <= settings.minPrunableToolChars) {
        continue;
      }
      oversizedIndices.push(i);
      log.info(
        `[tool-result-truncation] Found toolResult requiring pre-compaction pruning: ` +
          `entry=${entry.id} chars=${rawLen} ` +
          `minPrunableToolChars=${settings.minPrunableToolChars} ` +
          `softTrimMaxChars=${settings.softTrim.maxChars} ` +
          `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
      );
    }

    if (oversizedIndices.length === 0) {
      return { truncated: false, truncatedCount: 0, reason: "no prunable tool results" };
    }

    const firstOversizedIdx = oversizedIndices[0];
    const firstOversizedEntry = branch[firstOversizedIdx];
    const branchFromId = firstOversizedEntry.parentId;

    // S1 fix: pre-scan for unknown entry types before destructive rewrite
    const KNOWN_ENTRY_TYPES = new Set([
      "message",
      "compaction",
      "thinking_level_change",
      "model_change",
      "custom",
      "custom_message",
      "branch_summary",
      "label",
      "session_info",
    ]);
    for (let i = firstOversizedIdx; i < branch.length; i++) {
      const entryType = (branch[i] as { type?: string }).type;
      if (entryType && !KNOWN_ENTRY_TYPES.has(entryType)) {
        log.warn(
          `[tool-result-truncation] Unknown entry type "${entryType}" at index ${i}, ` +
            `skipping rewrite to preserve data integrity. ` +
            `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
        );
        return { truncated: false, truncatedCount: 0, reason: `unknown entry type: ${entryType}` };
      }
    }

    if (!branchFromId) {
      sessionManager.resetLeaf();
    } else {
      sessionManager.branch(branchFromId);
    }

    let truncatedCount = 0;

    for (let i = firstOversizedIdx; i < branch.length; i++) {
      const entry = branch[i];

      if (entry.type === "message") {
        let message = entry.message;
        if ((message as { role?: string }).role === "toolResult") {
          const pruned = pruneToolResultMessage({ msg: message, settings });
          if (pruned.changed) {
            truncatedCount += 1;
            message = pruned.next;
            const newLen = getToolResultJoinedTextLength(message);
            log.info(
              `[tool-result-truncation] Rewrote toolResult (softTrim): ` +
                `originalEntry=${entry.id} originalChars=${pruned.rawLen} newChars=${newLen} ` +
                `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
            );
          }
        }
        sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
        continue;
      }

      if (entry.type === "compaction") {
        sessionManager.appendCompaction(
          entry.summary,
          entry.firstKeptEntryId,
          entry.tokensBefore,
          entry.details,
          entry.fromHook,
        );
        continue;
      }
      if (entry.type === "thinking_level_change") {
        sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
        continue;
      }
      if (entry.type === "model_change") {
        sessionManager.appendModelChange(entry.provider, entry.modelId);
        continue;
      }
      if (entry.type === "custom") {
        sessionManager.appendCustomEntry(entry.customType, entry.data);
        continue;
      }
      if (entry.type === "custom_message") {
        sessionManager.appendCustomMessageEntry(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
        );
        continue;
      }
      if (entry.type === "branch_summary") {
        sessionManager.branchWithSummary(null, entry.summary, entry.details, entry.fromHook);
        continue;
      }
      if (entry.type === "label") {
        if (entry.label) {
          sessionManager.appendLabelChange(entry.targetId, entry.label);
        }
        continue;
      }
      if (entry.type === "session_info") {
        if (entry.name) {
          sessionManager.appendSessionInfo(entry.name);
        }
        continue;
      }
    }

    log.info(
      `[tool-result-truncation] Rewrote ${truncatedCount} tool result(s) with pre-compaction pruning ` +
        `(contextWindow=${params.contextWindowTokens} tokens) ` +
        `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
    );
    return { truncated: truncatedCount > 0, truncatedCount };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  }
}

/**
 * Truncate oversized tool results in an array of messages (in-memory).
 * Returns a new array with truncated messages.
 */
export function truncateOversizedToolResultsInMessages(
  messages: AgentMessage[],
  _contextWindowTokens: number,
  contextPruning?: AgentContextPruningConfig,
): { messages: AgentMessage[]; truncatedCount: number } {
  const settings = resolveToolResultPruningSettings(contextPruning);
  let truncatedCount = 0;

  const result = messages.map((msg) => {
    if ((msg as { role?: string }).role !== "toolResult") {
      return msg;
    }
    const pruned = pruneToolResultMessage({ msg, settings });
    if (!pruned.changed) {
      return msg;
    }
    truncatedCount += 1;
    return pruned.next;
  });

  return { messages: result, truncatedCount };
}

/**
 * Check if a tool result message is eligible for pruning using contextPruning settings.
 */
export function isOversizedToolResult(
  msg: AgentMessage,
  _contextWindowTokens: number,
  contextPruning?: AgentContextPruningConfig,
): boolean {
  if ((msg as { role?: string }).role !== "toolResult") {
    return false;
  }
  const settings = resolveToolResultPruningSettings(contextPruning);
  const rawLen = getToolResultJoinedTextLength(msg);
  return rawLen > settings.minPrunableToolChars;
}

/**
 * Heuristic used by context-overflow recovery to decide whether to attempt a toolResult rewrite.
 */
export function sessionLikelyHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  contextPruning?: AgentContextPruningConfig;
}): boolean {
  const { messages, contextWindowTokens, contextPruning } = params;

  for (const msg of messages) {
    if (isOversizedToolResult(msg, contextWindowTokens, contextPruning)) {
      return true;
    }
  }

  return false;
}
