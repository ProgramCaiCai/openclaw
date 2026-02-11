import { describe, expect, it } from "vitest";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  formatFileOperations,
} from "./file-ops.js";

function makeAssistant(toolCalls: Array<{ name: string; arguments: unknown }>) {
  return {
    role: "assistant" as const,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    content: toolCalls.map((call, idx) => ({
      type: "toolCall" as const,
      id: String(idx + 1),
      name: call.name,
      arguments: call.arguments as Record<string, unknown>,
    })),
    timestamp: 0,
  };
}

describe("file ops", () => {
  it("extracts read/write/edit and normalizes path argument keys", () => {
    const fileOps = createFileOps();

    const message = makeAssistant([
      { name: "read", arguments: { path: "a.txt" } },
      { name: "write", arguments: { file_path: "b.txt" } },
      { name: "edit", arguments: { filePath: "c.txt" } },
    ]);

    extractFileOpsFromMessage(message as unknown, fileOps);

    expect([...fileOps.read]).toEqual(["a.txt"]);
    expect([...fileOps.written]).toEqual(["b.txt"]);
    expect([...fileOps.edited]).toEqual(["c.txt"]);
  });

  it("places a file read+edited into modified only", () => {
    const fileOps = createFileOps();

    const message = makeAssistant([
      { name: "read", arguments: { path: "same.txt" } },
      { name: "edit", arguments: { filepath: "same.txt" } },
    ]);

    extractFileOpsFromMessage(message as unknown, fileOps);
    const { readFiles, modifiedFiles } = computeFileLists(fileOps);

    expect(readFiles).toEqual([]);
    expect(modifiedFiles).toEqual(["same.txt"]);
  });

  it("supports array path keys (paths/filePaths)", () => {
    const fileOps = createFileOps();

    const message = makeAssistant([
      { name: "read", arguments: { paths: ["x.txt", "y.txt"] } },
      { name: "edit", arguments: { filePaths: ["y.txt", "z.txt"] } },
    ]);

    extractFileOpsFromMessage(message as unknown, fileOps);
    const { readFiles, modifiedFiles } = computeFileLists(fileOps);

    expect(readFiles).toEqual(["x.txt"]);
    expect(modifiedFiles).toEqual(["y.txt", "z.txt"]);
  });

  it("formats output identically to Codex/pi-coding-agent", () => {
    expect(formatFileOperations([], [])).toBe("");
    expect(formatFileOperations(["a.txt"], [])).toBe("\n\n<read-files>\na.txt\n</read-files>");
    expect(formatFileOperations([], ["b.txt"])).toBe(
      "\n\n<modified-files>\nb.txt\n</modified-files>",
    );
    expect(formatFileOperations(["a.txt"], ["b.txt"])).toBe(
      "\n\n<read-files>\na.txt\n</read-files>\n\n<modified-files>\nb.txt\n</modified-files>",
    );
  });
});
