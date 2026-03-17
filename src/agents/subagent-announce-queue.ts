import { type QueueDropPolicy, type QueueMode } from "../auto-reply/reply/queue.js";
import { defaultRuntime } from "../runtime.js";
import {
  type DeliveryContext,
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import {
  applyQueueRuntimeSettings,
  applyQueueDropPolicy,
  beginQueueDrain,
  buildCollectPrompt,
  clearQueueSummaryState,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  previewQueueSummaryPrompt,
} from "../utils/queue-helpers.js";
import type { AgentInternalEvent } from "./internal-events.js";

export type AnnounceQueueItem = {
  // Stable announce identity shared by direct + queued delivery paths.
  // Optional for backward compatibility with previously queued items.
  announceId?: string;
  prompt: string;
  summaryLine?: string;
  internalEvents?: AgentInternalEvent[];
  enqueuedAt: number;
  sessionKey: string;
  origin?: DeliveryContext;
  originKey?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  expectsCompletionMessage?: boolean;
  pendingRunId?: string;
  pendingRunIds?: string[];
  retryAttempt?: number;
};

export type AnnounceQueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

type AnnounceQueueState = {
  items: AnnounceQueueItem[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  send: (item: AnnounceQueueItem) => Promise<void>;
  /** Consecutive drain failures — drives exponential backoff on errors. */
  consecutiveFailures: number;
  retryNotBeforeAt: number;
};

export class AnnounceQueueDeferredError extends Error {
  readonly retryDelayMs?: number;

  constructor(message: string, options?: { retryDelayMs?: number }) {
    super(message);
    this.name = "AnnounceQueueDeferredError";
    this.retryDelayMs =
      typeof options?.retryDelayMs === "number" && Number.isFinite(options.retryDelayMs)
        ? Math.max(0, Math.floor(options.retryDelayMs))
        : undefined;
  }
}

const ANNOUNCE_QUEUES = new Map<string, AnnounceQueueState>();
const DEFAULT_PENDING_ANNOUNCE_RETRY_DELAY_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 8 : 1_000;
const MAX_CONSECUTIVE_DRAIN_FAILURES = 3;

function syncMutableAnnounceItemState(target: AnnounceQueueItem, source: AnnounceQueueItem): void {
  target.pendingRunId = source.pendingRunId;
  target.pendingRunIds = source.pendingRunIds;
  target.retryAttempt = source.retryAttempt;
}

async function sendAnnounceWithPromptOverride(params: {
  item: AnnounceQueueItem;
  prompt: string;
  send: (item: AnnounceQueueItem) => Promise<void>;
}): Promise<void> {
  const transientItem: AnnounceQueueItem = {
    ...params.item,
    prompt: params.prompt,
  };
  try {
    await params.send(transientItem);
  } finally {
    syncMutableAnnounceItemState(params.item, transientItem);
  }
}

export function resetAnnounceQueuesForTests() {
  // Test isolation: other suites may leave a draining queue behind in the worker.
  // Clearing the map alone isn't enough because drain loops capture `queue` by reference.
  for (const queue of ANNOUNCE_QUEUES.values()) {
    queue.items.length = 0;
    queue.summaryLines.length = 0;
    queue.droppedCount = 0;
    queue.lastEnqueuedAt = 0;
  }
  ANNOUNCE_QUEUES.clear();
}

function getAnnounceQueue(
  key: string,
  settings: AnnounceQueueSettings,
  send: (item: AnnounceQueueItem) => Promise<void>,
) {
  const existing = ANNOUNCE_QUEUES.get(key);
  if (existing) {
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    existing.send = send;
    return existing;
  }
  const created: AnnounceQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs: typeof settings.debounceMs === "number" ? Math.max(0, settings.debounceMs) : 1000,
    cap: typeof settings.cap === "number" && settings.cap > 0 ? Math.floor(settings.cap) : 20,
    dropPolicy: settings.dropPolicy ?? "summarize",
    droppedCount: 0,
    summaryLines: [],
    send,
    consecutiveFailures: 0,
    retryNotBeforeAt: 0,
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  ANNOUNCE_QUEUES.set(key, created);
  return created;
}

function hasAnnounceCrossChannelItems(items: AnnounceQueueItem[]): boolean {
  return hasCrossChannelItems(items, (item) => {
    if (!item.origin) {
      return {};
    }
    if (!item.originKey) {
      return { cross: true };
    }
    return { key: item.originKey };
  });
}

function isPendingAnnounceRunError(error: unknown): error is AnnounceQueueDeferredError {
  return error instanceof AnnounceQueueDeferredError;
}

function resolvePendingRetryDelayMs(
  error: AnnounceQueueDeferredError,
  queue: AnnounceQueueState,
): number {
  const requested =
    typeof error.retryDelayMs === "number" && Number.isFinite(error.retryDelayMs)
      ? Math.max(0, Math.floor(error.retryDelayMs))
      : DEFAULT_PENDING_ANNOUNCE_RETRY_DELAY_MS;
  return Math.max(requested, queue.debounceMs);
}

function mergePendingRunIds(
  existing: Pick<AnnounceQueueItem, "pendingRunId" | "pendingRunIds">,
  next: Pick<AnnounceQueueItem, "pendingRunId" | "pendingRunIds">,
): string[] {
  return Array.from(
    new Set(
      [
        ...(Array.isArray(existing.pendingRunIds) ? existing.pendingRunIds : []),
        ...(existing.pendingRunId ? [existing.pendingRunId] : []),
        ...(Array.isArray(next.pendingRunIds) ? next.pendingRunIds : []),
        ...(next.pendingRunId ? [next.pendingRunId] : []),
      ].filter((runId) => Boolean(runId)),
    ),
  );
}

function upsertAnnounceQueueItem(queue: AnnounceQueueState, item: AnnounceQueueItem): void {
  const announceId = item.announceId?.trim();
  if (!announceId) {
    queue.items.push(item);
    return;
  }

  const existingIndex = queue.items.findIndex((queuedItem) => queuedItem.announceId === announceId);
  if (existingIndex < 0) {
    queue.items.push(item);
    return;
  }

  const existing = queue.items[existingIndex];
  if (!existing) {
    queue.items.push(item);
    return;
  }

  const pendingRunIds = mergePendingRunIds(existing, item);
  queue.items[existingIndex] = {
    ...existing,
    ...item,
    announceId,
    enqueuedAt: existing.enqueuedAt,
    internalEvents: item.internalEvents ?? existing.internalEvents,
    pendingRunIds: pendingRunIds.length > 0 ? pendingRunIds : undefined,
    pendingRunId: pendingRunIds.length > 0 ? pendingRunIds[pendingRunIds.length - 1] : undefined,
    retryAttempt: Math.max(existing.retryAttempt ?? 0, item.retryAttempt ?? 0),
  };
}

function scheduleAnnounceDrain(key: string) {
  const queue = beginQueueDrain(ANNOUNCE_QUEUES, key);
  if (!queue) {
    return;
  }
  void (async () => {
    try {
      const collectState = { forceIndividualCollect: false };
      for (;;) {
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        await waitForAnnounceQueueReady(queue);
        if (queue.mode === "collect") {
          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel: hasAnnounceCrossChannelItems(queue.items),
            items: queue.items,
            run: async (item) => await queue.send(item),
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }
          const items = queue.items.slice();
          const summary = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
          const prompt = buildCollectPrompt({
            title: "[Queued announce messages while agent was busy]",
            items,
            summary,
            renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
          });
          const internalEvents = items.flatMap((item) => item.internalEvents ?? []);
          const pendingRunIds = Array.from(
            new Set(
              items.flatMap((item) => {
                const ids: string[] = [];
                if (Array.isArray(item.pendingRunIds)) {
                  ids.push(...item.pendingRunIds);
                }
                if (item.pendingRunId) {
                  ids.push(item.pendingRunId);
                }
                return ids;
              }),
            ),
          );
          const last = items.at(-1);
          if (!last) {
            break;
          }
          const transientItem: AnnounceQueueItem = {
            ...last,
            prompt,
            internalEvents: internalEvents.length > 0 ? internalEvents : last.internalEvents,
            pendingRunIds: pendingRunIds.length > 0 ? pendingRunIds : last.pendingRunIds,
            pendingRunId:
              pendingRunIds.length > 0
                ? pendingRunIds[pendingRunIds.length - 1]
                : last.pendingRunId,
          };
          try {
            await queue.send(transientItem);
          } finally {
            syncMutableAnnounceItemState(last, transientItem);
          }
          queue.items.splice(0, items.length);
          if (summary) {
            clearQueueSummaryState(queue);
          }
          continue;
        }

        const summaryPrompt = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
        if (summaryPrompt) {
          if (
            !(await drainNextQueueItem(
              queue.items,
              async (item) =>
                await sendAnnounceWithPromptOverride({
                  item,
                  prompt: summaryPrompt,
                  send: queue.send,
                }),
            ))
          ) {
            break;
          }
          clearQueueSummaryState(queue);
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, async (item) => await queue.send(item)))) {
          break;
        }
      }
      // Drain succeeded — reset failure counter.
      queue.consecutiveFailures = 0;
      queue.retryNotBeforeAt = 0;
    } catch (err) {
      if (isPendingAnnounceRunError(err)) {
        queue.consecutiveFailures = 0;
        const retryDelayMs = resolvePendingRetryDelayMs(err, queue);
        queue.retryNotBeforeAt = Date.now() + retryDelayMs;
        defaultRuntime.log(
          `[info] announce queue pending for ${key} (retry in ${Math.round(retryDelayMs / 1000)}s): ${err.message}`,
        );
      } else {
        queue.consecutiveFailures++;
        if (queue.consecutiveFailures >= MAX_CONSECUTIVE_DRAIN_FAILURES && queue.items.length > 0) {
          const dropped = queue.items.shift();
          queue.consecutiveFailures = 0;
          defaultRuntime.error?.(
            `announce queue fail-open dropped stuck head item for ${key}: ${String(err)}${dropped ? ` (session ${dropped.sessionKey})` : ""}`,
          );
          return;
        }
        // Exponential backoff on consecutive failures: 2s, 4s, 8s, ... capped at 60s.
        const errorBackoffMs = Math.min(1000 * Math.pow(2, queue.consecutiveFailures), 60_000);
        const retryDelayMs = Math.max(errorBackoffMs, queue.debounceMs);
        queue.retryNotBeforeAt = Date.now() + retryDelayMs;
        defaultRuntime.error?.(
          `announce queue drain failed for ${key} (attempt ${queue.consecutiveFailures}, retry in ${Math.round(retryDelayMs / 1000)}s): ${String(err)}`,
        );
      }
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        ANNOUNCE_QUEUES.delete(key);
      } else {
        scheduleAnnounceDrain(key);
      }
    }
  })();
}

