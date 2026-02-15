import { describe, expect, it, vi } from "vitest";

const middlewareUseSpy = vi.fn();
const botCatchSpy = vi.fn();
const botOnSpy = vi.fn();
const apiConfigUseSpy = vi.fn();

vi.mock("./bot-handlers.js", () => ({
  registerTelegramHandlers: vi.fn(),
}));

vi.mock("./bot-message.js", () => ({
  createTelegramMessageProcessor: vi.fn(() => vi.fn(async () => undefined)),
}));

vi.mock("./bot-native-commands.js", () => ({
  registerTelegramNativeCommands: vi.fn(),
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = { config: { use: apiConfigUseSpy } };
    use = middlewareUseSpy;
    on = botOnSpy;
    stop = vi.fn();
    command = vi.fn();
    catch = botCatchSpy;

    constructor(public token: string) {
      void token;
    }
  },
  webhookCallback: vi.fn(),
}));

const sequentializeMiddleware = vi.fn();
vi.mock("@grammyjs/runner", () => ({
  sequentialize: () => sequentializeMiddleware,
}));

vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => "throttler",
}));

import { setTelegramUpdateCompletionDefer } from "./bot-updates.js";
import { createTelegramBot } from "./bot.js";

const flushMicrotasks = async () => {
  // Allow the internal commitTask promise chain to execute.
  await Promise.resolve();
  await Promise.resolve();
};

describe("createTelegramBot update offset", () => {
  it("commits update offset after completion defer resolves", async () => {
    middlewareUseSpy.mockClear();

    const onUpdateId = vi.fn(async () => undefined);
    createTelegramBot({
      token: "TOKEN",
      config: { channels: { telegram: {} }, agents: { defaults: {} } },
      updateOffset: { lastUpdateId: null, onUpdateId },
    });

    const offsetMiddleware = middlewareUseSpy.mock.calls[1]?.[0] as
      | ((ctx: unknown, next: () => Promise<void>) => Promise<void>)
      | undefined;
    expect(typeof offsetMiddleware).toBe("function");

    const ctx = { update: { update_id: 10 } };
    await offsetMiddleware!(ctx, async () => {
      setTelegramUpdateCompletionDefer(ctx, Promise.resolve());
    });

    await flushMicrotasks();
    expect(onUpdateId).toHaveBeenCalledWith(10);
  });

  it("does not commit update offset when completion defer rejects with retryable error", async () => {
    middlewareUseSpy.mockClear();

    const onUpdateId = vi.fn(async () => undefined);
    createTelegramBot({
      token: "TOKEN",
      config: { channels: { telegram: {} }, agents: { defaults: {} } },
      updateOffset: { lastUpdateId: null, onUpdateId },
    });

    const offsetMiddleware = middlewareUseSpy.mock.calls[1]?.[0] as
      | ((ctx: unknown, next: () => Promise<void>) => Promise<void>)
      | undefined;
    expect(typeof offsetMiddleware).toBe("function");

    const ctx = { update: { update_id: 11 } };
    let reject!: (err: unknown) => void;
    const defer = new Promise<void>((_resolve, rej) => {
      reject = rej;
    });

    await offsetMiddleware!(ctx, async () => {
      setTelegramUpdateCompletionDefer(ctx, defer);
    });

    reject({ error_code: 429, parameters: { retry_after: 1 } });
    await flushMicrotasks();

    expect(onUpdateId).not.toHaveBeenCalled();
  });

  it("commits update offset when completion defer rejects with permanent error", async () => {
    middlewareUseSpy.mockClear();

    const onUpdateId = vi.fn(async () => undefined);
    createTelegramBot({
      token: "TOKEN",
      config: { channels: { telegram: {} }, agents: { defaults: {} } },
      updateOffset: { lastUpdateId: null, onUpdateId },
    });

    const offsetMiddleware = middlewareUseSpy.mock.calls[1]?.[0] as
      | ((ctx: unknown, next: () => Promise<void>) => Promise<void>)
      | undefined;
    expect(typeof offsetMiddleware).toBe("function");

    const ctx = { update: { update_id: 12 } };
    let reject!: (err: unknown) => void;
    const defer = new Promise<void>((_resolve, rej) => {
      reject = rej;
    });

    await offsetMiddleware!(ctx, async () => {
      setTelegramUpdateCompletionDefer(ctx, defer);
    });

    reject({ error_code: 400, description: "Bad Request" });
    await flushMicrotasks();

    expect(onUpdateId).toHaveBeenCalledWith(12);
  });

  it("does not commit update offset when middleware throws retryable error", async () => {
    middlewareUseSpy.mockClear();

    const onUpdateId = vi.fn(async () => undefined);
    createTelegramBot({
      token: "TOKEN",
      config: { channels: { telegram: {} }, agents: { defaults: {} } },
      updateOffset: { lastUpdateId: null, onUpdateId },
    });

    const offsetMiddleware = middlewareUseSpy.mock.calls[1]?.[0] as
      | ((ctx: unknown, next: () => Promise<void>) => Promise<void>)
      | undefined;
    expect(typeof offsetMiddleware).toBe("function");

    const ctx = { update: { update_id: 13 } };
    await expect(
      offsetMiddleware!(ctx, async () => {
        throw { error_code: 429, parameters: { retry_after: 1 } };
      }),
    ).rejects.toBeTruthy();

    await flushMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();
  });

  it("commits update offset when middleware throws permanent error", async () => {
    middlewareUseSpy.mockClear();

    const onUpdateId = vi.fn(async () => undefined);
    createTelegramBot({
      token: "TOKEN",
      config: { channels: { telegram: {} }, agents: { defaults: {} } },
      updateOffset: { lastUpdateId: null, onUpdateId },
    });

    const offsetMiddleware = middlewareUseSpy.mock.calls[1]?.[0] as
      | ((ctx: unknown, next: () => Promise<void>) => Promise<void>)
      | undefined;
    expect(typeof offsetMiddleware).toBe("function");

    const ctx = { update: { update_id: 14 } };
    await expect(
      offsetMiddleware!(ctx, async () => {
        throw new Error("logic bug");
      }),
    ).resolves.toBeUndefined();

    await flushMicrotasks();
    expect(onUpdateId).toHaveBeenCalledWith(14);
  });
});
