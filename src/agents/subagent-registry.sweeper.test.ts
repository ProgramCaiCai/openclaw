import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.js";

const noop = () => {};
const persistedRuns = new Map<string, SubagentRunRecord>();

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: { method?: string }) => {
    if (req?.method === "agent.wait") {
      // Keep the run non-terminal so the sweeper guard is the only gate.
      return { status: "running" };
    }
    return { ok: true };
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => noop),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
  })),
}));

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
  buildSubagentSystemPrompt: vi.fn(() => "test prompt"),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map(persistedRuns)),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry sweeper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    persistedRuns.clear();
  });

  afterEach(async () => {
    const mod = await import("./subagent-registry.js");
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
    vi.clearAllMocks();
    persistedRuns.clear();
  });

  it("clears stale archiveAtMs on active runs during restore", async () => {
    const now = Date.now();
    persistedRuns.set("run-stale", {
      runId: "run-stale",
      childSessionKey: "agent:main:subagent:stale-archive",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "4h closure",
      cleanup: "keep",
      runTimeoutSeconds: 14400,
      createdAt: now - 3_600_000,
      startedAt: now - 3_600_000,
      archiveAtMs: now - 5_000, // stale: set by old code at spawn time
      cleanupHandled: false,
    });

    const mod = await import("./subagent-registry.js");
    mod.initSubagentRegistry();

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    const entry = runs.find((e) => e.runId === "run-stale");
    expect(entry).toBeDefined();
    expect(entry!.archiveAtMs).toBeUndefined();
  });

  it("does not archive a 4h long-run at the 60-minute mark", async () => {
    const mod = await import("./subagent-registry.js");
    const { callGateway } = await import("../gateway/call.js");

    mod.registerSubagentRun({
      runId: "run-4h",
      childSessionKey: "agent:main:subagent:closure-4h",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "4h closure sync",
      cleanup: "keep",
      runTimeoutSeconds: 14400,
    });

    // Advance past the 60-minute archiveAfterMinutes default window.
    await vi.advanceTimersByTimeAsync(61 * 60_000);

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs.some((e) => e.runId === "run-4h")).toBe(true);
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
  });

  it("does not archive a running run even when archiveAtMs is in the past", async () => {
    const now = Date.now();
    persistedRuns.set("run-active", {
      runId: "run-active",
      childSessionKey: "agent:main:subagent:still-running",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "long running sync",
      cleanup: "keep",
      createdAt: now - 70_000,
      startedAt: now - 65_000,
      archiveAtMs: now - 5_000,
      cleanupHandled: false,
    });

    const mod = await import("./subagent-registry.js");
    const { callGateway } = await import("../gateway/call.js");

    mod.initSubagentRegistry();
    await vi.advanceTimersByTimeAsync(61_000);

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs.some((entry) => entry.runId === "run-active")).toBe(true);
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
  });
});
