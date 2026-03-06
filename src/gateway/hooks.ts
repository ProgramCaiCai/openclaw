import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { type HookMappingResolved, resolveHookMappings } from "./hooks-mapping.js";

const DEFAULT_HOOKS_PATH = "/hooks";
const DEFAULT_HOOKS_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_HOOKS_IDEMPOTENCY_TTL_MS = 5 * 60_000;
const DEFAULT_HOOKS_IDEMPOTENCY_MAX_ENTRIES = 2048;
const DEFAULT_HOOKS_SIGNATURE_HEADER = "x-openclaw-signature";
const DEFAULT_HOOKS_SIGNATURE_TIMESTAMP_HEADER = "x-openclaw-timestamp";
const DEFAULT_HOOKS_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export type HooksConfigResolved = {
  basePath: string;
  token: string;
  maxBodyBytes: number;
  mappings: HookMappingResolved[];
  agentPolicy: HookAgentPolicyResolved;
  sessionPolicy: HookSessionPolicyResolved;
};

export type HookAgentPolicyResolved = {
  defaultAgentId: string;
  knownAgentIds: Set<string>;
  allowedAgentIds?: Set<string>;
};

export type HookSessionPolicyResolved = {
  defaultSessionKey?: string;
  allowRequestSessionKey: boolean;
  allowedSessionKeyPrefixes?: string[];
};

export type HookIdempotencyRuntimeConfig = {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
};

export type HookSignatureRuntimeConfig = {
  enabled: boolean;
  secret: string;
  header: string;
  timestampHeader: string;
  maxAgeSeconds: number;
  shadowMode: boolean;
};

export type HooksRuntimeSecurityConfig = {
  idempotency: HookIdempotencyRuntimeConfig;
  signature: HookSignatureRuntimeConfig;
};

export function resolveHooksConfig(cfg: OpenClawConfig): HooksConfigResolved | null {
  if (cfg.hooks?.enabled !== true) {
    return null;
  }
  const token = cfg.hooks?.token?.trim();
  if (!token) {
    throw new Error("hooks.enabled requires hooks.token");
  }
  const rawPath = cfg.hooks?.path?.trim() || DEFAULT_HOOKS_PATH;
  const withSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  if (trimmed === "/") {
    throw new Error("hooks.path may not be '/'");
  }
  const maxBodyBytes =
    cfg.hooks?.maxBodyBytes && cfg.hooks.maxBodyBytes > 0
      ? cfg.hooks.maxBodyBytes
      : DEFAULT_HOOKS_MAX_BODY_BYTES;
  const mappings = resolveHookMappings(cfg.hooks);
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const knownAgentIds = resolveKnownAgentIds(cfg, defaultAgentId);
  const allowedAgentIds = resolveAllowedAgentIds(cfg.hooks?.allowedAgentIds);
  const defaultSessionKey = resolveSessionKey(cfg.hooks?.defaultSessionKey);
  const allowedSessionKeyPrefixes = resolveAllowedSessionKeyPrefixes(
    cfg.hooks?.allowedSessionKeyPrefixes,
  );
  if (
    defaultSessionKey &&
    allowedSessionKeyPrefixes &&
    !isSessionKeyAllowedByPrefix(defaultSessionKey, allowedSessionKeyPrefixes)
  ) {
    throw new Error("hooks.defaultSessionKey must match hooks.allowedSessionKeyPrefixes");
  }
  if (
    !defaultSessionKey &&
    allowedSessionKeyPrefixes &&
    !isSessionKeyAllowedByPrefix("hook:example", allowedSessionKeyPrefixes)
  ) {
    throw new Error(
      "hooks.allowedSessionKeyPrefixes must include 'hook:' when hooks.defaultSessionKey is unset",
    );
  }
  return {
    basePath: trimmed,
    token,
    maxBodyBytes,
    mappings,
    agentPolicy: {
      defaultAgentId,
      knownAgentIds,
      allowedAgentIds,
    },
    sessionPolicy: {
      defaultSessionKey,
      allowRequestSessionKey: cfg.hooks?.allowRequestSessionKey === true,
      allowedSessionKeyPrefixes,
    },
  };
}

