import { describe, expect, it, vi } from "vitest";

let capturedOnFlush:
  | ((
      entries: Array<{ ctx: any; msg: any; allMedia: any[]; storeAllowFrom: string[]; done: any }>,
    ) => Promise<void>)
  | undefined;

vi.mock("../auto-reply/inbound-debounce.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    createInboundDebouncer: (opts: any) => {
      capturedOnFlush = opts.onFlush;
      return {
        enqueue: vi.fn(async () => undefined),
      };
    },
  };
});

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

const createDeferred = () => {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("telegram debounce flush isolation", () => {
  it("falls back to per-entry processing when combined flush fails", async () => {
    const { registerTelegramHandlers } = await import("./bot-handlers.js");

    const processMessage = vi.fn(async (ctx: any) => {
      if (ctx && typeof ctx === "object" && "message" in ctx) {
        // Combined synthetic flush attempt.
        throw new Error("combined failed");
      }
      if (ctx?.update?.update_id === 2) {
        throw new Error("entry failed");
      }
    });

    registerTelegramHandlers({
      cfg: {
        agents: { defaults: {} },
        channels: { telegram: { accounts: { default: {} } } },
      } as any,
      accountId: "default",
      bot: { on: () => undefined, api: {} } as any,
      opts: { token: "tok" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: () => undefined } as any,
      mediaMaxBytes: 1024 * 1024,
      telegramCfg: {} as any,
      groupAllowFrom: [],
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveTelegramGroupConfig: () => ({}),
      shouldSkipUpdate: () => false,
      processMessage,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    });

    expect(typeof capturedOnFlush).toBe("function");

    const msgBase = {
      chat: { id: 99, type: "private" },
      date: 1,
    };

    const d1 = createDeferred();
    const d2 = createDeferred();

    await capturedOnFlush!([
      {
        ctx: { update: { update_id: 1 } },
        msg: { ...msgBase, message_id: 1, text: "hello" },
        allMedia: [],
        storeAllowFrom: [],
        done: d1,
      },
      {
        ctx: { update: { update_id: 2 } },
        msg: { ...msgBase, message_id: 2, text: "world" },
        allMedia: [],
        storeAllowFrom: [],
        done: d2,
      },
    ]);

    // 1x combined attempt + 2x per-entry fallback.
    expect(processMessage).toHaveBeenCalledTimes(3);

    await expect(withTimeout(d1.promise, 200)).resolves.toBeUndefined();
    await expect(withTimeout(d2.promise, 200)).rejects.toBeTruthy();
  });
});
