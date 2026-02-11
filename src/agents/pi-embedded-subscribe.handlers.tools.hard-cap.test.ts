import { describe, expect, it } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
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
  }) as any;

describe("tool output hard caps", () => {
  it("caps partialResult text by line count before emitting agent events", () => {
    const events: any[] = [];
    const stop = onAgentEvent((evt) => events.push(evt));

    const ctx = makeCtx();
    handleToolExecutionUpdate(ctx, {
      toolName: "exec",
      toolCallId: "call_1",
      partialResult: {
        content: [{ type: "text", text: "\n".repeat(3000) }],
      },
    } as any);

    stop();

    const updateEvt = events.find(
      (e) => e.stream === "tool" && e.data?.phase === "update" && e.data?.toolCallId === "call_1",
    );
    expect(updateEvt).toBeTruthy();

    const capped = updateEvt.data.partialResult as any;
    const text = capped?.content?.[0]?.text as string;
    expect(typeof text).toBe("string");
    expect(text.split(/\r?\n/).length).toBeLessThanOrEqual(TOOL_OUTPUT_HARD_MAX_LINES);
    expect(text).toContain("truncated");
  });

  it("caps oversized tool result objects before emitting agent events", () => {
    const events: any[] = [];
    const stop = onAgentEvent((evt) => events.push(evt));

    const ctx = makeCtx();
    ctx.state.toolMetaById.set("call_2", "meta");

    handleToolExecutionEnd(ctx, {
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
    } as any);

    stop();

    const resultEvt = events.find(
      (e) => e.stream === "tool" && e.data?.phase === "result" && e.data?.toolCallId === "call_2",
    );
    expect(resultEvt).toBeTruthy();

    const payloadBytes = Buffer.byteLength(JSON.stringify(resultEvt.data.result), "utf8");
    expect(payloadBytes).toBeLessThanOrEqual(TOOL_OUTPUT_HARD_MAX_BYTES);
  });
});
