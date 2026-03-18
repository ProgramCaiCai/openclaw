const RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses"]);

export type ResponsesTerminalEvent =
  | {
      type: "response.completed";
      response?: { status?: string | null; error?: { message?: string | null } | null } | null;
    }
  | {
      type: "response.failed";
      response?: { status?: string | null; error?: { message?: string | null } | null } | null;
    }
  | null;

export type ResponsesPrematureEndReason =
  | "close_before_terminal"
  | "eof_before_terminal"
  | "idle_timeout"
  | "missing_terminal_event";

export type ResponsesTerminalResult =
  | { kind: "success"; status: "completed" }
  | { kind: "incomplete"; reason: string; retryable: boolean; status?: string | null }
  | { kind: "failed"; reason: string; retryable: boolean; status?: string | null };

export type ResponsesTransportErrorCode =
  | "responses_incomplete"
  | "responses_idle_timeout"
  | "responses_premature_close"
  | "responses_premature_eof"
  | "responses_terminal_failed"
  | "responses_request_failed";

export type ResponsesTransportPhase = "request" | "stream";
export type ResponsesTransportKind = "http" | "websocket";

export class ResponsesTransportError extends Error {
  readonly code: ResponsesTransportErrorCode;
  readonly retryable: boolean;
  readonly phase: ResponsesTransportPhase;
  readonly transport: ResponsesTransportKind;

  constructor(params: {
    message: string;
    code: ResponsesTransportErrorCode;
    retryable: boolean;
    phase: ResponsesTransportPhase;
    transport: ResponsesTransportKind;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = "ResponsesTransportError";
    this.code = params.code;
    this.retryable = params.retryable;
    this.phase = params.phase;
    this.transport = params.transport;
  }
}

export function isResponsesApi(api: unknown): api is "openai-responses" | "openai-codex-responses" {
  return typeof api === "string" && RESPONSES_APIS.has(api);
}

export function classifyResponsesTerminal(params: {
  terminalEvent: ResponsesTerminalEvent;
  prematureEnd?: ResponsesPrematureEndReason;
}): ResponsesTerminalResult {
  if (params.terminalEvent?.type === "response.completed") {
    const status = params.terminalEvent.response?.status ?? null;
    if (status === "completed") {
      return { kind: "success", status: "completed" };
    }
    return {
      kind: "incomplete",
      reason: `response.completed:${status ?? "missing-status"}`,
      retryable: true,
      status,
    };
  }

  if (params.terminalEvent?.type === "response.failed") {
    return {
      kind: "failed",
      reason: params.terminalEvent.response?.error?.message ?? "response.failed",
      retryable: true,
      status: params.terminalEvent.response?.status ?? "failed",
    };
  }

  return {
    kind: "incomplete",
    reason: params.prematureEnd ?? "missing_terminal_event",
    retryable: true,
  };
}

export function createResponsesTransportError(params: {
  message: string;
  code: ResponsesTransportErrorCode;
  retryable: boolean;
  phase: ResponsesTransportPhase;
  transport: ResponsesTransportKind;
  cause?: unknown;
}): ResponsesTransportError {
  return new ResponsesTransportError(params);
}

export function isRetryableResponsesTransportError(
  error: unknown,
): error is ResponsesTransportError {
  return error instanceof ResponsesTransportError && error.retryable;
}
