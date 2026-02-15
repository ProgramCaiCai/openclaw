import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";

const RECOVERABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ECONNABORTED",
  "ERR_NETWORK",
]);

const RECOVERABLE_ERROR_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
]);

const RECOVERABLE_MESSAGE_SNIPPETS = [
  "fetch failed",
  "typeerror: fetch failed",
  "undici",
  "network error",
  "network request",
  "client network socket disconnected",
  "socket hang up",
  "getaddrinfo",
  "timeout", // catch timeout messages not covered by error codes/names
  "timed out", // grammY getUpdates returns "timed out after X seconds" (not matched by "timeout")
];

function normalizeCode(code?: string): string {
  return code?.trim().toUpperCase() ?? "";
}

function getErrorName(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  return "name" in err ? String(err.name) : "";
}

function getErrorCode(err: unknown): string | undefined {
  const direct = extractErrorCode(err);
  if (direct) {
    return direct;
  }
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === "string") {
    return errno;
  }
  if (typeof errno === "number") {
    return String(errno);
  }
  return undefined;
}

function getTelegramApiErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const typed = err as {
    error_code?: unknown;
    errorCode?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown } | null;
  };

  const candidates = [
    typed.error_code,
    typed.errorCode,
    typed.status,
    typed.statusCode,
    typed.response?.status,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function getTelegramRetryAfterSeconds(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const params = (err as { parameters?: unknown }).parameters;
  if (params && typeof params === "object") {
    const retryAfter = (params as { retry_after?: unknown }).retry_after;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
      return retryAfter;
    }
  }
  const direct = (err as { retry_after?: unknown; retryAfter?: unknown }).retry_after;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  const alt = (err as { retryAfter?: unknown }).retryAfter;
  if (typeof alt === "number" && Number.isFinite(alt)) {
    return alt;
  }
  return undefined;
}

function collectErrorCandidates(err: unknown): unknown[] {
  const queue = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (typeof current === "object") {
      const cause = (current as { cause?: unknown }).cause;
      if (cause && !seen.has(cause)) {
        queue.push(cause);
      }
      const reason = (current as { reason?: unknown }).reason;
      if (reason && !seen.has(reason)) {
        queue.push(reason);
      }
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) {
            queue.push(nested);
          }
        }
      }
      // Grammy's HttpError wraps the underlying error in .error (not .cause)
      // Only follow .error for HttpError to avoid widening the search graph
      if (getErrorName(current) === "HttpError") {
        const wrappedError = (current as { error?: unknown }).error;
        if (wrappedError && !seen.has(wrappedError)) {
          queue.push(wrappedError);
        }
      }
    }
  }

  return candidates;
}

export function extractTelegramRetryAfterMs(err: unknown): number | undefined {
  for (const candidate of collectErrorCandidates(err)) {
    const retryAfterSeconds = getTelegramRetryAfterSeconds(candidate);
    if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)) {
      return Math.max(0, Math.trunc(retryAfterSeconds * 1000));
    }
  }
  return undefined;
}

export type TelegramNetworkErrorContext = "polling" | "send" | "webhook" | "unknown";

/** Telegram API HTTP status codes that are transient server errors (safe to retry in polling/webhook). */
const RECOVERABLE_TELEGRAM_HTTP_CODES = new Set([500, 502, 503, 504]);

export function isRecoverableTelegramNetworkError(
  err: unknown,
  options: { context?: TelegramNetworkErrorContext; allowMessageMatch?: boolean } = {},
): boolean {
  if (!err) {
    return false;
  }
  const allowMessageMatch =
    typeof options.allowMessageMatch === "boolean"
      ? options.allowMessageMatch
      : options.context !== "send";

  for (const candidate of collectErrorCandidates(err)) {
    const telegramErrorCode = getTelegramApiErrorCode(candidate);
    if (telegramErrorCode === 429) {
      return true;
    }

    // Treat transient server errors (5xx) as recoverable in polling/webhook contexts
    // to prevent the polling loop from terminating on temporary Telegram API outages.
    if (telegramErrorCode && RECOVERABLE_TELEGRAM_HTTP_CODES.has(telegramErrorCode)) {
      if (options.context === "polling" || options.context === "webhook") {
        return true;
      }
    }

    const code = normalizeCode(getErrorCode(candidate));
    if (code && RECOVERABLE_ERROR_CODES.has(code)) {
      return true;
    }

    const name = getErrorName(candidate);
    if (name && RECOVERABLE_ERROR_NAMES.has(name)) {
      return true;
    }

    if (allowMessageMatch) {
      const message = formatErrorMessage(candidate).toLowerCase();
      if (message && RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
}
