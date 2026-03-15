import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  pickLastNonEmptyTextFromPayloadsMock,
  pickSummaryFromOutputMock,
  pickSummaryFromPayloadsMock,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — empty deliverable", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("returns an error when announce delivery is requested but no deliverable payload exists", async () => {
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
    pickSummaryFromPayloadsMock.mockReturnValue(undefined);
    pickSummaryFromOutputMock.mockReturnValue(undefined);
    pickLastNonEmptyTextFromPayloadsMock.mockReturnValue(undefined);
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toContain("no deliverable payload");
  });
});
