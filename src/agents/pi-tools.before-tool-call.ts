import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  loopDetection?: ToolLoopDetectionConfig;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;
const SUBAGENT_READ_DEFAULT_LIMIT = 200;
const SUBAGENT_READ_DEFAULT_OFFSET = 1;

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

function emitToolLoopAction(params: {
  level: "warning" | "critical";
  action: "warn" | "block";
  detector: "generic_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
  count: number;
  toolName: string;
  message: string;
  sessionKey?: string;
  sessionId?: string;
  pairedToolName?: string;
}) {
  emitDiagnosticEvent({
    type: "tool.loop",
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    level: params.level,
    action: params.action,
    detector: params.detector,
    count: params.count,
    toolName: params.toolName,
    pairedToolName: params.pairedToolName,
    message: params.message,
  });
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState } = await import("../logging/diagnostic-session-state.js");
    const { recordToolCallOutcome } = await import("./tool-loop-detection.js");
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx.agentId,
    });
    recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
    });
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
}

function applySubagentContextGuards(args: {
  toolName: string;
  params: unknown;
  sessionKey?: string;
}): unknown {
  if (!isSubagentSessionKey(args.sessionKey)) {
    return args.params;
  }
  if (!isPlainObject(args.params)) {
    return args.params;
  }

  const nextParams: Record<string, unknown> = { ...args.params };
  let changed = false;

  if (args.toolName === "exec") {
    // Treat undefined/null as missing so partial merges cannot accidentally disable the guard.
    if (nextParams.excludeFromContext == null) {
      nextParams.excludeFromContext = true;
      changed = true;
    }
  }

  if (args.toolName === "read" && nextParams.excludeFromContext !== true) {
    const limit = nextParams.limit;
    if (!(typeof limit === "number" && Number.isFinite(limit) && limit > 0)) {
      nextParams.limit = SUBAGENT_READ_DEFAULT_LIMIT;
      changed = true;
    }
    const offset = nextParams.offset;
    if (!(typeof offset === "number" && Number.isFinite(offset) && offset > 0)) {
      nextParams.offset = SUBAGENT_READ_DEFAULT_OFFSET;
      changed = true;
    }
  }

  return changed ? nextParams : args.params;
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;
  const guardedParams = applySubagentContextGuards({
    toolName,
    params,
    sessionKey: args.ctx?.sessionKey,
  });

  if (args.ctx?.sessionKey) {
    try {
      const { getDiagnosticSessionState } = await import("../logging/diagnostic-session-state.js");
      const { detectToolCallLoop, recordToolCall } = await import("./tool-loop-detection.js");
      const sessionState = getDiagnosticSessionState({
        sessionKey: args.ctx.sessionKey,
        sessionId: args.ctx.agentId,
      });

      const loopResult = detectToolCallLoop(
        sessionState,
        toolName,
        guardedParams,
        args.ctx.loopDetection,
      );
      if (loopResult.stuck) {
        if (loopResult.level === "critical") {
          log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
          emitToolLoopAction({
            sessionKey: args.ctx.sessionKey,
            sessionId: args.ctx.agentId,
            level: "critical",
            action: "block",
            detector: loopResult.detector,
            count: loopResult.count,
            toolName,
            message: loopResult.message,
            pairedToolName: loopResult.pairedToolName,
          });
          return {
            blocked: true,
            reason: loopResult.message,
          };
        }
        const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
        if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
          log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
          emitToolLoopAction({
            sessionKey: args.ctx.sessionKey,
            sessionId: args.ctx.agentId,
            level: "warning",
            action: "warn",
            detector: loopResult.detector,
            count: loopResult.count,
            toolName,
            message: loopResult.message,
            pairedToolName: loopResult.pairedToolName,
          });
        }
      }

      recordToolCall(
        sessionState,
        toolName,
        guardedParams,
        args.toolCallId,
        args.ctx.loopDetection,
      );
    } catch (err) {
      log.warn(`tool loop detection failed: tool=${toolName} error=${String(err)}`);
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: guardedParams };
  }

  try {
    const normalizedParams = isPlainObject(guardedParams) ? guardedParams : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
      },
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      const mergedParams = isPlainObject(guardedParams)
        ? { ...guardedParams, ...hookResult.params }
        : hookResult.params;
      return {
        blocked: false,
        params: applySubagentContextGuards({
          toolName,
          params: mergedParams,
          sessionKey: args.ctx?.sessionKey,
        }),
      };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params: guardedParams };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        adjustedParamsByToolCallId.set(toolCallId, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        return result;
      } catch (err) {
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
        throw err;
      }
    },
  };
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: false,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string): unknown {
  const params = adjustedParamsByToolCallId.get(toolCallId);
  adjustedParamsByToolCallId.delete(toolCallId);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  isPlainObject,
};
