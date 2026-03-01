import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TextContent } from "@mariozechner/pi-ai";
import { sliceUtf16Safe } from "../utils.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import {
  TOOL_OUTPUT_HARD_MAX_BYTES,
  TOOL_OUTPUT_HARD_MAX_BYTES_EXEC,
  TOOL_OUTPUT_HARD_MAX_LINES,
  TOOL_OUTPUT_HARD_MAX_LINES_EXEC,
} from "./tool-output-hard-cap.js";

export type ToolOutputHardLimits = {
  maxBytesUtf8: number;
  maxLines: number;
  suffix: string;
};

const HARD_TRUNCATE_ARTIFACT_DIR = "/tmp/openclaw/artifacts";
const PREVIEW_SPLIT_MARKER = "...";

export const DEFAULT_TOOL_OUTPUT_HARD_LIMITS: ToolOutputHardLimits = {
  maxBytesUtf8: TOOL_OUTPUT_HARD_MAX_BYTES,
  maxLines: TOOL_OUTPUT_HARD_MAX_LINES,
  suffix:
    "Use read with offset/limit to inspect the saved artifact, or rerun with excludeFromContext=true.",
};

export const EXEC_TOOL_OUTPUT_HARD_LIMITS: ToolOutputHardLimits = {
  ...DEFAULT_TOOL_OUTPUT_HARD_LIMITS,
  maxBytesUtf8: TOOL_OUTPUT_HARD_MAX_BYTES_EXEC,
  maxLines: TOOL_OUTPUT_HARD_MAX_LINES_EXEC,
};

