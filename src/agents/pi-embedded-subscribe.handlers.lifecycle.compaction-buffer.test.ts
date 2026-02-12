import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pi-embedded-runner/runs.js", () => ({
  drainCompactionBuffer: vi.fn(),
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

import { drainCompactionBuffer } from "./pi-embedded-runner/runs.js";
import { handleAutoCompactionEnd } from "./pi-embedded-subscribe.handlers.lifecycle.js";

describe("handleAutoCompactionEnd compaction buffer drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drains buffered messages using the AgentSession sessionId", () => {
    const sessionId = "test-session";

    const ctx = {
      params: {
        runId: "run-1",
        session: { sessionId },
      },
      state: {
        compactionInFlight: true,
      },
      noteCompactionRetry: vi.fn(),
      resetForCompactionRetry: vi.fn(),
      maybeResolveCompactionWait: vi.fn(),
      log: { debug: vi.fn(), warn: vi.fn() },
    } as any;

    handleAutoCompactionEnd(ctx, { type: "auto_compaction_end" } as any);

    expect(drainCompactionBuffer).toHaveBeenCalledTimes(1);
    expect(drainCompactionBuffer).toHaveBeenCalledWith(sessionId);
  });

  it("does not drain when compaction will retry", () => {
    const sessionId = "test-session";

    const ctx = {
      params: {
        runId: "run-1",
        session: { sessionId },
      },
      state: {
        compactionInFlight: true,
      },
      noteCompactionRetry: vi.fn(),
      resetForCompactionRetry: vi.fn(),
      maybeResolveCompactionWait: vi.fn(),
      log: { debug: vi.fn(), warn: vi.fn() },
    } as any;

    handleAutoCompactionEnd(ctx, { type: "auto_compaction_end", willRetry: true } as any);

    expect(drainCompactionBuffer).not.toHaveBeenCalled();
  });
});
