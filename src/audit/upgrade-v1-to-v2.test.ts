import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEventV1 } from "./schema-v1.js";
import { upgradeVerifiedAuditEventsV1ToV2 } from "./upgrade-v1-to-v2.js";
import { appendAuditEvent, configureAuditWriter, resetAuditWriterForTest } from "./writer.js";

describe("upgrade v1 to v2 (verified)", () => {
  afterEach(() => {
    resetAuditWriterForTest();
  });

  it("rejects tampered v1 input chain", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-audit-upgrade-"));
    const file = path.join(dir, "audit.ndjson");
    configureAuditWriter(file);

    appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system" },
      subject: { type: "message", id: "m1" },
      source: { component: "test" },
      payload: { n: 1 },
    });

    const events = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEventV1);

    const tampered = structuredClone(events);
    (tampered[0].payload as { n?: number }).n = 999;

    expect(() => upgradeVerifiedAuditEventsV1ToV2(tampered)).toThrow(
      /source v1 verification failed/,
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
