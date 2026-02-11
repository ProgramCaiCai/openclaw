import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./common.js";
import { createCtxSafeCallTool } from "./ctx-safe-call-tool.js";

function makeTargetTool(
  executeImpl: (args: Record<string, unknown>) => Promise<unknown> | unknown,
  safeCall?: { allowWrapping?: boolean; allowedParams?: string[] },
): AnyAgentTool {
  const tool = {
    label: "Target",
    name: "target_tool",
    description: "Target",
    parameters: {},
    execute: vi.fn(async (_toolCallId: string, args: Record<string, unknown>) => executeImpl(args)),
    safeCall,
  };
  return tool as unknown as AnyAgentTool;
}

function readDetails(result: unknown): Record<string, unknown> {
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw new Error("missing details");
  }
  return details as Record<string, unknown>;
}

describe("ctx_safe_call", () => {
  it("rejects wrapping itself", async () => {
    const tool = createCtxSafeCallTool({ resolveTool: () => undefined });
    await expect(tool.execute?.("1", { tool: "ctx_safe_call" })).rejects.toThrow(
      "ctx_safe_call cannot wrap itself",
    );
  });

  it("rejects unknown target tool", async () => {
    const tool = createCtxSafeCallTool({ resolveTool: () => undefined });
    await expect(tool.execute?.("1", { tool: "missing" })).rejects.toThrow("Unknown tool: missing");
  });

  it("respects safeCall.allowedParams when forwarding params", async () => {
    const target = makeTargetTool((args) => ({ details: args }), {
      allowedParams: ["keep"],
    });
    const resolveTool = vi.fn((name: string) => (name === "target" ? target : undefined));
    const tool = createCtxSafeCallTool({ resolveTool });

    const result = await tool.execute?.("1", {
      tool: "target",
      params: { keep: "ok", drop: "nope" },
    });

    expect(resolveTool).toHaveBeenCalledWith("target");
    expect((target.execute as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual({ keep: "ok" });

    const details = readDetails(result);
    expect(details.output).toContain('"keep": "ok"');
    expect(details.output).not.toContain('"drop": "nope"');
  });

  it("applies filterCommand when provided", async () => {
    const target = makeTargetTool(() => ({ details: "a\nb\nc" }));
    const tool = createCtxSafeCallTool({ resolveTool: () => target });

    const result = await tool.execute?.("1", {
      tool: "target",
      filterCommand: "head -n 2",
    });

    const details = readDetails(result);
    expect(details.filterApplied).toBe(true);
    expect(details.output).toBe("a\nb\n");
    expect(details.filterFallbackReason).toBeNull();
  });

  it("falls back to raw output when filterCommand fails", async () => {
    const target = makeTargetTool(() => ({ details: "alpha\nbeta\n" }));
    const tool = createCtxSafeCallTool({ resolveTool: () => target });

    const result = await tool.execute?.("1", {
      tool: "target",
      filterCommand: "grep gamma",
    });

    const details = readDetails(result);
    expect(details.filterApplied).toBe(false);
    expect(details.output).toBe("alpha\nbeta\n");
    expect(typeof details.filterFallbackReason).toBe("string");
  });

  it("rejects disallowed filterCommand prefix", async () => {
    const target = makeTargetTool(() => ({ details: "ok" }));
    const tool = createCtxSafeCallTool({ resolveTool: () => target });

    await expect(
      tool.execute?.("1", {
        tool: "target",
        filterCommand: "python -c 'print(1)'",
      }),
    ).rejects.toThrow("filterCommand prefix not allowed: python");
  });

  it("rejects wrapping when target disallows safe call", async () => {
    const target = makeTargetTool(() => ({ details: "ok" }), {
      allowWrapping: false,
    });
    const tool = createCtxSafeCallTool({ resolveTool: () => target });

    await expect(tool.execute?.("1", { tool: "target" })).rejects.toThrow(
      "Tool does not allow ctx_safe_call wrapping: target",
    );
  });
});