type TruncateContext = {
  toolCallId?: string;
  toolName?: string;
  artifactText?: string;
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

function cutTailByLines(text: string, maxLines: number): { cut: string; wasCut: boolean } {
  if (!text) {
    return { cut: text, wasCut: false };
  }
  const limit = Math.max(0, Math.floor(maxLines));
  if (limit === 0) {
    return { cut: "", wasCut: text.length > 0 };
  }

  let newlineCount = 0;
  let to = text.length;
  while (true) {
    const idx = text.lastIndexOf("\n", to - 1);
    if (idx === -1) {
      return { cut: text, wasCut: false };
    }
    newlineCount++;
    if (newlineCount >= limit) {
      return { cut: text.slice(idx + 1), wasCut: true };
    }
    to = idx;
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

function sliceUtf16SafeTail(text: string, tailCodeUnits: number): string {
  if (!text) {
    return text;
  }
  const len = Math.max(0, Math.floor(tailCodeUnits));
  if (len <= 0) {
    return "";
  }
  if (len >= text.length) {
    return text;
  }

  let start = text.length - len;
  const c = text.charCodeAt(start);
  if (c >= 0xdc00 && c <= 0xdfff && start > 0) {
    const prev = text.charCodeAt(start - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      start += 1;
    }
  }
  return text.slice(start);
}

function truncateUtf8BytesTail(
  text: string,
  maxBytesUtf8: number,
): { cut: string; wasCut: boolean } {
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

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = sliceUtf16SafeTail(text, mid);
    const bytes = countBytesUtf8(slice);
    if (bytes <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { cut: sliceUtf16SafeTail(text, lo), wasCut: true };
}

function sanitizeArtifactSegment(value: string | undefined, fallback: string): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalized = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function shortArtifactId(value: string | undefined): string {
  const normalized = sanitizeArtifactSegment(value, "call");
  return normalized.slice(-12);
}

function formatKiB(bytes: number): string {
  const kib = Math.max(0, bytes / 1024);
  if (kib >= 100) {
    return `${Math.round(kib)} KB`;
  }
  if (kib >= 10) {
    return `${kib.toFixed(1)} KB`;
  }
  return `${kib.toFixed(2)} KB`;
}

function writeTruncationArtifactSync(params: {
  toolName?: string;
  toolCallId?: string;
  text: string;
}): string | null {
  try {
    mkdirSync(HARD_TRUNCATE_ARTIFACT_DIR, { recursive: true });
    const fileName = `${Date.now()}-${sanitizeArtifactSegment(params.toolName, "tool")}-${shortArtifactId(params.toolCallId)}.txt`;
    const filePath = path.join(HARD_TRUNCATE_ARTIFACT_DIR, fileName);
    writeFileSync(filePath, params.text, "utf8");
    return filePath;
  } catch {
    return null;
  }
}

function truncateTextWithSuffix(
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
  const finalByLines = cutByLines(combined, maxLines).cut;
  const finalByBytes = truncateUtf8Bytes(finalByLines, maxBytes).cut;

  return { text: finalByBytes, truncated: true };
}

function makeHeadTailPreview(params: {
  text: string;
  maxLines: number;
  maxBytes: number;
  header: string;
}): string {
  const { text, maxLines, maxBytes, header } = params;
  if (!header) {
    return "";
  }

  let budgetScale = 1.0;
  for (let iter = 0; iter < 8; iter++) {
    const availableLines = Math.max(0, maxLines - countLines(header));
    const availableBytes = Math.max(0, maxBytes - countBytesUtf8(header) - 1);

    if (availableLines <= 0 || availableBytes <= 0) {
      break;
    }

    const bodyLinesBudget = Math.max(1, Math.floor(availableLines * budgetScale));
    const bodyBytesBudget = Math.max(1, Math.floor(availableBytes * budgetScale));

    const headLinesBudget = Math.ceil(bodyLinesBudget / 2);
    const tailLinesBudget = Math.max(1, bodyLinesBudget - headLinesBudget);
    const headBytesBudget = Math.ceil(bodyBytesBudget / 2);
    const tailBytesBudget = Math.max(1, bodyBytesBudget - headBytesBudget);

    let head = cutByLines(text, headLinesBudget).cut;
    head = truncateUtf8Bytes(head, headBytesBudget).cut;

    let tail = cutTailByLines(text, tailLinesBudget).cut;
    tail = truncateUtf8BytesTail(tail, tailBytesBudget).cut;

    const body: string[] = [];
    if (head) {
      body.push(head);
    }
    if (head && tail) {
      body.push(PREVIEW_SPLIT_MARKER);
    }
    if (tail) {
      body.push(tail);
    }

    const out = body.length > 0 ? `${header}\n${body.join("\n")}` : header;
    if (countLines(out) <= maxLines && countBytesUtf8(out) <= maxBytes) {
      return out;
    }

    budgetScale *= 0.8;
  }

  const clipped = cutByLines(header, maxLines).cut;
  return truncateUtf8Bytes(clipped, maxBytes).cut;
}

function truncateTextHard(
  text: string,
  limits: ToolOutputHardLimits,
  context?: TruncateContext,
): { text: string; truncated: boolean } {
  const maxLines = Math.max(0, Math.floor(limits.maxLines));
  const maxBytes = Math.max(0, Math.floor(limits.maxBytesUtf8));
  const under = countLines(text) <= maxLines && countBytesUtf8(text) <= maxBytes;
  if (under) {
    return { text, truncated: false };
  }

  const fullText = context?.artifactText ?? text;
  const artifactPath = writeTruncationArtifactSync({
    toolName: context?.toolName,
    toolCallId: context?.toolCallId,
    text: fullText,
  });
  if (!artifactPath) {
    return truncateTextWithSuffix(text, limits);
  }

  const fullBytes = countBytesUtf8(fullText);
  const fullLines = countLines(fullText);
  const baseHeader = `[Full output (${formatKiB(fullBytes)} / ${fullLines} lines) saved to ${artifactPath}; showing head+tail preview]`;
  const guidance = limits.suffix.trim();
  const header = guidance ? `${baseHeader}\n${guidance}` : baseHeader;
  const preview = makeHeadTailPreview({ text, maxLines, maxBytes, header });

  const finalByLines = cutByLines(preview, maxLines).cut;
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
  context?: TruncateContext,
): unknown {
  if (typeof payload === "string") {
    const res = truncateTextHard(payload, limits, context);
    return res.truncated ? res.text : payload;
  }

  if (!isToolPayloadWithContent(payload)) {
    return payload;
  }

  const original = payload as { content: unknown[] };
  const artifactText = original.content
    .filter(isToolTextBlock)
    .map((block) => block.text)
    .join("\n");
  const truncateContext =
    artifactText.length > 0
      ? { ...context, artifactText: context?.artifactText ?? artifactText }
      : context;

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
    const res = truncateTextHard(
      text,
      {
        ...limits,
        maxLines: remainingLines,
        maxBytesUtf8: remainingBytes,
      },
      truncateContext,
    );

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
  context?: TruncateContext,
): unknown {
  if (typeof err === "string") {
    return new Error(String(hardTruncateToolPayload(err, limits, context)));
  }
  if (!(err instanceof Error)) {
    return err;
  }

  const message = typeof err.message === "string" ? err.message : "";
  const truncated = hardTruncateToolPayload(message, limits, context);
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
      const context: TruncateContext = {
        toolCallId,
        toolName: tool.name,
      };
      const safeOnUpdate = onUpdate
        ? (partial: unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onUpdate(hardTruncateToolPayload(partial, limits, context) as any);
          }
        : onUpdate;

      try {
        const result = await execute(toolCallId, params, signal, safeOnUpdate);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return hardTruncateToolPayload(result, limits, context) as any;
      } catch (err) {
        throw hardTruncateToolError(err, limits, context);
      }
    },
  };
}