function resolveKnownAgentIds(cfg: OpenClawConfig, defaultAgentId: string): Set<string> {
  const known = new Set(listAgentIds(cfg));
  known.add(defaultAgentId);
  return known;
}

function resolveAllowedAgentIds(raw: string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const allowed = new Set<string>();
  let hasWildcard = false;
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      hasWildcard = true;
      break;
    }
    allowed.add(normalizeAgentId(trimmed));
  }
  if (hasWildcard) {
    return undefined;
  }
  return allowed;
}

function resolveSessionKey(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function normalizeSessionKeyPrefix(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  return value ? value : undefined;
}

function resolveAllowedSessionKeyPrefixes(raw: string[] | undefined): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const set = new Set<string>();
  for (const prefix of raw) {
    const normalized = normalizeSessionKeyPrefix(prefix);
    if (!normalized) {
      continue;
    }
    set.add(normalized);
  }
  return set.size > 0 ? Array.from(set) : undefined;
}

function isSessionKeyAllowedByPrefix(sessionKey: string, prefixes: string[]): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

export function extractHookToken(req: IncomingMessage): string | undefined {
  const auth =
    typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) {
      return token;
    }
  }
  const headerToken =
    typeof req.headers["x-openclaw-token"] === "string"
      ? req.headers["x-openclaw-token"].trim()
      : "";
  if (headerToken) {
    return headerToken;
  }
  return undefined;
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown; rawBody: string } | { ok: false; error: string }> {
  try {
    const rawBody = await readRequestBodyWithLimit(req, { maxBytes });
    const trimmed = rawBody.trim();
    if (!trimmed) {
      return { ok: true, value: {}, rawBody };
    }
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown, rawBody };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } catch (err) {
    if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
      return { ok: false, error: "payload too large" };
    }
    if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
      return { ok: false, error: "request body timeout" };
    }
    if (isRequestBodyLimitError(err, "CONNECTION_CLOSED")) {
      return { ok: false, error: requestBodyErrorToText("CONNECTION_CLOSED") };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function normalizeHookHeaders(req: IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      headers[key.toLowerCase()] = value.join(", ");
    }
  }
  return headers;
}

export function normalizeWakePayload(
  payload: Record<string, unknown>,
):
  | { ok: true; value: { text: string; mode: "now" | "next-heartbeat" } }
  | { ok: false; error: string } {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return { ok: false, error: "text required" };
  }
  const mode = payload.mode === "next-heartbeat" ? "next-heartbeat" : "now";
  return { ok: true, value: { text, mode } };
}

