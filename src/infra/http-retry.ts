import { sleep } from "../utils.js";
import { type RetryConfig, resolveRetryConfig } from "./retry.js";
import { isAbortError, isTransientNetworkError } from "./unhandled-rejections.js";

const DEFAULT_HTTP_RETRY_CONFIG: Required<RetryConfig> = {
  attempts: 3,
  minDelayMs: 250,
  maxDelayMs: 8_000,
  jitter: 0.1,
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"];
const DEFAULT_RETRYABLE_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504];

export type HttpRetryAttemptContext = {
  attempt: number;
  maxAttempts: number;
  method: string;
  label?: string;
};

export type HttpRetryInfo = HttpRetryAttemptContext & {
  delayMs: number;
  reason: "error" | "response";
  status?: number;
  error?: unknown;
};

export type HttpRequestExecutor<T> = (params: {
  attempt: number;
  signal: AbortSignal;
}) => Promise<T>;

export type HttpRetryOptions<T> = RetryConfig & {
  timeoutMs?: number;
  method?: string;
  retryableMethods?: readonly string[];
  retryableStatusCodes?: readonly number[];
  retryNonIdempotent?: boolean;
  signal?: AbortSignal;
  label?: string;
  shouldRetryError?: (err: unknown, context: HttpRetryAttemptContext) => boolean;
  shouldRetryResult?: (result: T, context: HttpRetryAttemptContext) => boolean;
  getRetryAfterMs?: (value: unknown, context: HttpRetryAttemptContext) => number | undefined;
  onRetry?: (info: HttpRetryInfo) => void;
};

export type FetchWithHttpRetryOptions = Omit<HttpRetryOptions<Response>, "method"> & {
  fetchFn?: typeof fetch;
};

export class HttpRequestTimeoutError extends Error {
  readonly code = "HTTP_TIMEOUT";
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`HTTP request timed out after ${timeoutMs}ms`);
    this.name = "HttpRequestTimeoutError";
    this.timeoutMs = timeoutMs;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function toFiniteNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeMethod(method?: string): string {
  return (method ?? "GET").trim().toUpperCase() || "GET";
}

function isMethodRetryable(method: string, options: HttpRetryOptions<unknown>): boolean {
  if (options.retryNonIdempotent) {
    return true;
  }
  const allowed = new Set(
    (options.retryableMethods ?? DEFAULT_RETRY_METHODS).map((candidate) => candidate.toUpperCase()),
  );
  return allowed.has(method.toUpperCase());
}

function applyJitter(delayMs: number, jitter: number): number {
  if (jitter <= 0) {
    return delayMs;
  }
  const offset = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(delayMs * (1 + offset)));
}

function computeRetryDelayMs(params: {
  attempt: number;
  minDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  retryAfterMs?: number;
}): number {
  const exponentialBackoffMs = params.minDelayMs * 2 ** Math.max(0, params.attempt - 1);
  const retryAfterMs = toFiniteNonNegativeInteger(params.retryAfterMs);
  const baseDelayMs =
    retryAfterMs === undefined
      ? exponentialBackoffMs
      : Math.max(params.minDelayMs, retryAfterMs, exponentialBackoffMs);
  const clampedMs = Math.min(Math.max(baseDelayMs, params.minDelayMs), params.maxDelayMs);
  return Math.min(
    Math.max(applyJitter(clampedMs, params.jitter), params.minDelayMs),
    params.maxDelayMs,
  );
}

function parseRetryAfterHeader(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function isResponseLike(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof (value as { status?: unknown }).status === "number" &&
    "headers" in value
  );
}

function getStatusCodeFromError(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }

  const directStatus = (err as { status?: unknown }).status;
  if (typeof directStatus === "number" && Number.isFinite(directStatus)) {
    return directStatus;
  }

  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number" && Number.isFinite(statusCode)) {
    return statusCode;
  }

  const responseStatus =
    "response" in err && err.response && typeof err.response === "object"
      ? (err.response as { status?: unknown }).status
      : undefined;
  if (typeof responseStatus === "number" && Number.isFinite(responseStatus)) {
    return responseStatus;
  }

  return undefined;
}

function getRetryAfterMsFromError(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }

  const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.floor(retryAfterMs);
  }

  const retryAfterSeconds = (err as { retry_after?: unknown }).retry_after;
  if (
    typeof retryAfterSeconds === "number" &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return Math.floor(retryAfterSeconds * 1000);
  }

  const responseHeaders =
    "response" in err && err.response && typeof err.response === "object"
      ? (err.response as { headers?: unknown }).headers
      : undefined;

  if (responseHeaders instanceof Headers) {
    return parseRetryAfterHeader(responseHeaders.get("retry-after"));
  }

  if (responseHeaders && typeof responseHeaders === "object") {
    const maybeHeader = (responseHeaders as Record<string, unknown>)["retry-after"];
    if (typeof maybeHeader === "string") {
      return parseRetryAfterHeader(maybeHeader);
    }
  }

  return undefined;
}

function defaultShouldRetryResult(
  result: unknown,
  options: HttpRetryOptions<unknown>,
  _context: HttpRetryAttemptContext,
): boolean {
  if (!isResponseLike(result)) {
    return false;
  }
  const statuses = new Set(options.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES);
  return statuses.has(result.status);
}

function defaultShouldRetryError(
  err: unknown,
  options: HttpRetryOptions<unknown>,
  _context: HttpRetryAttemptContext,
): boolean {
  if (err instanceof HttpRequestTimeoutError) {
    return true;
  }
  const status = getStatusCodeFromError(err);
  if (typeof status === "number") {
    const statuses = new Set(options.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES);
    if (statuses.has(status)) {
      return true;
    }
  }
  return isTransientNetworkError(err);
}

