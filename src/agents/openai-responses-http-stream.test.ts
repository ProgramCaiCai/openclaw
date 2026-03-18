import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIResponsesHttpStreamFn } from "./openai-responses-http-stream.js";
import type { ResponseObject } from "./openai-ws-connection.js";

const modelStub: Model<"openai-responses"> = {
  api: "openai-responses",
  provider: "custom-openai",
  id: "gpt-5.4",
  name: "gpt-5.4",
  baseUrl: "https://example.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

const contextStub: Context = {
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
  tools: [],
};

async function collectEvents(
  stream:
    | AsyncIterable<unknown>
    | Promise<AsyncIterable<unknown>>
    | ReturnType<ReturnType<typeof createOpenAIResponsesHttpStreamFn>>,
): Promise<unknown[]> {
  const events: unknown[] = [];
  const resolvedStream = stream instanceof Promise ? await stream : stream;
  for await (const event of resolvedStream) {
    events.push(event);
  }
  return events;
}

function makeCompletedResponse(
  id: string,
  text: string,
  status: ResponseObject["status"] = "completed",
) {
  return {
    id,
    object: "response",
    created_at: Date.now(),
    status,
    model: "gpt-5.4",
    output: [
      {
        type: "message" as const,
        id: `msg_${id}`,
        role: "assistant" as const,
        status: "completed" as const,
        content: [{ type: "output_text" as const, text }],
      },
    ],
  } satisfies ResponseObject;
}

describe("createOpenAIResponsesHttpStreamFn", () => {
  it("retries premature EOF and only flushes the successful attempt", async () => {
    let attemptCount = 0;
    const responseStreamFactory = vi.fn(async function* () {
      attemptCount += 1;
      if (attemptCount === 1) {
        yield { type: "response.output_text.delta", delta: "partial" };
        return;
      }
      yield { type: "response.output_text.delta", delta: "final" };
      yield {
        type: "response.completed",
        response: makeCompletedResponse("resp_ok", "final"),
      };
    });

    const streamFn = createOpenAIResponsesHttpStreamFn({
      responseStreamFactory,
      requestMaxRetries: 0,
      streamMaxRetries: 1,
      retryBaseDelayMs: 0,
      sleep: vi.fn(async () => undefined),
    });

    const events = await collectEvents(streamFn(modelStub, contextStub, { apiKey: "sk-test" }));

    expect(responseStreamFactory).toHaveBeenCalledTimes(2);
    expect(
      events.filter((event) => (event as { type?: string }).type === "text_delta"),
    ).toMatchObject([{ delta: "final" }]);
    expect(events.map((event) => (event as { type?: string }).type)).toEqual([
      "start",
      "text_delta",
      "done",
    ]);
  });

  it("fails closed after exhausting retries on incomplete terminal status", async () => {
    const responseStreamFactory = vi.fn(async function* () {
      yield {
        type: "response.completed",
        response: makeCompletedResponse("resp_short", "", "incomplete"),
      };
    });

    const streamFn = createOpenAIResponsesHttpStreamFn({
      responseStreamFactory,
      requestMaxRetries: 0,
      streamMaxRetries: 1,
      retryBaseDelayMs: 0,
      sleep: vi.fn(async () => undefined),
    });

    const events = await collectEvents(streamFn(modelStub, contextStub, { apiKey: "sk-test" }));

    expect(responseStreamFactory).toHaveBeenCalledTimes(2);
    const errorEvent = events.at(-1) as
      | {
          type: string;
          error?: { errorMessage?: string };
        }
      | undefined;
    expect(errorEvent?.type).toBe("error");
    expect(errorEvent?.error?.errorMessage).toContain("response.completed:incomplete");
  });
});
