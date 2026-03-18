import { describe, expect, it } from "vitest";
import {
  classifyResponsesTerminal,
  createResponsesTransportError,
  isRetryableResponsesTransportError,
  isResponsesApi,
} from "./openai-responses-state.js";

describe("isResponsesApi", () => {
  it("matches the strict Responses API set", () => {
    expect(isResponsesApi("openai-responses")).toBe(true);
    expect(isResponsesApi("openai-codex-responses")).toBe(true);
    expect(isResponsesApi("openai-completions")).toBe(false);
  });
});

describe("classifyResponsesTerminal", () => {
  it("accepts only response.completed with status completed as success", () => {
    expect(
      classifyResponsesTerminal({
        terminalEvent: {
          type: "response.completed",
          response: { status: "completed" },
        },
      }),
    ).toMatchObject({ kind: "success", status: "completed" });

    expect(
      classifyResponsesTerminal({
        terminalEvent: {
          type: "response.completed",
          response: { status: "incomplete" },
        },
      }),
    ).toMatchObject({
      kind: "incomplete",
      reason: "response.completed:incomplete",
      retryable: true,
      status: "incomplete",
    });
  });

  it("treats response.failed as failed and retryable", () => {
    expect(
      classifyResponsesTerminal({
        terminalEvent: {
          type: "response.failed",
          response: {
            status: "failed",
            error: { message: "boom" },
          },
        },
      }),
    ).toMatchObject({
      kind: "failed",
      reason: "boom",
      retryable: true,
      status: "failed",
    });
  });

  it("fails closed when the stream ends without a terminal completion", () => {
    expect(
      classifyResponsesTerminal({
        terminalEvent: null,
        prematureEnd: "eof_before_terminal",
      }),
    ).toMatchObject({
      kind: "incomplete",
      reason: "eof_before_terminal",
      retryable: true,
    });
  });
});

describe("ResponsesTransportError", () => {
  it("preserves retryability and transport metadata", () => {
    const error = createResponsesTransportError({
      message: "Responses stream incomplete: eof_before_terminal",
      code: "responses_premature_eof",
      retryable: true,
      phase: "stream",
      transport: "http",
    });

    expect(isRetryableResponsesTransportError(error)).toBe(true);
    expect(error.code).toBe("responses_premature_eof");
    expect(error.phase).toBe("stream");
    expect(error.transport).toBe("http");
  });
});
