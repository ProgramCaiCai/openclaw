import fs from "node:fs";
import path from "node:path";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
} from "../config/sessions.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { DEFAULT_EMBEDDED_PI_INCOMPLETE_RUN_MAX_SILENT_RETRIES } from "./pi-project-settings.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";

const INCOMPLETE_OPENAI_RESPONSES_FALLBACK_PROMPT = "continue";
const OPENAI_RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses"]);

export const OPENAI_RESPONSES_INCOMPLETE_RUN_RETRY_DELAY_MS = 2_500;

type ManagedRetryBaselineSnapshot =
  | {
      kind: "restorable";
      sessionFile: string;
      existed: boolean;
      content?: Buffer;
      mode?: number;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

export type RestoreManagedRetryBaselineResult = {
  restored: boolean;
  reason?: string;
};

function formatRetryBaselineReason(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${detail}`;
}

function resolveManagedRetrySessionFile(params: {
  agentId?: string;
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  storePath?: string;
}): ManagedRetryBaselineSnapshot {
  const sessionId = params.sessionEntry?.sessionId?.trim() ?? params.sessionId?.trim();
  if (!sessionId) {
    return {
      kind: "unavailable",
      reason: "missing session id",
    };
  }

  try {
    const transcriptPath = (
      params.sessionEntry as (SessionEntry & { transcriptPath?: string }) | undefined
    )?.transcriptPath?.trim();
    const sessionFile =
      params.sessionEntry?.sessionFile?.trim() || transcriptPath || params.sessionFile?.trim();
    const resolvedSessionFile = resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : params.sessionEntry,
      resolveSessionFilePathOptions({
        agentId: params.agentId,
        storePath: params.storePath,
      }),
    );

    return {
      kind: "restorable",
      sessionFile: resolvedSessionFile,
      existed: false,
    };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: formatRetryBaselineReason("failed to resolve session file", error),
    };
  }
}

export async function captureIncompleteOpenAiResponsesRetryBaseline(params: {
  agentId?: string;
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  storePath?: string;
}): Promise<ManagedRetryBaselineSnapshot> {
  const resolved = resolveManagedRetrySessionFile(params);
  if (resolved.kind !== "restorable") {
    return resolved;
  }

  try {
    const content = await fs.promises.readFile(resolved.sessionFile);
    const stat = await fs.promises.stat(resolved.sessionFile).catch(() => null);
    return {
      ...resolved,
      existed: true,
      content,
      mode: stat?.mode,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return resolved;
    }
    return {
      kind: "unavailable",
      reason: formatRetryBaselineReason("failed to capture retry baseline", error),
    };
  }
}

export async function restoreIncompleteOpenAiResponsesRetryBaseline(
  baseline: Awaited<ReturnType<typeof captureIncompleteOpenAiResponsesRetryBaseline>>,
): Promise<RestoreManagedRetryBaselineResult> {
  if (baseline.kind !== "restorable") {
    return {
      restored: false,
      reason: baseline.reason,
    };
  }

  const lock = await acquireSessionWriteLock({
    sessionFile: baseline.sessionFile,
  });
  const tmpPath = `${baseline.sessionFile}.retry-restore-${process.pid}-${Date.now()}.tmp`;
  try {
    if (baseline.existed) {
      await fs.promises.mkdir(path.dirname(baseline.sessionFile), { recursive: true });
      await fs.promises.writeFile(tmpPath, baseline.content ?? Buffer.alloc(0));
      await fs.promises.chmod(tmpPath, baseline.mode ?? 0o600);
      await fs.promises.rename(tmpPath, baseline.sessionFile);
    } else {
      await fs.promises.rm(baseline.sessionFile, { force: true });
    }
    emitSessionTranscriptUpdate(baseline.sessionFile);
    return { restored: true };
  } catch (error) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    return {
      restored: false,
      reason: formatRetryBaselineReason("failed to restore retry baseline", error),
    };
  } finally {
    await lock.release();
  }
}

export function buildIncompleteOpenAiResponsesFallbackPrompt(): string {
  return INCOMPLETE_OPENAI_RESPONSES_FALLBACK_PROMPT;
}

export function hasDeliverablePayload(
  payloads:
    | Array<{
        text?: string;
        mediaUrl?: string;
        mediaUrls?: string[];
        channelData?: Record<string, unknown>;
      }>
    | undefined,
): boolean {
  return (
    payloads?.some(
      (payload) =>
        Boolean(payload.text?.trim()) ||
        Boolean(payload.mediaUrl?.trim()) ||
        (payload.mediaUrls?.length ?? 0) > 0 ||
        Object.keys(payload.channelData ?? {}).length > 0,
    ) ?? false
  );
}

export function isIncompleteOpenAiResponsesRun(params: {
  api?: string;
  payloads:
    | Array<{
        text?: string;
        mediaUrl?: string;
        mediaUrls?: string[];
        channelData?: Record<string, unknown>;
      }>
    | undefined;
  didSendViaMessagingTool?: boolean;
  hasEmbeddedError?: boolean;
}): boolean {
  if (
    params.hasEmbeddedError ||
    params.didSendViaMessagingTool === true ||
    hasDeliverablePayload(params.payloads)
  ) {
    return false;
  }
  return Boolean(params.api && OPENAI_RESPONSES_APIS.has(params.api));
}

export function formatIncompleteOpenAiResponsesRetryLog(params: {
  retryAttempt: number;
  maxSilentRetries: number;
  restoredBaseline: boolean;
  reason?: string;
}): string {
  const strategy = params.restoredBaseline
    ? "replaying the original prompt from the restored pre-turn baseline"
    : `falling back to literal continue${params.reason ? ` (${params.reason})` : ""}`;
  return `OpenAI Responses run ended without a deliverable payload. Retrying ${params.retryAttempt}/${params.maxSilentRetries} in ${OPENAI_RESPONSES_INCOMPLETE_RUN_RETRY_DELAY_MS}ms, ${strategy}.`;
}

export function formatIncompleteOpenAiResponsesUserMessage(
  retryCount: number,
  maxSilentRetries = DEFAULT_EMBEDDED_PI_INCOMPLETE_RUN_MAX_SILENT_RETRIES,
): string {
  if (retryCount >= maxSilentRetries) {
    return `⚠️ Automatic retry failed ${maxSilentRetries} times because the upstream model stream kept ending early. Please try again later or switch to another model/provider.`;
  }

  return "⚠️ Upstream model stream ended before the automatic retry sequence finished. Please retry.";
}
