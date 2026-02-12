import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logging/diagnostic.js", () => ({
  diagnosticLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  logMessageQueued: vi.fn(),
  logSessionStateChange: vi.fn(),
}));

import {
  clearActiveEmbeddedRun,
  drainCompactionBuffer,
  getCompactionBufferSize,
  queueEmbeddedPiMessage,
  setActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
} from "./runs.js";

function createMockHandle(overrides?: Partial<EmbeddedPiQueueHandle>): EmbeddedPiQueueHandle {
  return {
    queueMessage: vi.fn().mockResolvedValue(undefined),
    isStreaming: vi.fn().mockReturnValue(true),
    isCompacting: vi.fn().mockReturnValue(false),
    abort: vi.fn(),
    ...overrides,
  };
}

describe("compaction message buffer", () => {
  const sessionId = "test-session";

  beforeEach(() => {
    // Clean up any leftover state
    const handle = createMockHandle();
    setActiveEmbeddedRun(sessionId, handle);
    clearActiveEmbeddedRun(sessionId, handle);
  });

  it("buffers messages during compaction instead of dropping them", () => {
    const handle = createMockHandle({ isCompacting: () => true });
    setActiveEmbeddedRun(sessionId, handle);

    const result = queueEmbeddedPiMessage(sessionId, "hello during compaction");

    expect(result).toBe(true);
    expect(handle.queueMessage).not.toHaveBeenCalled();
    expect(getCompactionBufferSize(sessionId)).toBe(1);

    clearActiveEmbeddedRun(sessionId, handle);
  });

  it("buffers multiple messages during compaction", () => {
    const handle = createMockHandle({ isCompacting: () => true });
    setActiveEmbeddedRun(sessionId, handle);

    queueEmbeddedPiMessage(sessionId, "msg1");
    queueEmbeddedPiMessage(sessionId, "msg2");
    queueEmbeddedPiMessage(sessionId, "msg3");

    expect(getCompactionBufferSize(sessionId)).toBe(3);

    clearActiveEmbeddedRun(sessionId, handle);
  });

  it("drains buffered messages after compaction ends", () => {
    let compacting = true;
    const handle = createMockHandle({ isCompacting: () => compacting });
    setActiveEmbeddedRun(sessionId, handle);

    queueEmbeddedPiMessage(sessionId, "msg1");
    queueEmbeddedPiMessage(sessionId, "msg2");

    // Simulate compaction ending
    compacting = false;
    drainCompactionBuffer(sessionId);

    expect(handle.queueMessage).toHaveBeenCalledTimes(2);
    expect(handle.queueMessage).toHaveBeenCalledWith("msg1");
    expect(handle.queueMessage).toHaveBeenCalledWith("msg2");
    expect(getCompactionBufferSize(sessionId)).toBe(0);

    clearActiveEmbeddedRun(sessionId, handle);
  });

  it("clears buffer when run ends (prevents memory leak)", () => {
    const handle = createMockHandle({ isCompacting: () => true });
    setActiveEmbeddedRun(sessionId, handle);

    queueEmbeddedPiMessage(sessionId, "msg1");
    expect(getCompactionBufferSize(sessionId)).toBe(1);

    clearActiveEmbeddedRun(sessionId, handle);
    expect(getCompactionBufferSize(sessionId)).toBe(0);
  });

  it("still rejects messages when no active run exists", () => {
    const result = queueEmbeddedPiMessage("nonexistent", "hello");
    expect(result).toBe(false);
  });

  it("still rejects messages when not streaming", () => {
    const handle = createMockHandle({ isStreaming: () => false });
    setActiveEmbeddedRun(sessionId, handle);

    const result = queueEmbeddedPiMessage(sessionId, "hello");
    expect(result).toBe(false);

    clearActiveEmbeddedRun(sessionId, handle);
  });

  it("queues normally when not compacting", () => {
    const handle = createMockHandle();
    setActiveEmbeddedRun(sessionId, handle);

    const result = queueEmbeddedPiMessage(sessionId, "hello");

    expect(result).toBe(true);
    expect(handle.queueMessage).toHaveBeenCalledWith("hello");
    expect(getCompactionBufferSize(sessionId)).toBe(0);

    clearActiveEmbeddedRun(sessionId, handle);
  });

  it("drain is a no-op when buffer is empty", () => {
    const handle = createMockHandle();
    setActiveEmbeddedRun(sessionId, handle);

    drainCompactionBuffer(sessionId);
    expect(handle.queueMessage).not.toHaveBeenCalled();

    clearActiveEmbeddedRun(sessionId, handle);
  });

  it("preserves buffer across compaction retries", () => {
    let compacting = true;
    const handle = createMockHandle({ isCompacting: () => compacting });
    setActiveEmbeddedRun(sessionId, handle);

    // First compaction attempt — user sends message
    queueEmbeddedPiMessage(sessionId, "msg during first attempt");

    // Compaction retries (compactionInFlight stays true during retry)
    // Buffer should persist
    expect(getCompactionBufferSize(sessionId)).toBe(1);

    // Second message during retry
    queueEmbeddedPiMessage(sessionId, "msg during retry");
    expect(getCompactionBufferSize(sessionId)).toBe(2);

    // Compaction finally succeeds
    compacting = false;
    drainCompactionBuffer(sessionId);

    expect(handle.queueMessage).toHaveBeenCalledTimes(2);
    expect(handle.queueMessage).toHaveBeenCalledWith("msg during first attempt");
    expect(handle.queueMessage).toHaveBeenCalledWith("msg during retry");

    clearActiveEmbeddedRun(sessionId, handle);
  });
});
