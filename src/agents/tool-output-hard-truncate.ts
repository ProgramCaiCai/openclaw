import type { TextContent } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { sliceUtf16Safe } from "../utils.js";

export type ToolOutputHardLimits = {
  maxBytesUtf8: number;
  maxLines: number;
  suffix: string;
};

export const DEFAULT_TOOL_OUTPUT_HARD_LIMITS: ToolOutputHardLimits = {
  maxBytesUtf8: 50 * 1024,
  maxLines: 2000,
  suffix:
    "\n\n[tool output truncated: exceeded 50KB or 2000 lines; request smaller chunks (offset/limit) or specific sections]",
};

function countNewlines(text: string): number {
  let count = 0;
  let idx = -1;
  while (true) {
    idx = text.indexOf("\n", idx + 1);
    if (idx === -1) {
      return count;
    }
    count++;
  }
}

export function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return 1 + countNewlines(text);
}

export function countBytesUtf8(text: string): number {
  if (!text) {
    return 0;
  }
  return Buffer.byteLength(text, "utf8");
}

function cutByLines(text: string, maxLines: number): { cut: string; wasCut: boolean } {
  if (!text) {
    return { cut: text, wasCut: false };
  }
  const limit = Math.max(0, Math.floor(maxLines));
  if (limit === 0) {
    return { cut: "", wasCut: text.length > 0 };
  }
  let newlineCount = 0;
  let from = 0;
  while (true) {
    const idx = text.indexOf("\n", from);
    if (idx === -1) {
      return { cut: text, wasCut: false };
    }
    newlineCount++;
    if (newlineCount >= limit) {
      return { cut: text.slice(0, idx), wasCut: true };
    }
    from = idx + 1;
  }
}

function truncateUtf8Bytes(text: string, maxBytesUtf8: number): { cut: string; wasCut: boolean } {
  if (!text) {
    return { cut: text, wasCut: false };
  }
  const limit = Math.max(0, Math.floor(maxBytesUtf8));
  if (limit === 0) {
    return { cut: "", wasCut: text.length > 0 };
  }
  if (countBytesUtf8(text) <= limit) {
    return { cut: text, wasCut: false };
  }

  // Binary search on UTF-16 code unit boundary using UTF-8 byte measurement.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = sliceUtf16Safe(text, 0, mid);
    const bytes = countBytesUtf8(slice);
    if (bytes <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { cut: sliceUtf16Safe(text, 0, lo), wasCut: true };
}

function truncateTextHard(
  text: string,
  limits: ToolOutputHardLimits,
): { text: string; truncated: boolean } {
  const maxLines = Math.max(0, Math.floor(limits.maxLines));
  const maxBytes = Math.max(0, Math.floor(limits.maxBytesUtf8));

  const suffixBase = limits.suffix || "";
  const suffix = (() => {
    if (!suffixBase) {
      return "";
    }
    // Ensure suffix itself fits the budget.
    let out = suffixBase;
    const byLines = cutByLines(out, maxLines);
    out = byLines.cut;
    const byBytes = truncateUtf8Bytes(out, maxBytes);
    return byBytes.cut;
  })();

  const under = countLines(text) <= maxLines && countBytesUtf8(text) <= maxBytes;
  if (under) {
    return { text, truncated: false };
  }

  const suffixLines = countLines(suffix);
  const suffixBytes = countBytesUtf8(suffix);
  const prefixMaxLines = suffix ? Math.max(0, maxLines - suffixLines + 1) : maxLines;
  const prefixMaxBytes = suffix ? Math.max(0, maxBytes - suffixBytes) : maxBytes;

  let prefix = cutByLines(text, prefixMaxLines).cut;
  prefix = truncateUtf8Bytes(prefix, prefixMaxBytes).cut;

  const combined = prefix ? `${prefix}${suffix}` : suffix;
  // Final guard: ensure we never exceed the hard budgets.
  const finalByLines = cutByLines(combined, maxLines).cut;
  const finalByBytes = truncateUtf8Bytes(finalByLines, maxBytes).cut;

  return { text: finalByBytes, truncated: true };
}

type ToolTextBlock = TextContent & { type: "text" };

function isToolTextBlock(block: unknown): block is ToolTextBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const rec = block as { type?: unknown; text?: unknown };
  return rec.type === "text" && typeof rec.text === "string";
}