function defaultGetRetryAfterMs(value: unknown): number | undefined {
  if (isResponseLike(value)) {
    return parseRetryAfterHeader(value.headers.get("retry-after"));
  }
  return getRetryAfterMsFromError(value);
}

function maybeCancelResponseBody(result: unknown): void {
  if (!isResponseLike(result) || !result.body) {
    return;
  }
  void result.body.cancel();
}

function createAbortError(message: string): Error {
  if (typeof DOMException === "function") {
    return new DOMException(message, "AbortError");
  }
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

async function runAttempt<T>(params: {
  attempt: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  executor: HttpRequestExecutor<T>;
}): Promise<T> {
  if (params.signal?.aborted) {
    throw createAbortError("The operation was aborted");
  }

  const controller = new AbortController();
  const timeoutMs = toFiniteNonNegativeInteger(params.timeoutMs);
  let timeoutId: NodeJS.Timeout | undefined;

  const relayAbort = () => controller.abort(params.signal?.reason);
  if (params.signal) {
    params.signal.addEventListener("abort", relayAbort, { once: true });
  }

  const runPromise = Promise.resolve().then(() =>
    params.executor({
      attempt: params.attempt,
      signal: controller.signal,
    }),
  );

  const timeoutPromise =
    timeoutMs === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => {
              controller.abort(new HttpRequestTimeoutError(timeoutMs));
              reject(new HttpRequestTimeoutError(timeoutMs));
            },
            Math.max(1, timeoutMs),
          );
        });

  try {
    return timeoutPromise === undefined
      ? await runPromise
      : await Promise.race([runPromise, timeoutPromise]);
  } catch (err) {
    if (err instanceof HttpRequestTimeoutError) {
      throw err;
    }
    if (timeoutMs !== undefined && isAbortError(err) && !params.signal?.aborted) {
      throw new HttpRequestTimeoutError(timeoutMs, err);
    }
    throw err;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (params.signal) {
      params.signal.removeEventListener("abort", relayAbort);
    }
  }
}

export async function retryHttpRequest<T>(
  executor: HttpRequestExecutor<T>,
  options: HttpRetryOptions<T> = {},
): Promise<T> {
  const method = normalizeMethod(options.method);
  const retryableMethod = isMethodRetryable(method, options as HttpRetryOptions<unknown>);
  const retryConfig = resolveRetryConfig(DEFAULT_HTTP_RETRY_CONFIG, options);
  const maxAttempts = retryableMethod ? retryConfig.attempts : 1;
  const timeoutMs = toFiniteNonNegativeInteger(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const context: HttpRetryAttemptContext = {
      attempt,
      maxAttempts,
      method,
      label: options.label,
    };

    try {
      const result = await runAttempt({
        attempt,
        timeoutMs,
        signal: options.signal,
        executor,
      });

      const shouldRetryResult =
        options.shouldRetryResult?.(result, context) ??
        defaultShouldRetryResult(result, options as HttpRetryOptions<unknown>, context);

      if (!shouldRetryResult || attempt >= maxAttempts) {
        return result;
      }

      const retryAfterMs =
        options.getRetryAfterMs?.(result, context) ?? defaultGetRetryAfterMs(result as unknown);
      const delayMs = computeRetryDelayMs({
        attempt,
        minDelayMs: retryConfig.minDelayMs,
        maxDelayMs: retryConfig.maxDelayMs,
        jitter: retryConfig.jitter,
        retryAfterMs,
      });

      options.onRetry?.({
        ...context,
        delayMs,
        reason: "response",
        status: isResponseLike(result) ? result.status : undefined,
      });

      maybeCancelResponseBody(result as unknown);
      await sleep(delayMs);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) {
        break;
      }
      if (isAbortError(err) && options.signal?.aborted) {
        break;
      }

      const shouldRetryError =
        options.shouldRetryError?.(err, context) ??
        defaultShouldRetryError(err, options as HttpRetryOptions<unknown>, context);
      if (!shouldRetryError) {
        break;
      }

      const retryAfterMs = options.getRetryAfterMs?.(err, context) ?? defaultGetRetryAfterMs(err);
      const delayMs = computeRetryDelayMs({
        attempt,
        minDelayMs: retryConfig.minDelayMs,
        maxDelayMs: retryConfig.maxDelayMs,
        jitter: retryConfig.jitter,
        retryAfterMs,
      });

      options.onRetry?.({
        ...context,
        delayMs,
        reason: "error",
        status: getStatusCodeFromError(err),
        error: err,
      });

      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("HTTP retry failed");
}

export async function fetchWithHttpRetry(
  input: string | URL,
  init: RequestInit = {},
  options: FetchWithHttpRetryOptions = {},
): Promise<Response> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (!fetchFn) {
    throw new Error("fetch is not available");
  }

  const method = normalizeMethod(init.method);
  const requestSignal = options.signal ?? init.signal;
  return retryHttpRequest(
    ({ signal, attempt }) => {
      if (attempt > 1 && init.body && typeof init.body === "object" && "used" in init.body) {
        throw new Error("Request body cannot be retried because it is a one-time stream");
      }
      return fetchFn(input, {
        ...init,
        signal: requestSignal ?? signal,
      });
    },
    {
      ...options,
      method,
      signal: requestSignal,
    },
  );
}
