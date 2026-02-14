import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";

type EmbeddedPiQueueHandle = {
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  abort: () => void;
};

const ACTIVE_EMBEDDED_RUNS = new Map<string, EmbeddedPiQueueHandle>();
type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};
const EMBEDDED_RUN_WAITERS = new Map<string, Set<EmbeddedRunWaiter>>();

export function queueEmbeddedPiMessage(sessionId: string, text: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  if (!handle.isStreaming()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return false;
  }
  if (handle.isCompacting()) {
    // Buffer messages during compaction instead of dropping them.
    // They will be drained once compaction completes (see drainCompactionBuffer).
    const buf = COMPACTION_BUFFERS.get(sessionId) ?? [];
    buf.push(text);
    COMPACTION_BUFFERS.set(sessionId, buf);
    diag.debug(
      `queue message buffered during compaction: sessionId=${sessionId} bufferSize=${buf.length}`,
    );
    logMessageQueued({ sessionId, source: "pi-embedded-runner-compaction-buffer" });
    return true;
  }
  logMessageQueued({ sessionId, source: "pi-embedded-runner" });
  void handle.queueMessage(text);
  return true;
}

export function abortEmbeddedPiRun(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  diag.debug(`aborting run: sessionId=${sessionId}`);
  handle.abort();
  return true;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    return false;
  }
  return handle.isStreaming();
}

export function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
  if (!sessionId || !ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return Promise.resolve(true);
  }
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

export function setActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle) {
  const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  logSessionStateChange({
    sessionId,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
}

export function clearActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle) {
  if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    // Clean up any leftover compaction buffer to prevent memory leaks.
    clearCompactionBuffer(sessionId);
    logSessionStateChange({ sessionId, state: "idle", reason: "run_completed" });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
    notifyEmbeddedRunEnded(sessionId);
  } else {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}

// ---------------------------------------------------------------------------
// Compaction message buffer — messages received while compaction is in-flight
// are held here and drained once compaction completes.
// ---------------------------------------------------------------------------
const COMPACTION_BUFFERS = new Map<string, string[]>();

/**
 * Drain buffered messages that arrived during compaction.
 * Called from lifecycle handler after compactionInFlight is cleared.
 */
export function drainCompactionBuffer(sessionId: string): void {
  const buf = COMPACTION_BUFFERS.get(sessionId);
  if (!buf || buf.length === 0) {
    COMPACTION_BUFFERS.delete(sessionId);
    return;
  }
  COMPACTION_BUFFERS.delete(sessionId);
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    diag.warn(
      `compaction buffer drain: no active run for sessionId=${sessionId}, ${buf.length} message(s) lost`,
    );
    return;
  }
  diag.debug(`compaction buffer drain: sessionId=${sessionId} messages=${buf.length}`);
  for (const text of buf) {
    void handle.queueMessage(text);
  }
}

/** Clear compaction buffer without draining (e.g. when run ends). */
export function clearCompactionBuffer(sessionId: string): number {
  const buf = COMPACTION_BUFFERS.get(sessionId);
  const count = buf?.length ?? 0;
  COMPACTION_BUFFERS.delete(sessionId);
  if (count > 0) {
    diag.debug(`compaction buffer cleared: sessionId=${sessionId} discarded=${count}`);
  }
  return count;
}

/** Get the number of buffered messages (for testing/diagnostics). */
export function getCompactionBufferSize(sessionId: string): number {
  return COMPACTION_BUFFERS.get(sessionId)?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Tool-requested compaction flag
// ---------------------------------------------------------------------------
const COMPACTION_REQUESTS = new Set<string>();
const COMPACTION_COOLDOWN_MS = 30_000;
const LAST_TOOL_COMPACTIONS = new Map<string, number>();

type SessionCompactionRequestResult =
  | { accepted: true }
  | { accepted: false; reason: "duplicate" | "cooldown"; retryAfterMs?: number };

/** Signal that a session should compact after the current attempt. */
export function requestSessionCompaction(
  sessionKey: string,
  nowMs = Date.now(),
): SessionCompactionRequestResult {
  if (COMPACTION_REQUESTS.has(sessionKey)) {
    diag.debug(`compaction request skipped: sessionKey=${sessionKey} reason=duplicate`);
    return { accepted: false, reason: "duplicate" };
  }

  const lastCompactedAt = LAST_TOOL_COMPACTIONS.get(sessionKey);
  if (typeof lastCompactedAt === "number") {
    const elapsedMs = Math.max(0, nowMs - lastCompactedAt);
    if (elapsedMs < COMPACTION_COOLDOWN_MS) {
      const retryAfterMs = COMPACTION_COOLDOWN_MS - elapsedMs;
      diag.debug(
        `compaction request skipped: sessionKey=${sessionKey} reason=cooldown retryAfterMs=${retryAfterMs}`,
      );
      return { accepted: false, reason: "cooldown", retryAfterMs };
    }
  }

  COMPACTION_REQUESTS.add(sessionKey);
  diag.debug(`compaction requested: sessionKey=${sessionKey}`);
  return { accepted: true };
}

/** Record that tool-requested compaction completed, enabling cooldown-based dedupe. */
export function markSessionCompactionCompleted(sessionKey: string, nowMs = Date.now()): void {
  LAST_TOOL_COMPACTIONS.set(sessionKey, nowMs);
  diag.debug(`compaction completion recorded: sessionKey=${sessionKey}`);
}

/** Consume (and clear) a pending compaction request. Returns true if one existed. */
export function consumeSessionCompactionRequest(sessionKey: string): boolean {
  const had = COMPACTION_REQUESTS.delete(sessionKey);
  if (had) {
    diag.debug(`compaction request consumed: sessionKey=${sessionKey}`);
  }
  return had;
}

export type { EmbeddedPiQueueHandle, SessionCompactionRequestResult };
