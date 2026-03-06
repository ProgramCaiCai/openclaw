import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TlsOptions } from "node:tls";
import type { WebSocketServer } from "ws";
import { resolveAgentAvatar } from "../agents/identity-avatar.js";
import { CANVAS_WS_PATH, handleA2uiHttpRequest } from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import { loadConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { handleSlackHttpRequest } from "../slack/http/index.js";
import {
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  createAuthRateLimiter,
  normalizeRateLimitClientIp,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { type GatewayAuthResult, type ResolvedGatewayAuth } from "./auth.js";
import { normalizeCanvasScopedUrl } from "./canvas-capability.js";
import {
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
  type ControlUiRootState,
} from "./control-ui.js";
import { applyHookMappings } from "./hooks-mapping.js";
import {
  extractHookIdempotencyKey,
  extractHookToken,
  getHookAgentPolicyError,
  getHookChannelError,
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
  isHookAgentAllowed,
  normalizeAgentPayload,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  normalizeHookDispatchSessionKey,
  resolveHooksRuntimeSecurityConfig,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
  resolveHookChannel,
  resolveHookDeliver,
  verifyHookSignature,
} from "./hooks.js";
import { sendGatewayAuthFailure, setDefaultSecurityHeaders } from "./http-common.js";
import { handleOpenAiHttpRequest } from "./openai-http.js";
import { handleOpenResponsesHttpRequest } from "./openresponses-http.js";
import { isProtectedPluginRoutePath } from "./security-path.js";
import {
  authorizeCanvasRequest,
  enforcePluginRouteGatewayAuth,
  isCanvasPath,
} from "./server/http-auth.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 60_000;

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: HookAgentDispatchPayload) => string;
};

type HookIdempotencyEntry =
  | {
      state: "in_flight";
      expiresAt: number;
    }
  | {
      state: "done";
      expiresAt: number;
      response: {
        status: number;
        body?: unknown;
      };
    };

