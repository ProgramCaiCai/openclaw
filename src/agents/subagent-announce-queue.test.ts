import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import {
  AnnounceQueueDeferredError,
  enqueueAnnounce,
  resetAnnounceQueuesForTests,
} from "./subagent-announce-queue.js";

function createRetryingSend() {
  const prompts: string[] = [];
  let attempts = 0;
  let resolved = false;
  let resolveSecondAttempt = () => {};
  const waitForSecondAttempt = new Promise<void>((resolve) => {
    resolveSecondAttempt = resolve;
  });

  const send = vi.fn(async (item: { prompt: string }) => {
    attempts += 1;
    prompts.push(item.prompt);
    if (attempts >= 2 && !resolved) {
      resolved = true;
      resolveSecondAttempt();
    }
    if (attempts === 1) {
      throw new Error("gateway timeout after 60000ms");
    }
  });

  return { send, prompts, waitForSecondAttempt };
}

describe("subagent-announce-queue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetAnnounceQueuesForTests();
  });

  it("retries failed sends without dropping queued announce items", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:retry",
      item: {
        prompt: "subagent completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts).toEqual(["subagent completed", "subagent completed"]);
  });

  it("preserves queue summary state across failed summary delivery retries", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "first result",
        summaryLine: "first result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "second result",
        summaryLine: "second result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts[0]).toContain("[Queue overflow]");
    expect(sender.prompts[1]).toContain("[Queue overflow]");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item one",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item two",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts[0]).toContain("Queued #1");
    expect(sender.prompts[0]).toContain("queued item one");
    expect(sender.prompts[0]).toContain("Queued #2");
    expect(sender.prompts[0]).toContain("queued item two");
    expect(sender.prompts[1]).toContain("Queued #1");
    expect(sender.prompts[1]).toContain("queued item one");
    expect(sender.prompts[1]).toContain("Queued #2");
    expect(sender.prompts[1]).toContain("queued item two");
  });

  it("uses debounce floor for retries when debounce exceeds backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const previousFast = process.env.OPENCLAW_TEST_FAST;
    delete process.env.OPENCLAW_TEST_FAST;

    try {
      const attempts: number[] = [];
      const send = vi.fn(async () => {
        attempts.push(Date.now());
        if (attempts.length === 1) {
          throw new Error("transient timeout");
        }
      });

      enqueueAnnounce({
        key: "announce:test:retry-debounce-floor",
        item: {
          prompt: "subagent completed",
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:telegram:dm:u1",
        },
        settings: { mode: "followup", debounceMs: 5_000 },
        send,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(2);
      const [firstAttempt, secondAttempt] = attempts;
      if (firstAttempt === undefined || secondAttempt === undefined) {
        throw new Error("expected two retry attempts");
      }
      expect(secondAttempt - firstAttempt).toBeGreaterThanOrEqual(5_000);
    } finally {
      if (previousFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFast;
      }
    }
  });

  it("dedupes repeated announce ids and merges pending completion runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const delivered: Array<{ prompt: string; pendingRunIds?: string[] }> = [];
    const send = vi.fn(async (item: { prompt: string; pendingRunIds?: string[] }) => {
      delivered.push({
        prompt: item.prompt,
        pendingRunIds: item.pendingRunIds,
      });
    });

    enqueueAnnounce({
      key: "announce:test:dedupe",
      item: {
        announceId: "announce:dup",
        prompt: "first result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
        pendingRunIds: ["run-1"],
      },
      settings: { mode: "followup", debounceMs: 25 },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:dedupe",
      item: {
        announceId: "announce:dup",
        prompt: "second result",
        enqueuedAt: Date.now() + 1,
        sessionKey: "agent:main:telegram:dm:u1",
        pendingRunIds: ["run-2"],
      },
      settings: { mode: "followup", debounceMs: 25 },
      send,
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(send).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([
      {
        prompt: "second result",
        pendingRunIds: ["run-1", "run-2"],
      },
    ]);
  });

  it("retries deferred sends on the deferred delay without failure logging", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const runtimeErrorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const attempts: number[] = [];
    const send = vi.fn(async () => {
      attempts.push(Date.now());
      if (attempts.length === 1) {
        throw new AnnounceQueueDeferredError("completion announce accepted for run run-1", {
          retryDelayMs: 10,
        });
      }
    });

    enqueueAnnounce({
      key: "announce:test:pending-retry",
      item: {
        announceId: "announce:pending",
        prompt: "subagent completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(2);
    expect(runtimeErrorSpy).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBe(10);
  });

  it("preserves summary pending completion state across deferred retries", async () => {
    const seen: Array<{
      prompt: string;
      pendingRunId: string | undefined;
      pendingRunIds: string[] | undefined;
      retryAttempt: number | undefined;
    }> = [];
    let attempts = 0;
    let resolveSecondAttempt = () => {};
    const secondAttempt = new Promise<void>((resolve) => {
      resolveSecondAttempt = resolve;
    });
    const send = vi.fn(
      async (item: {
        prompt: string;
        pendingRunId?: string;
        pendingRunIds?: string[];
        retryAttempt?: number;
      }) => {
        attempts += 1;
        seen.push({
          prompt: item.prompt,
          pendingRunId: item.pendingRunId,
          pendingRunIds: item.pendingRunIds ? [...item.pendingRunIds] : undefined,
          retryAttempt: item.retryAttempt,
        });
        if (attempts === 1) {
          item.pendingRunIds = ["announce-run-1"];
          item.pendingRunId = "announce-run-1";
          item.retryAttempt = 1;
          throw new AnnounceQueueDeferredError("completion still pending");
        }
        resolveSecondAttempt();
      },
    );

    enqueueAnnounce({
      key: "announce:test:summary-deferred-state",
      item: {
        prompt: "first result",
        summaryLine: "first result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
        expectsCompletionMessage: true,
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:summary-deferred-state",
      item: {
        prompt: "second result",
        summaryLine: "second result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
        expectsCompletionMessage: true,
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });

    await secondAttempt;
    expect(send).toHaveBeenCalledTimes(2);
    expect(seen[0]?.prompt).toContain("[Queue overflow]");
    expect(seen[1]?.prompt).toContain("[Queue overflow]");
    expect(seen[1]?.pendingRunId).toBe("announce-run-1");
    expect(seen[1]?.pendingRunIds).toEqual(["announce-run-1"]);
    expect(seen[1]?.retryAttempt).toBe(1);
  });

  it("preserves collect-mode pending completion state across deferred retries", async () => {
    const seenPendingRunIds: string[][] = [];
    const seenRetryAttempts: number[] = [];
    let attempts = 0;
    let resolveSecondAttempt = () => {};
    const secondAttempt = new Promise<void>((resolve) => {
      resolveSecondAttempt = resolve;
    });
    const send = vi.fn(
      async (item: {
        prompt: string;
        pendingRunId?: string;
        pendingRunIds?: string[];
        retryAttempt?: number;
      }) => {
        attempts += 1;
        seenPendingRunIds.push([...(item.pendingRunIds ?? [])]);
        seenRetryAttempts.push(item.retryAttempt ?? 0);
        if (attempts === 1) {
          item.pendingRunIds = ["announce-run-1", "announce-run-2"];
          item.pendingRunId = "announce-run-2";
          item.retryAttempt = 4;
          throw new AnnounceQueueDeferredError("completion still pending");
        }
        resolveSecondAttempt();
      },
    );

    enqueueAnnounce({
      key: "announce:test:collect-deferred-state",
      item: {
        prompt: "queued item one",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-deferred-state",
      item: {
        prompt: "queued item two",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });

    await secondAttempt;
    expect(send).toHaveBeenCalledTimes(2);
    expect(seenPendingRunIds).toEqual([[], ["announce-run-1", "announce-run-2"]]);
    expect(seenRetryAttempts).toEqual([0, 4]);
  });

  it("fails open after repeated drain failures so later announces can proceed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const prompts: string[] = [];
    let resolveHealthySend = () => {};
    const healthySend = new Promise<void>((resolve) => {
      resolveHealthySend = resolve;
    });

    const send = vi.fn(async (item: { prompt: string }) => {
      prompts.push(item.prompt);
      if (item.prompt === "stuck announce") {
        throw new Error("gateway timeout after 60000ms");
      }
      resolveHealthySend();
    });

    enqueueAnnounce({
      key: "announce:test:fail-open",
      item: {
        prompt: "stuck announce",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 1_000 },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:fail-open",
      item: {
        prompt: "healthy announce",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 1_000 },
      send,
    });

    const outcome = Promise.race([
      healthySend.then(() => "healthy" as const),
      vi.advanceTimersByTimeAsync(15_000).then(() => "timeout" as const),
    ]);

    await expect(outcome).resolves.toBe("healthy");

    expect(prompts).toEqual([
      "stuck announce",
      "stuck announce",
      "stuck announce",
      "healthy announce",
    ]);
  });
});
