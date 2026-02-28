import { truncateUtf16Safe } from "../utils.js";

// These caps exist to keep tool results from bloating the session context.
// Lowering them reduces context growth while head+tail truncation keeps the
// most actionable parts (headers + endings like errors).
export const TOOL_OUTPUT_HARD_MAX_BYTES = 12 * 1024;
export const TOOL_OUTPUT_HARD_MAX_LINES = 400;

// `exec` outputs tend to be large and repetitive. Apply a stricter cap when the
// caller has the tool name and can opt into it (e.g. during persistence).
export const TOOL_OUTPUT_HARD_MAX_BYTES_EXEC = 6 * 1024;
export const TOOL_OUTPUT_HARD_MAX_LINES_EXEC = 200;

export type HardTruncateMeta = {
  maxBytes: number;
  maxLines: number;
  originalBytes: number;
  originalLines: number;
  headBytes: number;
  headLines: number;
  tailBytes: number;
  tailLines: number;
};

export type HardTruncateSuffix = string | ((meta: HardTruncateMeta) => string);

function toIntLimit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : fallback;
  return Math.max(0, Math.floor(Number.isFinite(n) ? n : fallback));
}

function formatKiB(bytes: number): string {
  const kib = Math.max(0, Math.round(bytes / 1024));
  return `${kib}KB`;
}

function formatLimit(maxBytes: number, maxLines: number): string {
  return `${formatKiB(maxBytes)} / ${maxLines} lines`;
}

export function makeHardLimitSuffix(params: {
  context: string;
}): (meta: HardTruncateMeta) => string {
  return (meta) => {
    const limit = formatLimit(meta.maxBytes, meta.maxLines);
    const original = `${formatKiB(meta.originalBytes)} / ${meta.originalLines} lines`;
    const kept =
      meta.headBytes > 0 && meta.tailBytes > 0
        ? `kept head ${meta.headLines} lines (${formatKiB(meta.headBytes)}) + tail ${meta.tailLines} lines (${formatKiB(meta.tailBytes)})`
        : "kept a partial preview";

    return (
      `⚠️ [${params.context} - exceeded hard limit (${limit}); ` +
      `original (${original}); ${kept}. ` +
      `Request specific sections or use offset/limit parameters.]`
    );
  };
}

const DEFAULT_TRUNCATION_SUFFIX = makeHardLimitSuffix({ context: "Tool output truncated" });

const DEFAULT_TRUNCATION_MIDDLE_MARKER = "… [snip]";

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

function sliceToMaxLines(text: string, maxLines: number): string {
  if (!text) {
    return text;
  }
  const limit = toIntLimit(maxLines, 0);
  if (limit <= 0) {
    return "";
  }
  // Fast path: already within line budget.
  if (countLines(text) <= limit) {
    return text;
  }

  let from = 0;
  for (let i = 1; i <= limit; i++) {
    const next = text.indexOf("\n", from);
    if (next === -1) {
      return text;
    }
    if (i === limit) {
      return text.slice(0, next);
    }
    from = next + 1;
  }
  return text;
}

function sliceToMaxLinesTail(text: string, maxLines: number): string {
  if (!text) {
    return text;
  }
  const limit = toIntLimit(maxLines, 0);
  if (limit <= 0) {
    return "";
  }
  // Fast path: already within line budget.
  if (countLines(text) <= limit) {
    return text;
  }

  let to = text.length;
  for (let i = 1; i <= limit; i++) {
    const prev = text.lastIndexOf("\n", to - 1);
    if (prev === -1) {
      return text;
    }
    if (i === limit) {
      return text.slice(prev + 1);
    }
    to = prev;
  }
  return text;
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
  // Avoid starting on a low surrogate.
  const c = text.charCodeAt(start);
  if (c >= 0xdc00 && c <= 0xdfff && start > 0) {
    const prev = text.charCodeAt(start - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      start += 1;
    }
  }
  return text.slice(start);
}

