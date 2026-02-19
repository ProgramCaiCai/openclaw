import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upgradeAuditEventsV1ToV2 } from "./migrate-v1-to-v2.js";
import { type AuditEventV1 } from "./schema-v1.js";
import { verifyAuditChain } from "./verify.js";
import { appendAuditEvent, configureAuditWriter, resetAuditWriterForTest } from "./writer.js";

describe("audit v1 to v2 migration", () => {
  afterEach(() => {
    resetAuditWriterForTest();
  });

  it("upgrades v1 events to v2 with a fresh hash chain", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-audit-migrate-"));
    const file = path.join(dir, "audit-v1.ndjson");
    configureAuditWriter(file);

    appendAuditEvent({
      eventType: "exec.approval.requested",
      action: "requested",
      outcome: "skipped",
      actor: { type: "system", id: "openclaw" },
      subject: { type: "approval", id: "ap-1" },
      source: { component: "test" },
    });

    appendAuditEvent({
      eventType: "exec.approval.resolved",
      action: "resolved",
      outcome: "success",
      actor: { type: "user", id: "operator" },
      subject: { type: "approval", id: "ap-1" },
      source: { component: "test" },
      payload: { decision: "allow-once" },
    });

    const v1Events = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEventV1);

    const migratedAt = "2026-02-16T05:30:00.000Z";
    const v2Events = upgradeAuditEventsV1ToV2(v1Events, migratedAt);

    expect(v2Events).toHaveLength(2);
    expect(v2Events[0]?.version).toBe(2);
    expect(v2Events[0]?.schemaMinor).toBe(0);
    expect(v2Events[0]?.normalized.outcome).toBe("skipped");
    expect(v2Events[0]?.migration).toEqual(
      expect.objectContaining({
        fromVersion: 1,
        migratedAt,
        sourceHash: v1Events[0]?.evidence.hash,
      }),
    );
    expect(v2Events[1]?.evidence.prevHash).toBe(v2Events[0]?.evidence.hash);

    const verify = verifyAuditChain(v2Events);
    expect(verify.ok).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
