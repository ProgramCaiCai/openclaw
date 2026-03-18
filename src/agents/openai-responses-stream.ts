import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { createOpenAIResponsesHttpStreamFn } from "./openai-responses-http-stream.js";
import { isResponsesApi } from "./openai-responses-state.js";
import { createOpenAIWebSocketStreamFn } from "./openai-ws-stream.js";

export interface OpenAIResponsesStreamOptions {
  sessionId: string;
  signal?: AbortSignal;
  wsApiKey?: string;
}

export function createOpenAIResponsesStreamFn(opts: OpenAIResponsesStreamOptions): StreamFn {
  const httpStreamFn = createOpenAIResponsesHttpStreamFn();
  const wsStreamFn = opts.wsApiKey
    ? createOpenAIWebSocketStreamFn(opts.wsApiKey, opts.sessionId, {
        signal: opts.signal,
      })
    : undefined;

  return (model, context, options) => {
    if (!isResponsesApi(model.api)) {
      return streamSimple(model, context, options);
    }

    const transport = (options as { transport?: unknown } | undefined)?.transport;
    const canUseWs =
      wsStreamFn &&
      model.api === "openai-responses" &&
      model.provider === "openai" &&
      transport !== "sse";

    return canUseWs ? wsStreamFn(model, context, options) : httpStreamFn(model, context, options);
  };
}
