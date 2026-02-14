import { describe, expect, it } from "vitest";
import {
  consumeSessionCompactionRequest,
  markSessionCompactionCompleted,
} from "../pi-embedded-runner/runs.js";
import { createSessionCompactTool } from "./session-compact-tool.js";

function makeSessionKey(label: string): string {
  return `session-compact-tool-test:${label}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

describe("session_compact tool", () => {
  it("queues compaction requests for an active session", async () => {
    const sessionKey = makeSessionKey("queue");
    const tool = createSessionCompactTool({ agentSessionKey: sessionKey });

    const result = await tool.execute("call-1", { instructions: "keep decisions" });

    expect(result.details).toMatchObject({
      ok: true,
      status: "queued",
      scheduled: true,
      instructions: "keep decisions",
    });
    expect(consumeSessionCompactionRequest(sessionKey)).toBe(true);
  });

  it("skips duplicate requests while compaction is already queued", async () => {
    const sessionKey = makeSessionKey("duplicate");
    const tool = createSessionCompactTool({ agentSessionKey: sessionKey });

    await tool.execute("call-1", {});
    const result = await tool.execute("call-2", {});

    expect(result.details).toMatchObject({
      ok: true,
      status: "skipped",
      reason: "duplicate",
      scheduled: false,
    });
    expect(consumeSessionCompactionRequest(sessionKey)).toBe(true);
  });

  it("skips requests during cooldown right after compaction", async () => {
    const sessionKey = makeSessionKey("cooldown");
    const tool = createSessionCompactTool({ agentSessionKey: sessionKey });

    await tool.execute("call-1", {});
    expect(consumeSessionCompactionRequest(sessionKey)).toBe(true);
    markSessionCompactionCompleted(sessionKey, Date.now());

    const result = await tool.execute("call-2", {});

    expect(result.details).toMatchObject({
      ok: true,
      status: "skipped",
      reason: "cooldown",
      scheduled: false,
    });
    expect(typeof (result.details as { retryAfterMs?: unknown }).retryAfterMs).toBe("number");
  });
});