export type HookAgentPayload = {
  message: string;
  name: string;
  agentId?: string;
  wakeMode: "now" | "next-heartbeat";
  sessionKey?: string;
  deliver: boolean;
  channel: HookMessageChannel;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

export type HookAgentDispatchPayload = Omit<HookAgentPayload, "sessionKey"> & {
  sessionKey: string;
  allowUnsafeExternalContent?: boolean;
};

const listHookChannelValues = () => ["last", ...listChannelPlugins().map((plugin) => plugin.id)];

export type HookMessageChannel = ChannelId | "last";

const getHookChannelSet = () => new Set<string>(listHookChannelValues());
export const getHookChannelError = () => `channel must be ${listHookChannelValues().join("|")}`;

export function resolveHookChannel(raw: unknown): HookMessageChannel | null {
  if (raw === undefined) {
    return "last";
  }
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = normalizeMessageChannel(raw);
  if (!normalized || !getHookChannelSet().has(normalized)) {
    return null;
  }
  return normalized as HookMessageChannel;
}

export function resolveHookDeliver(raw: unknown): boolean {
  return raw !== false;
}

export function resolveHookTargetAgentId(
  hooksConfig: HooksConfigResolved,
  agentId: string | undefined,
): string | undefined {
  const raw = agentId?.trim();
  if (!raw) {
    return undefined;
  }
  const normalized = normalizeAgentId(raw);
  if (hooksConfig.agentPolicy.knownAgentIds.has(normalized)) {
    return normalized;
  }
  return hooksConfig.agentPolicy.defaultAgentId;
}

export function isHookAgentAllowed(
  hooksConfig: HooksConfigResolved,
  agentId: string | undefined,
): boolean {
  // Keep backwards compatibility for callers that omit agentId.
  const raw = agentId?.trim();
  if (!raw) {
    return true;
  }
  const allowed = hooksConfig.agentPolicy.allowedAgentIds;
  if (allowed === undefined) {
    return true;
  }
  const resolved = resolveHookTargetAgentId(hooksConfig, raw);
  return resolved ? allowed.has(resolved) : false;
}

export const getHookAgentPolicyError = () => "agentId is not allowed by hooks.allowedAgentIds";
export const getHookSessionKeyRequestPolicyError = () =>
  "sessionKey is disabled for external /hooks/agent payloads; set hooks.allowRequestSessionKey=true to enable";
export const getHookSessionKeyPrefixError = (prefixes: string[]) =>
  `sessionKey must start with one of: ${prefixes.join(", ")}`;

export function resolveHookSessionKey(params: {
  hooksConfig: HooksConfigResolved;
  source: "request" | "mapping";
  sessionKey?: string;
  idFactory?: () => string;
}): { ok: true; value: string } | { ok: false; error: string } {
  const requested = resolveSessionKey(params.sessionKey);
  if (requested) {
    if (params.source === "request" && !params.hooksConfig.sessionPolicy.allowRequestSessionKey) {
      return { ok: false, error: getHookSessionKeyRequestPolicyError() };
    }
    const allowedPrefixes = params.hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
    if (allowedPrefixes && !isSessionKeyAllowedByPrefix(requested, allowedPrefixes)) {
      return { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) };
    }
    return { ok: true, value: requested };
  }

  const defaultSessionKey = params.hooksConfig.sessionPolicy.defaultSessionKey;
  if (defaultSessionKey) {
    return { ok: true, value: defaultSessionKey };
  }

  const generated = `hook:${(params.idFactory ?? randomUUID)()}`;
  const allowedPrefixes = params.hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
  if (allowedPrefixes && !isSessionKeyAllowedByPrefix(generated, allowedPrefixes)) {
    return { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) };
  }
  return { ok: true, value: generated };
}

export function normalizeHookDispatchSessionKey(params: {
  sessionKey: string;
  targetAgentId: string | undefined;
}): string {
  const trimmed = params.sessionKey.trim();
  if (!trimmed || !params.targetAgentId) {
    return trimmed;
  }
  const parsed = parseAgentSessionKey(trimmed);
  if (!parsed) {
    return trimmed;
  }
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  if (parsed.agentId !== targetAgentId) {
    return `agent:${parsed.agentId}:${parsed.rest}`;
  }
  return parsed.rest;
}

