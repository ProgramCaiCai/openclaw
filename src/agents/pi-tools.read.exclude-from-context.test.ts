import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenClawReadTool } from "./pi-tools.read.js";

describe("read excludeFromContext", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-read-exclude-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("returns full content when excludeFromContext is not set", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "test.txt");
    const content = "hello world\nline two\n";
    fs.writeFileSync(filePath, content);

    const baseTool = {
      name: "read",
      label: "read",
      description: "read",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "path" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
      },
      execute: async (_id: string, params: Record<string, unknown>) => {
        const text = fs.readFileSync(params.path as string, "utf-8");
        return {
          content: [{ type: "text" as const, text }],
          details: undefined,
        };
      },
    };

    const tool = createOpenClawReadTool(baseTool as any);
    const result = await tool.execute("call1", { path: filePath });
    const text = result.content.find((c: any) => c.type === "text")?.text ?? "";
    expect(text).toContain("hello world");
    expect(text).not.toContain("excluded from context");
  });

  it("writes artifact and returns preview when excludeFromContext is true", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "big.txt");
    const bigContent = "x".repeat(12_000);
    fs.writeFileSync(filePath, bigContent);

    const baseTool = {
      name: "read",
      label: "read",
      description: "read",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "path" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
      },
      execute: async (_id: string, params: Record<string, unknown>) => {
        const text = fs.readFileSync(params.path as string, "utf-8");
        return {
          content: [{ type: "text" as const, text }],
          details: undefined,
        };
      },
    };

    const tool = createOpenClawReadTool(baseTool as any);
    const result = await tool.execute("call_exclude", {
      path: filePath,
      excludeFromContext: true,
    });

    const text = result.content.find((c: any) => c.type === "text")?.text ?? "";
    expect(text).toContain("excluded from context");
    // Preview should be capped
    expect(text.length).toBeLessThan(6_000);

    const details = result.details as {
      outputFile?: string;
      excludedFromContext?: boolean;
    };
    expect(details.excludedFromContext).toBe(true);
    expect(details.outputFile).toBeTruthy();

    // Verify artifact file contains full content
    const artifactContent = fs.readFileSync(details.outputFile!, "utf-8");
    expect(artifactContent.length).toBeGreaterThanOrEqual(12_000);
  });
});
