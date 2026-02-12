import { SessionManager } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { truncateOversizedToolResultsInSession } from "./tool-result-truncation.js";

const TMP_DIR = join(process.cwd(), "tmp-test-branch-summary");

function makeSessionFile(entries: object[]): string {
  const sessionId = randomUUID();
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  const dir = join(TMP_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  const lines = [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(filePath, lines);
  return filePath;
}

afterEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("truncateOversizedToolResultsInSession - branch_summary preservation", () => {
  it("preserves branch_summary entries when truncating oversized tool results", async () => {
    const oversizedText = "x".repeat(600_000);
    const entries = [
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "hello", timestamp: Date.now() },
      },
      {
        type: "message",
        id: "e2",
        parentId: "e1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will use a tool" },
            { type: "toolUse", id: "call_1", name: "read", input: { path: "foo.txt" } },
          ],
          api: "messages",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 10, outputTokens: 10 },
          stopReason: "tool_use",
          timestamp: Date.now(),
        },
      },
      {
        type: "message",
        id: "e3",
        parentId: "e2",
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: oversizedText }],
          isError: false,
          timestamp: Date.now(),
        },
      },
      {
        type: "branch_summary",
        id: "e4",
        parentId: "e3",
        timestamp: new Date().toISOString(),
        fromId: "e1",
        summary: "User asked about foo.txt; tool read the file successfully.",
        details: undefined,
        fromHook: undefined,
      },
      {
        type: "message",
        id: "e5",
        parentId: "e4",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "continue", timestamp: Date.now() },
      },
      {
        type: "message",
        id: "e6",
        parentId: "e5",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          api: "messages",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 10, outputTokens: 10 },
          stopReason: "end_turn",
          timestamp: Date.now(),
        },
      },
    ];

    const sessionFile = makeSessionFile(entries);

    const result = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens: 128_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBe(1);

    // Re-open the session and verify branch_summary is preserved
    const sm = SessionManager.open(sessionFile);
    const branch = sm.getBranch();
    const branchSummaryEntries = branch.filter(
      (e: { type: string }) => e.type === "branch_summary",
    );

    expect(branchSummaryEntries.length).toBeGreaterThanOrEqual(1);
    const bs = branchSummaryEntries[0] as { summary?: string };
    expect(bs.summary).toContain("foo.txt");
  });

  it("preserves label entries when truncating oversized tool results", async () => {
    const oversizedText = "y".repeat(600_000);
    const entries = [
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "hello", timestamp: Date.now() },
      },
      {
        type: "message",
        id: "e2",
        parentId: "e1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "reading" },
            { type: "toolUse", id: "call_2", name: "read", input: { path: "bar.txt" } },
          ],
          api: "messages",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 10, outputTokens: 10 },
          stopReason: "tool_use",
          timestamp: Date.now(),
        },
      },
      {
        type: "message",
        id: "e3",
        parentId: "e2",
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "call_2",
          toolName: "read",
          content: [{ type: "text", text: oversizedText }],
          isError: false,
          timestamp: Date.now(),
        },
      },
      {
        type: "label",
        id: "e4",
        parentId: "e3",
        timestamp: new Date().toISOString(),
        targetId: "e2",
        label: "important-checkpoint",
      },
      {
        type: "message",
        id: "e5",
        parentId: "e4",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          api: "messages",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          usage: { inputTokens: 10, outputTokens: 10 },
          stopReason: "end_turn",
          timestamp: Date.now(),
        },
      },
    ];

    const sessionFile = makeSessionFile(entries);

    const result = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens: 128_000,
    });

    expect(result.truncated).toBe(true);

    // Re-open and verify label is preserved
    const sm = SessionManager.open(sessionFile);
    const branch = sm.getBranch();
    const labelEntries = branch.filter((e: { type: string }) => e.type === "label");

    expect(labelEntries.length).toBeGreaterThanOrEqual(1);
    const lbl = labelEntries[0] as { label?: string };
    expect(lbl.label).toBe("important-checkpoint");
  });
});
