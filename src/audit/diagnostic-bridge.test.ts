import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  resetDiagnosticAuditBridgeForTest,
  startDiagnosticAuditBridge,
} from "./diagnostic-bridge.js";
import { configureAuditWriter, resetAuditWriterForTest } from "./writer.js";

describe("diagnostic audit bridge", () => {
  afterEach(() => {
    resetDiagnosticAuditBridgeForTest();
    resetDiagnosticEventsForTest();
    resetAuditWriterForTest();
  });

  it("mirrors diagnostic events into audit v1 entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-audit-bridge-"));
    const file = path.join(dir, "audit.ndjson");
    configureAuditWriter(file);

    startDiagnosticAuditBridge();
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "error",
      error: "boom",
      sessionId: "s1",
      sessionKey: "agent:main:main",
    });

    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.schema).toBe("openclaw.audit");
    expect(lines[0]?.version).toBe(1);
    expect(lines[0]?.eventType).toBe("message.processed");
    expect(lines[0]?.outcome).toBe("failure");
    expect((lines[0]?.legacy as Record<string, unknown>)?.diagnosticSeq).toBe(1);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
