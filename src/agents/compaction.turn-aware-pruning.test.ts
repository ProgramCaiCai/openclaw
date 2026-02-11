import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { pruneHistoryForContextShare } from "./compaction.js";

function makeUser(id: number, size: number): AgentMessage {
  return { role: "user", content: "x".repeat(size), timestamp: id };
}

function makeAssistantWithToolUse(params: {
  id: number;
  size: number;
  toolCallId: string;
  toolName: string;
}): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "y".repeat(params.size) },
      { type: "toolUse", id: params.toolCallId, name: params.toolName, input: {} },
    ],
    timestamp: params.id,
  } as AgentMessage;
}

function makeToolResult(
  id: number,
  toolCallId: string,
  toolName: string,
  size: number,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "r".repeat(size) }],
    timestamp: id,
  } as AgentMessage;
}

function makeAssistant(id: number, size: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "a".repeat(size) }],
    timestamp: id,
  } as AgentMessage;
}

describe("pruneHistoryForContextShare (turn-aware)", () => {
  it("cuts at a turn boundary when possible", () => {
    const messages: AgentMessage[] = [
      makeUser(1, 4000),
      makeAssistant(2, 4000),
      makeUser(3, 4000),
      makeAssistant(4, 4000),
      makeUser(5, 4000),
      makeAssistant(6, 4000),
    ];

    // budget = 4000 * 0.5 = 2000 tokens; last user+assistant turn fits
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 4000,
      maxHistoryShare: 0.5,
    });

    // Should cut at a user message boundary
    expect(pruned.messages[0]?.role).toBe("user");
    expect(pruned.droppedChunks).toBe(1);
    expect(pruned.keptTokens).toBeLessThanOrEqual(2000);
  });

  it("never starts the kept suffix at a toolResult", () => {
    const messages: AgentMessage[] = [
      makeAssistantWithToolUse({ id: 1, size: 4000, toolCallId: "call_1", toolName: "t" }),
      makeToolResult(2, "call_1", "t", 3000),
      makeUser(3, 500),
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
    });

    expect(pruned.messages.length).toBeGreaterThan(0);
    expect(pruned.messages[0]?.role).not.toBe("toolResult");

    // If tool_use is dropped, its toolResult must also be dropped
    const keptToolResults = pruned.messages.filter((m) => m.role === "toolResult");
    expect(keptToolResults).toHaveLength(0);
    const droppedToolResults = pruned.droppedMessagesList.filter((m) => m.role === "toolResult");
    expect(droppedToolResults).toHaveLength(1);
  });

  it("keeps toolCall/toolResult pairs together when both fit in budget", () => {
    const messages: AgentMessage[] = [
      makeUser(1, 8000),
      makeAssistantWithToolUse({ id: 2, size: 2000, toolCallId: "call_abc", toolName: "tool" }),
      makeToolResult(3, "call_abc", "tool", 2000),
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
    });

    // The assistant is a valid cut point; its toolResult follows and should be kept
    const keptAssistant = pruned.messages.find((m) => m.role === "assistant");
    const keptToolResult = pruned.messages.find((m) => m.role === "toolResult") as
      | Extract<AgentMessage, { role: "toolResult" }>
      | undefined;

    if (keptAssistant) {
      // If assistant is kept, its toolResult must also be kept
      expect(keptToolResult).toBeTruthy();
    }
    // First kept message must not be a toolResult
    expect(pruned.messages[0]?.role).not.toBe("toolResult");
  });

  it("handles empty and single-message edge cases", () => {
    const empty = pruneHistoryForContextShare({
      messages: [],
      maxContextTokens: 1000,
      maxHistoryShare: 0.5,
    });
    expect(empty.messages).toEqual([]);
    expect(empty.droppedChunks).toBe(0);

    // Single user message that exceeds budget — still kept (only valid cut point)
    const singleUser = pruneHistoryForContextShare({
      messages: [makeUser(1, 8000)],
      maxContextTokens: 1000,
      maxHistoryShare: 0.5,
    });
    expect(singleUser.messages).toHaveLength(1);

    // Single toolResult with no matching tool_use — dropped as orphan
    const singleToolResult = pruneHistoryForContextShare({
      messages: [makeToolResult(1, "call_orphan", "tool", 8000)],
      maxContextTokens: 1000,
      maxHistoryShare: 0.5,
    });
    expect(singleToolResult.messages).toEqual([]);
    expect(singleToolResult.droppedMessagesList).toHaveLength(1);
  });
});
