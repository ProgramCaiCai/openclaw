import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEventV1 } from "./schema-v1.js";
import { verifyAuditChain } from "./verify.js";
import { appendAuditEvent, configureAuditWriter, resetAuditWriterForTest } from "./writer.js";

describe("audit chain verify", () => {
  afterEach(() => {
    resetAuditWriterForTest();
  });

  it("accepts untampered v1 chains", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-audit-verify-"));
    const file = path.join(dir, "audit.ndjson");
    configureAuditWriter(file);

    appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system", id: "openclaw" },
      subject: { type: "message", id: "msg-1" },
      source: { component: "test" },
    });

    appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system", id: "openclaw" },
      subject: { type: "message", id: "msg-2" },
      source: { component: "test" },
    });

    const events = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEventV1);

    const verify = verifyAuditChain(events);
    expect(verify.ok).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects tampered payload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-audit-verify-"));
    const file = path.join(dir, "audit.ndjson");
    configureAuditWriter(file);

    appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system", id: "openclaw" },
      subject: { type: "message", id: "msg-1" },
      source: { component: "test" },
      payload: { n: 1 },
    });

    appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system", id: "openclaw" },
      subject: { type: "message", id: "msg-2" },
      source: { component: "test" },
      payload: { n: 2 },
    });

    const events = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEventV1);

    const tampered = structuredClone(events);
    (tampered[1].payload as { n?: number }).n = 999;

    const verify = verifyAuditChain(tampered);
    expect(verify.ok).toBe(false);
    expect(verify.issues[0]?.message).toContain("hash mismatch");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
