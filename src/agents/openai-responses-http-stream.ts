import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createParser } from "eventsource-parser";
import { fetch as undiciFetch } from "undici";
import {
  classifyResponsesTerminal,
  createResponsesTransportError,
  ResponsesTransportError,
  type ResponsesTerminalEvent,
  isRetryableResponsesTransportError,
} from "./openai-responses-state.js";
import type { ResponseObject } from "./openai-ws-connection.js";
import {
  buildAssistantMessageFromResponse,
  convertMessagesToInputItems,
  convertTools,
} from "./openai-ws-stream.js";
import {
  buildAssistantMessageWithZeroUsage,
  buildStreamErrorAssistantMessage,
} from "./stream-message-shared.js";

type ResponsesStreamOptions = Parameters<StreamFn>[2] & {
  cacheRetention?: "none" | "short" | "long";
  headers?: Record<string, string>;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
  reasoningEffort?: string;
  reasoningSummary?: string;
  sessionId?: string;
  temperature?: number;
  toolChoice?: unknown;
  topP?: number;
};

type ResponsesProtocolEvent = {
  type?: string;
  delta?: string;
  response?: ResponseObject;
  [key: string]: unknown;
};

export type OpenAIResponsesEventStreamFactory = (params: {
  context: Parameters<StreamFn>[1];
  headers: Record<string, string>;
  model: Parameters<StreamFn>[0];
  options?: ResponsesStreamOptions;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  url: string;
}) => AsyncIterable<ResponsesProtocolEvent> | Promise<AsyncIterable<ResponsesProtocolEvent>>;

export interface OpenAIResponsesHttpStreamOptions {
  fetchImpl?: typeof undiciFetch;
  idleTimeoutMs?: number;
  requestMaxRetries?: number;
  responseStreamFactory?: OpenAIResponsesEventStreamFactory;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  streamMaxRetries?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_MAX_RETRIES = 2;
const DEFAULT_STREAM_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRetryDelay(baseDelayMs: number, retriesSoFar: number): number {
  if (baseDelayMs <= 0) {
    return 0;
  }
  return baseDelayMs * 2 ** Math.max(0, retriesSoFar);
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function buildResponsesUrl(baseUrl: string): string {
  return new URL("responses", normalizeBaseUrl(baseUrl)).toString();
}

function isOpenAIPublicApiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return baseUrl.toLowerCase().includes("api.openai.com");
  }
}

function resolvePromptCacheRetention(
  baseUrl: string,
  cacheRetention: ResponsesStreamOptions["cacheRetention"],
): string | undefined {
  if (cacheRetention !== "long") {
    return undefined;
  }
  return isOpenAIPublicApiBaseUrl(baseUrl) ? "24h" : undefined;
}

function buildResponsesPayload(
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options?: ResponsesStreamOptions,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: model.id,
    stream: true,
    store: false,
    input: convertMessagesToInputItems(context.messages, model),
  };

  if (context.systemPrompt?.trim()) {
    payload.instructions = context.systemPrompt;
  }

  const tools = convertTools(context.tools);
  if (tools.length > 0) {
    payload.tools = tools;
  }

  const maxOutputTokens =
    options?.maxTokens ??
    Math.min(model.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  if (maxOutputTokens !== undefined) {
    payload.max_output_tokens = maxOutputTokens;
  }
  if (options?.temperature !== undefined) {
    payload.temperature = options.temperature;
  }
  if (options?.topP !== undefined) {
    payload.top_p = options.topP;
  }
  if (options?.toolChoice !== undefined) {
    payload.tool_choice = options.toolChoice;
  }
  if (options?.metadata && typeof options.metadata === "object") {
    payload.metadata = options.metadata;
  }
  if (options?.cacheRetention !== "none" && options?.sessionId) {
    payload.prompt_cache_key = options.sessionId;
    const promptCacheRetention = resolvePromptCacheRetention(model.baseUrl, options.cacheRetention);
    if (promptCacheRetention) {
      payload.prompt_cache_retention = promptCacheRetention;
    }
  }
  if (options?.reasoningEffort !== undefined || options?.reasoningSummary !== undefined) {
    payload.reasoning = {
      ...(options.reasoningEffort !== undefined ? { effort: options.reasoningEffort } : {}),
      ...(options.reasoningSummary !== undefined ? { summary: options.reasoningSummary } : {}),
    };
  }
  return payload;
}

function buildResponsesHeaders(
  model: Parameters<StreamFn>[0],
  options: ResponsesStreamOptions | undefined,
  apiKey: string,
): Record<string, string> {
  return {
    Accept: "text/event-stream",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...model.headers,
    ...options?.headers,
  };
}

