import { logFollowupDropped, logFollowupEnqueued } from "../../../logging/diagnostic.js";
import { applyQueueDropPolicy, shouldSkipQueueItem } from "../../../utils/queue-helpers.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";
import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";

export type FollowupEnqueueResult = {
  accepted: boolean;
  queueDepth: number;
  mode: QueueSettings["mode"];
  droppedCount: number;
  rejectedReason?: "duplicate" | "cap_new";
  droppedReason?: "cap_old" | "cap_summarize";
};

function isRunAlreadyQueued(
  run: FollowupRun,
  items: FollowupRun[],
  allowPromptFallback = false,
): boolean {
  const hasSameRouting = (item: FollowupRun) =>
    item.originatingChannel === run.originatingChannel &&
    item.originatingTo === run.originatingTo &&
    item.originatingAccountId === run.originatingAccountId &&
    item.originatingThreadId === run.originatingThreadId;

  const messageId = run.messageId?.trim();
  if (messageId) {
    return items.some((item) => item.messageId?.trim() === messageId && hasSameRouting(item));
  }
  if (!allowPromptFallback) {
    return false;
  }
  return items.some((item) => item.prompt === run.prompt && hasSameRouting(item));
}

function logDropped(
  sessionKey: string,
  run: FollowupRun,
  mode: QueueSettings["mode"],
  queueDepth: number,
  reason: "duplicate" | "cap_new" | "cap_old" | "cap_summarize",
  droppedCount: number,
): void {
  logFollowupDropped({
    sessionKey,
    sessionId: run.run.sessionId,
    messageId: run.messageId,
    mode,
    queueDepth,
    droppedCount,
    reason,
  });
}

export function enqueueFollowupRunDetailed(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
): FollowupEnqueueResult {
  const queue = getFollowupQueue(key, settings);
  const sessionKey = key.trim() || key || "unknown";
  const dedupe =
    dedupeMode === "none"
      ? undefined
      : (item: FollowupRun, items: FollowupRun[]) =>
          isRunAlreadyQueued(item, items, dedupeMode === "prompt");

  if (shouldSkipQueueItem({ item: run, items: queue.items, dedupe })) {
    const result: FollowupEnqueueResult = {
      accepted: false,
      queueDepth: queue.items.length,
      mode: queue.mode,
      droppedCount: 1,
      rejectedReason: "duplicate",
    };
    logDropped(sessionKey, run, queue.mode, result.queueDepth, "duplicate", 1);
    return result;
  }

  queue.lastEnqueuedAt = Date.now();
  queue.lastRun = run.run;

  const beforeLength = queue.items.length;
  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
  });
  if (!shouldEnqueue) {
    const result: FollowupEnqueueResult = {
      accepted: false,
      queueDepth: queue.items.length,
      mode: queue.mode,
      droppedCount: 1,
      rejectedReason: "cap_new",
    };
    logDropped(sessionKey, run, queue.mode, result.queueDepth, "cap_new", 1);
    return result;
  }

  const droppedCount = Math.max(0, beforeLength - queue.items.length);
  let droppedReason: FollowupEnqueueResult["droppedReason"];
  if (droppedCount > 0) {
    droppedReason = queue.dropPolicy === "old" ? "cap_old" : "cap_summarize";
    logDropped(sessionKey, run, queue.mode, queue.items.length, droppedReason, droppedCount);
  }

  queue.items.push(run);
  const result: FollowupEnqueueResult = {
    accepted: true,
    queueDepth: queue.items.length,
    mode: queue.mode,
    droppedCount,
    droppedReason,
  };
  logFollowupEnqueued({
    sessionKey,
    sessionId: run.run.sessionId,
    messageId: run.messageId,
    mode: queue.mode,
    queueDepth: result.queueDepth,
    droppedCount: droppedCount > 0 ? droppedCount : undefined,
  });
  return result;
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
): boolean {
  return enqueueFollowupRunDetailed(key, run, settings, dedupeMode).accepted;
}

export function getFollowupQueueDepth(key: string): number {
  const cleaned = key.trim();
  if (!cleaned) {
    return 0;
  }
  const queue = FOLLOWUP_QUEUES.get(cleaned);
  if (!queue) {
    return 0;
  }
  return queue.items.length;
}