function sliceToMaxUtf8Bytes(text: string, maxBytes: number): string {
  if (!text) {
    return text;
  }
  const limit = toIntLimit(maxBytes, 0);
  if (Buffer.byteLength(text, "utf8") <= limit) {
    return text;
  }
  if (limit <= 0) {
    return "";
  }

  // Binary search for the longest UTF-16-safe prefix that fits in maxBytes.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = truncateUtf16Safe(text, mid);
    if (Buffer.byteLength(candidate, "utf8") <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return truncateUtf16Safe(text, lo);
}

function sliceToMaxUtf8BytesTail(text: string, maxBytes: number): string {
  if (!text) {
    return text;
  }
  const limit = toIntLimit(maxBytes, 0);
  if (Buffer.byteLength(text, "utf8") <= limit) {
    return text;
  }
  if (limit <= 0) {
    return "";
  }

  // Binary search for the longest UTF-16-safe suffix that fits in maxBytes.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = sliceUtf16SafeTail(text, mid);
    if (Buffer.byteLength(candidate, "utf8") <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return sliceUtf16SafeTail(text, lo);
}

function resolveSuffixText(suffix: HardTruncateSuffix | undefined, meta: HardTruncateMeta): string {
  if (!suffix) {
    return DEFAULT_TRUNCATION_SUFFIX(meta);
  }
  return typeof suffix === "function" ? suffix(meta) : suffix;
}

function joinNonEmpty(parts: string[]): string {
  const filtered = parts.filter((p) => typeof p === "string" && p.length > 0);
  return filtered.join("\n");
}

export function hardTruncateText(
  text: string,
  opts?: {
    maxBytes?: number;
    maxLines?: number;
    suffix?: HardTruncateSuffix;
    middleMarker?: string;
  },
): { text: string; truncated: boolean } {
  const maxBytes = toIntLimit(opts?.maxBytes, TOOL_OUTPUT_HARD_MAX_BYTES);
  const maxLines = toIntLimit(opts?.maxLines, TOOL_OUTPUT_HARD_MAX_LINES);
  const middleMarker = (opts?.middleMarker ?? DEFAULT_TRUNCATION_MIDDLE_MARKER).trim();

  const originalBytes = Buffer.byteLength(text, "utf8");
  const originalLines = countLines(text);
  const withinLines = originalLines <= maxLines;
  const withinBytes = originalBytes <= maxBytes;
  if (withinLines && withinBytes) {
    return { text, truncated: false };
  }

  const meta0: HardTruncateMeta = {
    maxBytes,
    maxLines,
    originalBytes,
    originalLines,
    headBytes: 0,
    headLines: 0,
    tailBytes: 0,
    tailLines: 0,
  };

  const maxIters = 8;
  let budgetScale = 1.0;
  let lastSuffix = resolveSuffixText(opts?.suffix, meta0);

  for (let iter = 0; iter < maxIters; iter++) {
    const suffixTextBase = resolveSuffixText(opts?.suffix, meta0);

    const reservedLines = countLines(middleMarker) + countLines(suffixTextBase);
    const availableLines = Math.max(0, maxLines - reservedLines);

    // Account for the join newlines between (head, middle, tail, suffix).
    const joinBytes = 3;
    const reservedBytes =
      Buffer.byteLength(middleMarker, "utf8") +
      Buffer.byteLength(suffixTextBase, "utf8") +
      joinBytes;
    const availableBytes = Math.max(0, maxBytes - reservedBytes);

    if (availableBytes <= 0 || availableLines <= 0) {
      const tiny = sliceToMaxUtf8Bytes(sliceToMaxLines(suffixTextBase, maxLines), maxBytes);
      return { text: tiny, truncated: true };
    }

    const linesBudget = Math.max(1, Math.floor(availableLines * budgetScale));
    const bytesBudget = Math.max(1, Math.floor(availableBytes * budgetScale));

    const headLinesBudget = Math.ceil(linesBudget / 2);
    const tailLinesBudget = Math.max(0, linesBudget - headLinesBudget);

    const headBytesBudget = Math.ceil(bytesBudget / 2);
    const tailBytesBudget = Math.max(0, bytesBudget - headBytesBudget);

    let head = sliceToMaxLines(text, headLinesBudget);
    head = sliceToMaxUtf8Bytes(head, headBytesBudget);

    let tail = sliceToMaxLinesTail(text, tailLinesBudget);
    tail = sliceToMaxUtf8BytesTail(tail, tailBytesBudget);

    const meta: HardTruncateMeta = {
      ...meta0,
      headBytes: Buffer.byteLength(head, "utf8"),
      headLines: countLines(head),
      tailBytes: Buffer.byteLength(tail, "utf8"),
      tailLines: countLines(tail),
    };

    const suffixText = resolveSuffixText(opts?.suffix, meta);
    const out = joinNonEmpty([head, middleMarker, tail, suffixText]);

    const outLines = countLines(out);
    const outBytes = Buffer.byteLength(out, "utf8");

    if (outLines <= maxLines && outBytes <= maxBytes) {
      return { text: out, truncated: true };
    }

    if (suffixText !== lastSuffix) {
      lastSuffix = suffixText;
      continue;
    }

    budgetScale *= 0.8;
  }

  const suffixText = resolveSuffixText(opts?.suffix, meta0);
  const tiny = sliceToMaxUtf8Bytes(sliceToMaxLines(suffixText, maxLines), maxBytes);
  return { text: tiny, truncated: true };
}

function capContainerSize(value: unknown, opts: { maxArray: number; maxKeys: number }): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length <= opts.maxArray) {
      return value;
    }
    return [
      ...value.slice(0, opts.maxArray),
      { omitted: true, items: value.length - opts.maxArray },
    ];
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length <= opts.maxKeys) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of keys.slice(0, opts.maxKeys)) {
    out[key] = record[key];
  }
  out._omittedKeys = keys.length - opts.maxKeys;
  return out;
}

