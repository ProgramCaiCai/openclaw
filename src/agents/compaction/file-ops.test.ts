import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessages,
  formatFileOperations,
} from "./file-ops.js";

function makeAssistant(blocks: unknown[]): AgentMessage {
  return {
    role: "assistant",
    content: blocks as unknown,
    timestamp: 0,
  } as AgentMessage;
}

describe("file-ops", () => {
  it("extracts read/write/edit paths from toolCall blocks (path + file_path + filePath)", () => {
    const messages: AgentMessage[] = [
      makeAssistant([
        { type: "toolCall", name: "read", arguments: { path: "a.txt" } },
        { type: "toolCall", name: "write", arguments: { file_path: "b.txt" } },
        { type: "toolCall", name: "edit", arguments: { filePath: "c.txt" } },
        { type: "toolCall", name: "unrelated", arguments: { path: "ignored.txt" } },
      ]),
    ];

    const fileOps = createFileOps();
    extractFileOpsFromMessages(messages, fileOps);

    expect([...fileOps.read]).toEqual(["a.txt"]);
    expect([...fileOps.written]).toEqual(["b.txt"]);
    expect([...fileOps.edited]).toEqual(["c.txt"]);
  });

  it("extracts paths from toolUse blocks (input) and supports path arrays", () => {
    const messages: AgentMessage[] = [
      makeAssistant([
        { type: "toolUse", name: "read", input: { paths: ["r1.ts", "r2.ts"] } },
        { type: "toolUse", name: "write", input: { filePaths: ["w1.ts"] } },
      ]),
    ];

    const fileOps = createFileOps();
    extractFileOpsFromMessages(messages, fileOps);

    expect([...fileOps.read].toSorted()).toEqual(["r1.ts", "r2.ts"]);
    expect([...fileOps.written]).toEqual(["w1.ts"]);
  });

  it("computeFileLists excludes modified files from readFiles", () => {
    const fileOps = createFileOps();
    fileOps.read.add("same.ts");
    fileOps.written.add("same.ts");
    fileOps.read.add("read-only.ts");
    fileOps.edited.add("edited.ts");

    const { readFiles, modifiedFiles } = computeFileLists(fileOps);
    expect(readFiles).toEqual(["read-only.ts"]);
    expect(modifiedFiles).toEqual(["edited.ts", "same.ts"]);
  });

  it("formatFileOperations returns empty string when no files exist", () => {
    expect(formatFileOperations([], [])).toBe("");
  });

  it("formatFileOperations emits Codex-style tags", () => {
    const formatted = formatFileOperations(["a"], ["b", "c"]);
    expect(formatted).toContain("<read-files>\n");
    expect(formatted).toContain("a");
    expect(formatted).toContain("</read-files>");
    expect(formatted).toContain("<modified-files>\n");
    expect(formatted).toContain("b");
    expect(formatted).toContain("c");
    expect(formatted).toContain("</modified-files>");
  });
});
