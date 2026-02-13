import { type RunOptions, run } from "@grammyjs/runner";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";
import { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { createTelegramBot, type TelegramBotWithFlush } from "./bot.js";
import {
  extractTelegramRetryAfterMs,
  isRecoverableTelegramNetworkError,
} from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import { readTelegramUpdateOffset, writeTelegramUpdateOffset } from "./update-offset-store.js";
import { startTelegramWebhook } from "./webhook.js";

export type MonitorTelegramOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
};

export function createTelegramRunnerOptions(cfg: OpenClawConfig): RunOptions<unknown> {
  return {
    sink: {
      concurrency: resolveAgentMaxConcurrent(cfg),
    },
    runner: {
      fetch: {
        // Match grammY defaults
        timeout: 30,
        // Request reactions without dropping default update types.
        allowed_updates: resolveTelegramAllowedUpdates(),
      },
      // Suppress grammY getUpdates stack traces; we log concise errors ourselves.
      silent: true,
      // Retry transient failures for a limited window before surfacing errors.
      maxRetryTime: 5 * 60 * 1000,
      retryInterval: "exponential",
    },
  };
}

const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const TELEGRAM_POLL_RESTART_STABLE_RESET_MS = 5 * 60_000;
const TELEGRAM_DELETE_WEBHOOK_MAX_ATTEMPTS = 5;

const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") {
    return false;
  }
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) {
    return false;
  }
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};

