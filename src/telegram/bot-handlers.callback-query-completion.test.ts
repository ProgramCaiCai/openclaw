import { describe, expect, it, vi } from "vitest";
import { registerTelegramHandlers } from "./bot-handlers.js";
import { getTelegramUpdateCompletionDefer } from "./bot-updates.js";

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

describe("telegram callback_query completion defer", () => {
  it("settles the completion defer even when the handler returns early", async () => {
    const handlers = new Map<string, (ctx: any) => Promise<void>>();

    const bot = {
      api: {
        answerCallbackQuery: vi.fn(async () => undefined),
      },
      on: (event: string, handler: (ctx: any) => Promise<void>) => {
        handlers.set(event, handler);
      },
    } as any;

    const cfg = {
      agents: { defaults: {} },
      channels: {
        telegram: {
          accounts: {
            default: {
              // Force an early return path before any heavy processing.
              capabilities: { inlineButtons: "off" },
            },
          },
        },
      },
    } as any;

    registerTelegramHandlers({
      cfg,
      accountId: "default",
      bot,
      mediaMaxBytes: 1024 * 1024,
      opts: { token: "tok" },
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: (_code: number) => {
          throw new Error("exit should not be called");
        },
      },
      telegramCfg: {},
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveTelegramGroupConfig: () => ({}),
      shouldSkipUpdate: () => false,
      processMessage: vi.fn(async () => undefined),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    });

    const handler = handlers.get("callback_query");
    expect(typeof handler).toBe("function");

    const ctx = {
      update: { update_id: 1 },
      callbackQuery: {
        id: "cb1",
        data: "hello",
        message: {
          message_id: 42,
          chat: { id: 99, type: "private" },
        },
      },
    };

    await handler!(ctx);

    const defer = getTelegramUpdateCompletionDefer(ctx);
    expect(defer).toBeTruthy();

    await expect(withTimeout(defer!, 200)).resolves.toBeUndefined();
  });
});
