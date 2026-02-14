import { describe, expect, it } from "vitest";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionUpdate,
} from "./pi-embedded-subscribe.handlers.tools.js";
import { TOOL_OUTPUT_HARD_MAX_BYTES, TOOL_OUTPUT_HARD_MAX_LINES } from "./tool-output-hard-cap.js";

const makeCtx = () =>
  ({
    params: {
      runId: "run_1",
    },
    state: {
      toolMetaById: new Map<string, string | undefined>(),
      toolMetas: [] as Array<{ toolName: string; meta?: string }>,
      toolSummaryById: new Set<string>(),
      lastToolError: undefined as unknown,
      pendingMessagingTexts: new Map<string, string>(),
      pendingMessagingTargets: new Map<string, unknown>(),
      messagingToolSentTexts: [] as string[],
      messagingToolSentTextsNormalized: [] as string[],
      messagingToolSentTargets: [] as unknown[],
    },
    trimMessagingToolSent: () => {},
    log: {
      debug: () => {},
      warn: () => {},
    },
  }) satisfies Record<string, unknown>;

function findToolEvent(events: AgentEventPayload[], phase: string, toolCallId: string) {
  return events.find((evt) => {
    if (evt.stream !== "tool") {
      return false;
    }
    const evtPhase = typeof evt.data?.phase === "string" ? evt.data.phase : null;
    const evtToolCallId = typeof evt.data?.toolCallId === "string" ? evt.data.toolCallId : null;
    return evtPhase === phase && evtToolCallId === toolCallId;
  });
}

function extractFirstTextBlock(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const content = (payload as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      return rec.text;
    }
  }
  return null;
}

describe("tool output hard caps", () => {
  it("caps partialResult text by line count before emitting agent events", () => {
    const events: AgentEventPayload[] = [];
    const stop = onAgentEvent((evt) => events.push(evt));

    const ctx = makeCtx();
    handleToolExecutionUpdate(
      ctx as unknown as Parameters<typeof handleToolExecutionUpdate>[0],
      {
        toolName: "exec",
        toolCallId: "call_1",
        partialResult: {
          content: [{ type: "text", text: "\n".repeat(3000) }],
        },
      } as unknown as Parameters<typeof handleToolExecutionUpdate>[1],
    );

    stop();

    const updateEvt = findToolEvent(events, "update", "call_1");
    expect(updateEvt).toBeTruthy();

    const partial = updateEvt?.data.partialResult;
    const text = extractFirstTextBlock(partial);
    expect(typeof text).toBe("string");
    expect((text ?? "").split(/\r?\n/).length).toBeLessThanOrEqual(TOOL_OUTPUT_HARD_MAX_LINES);
    expect(text).toContain("truncated");
  });

  it("caps oversized tool result objects before emitting agent events", () => {
    const events: AgentEventPayload[] = [];
    const stop = onAgentEvent((evt) => events.push(evt));

    const ctx = makeCtx();
    (ctx.state as { toolMetaById: Map<string, string | undefined> }).toolMetaById.set(
      "call_2",
      "meta",
    );

    void handleToolExecutionEnd(
      ctx as unknown as Parameters<typeof handleToolExecutionEnd>[0],
      {
        toolName: "exec",
        toolCallId: "call_2",
        isError: true,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: {
            aggregated: "x".repeat(200_000),
            stderr: "y".repeat(200_000),
          },
        },
      } as unknown as Parameters<typeof handleToolExecutionEnd>[1],
    );

    stop();

    const resultEvt = findToolEvent(events, "result", "call_2");
    expect(resultEvt).toBeTruthy();

    const result = resultEvt?.data.result;
    const payloadBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(payloadBytes).toBeLessThanOrEqual(TOOL_OUTPUT_HARD_MAX_BYTES);
  });
});
