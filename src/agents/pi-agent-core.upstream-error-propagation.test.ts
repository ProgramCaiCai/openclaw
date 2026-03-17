import { Agent } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

function buildAssistantMessage(params?: {
  text?: string;
  stopReason?: "stop" | "error" | "aborted";
  errorMessage?: string;
}) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: params?.text ?? "" }],
    api: "openai",
    provider: "openai",
    model: "mock-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: params?.stopReason ?? "stop",
    errorMessage: params?.errorMessage,
    timestamp: Date.now(),
  };
}

describe("pi-agent-core upstream error propagation", () => {
  it("rethrows synchronous stream errors instead of appending an empty assistant message", async () => {
    const agent = new Agent({
      streamFn: () => {
        throw new Error("boom from streamFn");
      },
    });

    await expect(agent.prompt("hi")).rejects.toThrow("boom from streamFn");
    expect(agent.state.error).toBe("boom from streamFn");
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0]?.role).toBe("user");
  });

  it("rethrows provider error events without persisting an empty assistant artifact", async () => {
    const providerError = buildAssistantMessage({
      stopReason: "error",
      errorMessage: "503 service_unavailable",
    });

    const agent = new Agent({
      streamFn: async () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "start" as const,
            partial: buildAssistantMessage(),
          };
          yield {
            type: "error" as const,
            reason: "error" as const,
            error: providerError,
          };
        },
        result: async () => providerError,
      }),
    });

    await expect(agent.prompt("hi")).rejects.toThrow("503 service_unavailable");
    expect(agent.state.error).toBe("503 service_unavailable");
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.messages[0]?.role).toBe("user");
  });
});
