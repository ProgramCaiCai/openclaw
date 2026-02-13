import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorTelegramProvider } from "./monitor.js";

const runSpy = vi.fn();
const deleteWebhookSpy = vi.fn(async () => undefined);

vi.mock("./bot.js", () => ({
  createTelegramBot: () => ({
    api: { deleteWebhook: deleteWebhookSpy },
  }),
}));

vi.mock("@grammyjs/runner", () => ({
  run: (...args: unknown[]) => runSpy(...args),
}));

const computeBackoffSpy = vi.fn();
const sleepWithAbortSpy = vi.fn();

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: (...args: unknown[]) => computeBackoffSpy(...args),
  sleepWithAbort: (...args: unknown[]) => sleepWithAbortSpy(...args),
}));

vi.mock("./update-offset-store.js", () => ({
  readTelegramUpdateOffset: vi.fn(async () => null),
  writeTelegramUpdateOffset: vi.fn(async () => undefined),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      agents: { defaults: { maxConcurrent: 2 } },
      channels: { telegram: {} },
    })),
  };
});

describe("monitorTelegramProvider restart backoff", () => {
  beforeEach(() => {
    runSpy.mockReset();
    deleteWebhookSpy.mockReset();
    computeBackoffSpy.mockReset();
    sleepWithAbortSpy.mockReset();
  });

  afterEach(() => {
    // Avoid leaking fake timers across test files in the shared worker.
    vi.useRealTimers();
  });

  it("resets restart attempt counter after a stable run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const abort = new AbortController();

    // First runner: fails quickly with recoverable network error.
    // Second runner: stops after a long (stable) run, then we abort on the sleep.
    const networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    runSpy
      .mockImplementationOnce(() => ({
        task: () => Promise.reject(networkError),
        stop: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        task: () => new Promise<void>((resolve) => setTimeout(resolve, 5 * 60_000 + 50)),
        stop: vi.fn(),
      }));

    // Make computeBackoff deterministic and observable.
    computeBackoffSpy.mockImplementation((_policy: unknown, attempt: number) => attempt * 1000);

    // Abort after the second sleep, so the loop exits cleanly.
    let sleepCalls = 0;
    sleepWithAbortSpy.mockImplementation(async () => {
      sleepCalls += 1;
      if (sleepCalls >= 2) {
        abort.abort();
      }
    });

    const task = monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

    // Wait until the second runner is started (its task schedules the long timer).
    for (let i = 0; i < 50 && runSpy.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 50);
    await task;

    // If attempts are reset after the stable run, we compute backoff with attempt=1 twice.
    const attempts = computeBackoffSpy.mock.calls.map((call) => call[1]);
    expect(attempts).toEqual([1, 1]);

    vi.useRealTimers();
  });

  it("caps restart backoff delay to policy max", async () => {
    const abort = new AbortController();

    runSpy.mockImplementationOnce(() => ({
      task: () => Promise.resolve(),
      stop: vi.fn(),
    }));

    computeBackoffSpy.mockImplementation(() => 999_999);

    sleepWithAbortSpy.mockImplementation(async () => {
      abort.abort();
    });

    const nowSpy = vi.spyOn(Date, "now");
    const times = [0, 1];
    let idx = 0;
    nowSpy.mockImplementation(() => {
      const value = times[Math.min(idx, times.length - 1)];
      idx += 1;
      return value;
    });

    try {
      await monitorTelegramProvider({ token: "tok", abortSignal: abort.signal });

      expect(sleepWithAbortSpy).toHaveBeenCalled();
      const delayMs = sleepWithAbortSpy.mock.calls[0]?.[0];
      expect(delayMs).toBe(30_000);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
