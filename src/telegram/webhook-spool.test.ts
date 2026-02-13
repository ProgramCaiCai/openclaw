import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTelegramWebhookSpool } from "./webhook-spool.js";

describe("createTelegramWebhookSpool", () => {
  let rootDir: string | null = null;

  afterEach(async () => {
    if (rootDir) {
      await fs.rm(rootDir, { recursive: true, force: true });
      rootDir = null;
    }
  });

  it("normalizes accountId into a safe directory segment", async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-webhook-spool-test-"));

    const spool = createTelegramWebhookSpool({ rootDir, accountId: "../evil" });
    const rel = path.relative(rootDir, spool.dir);

    // Should not escape the configured root directory.
    expect(rel.startsWith(".." + path.sep) || rel === "..").toBe(false);

    // Should still be writable.
    const appended = await spool.append({ receivedAtMs: Date.now(), update: { ok: true } });
    expect(await fs.readFile(appended.filePath, "utf8")).toContain('"ok":true');
  });

  it("treats ack as idempotent", async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-webhook-spool-test-"));

    const spool = createTelegramWebhookSpool({ rootDir, accountId: "acct" });
    const appended = await spool.append({ receivedAtMs: 1, updateId: 1, update: { ok: true } });

    await spool.ack(appended.filePath);
    await expect(spool.ack(appended.filePath)).resolves.toBeUndefined();
  });

  it("lists spool files deterministically", async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-webhook-spool-test-"));

    const spool = createTelegramWebhookSpool({ rootDir, accountId: "acct" });
    await fs.mkdir(spool.dir, { recursive: true });

    const names = ["2-unknown-b.json", "1-unknown-a.json", "3-unknown-c.json"];
    for (const name of names) {
      await fs.writeFile(path.join(spool.dir, name), "{}", "utf8");
    }

    const listed = await spool.list();
    expect(listed.map((p) => path.basename(p))).toEqual([
      "1-unknown-a.json",
      "2-unknown-b.json",
      "3-unknown-c.json",
    ]);
  });
});
