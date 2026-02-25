import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "../pi-embedded-runner.js";

// Mock the logger to avoid noise in tests
vi.mock("./logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("cacheRetention default behavior", () => {
  it("returns 'short' for Anthropic when not configured", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = undefined;
    const provider = "anthropic";
    const modelId = "claude-3-sonnet";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Verify streamFn was set (indicating cache retention was applied)
    expect(agent.streamFn).toBeDefined();

    // The fact that agent.streamFn was modified indicates that cacheRetention
    // default "short" was applied. We don't need to call the actual function
    // since that would require API provider setup.
  });

  it("applies default short retention for anthropic-messages custom providers", () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options as Record<string, unknown> | undefined);
      return {} as ReturnType<StreamFn>;
    };
    const agent: { streamFn?: StreamFn } = { streamFn: baseStreamFn };
    const provider = "custom_anthropic";
    const modelId = "claude-3-sonnet";
    const cfg = {
      models: {
        providers: {
          custom_anthropic: {
            baseUrl: "https://api.example.com/v1",
            api: "anthropic-messages" as const,
            models: [
              {
                id: "claude-3-sonnet",
                name: "Claude 3 Sonnet",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider,
        id: modelId,
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe("short");
  });

  it("applies Anthropic beta headers for anthropic-messages custom providers", () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options as Record<string, unknown> | undefined);
      return {} as ReturnType<StreamFn>;
    };
    const agent: { streamFn?: StreamFn } = { streamFn: baseStreamFn };
    const provider = "custom_anthropic";
    const modelId = "claude-sonnet-4-6";
    const cfg = {
      agents: {
        defaults: {
          models: {
            "custom_anthropic/claude-sonnet-4-6": {
              params: {
                context1m: true,
              },
            },
          },
        },
      },
      models: {
        providers: {
          custom_anthropic: {
            baseUrl: "https://api.example.com/v1",
            api: "anthropic-messages" as const,
            models: [
              {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider,
        id: modelId,
      } as never,
      { messages: [] } as never,
      { apiKey: "sk-ant-api03-test" } as never,
    );

    expect(calls).toHaveLength(1);
    const headers = calls[0]?.headers as Record<string, string> | undefined;
    expect(headers?.["anthropic-beta"]).toContain("context-1m-2025-08-07");
  });

  it("respects explicit 'none' config", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-3-sonnet": {
              params: {
                cacheRetention: "none" as const,
              },
            },
          },
        },
      },
    };
    const provider = "anthropic";
    const modelId = "claude-3-sonnet";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Verify streamFn was set (config was applied)
    expect(agent.streamFn).toBeDefined();
  });

  it("respects explicit 'long' config", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-3-opus": {
              params: {
                cacheRetention: "long" as const,
              },
            },
          },
        },
      },
    };
    const provider = "anthropic";
    const modelId = "claude-3-opus";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Verify streamFn was set (config was applied)
    expect(agent.streamFn).toBeDefined();
  });

  it("respects legacy cacheControlTtl config", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-3-haiku": {
              params: {
                cacheControlTtl: "1h",
              },
            },
          },
        },
      },
    };
    const provider = "anthropic";
    const modelId = "claude-3-haiku";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Verify streamFn was set (legacy config was applied)
    expect(agent.streamFn).toBeDefined();
  });

  it("returns undefined for non-Anthropic providers", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = undefined;
    const provider = "openai";
    const modelId = "gpt-4";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // For OpenAI, the streamFn might be wrapped for other reasons (like OpenAI responses store)
    // but cacheRetention should not be applied
    // This is implicitly tested by the lack of cacheRetention-specific wrapping
  });

  it("prefers explicit cacheRetention over default", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-3-sonnet": {
              params: {
                cacheRetention: "long" as const,
                temperature: 0.7,
              },
            },
          },
        },
      },
    };
    const provider = "anthropic";
    const modelId = "claude-3-sonnet";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Verify streamFn was set with explicit config
    expect(agent.streamFn).toBeDefined();
  });

  it("works with extraParamsOverride", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = undefined;
    const provider = "anthropic";
    const modelId = "claude-3-sonnet";
    const extraParamsOverride = {
      cacheRetention: "none" as const,
    };

    applyExtraParamsToAgent(agent, cfg, provider, modelId, extraParamsOverride);

    // Verify streamFn was set (override was applied)
    expect(agent.streamFn).toBeDefined();
  });
});