function pruneHookIdempotencyStore(
  store: Map<string, HookIdempotencyEntry>,
  nowMs: number,
  maxEntries: number,
) {
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt <= nowMs) {
      store.delete(key);
    }
  }
  if (store.size <= maxEntries) {
    return;
  }
  const sorted = [...store.entries()].toSorted((a, b) => a[1].expiresAt - b[1].expiresAt);
  const toDelete = Math.max(0, store.size - maxEntries);
  for (let index = 0; index < toDelete; index += 1) {
    const key = sorted[index]?.[0];
    if (key) {
      store.delete(key);
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

const GATEWAY_PROBE_STATUS_BY_PATH = new Map<string, "live" | "ready">([
  ["/health", "live"],
  ["/healthz", "live"],
  ["/ready", "ready"],
  ["/readyz", "ready"],
]);

function handleGatewayProbeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
): boolean {
  const status = GATEWAY_PROBE_STATUS_BY_PATH.get(requestPath);
  if (!status) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (method === "HEAD") {
    res.end();
    return true;
  }
  res.end(JSON.stringify({ ok: true, status }));
  return true;
}

function writeUpgradeAuthFailure(
  socket: { write: (chunk: string) => void },
  auth: GatewayAuthResult,
) {
  if (auth.rateLimited) {
    const retryAfterSeconds =
      auth.retryAfterMs && auth.retryAfterMs > 0 ? Math.ceil(auth.retryAfterMs / 1000) : undefined;
    socket.write(
      [
        "HTTP/1.1 429 Too Many Requests",
        retryAfterSeconds ? `Retry-After: ${retryAfterSeconds}` : undefined,
        "Content-Type: application/json; charset=utf-8",
        "Connection: close",
        "",
        JSON.stringify({
          error: {
            message: "Too many failed authentication attempts. Please try again later.",
            type: "rate_limited",
          },
        }),
      ]
        .filter(Boolean)
        .join("\r\n"),
    );
    return;
  }
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
}

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, logHooks, dispatchAgentHook, dispatchWakeHook } = opts;
  const hookAuthLimiter = createAuthRateLimiter({
    maxAttempts: HOOK_AUTH_FAILURE_LIMIT,
    windowMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    lockoutMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    exemptLoopback: false,
    // Handler lifetimes are tied to gateway runtime/tests; skip background timer fanout.
    pruneIntervalMs: 0,
  });
  const runtimeSecurity = resolveHooksRuntimeSecurityConfig();
  const hookIdempotencyStore = new Map<string, HookIdempotencyEntry>();

  const resolveHookClientKey = (req: IncomingMessage): string => {
    return normalizeRateLimitClientIp(req.socket?.remoteAddress);
  };

  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    // Only pathname/search are used here; keep the base host fixed so bind-host
    // representation (e.g. IPv6 wildcards) cannot break request parsing.
    const url = new URL(req.url ?? "/", "http://localhost");
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (url.searchParams.has("token")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).",
      );
      return true;
    }

    const token = extractHookToken(req);
    const clientKey = resolveHookClientKey(req);
    if (!safeEqualSecret(token, hooksConfig.token)) {
      const throttle = hookAuthLimiter.check(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      if (!throttle.allowed) {
        const retryAfter = throttle.retryAfterMs > 0 ? Math.ceil(throttle.retryAfterMs / 1000) : 1;
        res.statusCode = 429;
        res.setHeader("Retry-After", String(retryAfter));
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Too Many Requests");
        logHooks.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
        return true;
      }
      hookAuthLimiter.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }
    hookAuthLimiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const nowMs = Date.now();
    const idempotencyKey = runtimeSecurity.idempotency.enabled
      ? extractHookIdempotencyKey(req)
      : undefined;
    const scopedIdempotencyKey = idempotencyKey ? `${subPath}:${idempotencyKey}` : undefined;

    const abortIdempotency = () => {
      if (!scopedIdempotencyKey) {
        return;
      }
      const current = hookIdempotencyStore.get(scopedIdempotencyKey);
      if (current?.state === "in_flight") {
        hookIdempotencyStore.delete(scopedIdempotencyKey);
      }
    };

    const commitIdempotency = (status: number, body?: unknown) => {
      if (!scopedIdempotencyKey) {
        return;
      }
      hookIdempotencyStore.set(scopedIdempotencyKey, {
        state: "done",
        expiresAt: Date.now() + runtimeSecurity.idempotency.ttlMs,
        response: {
          status,
          ...(body === undefined ? {} : { body }),
        },
      });
    };

    if (scopedIdempotencyKey) {
      pruneHookIdempotencyStore(
        hookIdempotencyStore,
        nowMs,
        runtimeSecurity.idempotency.maxEntries,
      );
      const existing = hookIdempotencyStore.get(scopedIdempotencyKey);
      if (existing && existing.expiresAt > nowMs) {
        if (existing.state === "in_flight") {
          sendJson(res, 409, {
            ok: false,
            error: "duplicate request in flight",
            idempotencyStatus: "in_flight",
          });
          return true;
        }
        res.setHeader("X-Idempotency-Replayed", "true");
        if (existing.response.body === undefined) {
          res.statusCode = existing.response.status;
          res.end();
          return true;
        }
        sendJson(res, existing.response.status, existing.response.body);
        return true;
      }
      hookIdempotencyStore.set(scopedIdempotencyKey, {
        state: "in_flight",
        expiresAt: nowMs + runtimeSecurity.idempotency.ttlMs,
      });
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      abortIdempotency();
      const status =
        body.error === "payload too large"
          ? 413
          : body.error === "request body timeout"
            ? 408
            : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);

    const signatureCheck = verifyHookSignature({
      headers,
      rawBody: body.rawBody,
      signature: runtimeSecurity.signature,
    });
    if (!signatureCheck.ok) {
      if (runtimeSecurity.signature.shadowMode) {
        logHooks.warn(`hook signature check failed in shadow mode: ${signatureCheck.error}`);
        res.setHeader("X-OpenClaw-Signature-Shadow", "fail");
      } else {
        abortIdempotency();
        sendJson(res, 401, { ok: false, error: signatureCheck.error });
        return true;
      }
    }

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        abortIdempotency();
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      const response = { ok: true, mode: normalized.value.mode };
      commitIdempotency(200, response);
      sendJson(res, 200, response);
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        abortIdempotency();
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      if (!isHookAgentAllowed(hooksConfig, normalized.value.agentId)) {
        abortIdempotency();
        sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
        return true;
      }
      const sessionKey = resolveHookSessionKey({
        hooksConfig,
        source: "request",
        sessionKey: normalized.value.sessionKey,
      });
      if (!sessionKey.ok) {
        abortIdempotency();
        sendJson(res, 400, { ok: false, error: sessionKey.error });
        return true;
      }
      const targetAgentId = resolveHookTargetAgentId(hooksConfig, normalized.value.agentId);
      const runId = dispatchAgentHook({
        ...normalized.value,
        sessionKey: normalizeHookDispatchSessionKey({
          sessionKey: sessionKey.value,
          targetAgentId,
        }),
        agentId: targetAgentId,
      });
      const response = { ok: true, runId };
      commitIdempotency(202, response);
      sendJson(res, 202, response);
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            abortIdempotency();
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            commitIdempotency(204);
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            const response = { ok: true, mode: mapped.action.mode };
            commitIdempotency(200, response);
            sendJson(res, 200, response);
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            abortIdempotency();
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
            abortIdempotency();
            sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
            return true;
          }
          const sessionKey = resolveHookSessionKey({
            hooksConfig,
            source: "mapping",
            sessionKey: mapped.action.sessionKey,
          });
          if (!sessionKey.ok) {
            abortIdempotency();
            sendJson(res, 400, { ok: false, error: sessionKey.error });
            return true;
          }
          const targetAgentId = resolveHookTargetAgentId(hooksConfig, mapped.action.agentId);
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            agentId: targetAgentId,
            wakeMode: mapped.action.wakeMode,
            sessionKey: normalizeHookDispatchSessionKey({
              sessionKey: sessionKey.value,
              targetAgentId,
            }),
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
          });
          const response = { ok: true, runId };
          commitIdempotency(202, response);
          sendJson(res, 202, response);
          return true;
        }
      } catch (err) {
        abortIdempotency();
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    abortIdempotency();
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}

