import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../../infra/diagnostic-events.js";
import {
  clearFollowupQueue,
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "../queue.js";

function createRun(prompt: string, messageId?: string): FollowupRun {
  return {
    prompt,
    messageId,
    enqueuedAt: Date.now(),
    originatingChannel: "slack",
    originatingTo: "channel:C123",
    run: {
      agentId: "agent",
      agentDir: "/tmp",
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {} as OpenClawConfig,
      provider: "anthropic",
      model: "claude",
      timeoutMs: 10_000,
      blockReplyBreak: "message_end",
    },
  };
}

describe("followup queue observability", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("emits followup.enqueued and followup.drained for collect batches", async () => {
    const key = `test-followup-observe-${Date.now()}`;
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 20,
      dropPolicy: "summarize",
    };
    const events: Array<Record<string, unknown>> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });

    try {
      expect(enqueueFollowupRun(key, createRun("one", "m1"), settings)).toBe(true);
      expect(enqueueFollowupRun(key, createRun("two", "m2"), settings)).toBe(true);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("followup drain timed out")), 1000);
        scheduleFollowupDrain(key, async () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const eventTypes = events.map((event) => String(event.type));
      expect(eventTypes).toContain("followup.enqueued");
      expect(eventTypes).toContain("followup.drained");
      const drained = events.find((event) => event.type === "followup.drained");
      expect(drained?.drainedCount).toBe(2);
    } finally {
      stop();
      clearFollowupQueue(key);
    }
  });

  it("emits followup.dropped for duplicate and cap_new drops", () => {
    const duplicateKey = `test-followup-drop-dup-${Date.now()}`;
    const capKey = `test-followup-drop-cap-${Date.now()}`;
    const events: Array<Record<string, unknown>> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });

    try {
      const duplicateSettings: QueueSettings = {
        mode: "followup",
        debounceMs: 0,
        cap: 20,
        dropPolicy: "summarize",
      };
      const capSettings: QueueSettings = {
        mode: "followup",
        debounceMs: 0,
        cap: 1,
        dropPolicy: "new",
      };

      expect(enqueueFollowupRun(duplicateKey, createRun("hello", "same"), duplicateSettings)).toBe(
        true,
      );
      expect(
        enqueueFollowupRun(duplicateKey, createRun("hello again", "same"), duplicateSettings),
      ).toBe(false);

      expect(enqueueFollowupRun(capKey, createRun("first", "c1"), capSettings)).toBe(true);
      expect(enqueueFollowupRun(capKey, createRun("second", "c2"), capSettings)).toBe(false);

      const droppedReasons = events
        .filter((event) => event.type === "followup.dropped")
        .map((event) => String(event.reason));
      expect(droppedReasons).toContain("duplicate");
      expect(droppedReasons).toContain("cap_new");
    } finally {
      stop();
      clearFollowupQueue(duplicateKey);
      clearFollowupQueue(capKey);
    }
  });
});
