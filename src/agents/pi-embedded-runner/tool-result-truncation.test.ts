import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { AgentContextPruningConfig } from "../../config/types.agent-defaults.js";
import {
  truncateOversizedToolResultsInMessages,
  isOversizedToolResult,
  sessionLikelyHasOversizedToolResults,
} from "./tool-result-truncation.js";

const PRUNING: AgentContextPruningConfig = {
  minPrunableToolChars: 4000,
  softTrim: { maxChars: 2000, headChars: 800, tailChars: 800 },
};

function makeToolResult(text: string, toolCallId = "call_1"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeUserMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "messages",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    stopReason: "end_turn",
    timestamp: Date.now(),
  } as AgentMessage;
}

describe("isOversizedToolResult (contextPruning)", () => {
  it("returns false for small tool results", () => {
    expect(isOversizedToolResult(makeToolResult("small"), 200_000, PRUNING)).toBe(false);
  });

  it("returns true when content exceeds minPrunableToolChars", () => {
    expect(isOversizedToolResult(makeToolResult("x".repeat(5000)), 200_000, PRUNING)).toBe(true);
  });

  it("returns false for non-toolResult messages", () => {
    expect(isOversizedToolResult(makeUserMessage("x".repeat(50_000)), 200_000, PRUNING)).toBe(
      false,
    );
  });

  it("uses default minPrunableToolChars=4000 when no config provided", () => {
    expect(isOversizedToolResult(makeToolResult("x".repeat(3999)), 200_000)).toBe(false);
    expect(isOversizedToolResult(makeToolResult("x".repeat(4001)), 200_000)).toBe(true);
  });
});

describe("truncateOversizedToolResultsInMessages (contextPruning)", () => {
  it("returns unchanged messages when nothing is oversized", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("ok"),
      makeToolResult("small"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      200_000,
      PRUNING,
    );
    expect(truncatedCount).toBe(0);
    expect(result).toEqual(messages);
  });

  it("trims tool results keeping head + marker + tail within maxChars", () => {
    const head = "A".repeat(800);
    const mid = "B".repeat(9000);
    const tail = "C".repeat(800);
    const bigContent = head + mid + tail;
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading"),
      makeToolResult(bigContent),
    ];

    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      200_000,
      PRUNING,
    );
    expect(truncatedCount).toBe(1);

    const outText = (result[2] as { content: Array<{ text: string }> }).content[0].text;
    expect(outText.length).toBeLessThanOrEqual(2000);
    expect(outText).toContain("\n...\n");
    expect(outText.startsWith(head)).toBe(true);
    expect(outText.endsWith(tail)).toBe(true);
    expect(outText).not.toContain("B".repeat(100));
  });

  it("preserves non-toolResult messages by reference", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading"),
      makeToolResult("x".repeat(10_000)),
    ];
    const { messages: result } = truncateOversizedToolResultsInMessages(messages, 200_000, PRUNING);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
  });

  it("handles multiple oversized tool results", () => {
    const messages = [
      makeUserMessage("hello"),
      makeToolResult("x".repeat(10_000), "call_1"),
      makeToolResult("y".repeat(10_000), "call_2"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      200_000,
      PRUNING,
    );
    expect(truncatedCount).toBe(2);
    for (const msg of result.slice(1)) {
      const tr = msg as { content: Array<{ text: string }> };
      expect(tr.content[0].text.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe("sessionLikelyHasOversizedToolResults", () => {
  it("returns false when no tool results are oversized", () => {
    expect(
      sessionLikelyHasOversizedToolResults({
        messages: [makeUserMessage("hello"), makeToolResult("small")],
        contextWindowTokens: 200_000,
        contextPruning: PRUNING,
      }),
    ).toBe(false);
  });

  it("returns true when a tool result is oversized", () => {
    expect(
      sessionLikelyHasOversizedToolResults({
        messages: [makeUserMessage("hello"), makeToolResult("x".repeat(10_000))],
        contextWindowTokens: 200_000,
        contextPruning: PRUNING,
      }),
    ).toBe(true);
  });

  it("returns false for empty messages", () => {
    expect(
      sessionLikelyHasOversizedToolResults({
        messages: [],
        contextWindowTokens: 200_000,
        contextPruning: PRUNING,
      }),
    ).toBe(false);
  });
});
