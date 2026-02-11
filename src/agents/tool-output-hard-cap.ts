import { truncateUtf16Safe } from "../utils.js";

export const TOOL_OUTPUT_HARD_MAX_BYTES = 50 * 1024;
export const TOOL_OUTPUT_HARD_MAX_LINES = 2000;

const DEFAULT_TRUNCATION_SUFFIX =
  "⚠️ [Tool output truncated - exceeded hard limit (50KB / 2000 lines). " +
  "Request specific sections or use offset/limit parameters.]";

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
  const limit = Math.max(0, Math.floor(maxLines));
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

function sliceToMaxUtf8Bytes(text: string, maxBytes: number): string {
  if (!text) {
    return text;
  }
  const limit = Math.max(0, Math.floor(maxBytes));
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

export function hardTruncateText(
  text: string,
  opts?: {
    maxBytes?: number;
    maxLines?: number;
    suffix?: string;
  },
): { text: string; truncated: boolean } {
  const maxBytes = opts?.maxBytes ?? TOOL_OUTPUT_HARD_MAX_BYTES;
  const maxLines = opts?.maxLines ?? TOOL_OUTPUT_HARD_MAX_LINES;
  const suffix = opts?.suffix ?? DEFAULT_TRUNCATION_SUFFIX;

  const withinLines = countLines(text) <= maxLines;
  const withinBytes = Buffer.byteLength(text, "utf8") <= maxBytes;
  if (withinLines && withinBytes) {
    return { text, truncated: false };
  }

  // Reserve space for the truncation marker (which may be multi-line).
  // When appending `\n` + suffix, the total line count becomes:
  //   lines(text + "\n" + suffix) == lines(text) + lines(suffix)
  // so we reserve lines(suffix) (not lines("\n" + suffix)).
  const suffixBytes = Buffer.byteLength(`\n${suffix}`, "utf8");
  const suffixLines = countLines(suffix);
  const availableBytes = Math.max(0, maxBytes - suffixBytes);
  const availableLines = Math.max(0, maxLines - suffixLines);

  let trimmed = sliceToMaxLines(text, availableLines);
  trimmed = sliceToMaxUtf8Bytes(trimmed, availableBytes);

  const suffixText = trimmed ? `\n${suffix}` : suffix;
  return { text: `${trimmed}${suffixText}`, truncated: true };
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

  const seen = new WeakSet<object>();
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
      return "[Circular]";
    }
    seen.add(input as object);

    if (Array.isArray(input)) {
      if (depth <= 0) {
        return `[Array(${input.length})]`;
      }
      return input.map((v) => walk(v, depth - 1));
    }

    const record = input as Record<string, unknown>;
    if (depth <= 0) {
      return "[Object]";
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = walk(v, depth - 1);
    }
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