export function normalizeAgentPayload(payload: Record<string, unknown>):
  | {
      ok: true;
      value: HookAgentPayload;
    }
  | { ok: false; error: string } {
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) {
    return { ok: false, error: "message required" };
  }
  const nameRaw = payload.name;
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "Hook";
  const agentIdRaw = payload.agentId;
  const agentId =
    typeof agentIdRaw === "string" && agentIdRaw.trim() ? agentIdRaw.trim() : undefined;
  const wakeMode = payload.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now";
  const sessionKeyRaw = payload.sessionKey;
  const sessionKey =
    typeof sessionKeyRaw === "string" && sessionKeyRaw.trim() ? sessionKeyRaw.trim() : undefined;
  const channel = resolveHookChannel(payload.channel);
  if (!channel) {
    return { ok: false, error: getHookChannelError() };
  }
  const toRaw = payload.to;
  const to = typeof toRaw === "string" && toRaw.trim() ? toRaw.trim() : undefined;
  const modelRaw = payload.model;
  const model = typeof modelRaw === "string" && modelRaw.trim() ? modelRaw.trim() : undefined;
  if (modelRaw !== undefined && !model) {
    return { ok: false, error: "model required" };
  }
  const deliver = resolveHookDeliver(payload.deliver);
  const thinkingRaw = payload.thinking;
  const thinking =
    typeof thinkingRaw === "string" && thinkingRaw.trim() ? thinkingRaw.trim() : undefined;
  const timeoutRaw = payload.timeoutSeconds;
  const timeoutSeconds =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.floor(timeoutRaw)
      : undefined;
  return {
    ok: true,
    value: {
      message,
      name,
      agentId,
      wakeMode,
      sessionKey,
      deliver,
      channel,
      to,
      model,
      thinking,
      timeoutSeconds,
    },
  };
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function resolveHooksRuntimeSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
): HooksRuntimeSecurityConfig {
  const idempotencyEnabled = parseBooleanEnv(env.OPENCLAW_HOOKS_IDEMPOTENCY_ENABLED, false);
  const signatureEnabled = parseBooleanEnv(env.OPENCLAW_HOOKS_SIGNATURE_ENABLED, false);
  const signatureHeaderRaw =
    typeof env.OPENCLAW_HOOKS_SIGNATURE_HEADER === "string"
      ? env.OPENCLAW_HOOKS_SIGNATURE_HEADER
      : undefined;
  const timestampHeaderRaw =
    typeof env.OPENCLAW_HOOKS_SIGNATURE_TIMESTAMP_HEADER === "string"
      ? env.OPENCLAW_HOOKS_SIGNATURE_TIMESTAMP_HEADER
      : undefined;

  return {
    idempotency: {
      enabled: idempotencyEnabled,
      ttlMs: parsePositiveIntEnv(
        env.OPENCLAW_HOOKS_IDEMPOTENCY_TTL_MS,
        DEFAULT_HOOKS_IDEMPOTENCY_TTL_MS,
      ),
      maxEntries: parsePositiveIntEnv(
        env.OPENCLAW_HOOKS_IDEMPOTENCY_MAX_ENTRIES,
        DEFAULT_HOOKS_IDEMPOTENCY_MAX_ENTRIES,
      ),
    },
    signature: {
      enabled: signatureEnabled,
      secret: (env.OPENCLAW_HOOKS_SIGNATURE_SECRET ?? "").trim(),
      header: (signatureHeaderRaw?.trim() || DEFAULT_HOOKS_SIGNATURE_HEADER).toLowerCase(),
      timestampHeader: (
        timestampHeaderRaw?.trim() || DEFAULT_HOOKS_SIGNATURE_TIMESTAMP_HEADER
      ).toLowerCase(),
      maxAgeSeconds: parsePositiveIntEnv(
        env.OPENCLAW_HOOKS_SIGNATURE_MAX_AGE_SECONDS,
        DEFAULT_HOOKS_SIGNATURE_MAX_AGE_SECONDS,
      ),
      shadowMode: parseBooleanEnv(env.OPENCLAW_HOOKS_SIGNATURE_SHADOW_MODE, false),
    },
  };
}

export function extractHookIdempotencyKey(req: IncomingMessage): string | undefined {
  const rawHeader = req.headers["idempotency-key"] ?? req.headers["x-idempotency-key"];
  const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) {
    return undefined;
  }
  return trimmed;
}

function normalizeHookSignature(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.toLowerCase().startsWith("sha256=")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

export function verifyHookSignature(params: {
  headers: Record<string, string>;
  rawBody: string;
  signature: HookSignatureRuntimeConfig;
  nowMs?: number;
}): { ok: true } | { ok: false; error: string } {
  const { signature } = params;
  if (!signature.enabled) {
    return { ok: true };
  }
  if (!signature.secret) {
    return { ok: false, error: "hook signature secret is not configured" };
  }

  const providedSignature = normalizeHookSignature(params.headers[signature.header] ?? "");
  if (!providedSignature) {
    return { ok: false, error: "hook signature missing" };
  }

  const timestamp = (params.headers[signature.timestampHeader] ?? "").trim();
  if (!timestamp) {
    return { ok: false, error: "hook signature timestamp missing" };
  }
  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    return { ok: false, error: "hook signature timestamp invalid" };
  }

  const nowSeconds = Math.floor((params.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > signature.maxAgeSeconds) {
    return { ok: false, error: "hook signature timestamp expired" };
  }

  const expected = createHmac("sha256", signature.secret)
    .update(`${timestamp}.${params.rawBody}`)
    .digest("hex");
  const providedBuffer = Buffer.from(providedSignature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) {
    return { ok: false, error: "hook signature mismatch" };
  }
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, error: "hook signature mismatch" };
  }
  return { ok: true };
}
