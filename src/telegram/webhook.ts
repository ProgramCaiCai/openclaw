import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { isDiagnosticsEnabled } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { createTelegramWebhookSpool } from "./webhook-spool.js";

const webhookLog = createSubsystemLogger("gateway/channels/telegram/webhook");

async function readJsonBody(req: IncomingMessage, opts: { maxBytes: number }) {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > opts.maxBytes) {
      throw new Error(`webhook body too large (${size} bytes)`);
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}

function resolveSecretHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-telegram-bot-api-secret-token"];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return typeof raw === "string" ? raw : undefined;
}

export async function startTelegramWebhook(opts: {
  token: string;
  accountId?: string;
  config?: OpenClawConfig;
  path?: string;
  port?: number;
  host?: string;
  secret?: string;
  runtime?: RuntimeEnv;
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  healthPath?: string;
  publicUrl?: string;
}) {
  const path = opts.path ?? "/telegram-webhook";
  const healthPath = opts.healthPath ?? "/healthz";
  const port = opts.port ?? 8787;
  const host = opts.host ?? "0.0.0.0";
  const runtime = opts.runtime ?? defaultRuntime;
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);

  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    config: opts.config,
    accountId: opts.accountId,
  });

  const spool = createTelegramWebhookSpool({ accountId: opts.accountId });

  const processUpdate = async (update: unknown, spoolPath?: string) => {
    const startTime = Date.now();
    try {
      // We always ACK the HTTP request ourselves (see below), so this is purely
      // internal processing.
      await Promise.resolve(
        (bot as { handleUpdate?: (arg: unknown) => unknown }).handleUpdate?.(update),
      );

      if (spoolPath) {
        await spool.ack(spoolPath);
      }

      if (diagnosticsEnabled) {
        logWebhookProcessed({
          channel: "telegram",
          updateType: "telegram-post",
          durationMs: Date.now() - startTime,
        });
      }
    } catch (err) {
      const errMsg = formatErrorMessage(err);
      webhookLog.error("webhook update processing failed", {
        phase: "webhook.process",
        error: errMsg,
        spoolPath,
      });
      if (diagnosticsEnabled) {
        logWebhookError({
          channel: "telegram",
          updateType: "telegram-post",
          error: errMsg,
        });
      }
      runtime.log?.(`webhook update processing failed: ${errMsg}`);
    }
  };

  const replaySpoolOnce = async () => {
    const pending = await spool.list();
    for (const filePath of pending) {
      try {
        const entry = await spool.read(filePath);
        await processUpdate(entry.update, filePath);
      } catch (err) {
        webhookLog.error("webhook spool replay failed", {
          phase: "webhook.replay",
          error: formatErrorMessage(err),
          spoolPath: filePath,
        });
      }
    }
  };

  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat();
  }

  const server = createServer((req, res) => {
    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    if (opts.secret) {
      const secretHeader = resolveSecretHeader(req);
      if (!secretHeader || secretHeader !== opts.secret) {
        webhookLog.warn("telegram webhook secret mismatch", {
          phase: "webhook.auth",
          hasSecretHeader: Boolean(secretHeader),
        });
        // Always 200 to avoid retry storms; invalid requests are ignored.
        res.writeHead(200);
        res.end("ok");
        return;
      }
    }

    const requestStart = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
    }

    // Always ACK Telegram quickly to avoid retry storms and response leaks.
    res.writeHead(200);
    res.end("ok");

    void (async () => {
      let update: unknown;
      try {
        update = await readJsonBody(req, { maxBytes: 1_000_000 });
      } catch (err) {
        const errMsg = formatErrorMessage(err);
        webhookLog.error("webhook body parse failed", {
          phase: "webhook.body",
          error: errMsg,
        });
        runtime.log?.(`webhook body parse failed: ${errMsg}`);
        return;
      }

      if (!update) {
        return;
      }

      const updateId =
        update && typeof update === "object" && "update_id" in update
          ? (update as { update_id?: unknown }).update_id
          : undefined;
      const resolvedUpdateId = typeof updateId === "number" ? updateId : undefined;
      const receivedAtMs = Date.now();

      try {
        const appended = await spool.append({
          receivedAtMs,
          updateId: resolvedUpdateId,
          update,
        });
        webhookLog.info("webhook update spooled", {
          phase: "webhook.spool",
          updateId: resolvedUpdateId,
          durationMs: Date.now() - requestStart,
        });
        await processUpdate(update, appended.filePath);
      } catch (err) {
        const errMsg = formatErrorMessage(err);
        webhookLog.error("webhook spool append failed", {
          phase: "webhook.spool",
          error: errMsg,
          updateId: resolvedUpdateId,
        });
        runtime.log?.(`webhook spool append failed: ${errMsg}`);
        await processUpdate(update);
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  const address = server.address();
  const effectivePort = typeof address === "object" && address ? address.port : port;
  const publicHost = host === "0.0.0.0" ? "localhost" : host;
  const publicUrl = opts.publicUrl ?? `http://${publicHost}:${effectivePort}${path}`;

  // Basic self-check before registering the webhook.
  const healthUrl = `http://127.0.0.1:${effectivePort}${healthPath}`;
  try {
    const healthRes = await fetch(healthUrl);
    if (!healthRes.ok) {
      throw new Error(`health check failed: ${healthRes.status} ${healthRes.statusText}`);
    }
  } catch (err) {
    server.close();
    void bot.stop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
    throw err;
  }

  // Replay any pending updates before registering the webhook.
  await replaySpoolOnce();

  try {
    await withTelegramApiErrorLogging({
      operation: "setWebhook",
      runtime,
      fn: () =>
        bot.api.setWebhook(publicUrl, {
          secret_token: opts.secret,
          allowed_updates: resolveTelegramAllowedUpdates(),
        }),
    });
  } catch (err) {
    // If webhook registration fails, don't leave a dangling server running.
    server.close();
    void bot.stop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
    throw err;
  }

  runtime.log?.(`webhook listening on ${publicUrl}`);

  const replayTimer = setInterval(() => {
    void replaySpoolOnce();
  }, 5000);

  const shutdown = () => {
    clearInterval(replayTimer);
    server.close();

    // Best-effort cleanup; webhook ACK semantics already prevent retry storms.
    if (typeof bot.api.deleteWebhook === "function") {
      void Promise.resolve(bot.api.deleteWebhook({ drop_pending_updates: false })).catch(
        () => undefined,
      );
    }

    void bot.stop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
  };
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
  }

  return { server, bot, stop: shutdown };
}