export function createGatewayHttpServer(opts: {
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  handleHooksRequest: HooksRequestHandler;
  handlePluginRequest?: HooksRequestHandler;
  shouldEnforcePluginGatewayAuth?: (requestPath: string) => boolean;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  tlsOptions?: TlsOptions;
}): HttpServer {
  const {
    canvasHost,
    clients,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    handleHooksRequest,
    handlePluginRequest,
    shouldEnforcePluginGatewayAuth,
    resolvedAuth,
    rateLimiter,
  } = opts;
  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, (req, res) => {
        void handleRequest(req, res);
      })
    : createHttpServer((req, res) => {
        void handleRequest(req, res);
      });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    setDefaultSecurityHeaders(res, {
      strictTransportSecurity: strictTransportSecurityHeader,
    });

    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }

    try {
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
      if (scopedCanvas.malformedScopedPath) {
        sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
        return;
      }
      if (scopedCanvas.rewrittenUrl) {
        req.url = scopedCanvas.rewrittenUrl;
      }
      const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
      if (await handleHooksRequest(req, res)) {
        return;
      }
      if (
        await handleToolsInvokeHttpRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter,
        })
      ) {
        return;
      }
      if (await handleSlackHttpRequest(req, res)) {
        return;
      }
      if (openResponsesEnabled) {
        if (
          await handleOpenResponsesHttpRequest(req, res, {
            auth: resolvedAuth,
            config: openResponsesConfig,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter,
          })
        ) {
          return;
        }
      }
      if (openAiChatCompletionsEnabled) {
        if (
          await handleOpenAiHttpRequest(req, res, {
            auth: resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter,
          })
        ) {
          return;
        }
      }
      if (canvasHost) {
        if (isCanvasPath(requestPath)) {
          const ok = await authorizeCanvasRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            clients,
            canvasCapability: scopedCanvas.capability,
            malformedScopedPath: scopedCanvas.malformedScopedPath,
            rateLimiter,
          });
          if (!ok.ok) {
            sendGatewayAuthFailure(res, ok);
            return;
          }
        }
        if (await handleA2uiHttpRequest(req, res)) {
          return;
        }
        if (await canvasHost.handleHttpRequest(req, res)) {
          return;
        }
      }
      if (controlUiEnabled) {
        if (
          handleControlUiAvatarRequest(req, res, {
            basePath: controlUiBasePath,
            resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot, agentId),
          })
        ) {
          return;
        }
        if (
          handleControlUiHttpRequest(req, res, {
            basePath: controlUiBasePath,
            config: configSnapshot,
            root: controlUiRoot,
          })
        ) {
          return;
        }
      }
      // Plugins run after built-in gateway routes so core surfaces keep
      // precedence on overlapping paths.
      if (handlePluginRequest) {
        if ((shouldEnforcePluginGatewayAuth ?? isProtectedPluginRoutePath)(requestPath)) {
          const pluginAuthOk = await enforcePluginRouteGatewayAuth({
            req,
            res,
            auth: resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter,
          });
          if (!pluginAuthOk) {
            return;
          }
        }
        if (await handlePluginRequest(req, res)) {
          return;
        }
      }
      if (handleGatewayProbeRequest(req, res, requestPath)) {
        return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
}) {
  const { httpServer, wss, canvasHost, clients, resolvedAuth, rateLimiter } = opts;
  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
      if (scopedCanvas.malformedScopedPath) {
        writeUpgradeAuthFailure(socket, { ok: false, reason: "unauthorized" });
        socket.destroy();
        return;
      }
      if (scopedCanvas.rewrittenUrl) {
        req.url = scopedCanvas.rewrittenUrl;
      }
      if (canvasHost) {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === CANVAS_WS_PATH) {
          const configSnapshot = loadConfig();
          const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
          const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
          const ok = await authorizeCanvasRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            clients,
            canvasCapability: scopedCanvas.capability,
            malformedScopedPath: scopedCanvas.malformedScopedPath,
            rateLimiter,
          });
          if (!ok.ok) {
            writeUpgradeAuthFailure(socket, ok);
            socket.destroy();
            return;
          }
        }
        if (canvasHost.handleUpgrade(req, socket, head)) {
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    })().catch(() => {
      socket.destroy();
    });
  });
}