export function enqueueAnnounce(params: {
  key: string;
  item: AnnounceQueueItem;
  settings: AnnounceQueueSettings;
  send: (item: AnnounceQueueItem) => Promise<void>;
}): boolean {
  const queue = getAnnounceQueue(params.key, params.settings, params.send);
  // Preserve any retry backoff marker already encoded in lastEnqueuedAt.
  queue.lastEnqueuedAt = Math.max(queue.lastEnqueuedAt, Date.now());

  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
  });
  if (!shouldEnqueue) {
    if (queue.dropPolicy === "new") {
      scheduleAnnounceDrain(params.key);
    }
    return false;
  }

  const origin = normalizeDeliveryContext(params.item.origin);
  const originKey = deliveryContextKey(origin);
  upsertAnnounceQueueItem(queue, { ...params.item, origin, originKey });
  scheduleAnnounceDrain(params.key);
  return true;
}

async function waitForAnnounceQueueReady(
  queue: Pick<AnnounceQueueState, "debounceMs" | "lastEnqueuedAt" | "retryNotBeforeAt">,
) {
  for (;;) {
    const now = Date.now();
    const debounceReadyAt = queue.debounceMs > 0 ? queue.lastEnqueuedAt + queue.debounceMs : now;
    const retryReadyAt = queue.retryNotBeforeAt > 0 ? queue.retryNotBeforeAt : now;
    const readyAt = Math.max(debounceReadyAt, retryReadyAt);
    if (readyAt <= now) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, readyAt - now));
  }
}
