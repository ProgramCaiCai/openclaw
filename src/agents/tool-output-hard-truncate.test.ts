import { describe, expect, it } from "vitest";
import {
  countBytesUtf8,
  countLines,
  hardTruncateToolPayload,
} from "./tool-output-hard-truncate.js";

describe("hardTruncateToolPayload", () => {
  it("returns payload unchanged when under limits", () => {
    const payload = {
      content: [{ type: "text", text: "hello\nworld" }],
      details: { ok: true },
    };
    const out = hardTruncateToolPayload(payload, {
      maxBytesUtf8: 50 * 1024,
      maxLines: 2000,
      suffix: "\n[truncated]",
    });
    expect(out).toBe(payload);
  });

  it("truncates plain string payload by UTF-8 bytes", () => {
    const text = "a".repeat(10_000);
    const maxBytes = 200;
    const out = hardTruncateToolPayload(text, {
      maxBytesUtf8: maxBytes,
      maxLines: 2000,
      suffix: "\n[truncated]",
    });
    expect(typeof out).toBe("string");
    const outStr = out as string;
    expect(countBytesUtf8(outStr)).toBeLessThanOrEqual(maxBytes);
    expect(outStr).toContain("[truncated]");
  });

  it("truncates plain string payload by line count", () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
    const maxLines = 200;
    const out = hardTruncateToolPayload(lines, {
      maxBytesUtf8: 50 * 1024,
      maxLines,
      suffix: "\n[truncated]",
    }) as string;
    expect(countLines(out)).toBeLessThanOrEqual(maxLines);
    expect(out).toContain("[truncated]");
  });

  it("truncates across content blocks using shared budgets", () => {
    const payload = {
      content: [
        { type: "text", text: "a".repeat(30_000) },
        { type: "text", text: "b".repeat(30_000) },
      ],
      details: { ok: true },
    };
    const out = hardTruncateToolPayload(payload, {
      maxBytesUtf8: 1024,
      maxLines: 2000,
      suffix: "\n[truncated]",
    }) as { content: Array<{ type: string; text: string }> };

    expect(out).not.toBe(payload);
    expect(out.content.length).toBeGreaterThan(0);
    expect(countBytesUtf8(out.content.map((b) => b.text).join("\n"))).toBeLessThanOrEqual(1024);
    expect(out.content.some((b) => b.text.includes("[truncated]"))).toBe(true);
  });

  it("does not cut in the middle of a UTF-16 surrogate pair", () => {
    const emoji = "\ud83d\ude00"; // grinning face
    const text = `${"x".repeat(100)}${emoji}${"y".repeat(1000)}`;
    const out = hardTruncateToolPayload(text, {
      maxBytesUtf8: 120,
      maxLines: 2000,
      suffix: "\n[truncated]",
    }) as string;

    // Ensure the result doesn't end with a dangling high surrogate.
    if (out.length > 0) {
      const last = out.charCodeAt(out.length - 1);
      expect(last < 0xd800 || last > 0xdbff).toBe(true);
    }
  });
});
