import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

type OpenAIResponsesModel = Model<"openai-responses">;

type InvokeParams = {
  applyProvider: string;
  applyModelId: string;
  model: OpenAIResponsesModel;
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
  options?: SimpleStreamOptions;
  context?: Context;
};

function invokeWrappedStream(params: InvokeParams) {
  const payload: Record<string, unknown> = { model: params.model.id, input: [] };
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return {} as ReturnType<StreamFn>;
  };

  const agent = { streamFn: baseStreamFn };
  applyExtraParamsToAgent(agent, params.cfg, params.applyProvider, params.applyModelId);

  const context: Context = params.context ?? { messages: [] };
  const stream = agent.streamFn?.(params.model, context, params.options ?? {});

  return { payload, stream };
}

describe("extra-params: OpenAI Responses cache controls", () => {
  it("injects prompt_cache_retention for openai-responses across providers", () => {
    const { payload } = invokeWrappedStream({
      applyProvider: "openrouter",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openrouter",
        id: "gpt-5",
      } as OpenAIResponsesModel,
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/gpt-5": {
                params: {
                  promptCacheRetention: "24h",
                },
              },
            },
          },
        },
      },
    });

    expect(payload.prompt_cache_retention).toBe("24h");
  });

  it("does not inject prompt_cache_retention when not configured", () => {
    const { payload } = invokeWrappedStream({
      applyProvider: "openrouter",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openrouter",
        id: "gpt-5",
      } as OpenAIResponsesModel,
    });

    expect(payload).not.toHaveProperty("prompt_cache_retention");
  });

  it("prefers configured prompt_cache_key over auto-generated key", () => {
    const { payload } = invokeWrappedStream({
      applyProvider: "openrouter",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openrouter",
        id: "gpt-5",
      } as OpenAIResponsesModel,
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/gpt-5": {
                params: {
                  promptCacheKey: "fixed-cache-key",
                },
              },
            },
          },
        },
      },
      options: {
        sessionId: "session-123",
      },
    });

    expect(payload.prompt_cache_key).toBe("fixed-cache-key");
  });

  it("auto-generates prompt_cache_key from session id when not configured", () => {
    const { payload } = invokeWrappedStream({
      applyProvider: "openrouter",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openrouter",
        id: "gpt-5",
      } as OpenAIResponsesModel,
      options: {
        sessionId: "session-123",
      },
    });

    expect(payload.prompt_cache_key).toBe("session-123");
  });

  it("forces store=true only for direct openai responses", () => {
    const direct = invokeWrappedStream({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
      } as OpenAIResponsesModel,
    });
    const thirdParty = invokeWrappedStream({
      applyProvider: "openrouter",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openrouter",
        id: "gpt-5",
      } as OpenAIResponsesModel,
    });

    expect(direct.payload.store).toBe(true);
    expect(thirdParty.payload.store).toBeUndefined();
  });
});
