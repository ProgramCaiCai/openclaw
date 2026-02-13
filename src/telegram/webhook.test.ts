import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTelegramWebhook } from "./webhook.js";

const setWebhookSpy = vi.fn(async () => undefined);
const deleteWebhookSpy = vi.fn(async () => undefined);
const stopSpy = vi.fn(async () => undefined);
const handleUpdateSpy = vi.fn(async () => undefined);

const createTelegramBotSpy = vi.fn(() => ({
  api: { setWebhook: setWebhookSpy, deleteWebhook: deleteWebhookSpy },
  stop: stopSpy,
  handleUpdate: handleUpdateSpy,
}));

vi.mock("./bot.js", () => ({
  createTelegramBot: (...args: unknown[]) => createTelegramBotSpy(...args),
}));

describe("startTelegramWebhook", () => {
  let spoolRoot: string | null = null;

  afterEach(async () => {
    if (spoolRoot) {
      await fs.rm(spoolRoot, { recursive: true, force: true });
      spoolRoot = null;
    }
    delete process.env.OPENCLAW_TELEGRAM_WEBHOOK_SPOOL_DIR;
  });

  it("starts server, registers webhook, and serves health", async () => {
    createTelegramBotSpy.mockClear();
    setWebhookSpy.mockClear();
    handleUpdateSpy.mockClear();

    spoolRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-webhook-test-"));
    process.env.OPENCLAW_TELEGRAM_WEBHOOK_SPOOL_DIR = spoolRoot;

    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: cfg,
      port: 0,
      abortSignal: abort.signal,
    });

    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("no address");
    }
    const url = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(setWebhookSpy).toHaveBeenCalled();

    abort.abort();
  });

  it("ACKs 200 and spools updates before processing", async () => {
    createTelegramBotSpy.mockClear();
    setWebhookSpy.mockClear();
    handleUpdateSpy.mockClear();
    handleUpdateSpy.mockResolvedValue(undefined);

    spoolRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-webhook-test-"));
    process.env.OPENCLAW_TELEGRAM_WEBHOOK_SPOOL_DIR = spoolRoot;

    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: { bindings: [] },
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }

    const res = await fetch(`http://127.0.0.1:${addr.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1 } }),
    });
    expect(res.status).toBe(200);

    // Wait for async body parse + handleUpdate.
    for (let i = 0; i < 50 && handleUpdateSpy.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(handleUpdateSpy).toHaveBeenCalled();

    const spoolDir = path.join(spoolRoot, "opie");
    const remaining = (await fs.readdir(spoolDir)).filter((name) => name.endsWith(".json"));
    expect(remaining.length).toBe(0);

    abort.abort();
  });

  it("still returns 200 and keeps spool record when processing fails", async () => {
    createTelegramBotSpy.mockClear();
    setWebhookSpy.mockClear();
    handleUpdateSpy.mockClear();
    handleUpdateSpy.mockRejectedValueOnce(new Error("boom"));

    spoolRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-webhook-test-"));
    process.env.OPENCLAW_TELEGRAM_WEBHOOK_SPOOL_DIR = spoolRoot;

    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: { bindings: [] },
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }

    const res = await fetch(`http://127.0.0.1:${addr.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 2, message: { message_id: 2 } }),
    });
    expect(res.status).toBe(200);

    for (let i = 0; i < 50 && handleUpdateSpy.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const spoolDir = path.join(spoolRoot, "opie");
    const pending = (await fs.readdir(spoolDir)).filter((name) => name.endsWith(".json"));
    expect(pending.length).toBeGreaterThan(0);

    abort.abort();

    // Next start should replay and delete.
    handleUpdateSpy.mockClear();
    handleUpdateSpy.mockResolvedValue(undefined);
    const abort2 = new AbortController();
    const { stop } = await startTelegramWebhook({
      token: "tok",
      accountId: "opie",
      config: { bindings: [] },
      port: 0,
      abortSignal: abort2.signal,
      path: "/hook",
    });

    for (let i = 0; i < 50 && handleUpdateSpy.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const remaining = (await fs.readdir(spoolDir)).filter((name) => name.endsWith(".json"));
    expect(remaining.length).toBe(0);

    stop();
    abort2.abort();
  });
});
