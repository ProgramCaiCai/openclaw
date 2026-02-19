import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const queueEmbeddedPiMessageMock = vi.fn();
const isEmbeddedPiRunActiveMock = vi.fn();
const enqueueFollowupRunDetailedMock = vi.fn();
const runAgentTurnWithFallbackMock = vi.fn();

vi.mock("../../agents/pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/pi-embedded.js")>(
    "../../agents/pi-embedded.js",
  );
  return {
    ...actual,
    isEmbeddedPiRunActive: (...args: unknown[]) => isEmbeddedPiRunActiveMock(...args),
    queueEmbeddedPiMessage: (...args: unknown[]) => queueEmbeddedPiMessageMock(...args),
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRunDetailed: (...args: unknown[]) => enqueueFollowupRunDetailedMock(...args),
  };
});

vi.mock("./agent-runner-execution.js", () => ({
  runAgentTurnWithFallback: (...args: unknown[]) => runAgentTurnWithFallbackMock(...args),
}));

import { runReplyAgent } from "./agent-runner.js";

function buildRunReplyParams() {
  const followupRun = {
    prompt: "please continue",
    summaryLine: "continue",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session-steer",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude-sonnet",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 5_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;

  const resolvedQueue = { mode: "steer" } as QueueSettings;
  const sessionCtx = {
    Provider: "whatsapp",
    OriginatingTo: "+1555000",
    AccountId: "primary",
    Surface: "whatsapp",
  } as unknown as TemplateContext;
  const typing = createMockTypingController();

  return {
    commandBody: "please continue",
    followupRun,
    queueKey: "agent:main:main",
    resolvedQueue,
    shouldSteer: true,
    shouldFollowup: false,
    isActive: true,
    isStreaming: true,
    typing,
    defaultModel: "anthropic/claude-sonnet-4-5",
    resolvedVerboseLevel: "off" as const,
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end" as const,
    sessionCtx,
    shouldInjectGroupIntro: false,
    typingMode: "instant" as const,
  };
}

describe("runReplyAgent steer fallback", () => {
  beforeEach(() => {
    queueEmbeddedPiMessageMock.mockReset().mockReturnValue(false);
    isEmbeddedPiRunActiveMock.mockReset().mockReturnValue(true);
    enqueueFollowupRunDetailedMock.mockReset().mockReturnValue({
      accepted: true,
      queueDepth: 1,
      mode: "steer",
      droppedCount: 0,
    });
    runAgentTurnWithFallbackMock
      .mockReset()
      .mockResolvedValue({ kind: "final", payload: undefined });
  });

  it("falls back to followup enqueue when steer is rejected in active steer mode", async () => {
    queueEmbeddedPiMessageMock.mockResolvedValueOnce(false);
    const params = buildRunReplyParams();

    const result = await runReplyAgent(params);

    expect(result).toBeUndefined();
    expect(queueEmbeddedPiMessageMock).toHaveBeenCalledWith(
      params.followupRun.run.sessionId,
      params.followupRun.prompt,
    );
    expect(enqueueFollowupRunDetailedMock).toHaveBeenCalledWith(
      params.queueKey,
      params.followupRun,
      params.resolvedQueue,
    );
    expect(params.typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("reports rejected followup enqueue attempts", async () => {
    queueEmbeddedPiMessageMock.mockResolvedValueOnce(false);
    enqueueFollowupRunDetailedMock.mockReturnValueOnce({
      accepted: false,
      queueDepth: 20,
      mode: "steer",
      droppedCount: 1,
      rejectedReason: "cap_new",
    });
    const onDeferredDispatch = vi.fn();
    const params = {
      ...buildRunReplyParams(),
      opts: { onDeferredDispatch },
    };

    const result = await runReplyAgent(params);

    expect(result).toBeUndefined();
    expect(onDeferredDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "followup",
        accepted: false,
        reason: "cap_new",
      }),
    );
    expect(params.typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs directly when steer rejects after the active run already ended", async () => {
    queueEmbeddedPiMessageMock.mockResolvedValueOnce(false);
    isEmbeddedPiRunActiveMock.mockReturnValueOnce(false);
    const params = buildRunReplyParams();

    const result = await runReplyAgent(params);

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunDetailedMock).not.toHaveBeenCalled();
    expect(runAgentTurnWithFallbackMock).toHaveBeenCalledTimes(1);
  });

  it("waits for steer confirmation before deciding fallback path", async () => {
    let resolveSteer: ((accepted: boolean) => void) | undefined;
    queueEmbeddedPiMessageMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSteer = resolve;
        }),
    );
    const params = buildRunReplyParams();

    const resultPromise = runReplyAgent(params);
    await Promise.resolve();

    expect(enqueueFollowupRunDetailedMock).not.toHaveBeenCalled();

    resolveSteer?.(false);
    await resultPromise;

    expect(enqueueFollowupRunDetailedMock).toHaveBeenCalledWith(
      params.queueKey,
      params.followupRun,
      params.resolvedQueue,
    );
  });
});