/** Check if error is a Grammy HttpError (used to scope unhandled rejection handling) */
const isGrammyHttpError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") {
    return false;
  }
  return (err as { name?: string }).name === "HttpError";
};

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const log = opts.runtime?.error ?? console.error;

  // Register handler for Grammy HttpError unhandled rejections.
  // This catches network errors that escape the polling loop's try-catch
  // (e.g., from setMyCommands during bot setup).
  // We gate on isGrammyHttpError to avoid suppressing non-Telegram errors.
  const unregisterHandler = registerUnhandledRejectionHandler((err) => {
    if (isGrammyHttpError(err) && isRecoverableTelegramNetworkError(err, { context: "polling" })) {
      log(`[telegram] Suppressed network error: ${formatErrorMessage(err)}`);
      return true; // handled - don't crash
    }
    return false;
  });

  try {
    const cfg = opts.config ?? loadConfig();
    const account = resolveTelegramAccount({
      cfg,
      accountId: opts.accountId,
    });
    const token = opts.token?.trim() || account.token;
    if (!token) {
      throw new Error(
        `Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
      );
    }

    const proxyFetch =
      opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : undefined);

    let lastUpdateId = await readTelegramUpdateOffset({
      accountId: account.accountId,
    });
    const persistUpdateId = async (updateId: number) => {
      if (lastUpdateId !== null && updateId <= lastUpdateId) {
        return;
      }
      lastUpdateId = updateId;
      try {
        await writeTelegramUpdateOffset({
          accountId: account.accountId,
          updateId,
        });
      } catch (err) {
        (opts.runtime?.error ?? console.error)(
          `telegram: failed to persist update offset: ${String(err)}`,
        );
      }
    };

    const bot = createTelegramBot({
      token,
      runtime: opts.runtime,
      proxyFetch,
      config: cfg,
      accountId: account.accountId,
      updateOffset: {
        lastUpdateId,
        onUpdateId: persistUpdateId,
      },
    });

    if (opts.useWebhook) {
      await startTelegramWebhook({
        token,
        accountId: account.accountId,
        config: cfg,
        path: opts.webhookPath,
        port: opts.webhookPort,
        secret: opts.webhookSecret,
        runtime: opts.runtime as RuntimeEnv,
        fetch: proxyFetch,
        abortSignal: opts.abortSignal,
        publicUrl: opts.webhookUrl,
      });
      return;
    }

    // Ensure polling can take control even if a webhook was previously configured.
    if (typeof bot.api.deleteWebhook === "function") {
      for (let attempt = 1; attempt <= TELEGRAM_DELETE_WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
        try {
          await Promise.resolve(bot.api.deleteWebhook({ drop_pending_updates: false }));
          break;
        } catch (err) {
          const retryAfterMs = extractTelegramRetryAfterMs(err);
          const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
          if (!isRecoverable && typeof retryAfterMs !== "number") {
            throw err;
          }
          if (attempt >= TELEGRAM_DELETE_WEBHOOK_MAX_ATTEMPTS) {
            throw err;
          }

          const baseDelayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, attempt);
          const cappedDelayMs = Math.min(baseDelayMs, TELEGRAM_POLL_RESTART_POLICY.maxMs);
          const delayMs = Math.max(cappedDelayMs, retryAfterMs ?? 0);
          (opts.runtime?.error ?? console.error)(
            `Telegram deleteWebhook failed (attempt ${attempt}/${TELEGRAM_DELETE_WEBHOOK_MAX_ATTEMPTS}): ${formatErrorMessage(err)}; retrying in ${formatDurationPrecise(delayMs)}.`,
          );
          await sleepWithAbort(delayMs, opts.abortSignal);
        }
      }
    }

    // Use grammyjs/runner for concurrent update processing
    let restartAttempts = 0;

    while (!opts.abortSignal?.aborted) {
      const runStartedAtMs = Date.now();
      const runner = run(bot, createTelegramRunnerOptions(cfg));
      const stopOnAbort = () => {
        if (opts.abortSignal?.aborted) {
          void runner.stop();
        }
      };
      opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
      try {
        // runner.task() resolves when the runner stops (normally or unexpectedly).
        await runner.task();

        const runDurationMs = Date.now() - runStartedAtMs;
        if (runDurationMs >= TELEGRAM_POLL_RESTART_STABLE_RESET_MS) {
          restartAttempts = 0;
        }

        if (opts.abortSignal?.aborted) {
          return;
        }

        // Flush any pending offset commits before restarting the runner to prevent
        // duplicate delivery of already-processed updates (R1-09).
        const flushFn = (bot as TelegramBotWithFlush)._flushPendingCommits;
        if (flushFn) {
          await flushFn().catch((flushErr) => {
            (opts.runtime?.error ?? console.error)(
              `Telegram: failed to flush pending offset commits before restart: ${formatErrorMessage(flushErr)}`,
            );
          });
        }

        restartAttempts += 1;
        const baseDelayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, restartAttempts);
        const delayMs = Math.min(baseDelayMs, TELEGRAM_POLL_RESTART_POLICY.maxMs);
        (opts.runtime?.error ?? console.error)(
          `Telegram polling stopped unexpectedly (attempt ${restartAttempts}); restarting in ${formatDurationPrecise(delayMs)}.`,
        );
        await sleepWithAbort(delayMs, opts.abortSignal);
        continue;
      } catch (err) {
        const runDurationMs = Date.now() - runStartedAtMs;
        if (runDurationMs >= TELEGRAM_POLL_RESTART_STABLE_RESET_MS) {
          restartAttempts = 0;
        }

        if (opts.abortSignal?.aborted) {
          throw err;
        }
        const isConflict = isGetUpdatesConflict(err);
        const retryAfterMs = extractTelegramRetryAfterMs(err);
        const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
        if (!isConflict && !isRecoverable) {
          throw err;
        }

        if (isConflict) {
          if (typeof bot.api.deleteWebhook === "function") {
            await Promise.resolve(bot.api.deleteWebhook({ drop_pending_updates: false })).catch(
              (deleteErr) => {
                (opts.runtime?.error ?? console.error)(
                  `Telegram getUpdates conflict; deleteWebhook attempt failed: ${formatErrorMessage(deleteErr)}`,
                );
              },
            );
          }
        }

        restartAttempts += 1;
        const baseDelayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, restartAttempts);
        const cappedDelayMs = Math.min(baseDelayMs, TELEGRAM_POLL_RESTART_POLICY.maxMs);
        const delayMs = Math.max(cappedDelayMs, retryAfterMs ?? 0);
        const reason = retryAfterMs
          ? "rate limited"
          : isConflict
            ? "getUpdates conflict"
            : "network error";
        const errMsg = formatErrorMessage(err);
        (opts.runtime?.error ?? console.error)(
          `Telegram ${reason} (attempt ${restartAttempts}): ${errMsg}; retrying in ${formatDurationPrecise(delayMs)}.`,
        );
        try {
          await sleepWithAbort(delayMs, opts.abortSignal);
        } catch (sleepErr) {
          if (opts.abortSignal?.aborted) {
            return;
          }
          throw sleepErr;
        }
      } finally {
        opts.abortSignal?.removeEventListener("abort", stopOnAbort);
      }
    }
  } finally {
    unregisterHandler();
  }
}
