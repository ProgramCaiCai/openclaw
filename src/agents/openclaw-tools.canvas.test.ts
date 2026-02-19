import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGateway } = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({ callGateway }));

import { createCanvasTool } from "./tools/canvas-tool.js";

describe("canvas eval", () => {
  beforeEach(() => {
    callGateway.mockReset();
  });

  it("truncates oversized eval result text", async () => {
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return { nodes: [{ nodeId: "mac-1" }] };
      }
      if (method === "node.invoke") {
        expect(params).toMatchObject({ command: "canvas.eval" });
        return {
          payload: {
            result: "r".repeat(12_000),
          },
        };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const tool = createCanvasTool();
    const result = await tool.execute("call1", {
      action: "eval",
      node: "mac-1",
      javaScript: "1+1",
    });

    const details = result.details as Record<string, unknown>;
    expect(details).toMatchObject({
      truncated: true,
      rawLength: 12_000,
      maxChars: 8_000,
    });
    expect(typeof details.result).toBe("string");
    expect((details.result as string).includes("...(truncated)...")).toBe(true);
  });

  it("keeps small eval results unchanged", async () => {
    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return { nodes: [{ nodeId: "mac-1" }] };
      }
      if (method === "node.invoke") {
        return {
          payload: {
            result: "ok",
          },
        };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const tool = createCanvasTool();
    const result = await tool.execute("call2", {
      action: "eval",
      node: "mac-1",
      javaScript: "2+2",
    });

    expect(result.details).toMatchObject({
      result: "ok",
      truncated: false,
      rawLength: 2,
      maxChars: 8_000,
    });
  });
});
