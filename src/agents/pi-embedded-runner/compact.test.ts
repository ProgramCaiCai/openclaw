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
    timestamp: 0,
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
  it("sums estimateTokens for all messages (ignores stale usage)", () => {
    const messages = [makeUser("hello world"), makeAssistant("response text")];
    const expected =
      estimateTokens(messages[0] as unknown) + estimateTokens(messages[1] as unknown);
    const actual = estimateTokensAfterCompaction({
      messages: messages as unknown,
      tokensBefore: 10000,
    });
    expect(actual).toBe(expected);
  });

  it("returns undefined when estimate exceeds tokensBefore * sanity ratio", () => {
    const messages = [makeAssistant("x".repeat(5000))];
    const estimate = estimateTokens(messages[0] as unknown);
    // tokensBefore much smaller than estimate → sanity check fails
    const actual = estimateTokensAfterCompaction({
      messages: messages as unknown,
      tokensBefore: Math.floor(estimate / 2),
    });
    expect(actual).toBeUndefined();
  });

  it("allows slight overshoot within sanity ratio (1.1x)", () => {
    const messages = [makeAssistant("test")];
    const estimate = estimateTokens(messages[0] as unknown);
    // tokensBefore just below estimate → within 1.1x tolerance
    const actual = estimateTokensAfterCompaction({
      messages: messages as unknown,
      tokensBefore: estimate,
    });
    expect(actual).toBe(estimate);
  });

  it("handles empty messages", () => {
    const actual = estimateTokensAfterCompaction({
      messages: [],
      tokensBefore: 1000,
    });
    expect(actual).toBe(0);
  });
});