export function hardCapToolOutput(value: unknown, opts?: { maxBytes?: number; maxLines?: number }) {
  const maxBytes = opts?.maxBytes ?? TOOL_OUTPUT_HARD_MAX_BYTES;
  const maxLines = opts?.maxLines ?? TOOL_OUTPUT_HARD_MAX_LINES;

  const seen = new WeakMap<object, unknown>();
  const walk = (input: unknown, depth: number): unknown => {
    if (typeof input === "string") {
      return hardTruncateText(input, { maxBytes, maxLines }).text;
    }
    if (!input || typeof input !== "object") {
      return input;
    }

    const cappedContainer = capContainerSize(input, { maxArray: 400, maxKeys: 400 });
    if (cappedContainer !== input) {
      input = cappedContainer as never;
    }

    if (seen.has(input as object)) {
      return seen.get(input as object);
    }
    // Use a placeholder to break cycles before recursing
    seen.set(input as object, "[Circular]");

    if (Array.isArray(input)) {
      if (depth <= 0) {
        const result = `[Array(${input.length})]`;
        seen.set(input as object, result);
        return result;
      }
      const result = input.map((v) => walk(v, depth - 1));
      seen.set(input as object, result);
      return result;
    }

    const record = input as Record<string, unknown>;
    if (depth <= 0) {
      const result = "[Object]";
      seen.set(input as object, result);
      return result;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = walk(v, depth - 1);
    }
    seen.set(input as object, out);
    return out;
  };

  const mapped = walk(value, 6);

  // Enforce total payload size by falling back to a capped string preview.
  try {
    const serialized = JSON.stringify(mapped);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes <= maxBytes) {
      return mapped;
    }

    const base = { truncated: true as const, bytes };
    const overhead = Buffer.byteLength(JSON.stringify({ ...base, preview: "" }), "utf8");
    let budget = Math.max(0, maxBytes - overhead);
    let preview = hardTruncateText(serialized, { maxBytes: budget, maxLines }).text;
    let out = { ...base, preview };

    // In rare cases escaping overhead can still push us over the cap; shrink a few times.
    for (let i = 0; i < 6; i++) {
      const outBytes = Buffer.byteLength(JSON.stringify(out), "utf8");
      if (outBytes <= maxBytes || budget <= 0) {
        break;
      }
      budget = Math.max(0, Math.floor(budget * 0.9));
      preview = hardTruncateText(serialized, { maxBytes: budget, maxLines }).text;
      out = { ...base, preview };
    }

    return out;
  } catch {
    const base = { truncated: true as const };
    const overhead = Buffer.byteLength(JSON.stringify({ ...base, preview: "" }), "utf8");
    const budget = Math.max(0, maxBytes - overhead);
    const preview = hardTruncateText(String(mapped), { maxBytes: budget, maxLines }).text;
    return { ...base, preview };
  }
}