async function* createResponsesSseEventIterator(params: {
  fetchImpl: typeof undiciFetch;
  headers: Record<string, string>;
  idleTimeoutMs: number;
  options?: ResponsesStreamOptions;
  payload: Record<string, unknown>;
  url: string;
}): AsyncGenerator<ResponsesProtocolEvent, void, unknown> {
  const requestAbortController = new AbortController();
  const userAbortHandler = () => {
    requestAbortController.abort(params.options?.signal?.reason);
  };
  params.options?.signal?.addEventListener("abort", userAbortHandler, { once: true });

  let idleTimedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (params.idleTimeoutMs <= 0) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      requestAbortController.abort("responses_idle_timeout");
    }, params.idleTimeoutMs);
  };
  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  try {
    const response = await params.fetchImpl(params.url, {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.payload),
      signal: requestAbortController.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const detail = bodyText.trim() ? ` ${bodyText.trim()}` : "";
      throw createResponsesTransportError({
        message: `Responses HTTP request failed: ${response.status}${detail}`,
        code: "responses_request_failed",
        retryable: isRetryableHttpStatus(response.status),
        phase: "request",
        transport: "http",
      });
    }

    if (!response.body) {
      throw createResponsesTransportError({
        message: "Responses HTTP request returned no body",
        code: "responses_request_failed",
        retryable: true,
        phase: "request",
        transport: "http",
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const pendingEvents: ResponsesProtocolEvent[] = [];
    let parseError: Error | null = null;
    const parser = createParser({
      onError(error) {
        const detail =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : JSON.stringify(error);
        parseError = new Error(`Invalid SSE stream: ${detail ?? typeof error}`);
      },
      onEvent(event) {
        if (event.data === "[DONE]") {
          return;
        }
        try {
          const parsed = JSON.parse(event.data) as ResponsesProtocolEvent;
          if (typeof parsed.type !== "string" && event.event) {
            parsed.type = event.event;
          }
          pendingEvents.push(parsed);
        } catch (error) {
          parseError = error instanceof Error ? error : new Error(String(error));
        }
      },
    });

    resetIdleTimer();
    while (true) {
      const { done, value } = await reader.read();
      clearIdleTimer();
      if (done) {
        break;
      }
      parser.feed(decoder.decode(value, { stream: true }));
      if (parseError) {
        throw parseError;
      }
      while (pendingEvents.length > 0) {
        yield pendingEvents.shift()!;
      }
      resetIdleTimer();
    }

    parser.feed(decoder.decode());
    if (parseError) {
      throw parseError;
    }
    while (pendingEvents.length > 0) {
      yield pendingEvents.shift()!;
    }
  } catch (error) {
    if (idleTimedOut) {
      throw createResponsesTransportError({
        message: "Responses stream incomplete: idle_timeout",
        code: "responses_idle_timeout",
        retryable: true,
        phase: "stream",
        transport: "http",
      });
    }
    throw error;
  } finally {
    clearIdleTimer();
    params.options?.signal?.removeEventListener("abort", userAbortHandler);
  }
}

function normalizeResponsesStreamError(params: {
  error: unknown;
  streamOpened: boolean;
}): ResponsesTransportError | Error {
  if (params.error instanceof Error && isAbortError(params.error)) {
    return params.error;
  }
  if (params.error instanceof ResponsesTransportError) {
    return params.error;
  }
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return createResponsesTransportError({
    message: params.streamOpened
      ? `Responses stream failed: ${message}`
      : `Responses request failed: ${message}`,
    code: params.streamOpened ? "responses_terminal_failed" : "responses_request_failed",
    retryable: true,
    phase: params.streamOpened ? "stream" : "request",
    transport: "http",
    cause: params.error,
  });
}

export function createOpenAIResponsesHttpStreamFn(
  opts: OpenAIResponsesHttpStreamOptions = {},
): StreamFn {
  return (model, context, rawOptions) => {
    const eventStream = createAssistantMessageEventStream();
    const options = rawOptions as ResponsesStreamOptions | undefined;

    const run = async () => {
      const apiKey = options?.apiKey?.trim();
      if (!apiKey) {
        const errorMessage = `No API key for provider: ${model.provider}`;
        eventStream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model,
            errorMessage,
          }),
        });
        eventStream.end();
        return;
      }

      const fetchImpl = opts.fetchImpl ?? undiciFetch;
      const responseStreamFactory =
        opts.responseStreamFactory ??
        ((params: Parameters<OpenAIResponsesEventStreamFactory>[0]) =>
          createResponsesSseEventIterator({
            fetchImpl,
            headers: params.headers,
            idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
            options: params.options,
            payload: params.payload,
            url: params.url,
          }));
      const requestMaxRetries = opts.requestMaxRetries ?? DEFAULT_REQUEST_MAX_RETRIES;
      const streamMaxRetries = opts.streamMaxRetries ?? DEFAULT_STREAM_MAX_RETRIES;
      const retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
      const sleep = opts.sleep ?? sleepMs;
      const modelInfo = { api: model.api, provider: model.provider, id: model.id };
      const payload = buildResponsesPayload(model, context, options);
      const nextPayload = await options?.onPayload?.(payload, model);
      const requestPayload =
        nextPayload && typeof nextPayload === "object"
          ? (nextPayload as Record<string, unknown>)
          : payload;
      const headers = buildResponsesHeaders(model, options, apiKey);
      const url = buildResponsesUrl(model.baseUrl);

      let requestRetries = 0;
      let streamRetries = 0;

      while (true) {
        const attemptEvents: unknown[] = [];
        let streamOpened = false;
        try {
          attemptEvents.push({
            type: "start",
            partial: buildAssistantMessageWithZeroUsage({
              model,
              content: [],
              stopReason: "stop",
            }),
          });

          const responseEvents = await responseStreamFactory({
            context,
            headers,
            model,
            options,
            payload: requestPayload,
            signal: options?.signal ?? new AbortController().signal,
            url,
          });
          streamOpened = true;

          let terminalEvent: ResponsesTerminalEvent = null;
          for await (const event of responseEvents) {
            if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
              attemptEvents.push({
                type: "text_delta",
                contentIndex: 0,
                delta: event.delta,
                partial: buildAssistantMessageWithZeroUsage({
                  model,
                  content: [{ type: "text", text: event.delta }],
                  stopReason: "stop",
                }),
              });
            }

            if (event.type === "response.completed" || event.type === "response.failed") {
              terminalEvent = event as ResponsesTerminalEvent;
            }
          }

          const terminal = classifyResponsesTerminal({
            terminalEvent,
            prematureEnd: terminalEvent ? undefined : "eof_before_terminal",
          });
          if (terminal.kind !== "success" || terminalEvent?.type !== "response.completed") {
            const failedTerminal =
              terminal.kind === "success"
                ? {
                    kind: "incomplete" as const,
                    reason: "missing_terminal_event",
                    retryable: true,
                  }
                : terminal;
            const code =
              failedTerminal.reason === "idle_timeout"
                ? "responses_idle_timeout"
                : failedTerminal.reason === "close_before_terminal"
                  ? "responses_premature_close"
                  : failedTerminal.reason === "eof_before_terminal"
                    ? "responses_premature_eof"
                    : failedTerminal.kind === "failed"
                      ? "responses_terminal_failed"
                      : "responses_incomplete";
            throw createResponsesTransportError({
              message: `Responses stream incomplete: ${failedTerminal.reason}`,
              code,
              retryable: failedTerminal.retryable,
              phase: "stream",
              transport: "http",
            });
          }

          const completedResponse = terminalEvent.response;
          if (!completedResponse) {
            throw createResponsesTransportError({
              message: "Responses stream incomplete: missing completed response payload",
              code: "responses_incomplete",
              retryable: true,
              phase: "stream",
              transport: "http",
            });
          }

          const message = buildAssistantMessageFromResponse(
            completedResponse as ResponseObject,
            modelInfo,
          );
          attemptEvents.push({
            type: "done",
            reason:
              message.stopReason === "toolUse"
                ? "toolUse"
                : message.stopReason === "length"
                  ? "length"
                  : "stop",
            message,
          });

          for (const event of attemptEvents) {
            eventStream.push(event as never);
          }
          eventStream.end();
          return;
        } catch (error) {
          if (options?.signal?.aborted || isAbortError(error)) {
            eventStream.push({
              type: "error",
              reason: "aborted",
              error: buildStreamErrorAssistantMessage({
                model,
                errorMessage: "aborted",
              }),
            });
            eventStream.end();
            return;
          }

          const normalizedError = normalizeResponsesStreamError({
            error,
            streamOpened,
          });

          if (isRetryableResponsesTransportError(normalizedError)) {
            if (normalizedError.phase === "request" && requestRetries < requestMaxRetries) {
              const delay = computeRetryDelay(retryBaseDelayMs, requestRetries);
              requestRetries += 1;
              if (delay > 0) {
                await sleep(delay);
              }
              continue;
            }
            if (normalizedError.phase === "stream" && streamRetries < streamMaxRetries) {
              const delay = computeRetryDelay(retryBaseDelayMs, streamRetries);
              streamRetries += 1;
              if (delay > 0) {
                await sleep(delay);
              }
              continue;
            }
          }

          const errorMessage =
            normalizedError instanceof Error ? normalizedError.message : String(normalizedError);
          eventStream.push({
            type: "error",
            reason: "error",
            error: buildStreamErrorAssistantMessage({
              model,
              errorMessage,
            }),
          });
          eventStream.end();
          return;
        }
      }
    };

    queueMicrotask(() => {
      void run();
    });

    return eventStream;
  };
}
