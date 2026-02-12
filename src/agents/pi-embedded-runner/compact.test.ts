import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { estimateTokensAfterCompaction } from "./compact.js";

function makeAssistant(text: string) {
  return {
    role: "assistant" as const,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    content: [{ type: "text" as const, text }],
    stopReason: "end_turn" as const,
    timestamp: 0,
  };
}

function makeAssistantWithUsage(
  text: string,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens?: number;
  },
) {
  return {
    ...makeAssistant(text),
    usage,
  };
}

function makeUser(text: string) {
  return {
    role: "user" as const,
    content: text,
    timestamp: 0,
  };
}

describe("estimateTokensAfterCompaction", () => {
  it("uses last assistant usage + trailing estimate when usage exists", () => {
    const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
    const usageTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

    const messages = [
      makeUser("hello"),
      makeAssistantWithUsage("assistant", usage),
      // Trailing messages (after last usage) are estimated.
      {
        role: "toolResult" as const,
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text" as const, text: "ok" }],
        timestamp: 0,
      } as unknown,
    ];

    const trailingEstimate = estimateTokens(messages[2]);
    const actual = estimateTokensAfterCompaction({
      messages: messages as unknown,
      tokensBefore: 10_000,
    });

    expect(actual).toBe(usageTokens + trailingEstimate);
  });

  it("falls back to summing estimateTokens when no usage exists", () => {
    const messages = [makeUser("hello world"), makeAssistant("response text")];
    const expected =
      estimateTokens(messages[0] as unknown) + estimateTokens(messages[1] as unknown);
    const actual = estimateTokensAfterCompaction({
      messages: messages as unknown,
      tokensBefore: 10_000,
    });
    expect(actual).toBe(expected);
  });

  it("skips aborted/error assistant usage and uses the previous usage", () => {
    const oldUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };
    const messages = [
      makeAssistantWithUsage("old", oldUsage),
      {
        ...makeAssistantWithUsage("aborted", {
          input: 999,
          output: 999,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1998,
        }),
        stopReason: "aborted" as const,
      },
      makeUser("tail"),
    ];

    const trailingEstimate =
      estimateTokens(messages[1] as unknown) + estimateTokens(messages[2] as unknown);
    const actual = estimateTokensAfterCompaction({
      messages: messages as unknown,
      tokensBefore: 10_000,
    });

    expect(actual).toBe(oldUsage.totalTokens + trailingEstimate);
  });

  it("handles empty messages", () => {
    const actual = estimateTokensAfterCompaction({
      messages: [],
      tokensBefore: 1000,
    });
    expect(actual).toBe(0);
  });
});
