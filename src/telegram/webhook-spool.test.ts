import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTelegramWebhookSpool } from "./webhook-spool.js";

describe("telegram webhook spool", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
      root = null;
    }
  });

  it("sanitizes accountId into a safe spool directory and still replays legacy records", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-spool-test-"));

    const spool = createTelegramWebhookSpool({ accountId: "my bot", rootDir: root });

    expect(spool.dir).toBe(path.join(root, "my_bot"));

    // Simulate an existing legacy record written by older versions.
    const legacyDir = path.join(root, "my bot");
    await fs.mkdir(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, "100-unknown-legacy.json");
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ id: "legacy", receivedAtMs: 100, update: { update_id: 1 } }),
      "utf8",
    );

    const listed = await spool.list();
    expect(listed).toContain(legacyPath);
  });

  it("lists spool files deterministically (sorted by receivedAtMs prefix)", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-spool-test-"));

    const spool = createTelegramWebhookSpool({ accountId: "default", rootDir: root });

    await spool.append({ receivedAtMs: 300, updateId: 3, update: { update_id: 3 } });
    await spool.append({ receivedAtMs: 100, updateId: 1, update: { update_id: 1 } });
    await spool.append({ receivedAtMs: 200, updateId: 2, update: { update_id: 2 } });

    const listed = await spool.list();
    const prefixes = listed.map((filePath) => Number(path.basename(filePath).split("-")[0]));
    expect(prefixes).toEqual([100, 200, 300]);
  });

  it("ack is idempotent (ENOENT is tolerated)", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-spool-test-"));

    const spool = createTelegramWebhookSpool({ accountId: "default", rootDir: root });
    const appended = await spool.append({ receivedAtMs: 100, updateId: 1, update: {} });

    await spool.ack(appended.filePath);
    await expect(spool.ack(appended.filePath)).resolves.toBeUndefined();
  });
});