function isToolPayloadWithContent(payload: unknown): payload is { content: unknown[] } {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const rec = payload as { content?: unknown };
  return Array.isArray(rec.content);
}

/**
 * Hard-clamp a tool payload (tool result, tool update, or toolResult message) to fixed limits.
 * Only text blocks are truncated; non-text blocks are preserved until truncation occurs.
 */
export function hardTruncateToolPayload(
  payload: unknown,
  limits: ToolOutputHardLimits = DEFAULT_TOOL_OUTPUT_HARD_LIMITS,
): unknown {
  if (typeof payload === "string") {
    const res = truncateTextHard(payload, limits);
    return res.truncated ? res.text : payload;
  }

  if (!isToolPayloadWithContent(payload)) {
    return payload;
  }

  const original = payload as { content: unknown[] };
  const maxLines = Math.max(0, Math.floor(limits.maxLines));
  const maxBytes = Math.max(0, Math.floor(limits.maxBytesUtf8));

  let remainingLines = maxLines;
  let remainingBytes = maxBytes;

  const nextContent: unknown[] = [];
  let changed = false;
  let stopped = false;

  for (const block of original.content) {
    if (stopped) {
      changed = true;
      continue;
    }

    if (!isToolTextBlock(block)) {
      // Non-text blocks might still be important (e.g. metadata/images); keep them
      // until the first truncation triggers, then stop emitting blocks.
      nextContent.push(block);
      continue;
    }

    const text = block.text;
    const within = countLines(text) <= remainingLines && countBytesUtf8(text) <= remainingBytes;

    if (within) {
      nextContent.push(block);
      remainingLines = Math.max(0, remainingLines - countLines(text));
      remainingBytes = Math.max(0, remainingBytes - countBytesUtf8(text));
      continue;
    }

    // Truncate this block using the *remaining* shared budgets.
    const res = truncateTextHard(text, {
      ...limits,
      maxLines: remainingLines,
      maxBytesUtf8: remainingBytes,
    });

    const nextBlock = res.truncated ? { ...block, text: res.text } : block;
    nextContent.push(nextBlock);

    changed = changed || res.truncated;
    stopped = true;
  }

  if (!changed) {
    return payload;
  }

  return { ...(payload as Record<string, unknown>), content: nextContent };
}

export function hardTruncateToolError(
  err: unknown,
  limits: ToolOutputHardLimits = DEFAULT_TOOL_OUTPUT_HARD_LIMITS,
): unknown {
  if (typeof err === "string") {
    return new Error(String(hardTruncateToolPayload(err, limits)));
  }
  if (!(err instanceof Error)) {
    return err;
  }

  const message = typeof err.message === "string" ? err.message : "";
  const truncated = hardTruncateToolPayload(message, limits);
  if (typeof truncated !== "string" || truncated === message) {
    return err;
  }

  const next = new Error(truncated);
  next.name = err.name;
  // Preserve stack for debugging while ensuring the message sent to the model is bounded.
  if (typeof err.stack === "string") {
    next.stack = err.stack;
  }
  return next;
}

export function wrapToolWithHardOutputTruncate(
  tool: AnyAgentTool,
  limits: ToolOutputHardLimits = DEFAULT_TOOL_OUTPUT_HARD_LIMITS,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const safeOnUpdate = onUpdate
        ? (partial: unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onUpdate(hardTruncateToolPayload(partial, limits) as any);
          }
        : onUpdate;

      try {
        const result = await execute(toolCallId, params, signal, safeOnUpdate);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return hardTruncateToolPayload(result, limits) as any;
      } catch (err) {
        throw hardTruncateToolError(err, limits);
      }
    },
  };
}
