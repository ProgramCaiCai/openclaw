import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendAuditEvent,
  configureAuditWriter,
  getAuditWriterStateForTest,
  resetAuditWriterForTest,
} from "./writer.js";

describe("audit writer", () => {
  afterEach(() => {
    resetAuditWriterForTest();
    vi.useRealTimers();
  });

  it("writes schema v1 events with hash chaining", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-audit-v1-"));
    const file = path.join(dir, "audit.ndjson");
    configureAuditWriter(file);

    const first = appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system", id: "openclaw" },
      subject: { type: "message", id: "msg-1" },
      source: { component: "test" },
      payload: { n: 1 },
    });

    const second = appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system", id: "openclaw" },
      subject: { type: "message", id: "msg-2" },
      source: { component: "test" },
      payload: { n: 2 },
    });

    expect(first.schema).toBe("openclaw.audit");
    expect(first.version).toBe(1);
    expect(first.evidence.prevHash).toBeNull();
    expect(second.evidence.prevHash).toBe(first.evidence.hash);

    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { schema: string; version: number });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.schema).toBe("openclaw.audit");
    expect(lines[1]?.version).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("continues hash chain when the file tail has malformed lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-audit-v1-"));
    const file = path.join(dir, "audit.ndjson");
    configureAuditWriter(file);

    const first = appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system" },
      subject: { type: "message", id: "msg-1" },
      source: { component: "test" },
    });

    fs.appendFileSync(file, "{bad-json\n", "utf8");

    configureAuditWriter(file);
    const second = appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system" },
      subject: { type: "message", id: "msg-2" },
      source: { component: "test" },
    });

    expect(second.evidence.prevHash).toBe(first.evidence.hash);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rotates default audit file path when local date changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T10:00:00+08:00"));
    resetAuditWriterForTest();

    appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system" },
      subject: { type: "message", id: "msg-1" },
      source: { component: "test" },
    });
    const firstPath = getAuditWriterStateForTest().filePath;

    vi.setSystemTime(new Date("2026-02-16T10:00:00+08:00"));
    appendAuditEvent({
      eventType: "message.processed",
      action: "processed",
      outcome: "success",
      actor: { type: "system" },
      subject: { type: "message", id: "msg-2" },
      source: { component: "test" },
    });
    const secondPath = getAuditWriterStateForTest().filePath;

    expect(firstPath).not.toBe(secondPath);
    expect(firstPath).toContain("openclaw-audit-v1-2026-02-15.ndjson");
    expect(secondPath).toContain("openclaw-audit-v1-2026-02-16.ndjson");

    fs.rmSync(path.dirname(firstPath), { recursive: true, force: true });
  });
});
