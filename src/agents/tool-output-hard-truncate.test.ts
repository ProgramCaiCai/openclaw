import { existsSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  countBytesUtf8,
  countLines,
  DEFAULT_TOOL_OUTPUT_HARD_LIMITS,
  EXEC_TOOL_OUTPUT_HARD_LIMITS,
  hardTruncateToolPayload,
} from "./tool-output-hard-truncate.js";

describe("hardTruncateToolPayload", () => {
  it("uses tighter defaults for LLM context", () => {
    expect(DEFAULT_TOOL_OUTPUT_HARD_LIMITS.maxBytesUtf8).toBe(12 * 1024);
    expect(DEFAULT_TOOL_OUTPUT_HARD_LIMITS.maxLines).toBe(400);
    expect(EXEC_TOOL_OUTPUT_HARD_LIMITS.maxBytesUtf8).toBe(6 * 1024);
    expect(EXEC_TOOL_OUTPUT_HARD_LIMITS.maxLines).toBe(200);
  });

  it("returns payload unchanged when under limits", () => {
    const payload = {
      content: [{ type: "text", text: "hello\nworld" }],
      details: { ok: true },
    };
    const out = hardTruncateToolPayload(payload, {
      maxBytesUtf8: 12 * 1024,
      maxLines: 400,
      suffix: "Use read with offset/limit.",
    });
    expect(out).toBe(payload);
  });

  it("truncates plain string payload by UTF-8 bytes and writes full artifact", () => {
    const text = "a".repeat(10_000);
    const maxBytes = 240;
    const out = hardTruncateToolPayload(
      text,
      {
        maxBytesUtf8: maxBytes,
        maxLines: 400,
        suffix: "Use read with offset/limit.",
      },
      { toolName: "exec", toolCallId: "call_artifact_bytes" },
    );

    expect(typeof out).toBe("string");
    const outStr = out as string;
    expect(countBytesUtf8(outStr)).toBeLessThanOrEqual(maxBytes);
    expect(outStr).toContain("[Full output (");
    expect(outStr).toContain("showing head+tail preview]");

    const match = outStr.match(/saved to (\/tmp\/openclaw\/artifacts\/[^;]+);/);
    expect(match?.[1]).toBeTruthy();
    const artifactPath = match?.[1] as string;
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, "utf8")).toBe(text);

    rmSync(artifactPath, { force: true });
  });

  it("truncates plain string payload by line count", () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    const maxLines = 80;
    const out = hardTruncateToolPayload(lines, {
      maxBytesUtf8: 12 * 1024,
      maxLines,
      suffix: "Use read with offset/limit or excludeFromContext=true.",
    }) as string;
    expect(countLines(out)).toBeLessThanOrEqual(maxLines);
    expect(out).toContain("showing head+tail preview]");
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
      maxLines: 400,
      suffix: "Use read with offset/limit.",
    }) as { content: Array<{ type: string; text: string }> };

    expect(out).not.toBe(payload);
    expect(out.content.length).toBeGreaterThan(0);
    expect(countBytesUtf8(out.content.map((b) => b.text).join("\n"))).toBeLessThanOrEqual(1024);
    expect(out.content.some((b) => b.text.includes("showing head+tail preview"))).toBe(true);
  });

  it("does not cut in the middle of a UTF-16 surrogate pair", () => {
    const emoji = "\ud83d\ude00";
    const text = `${"x".repeat(100)}${emoji}${"y".repeat(1000)}`;
    const out = hardTruncateToolPayload(text, {
      maxBytesUtf8: 120,
      maxLines: 400,
      suffix: "Use read with offset/limit.",
    }) as string;

    if (out.length > 0) {
      const last = out.charCodeAt(out.length - 1);
      expect(last < 0xd800 || last > 0xdbff).toBe(true);
    }
  });
});
