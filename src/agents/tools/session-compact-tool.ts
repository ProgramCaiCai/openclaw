import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { requestSessionCompaction } from "../pi-embedded-runner/runs.js";
import { describeUnknownError } from "../pi-embedded-runner/utils.js";

const SessionCompactToolSchema = Type.Object({
  instructions: Type.Optional(
    Type.String({
      description:
        "Optional instructions for the compaction summary (e.g. what to preserve or emphasize).",
    }),
  ),
});

type ToolRequestedCompaction = {
  instructions?: string;
  requestedAtMs: number;
};

function getToolRequestedCompactionStore(): Map<string, ToolRequestedCompaction> {
  // Keep the instructions in-process keyed by sessionKey so the scheduler (or future
  // compaction runner wiring) can apply them even though the current flag is boolean.
  const g = globalThis as unknown as { __openclawToolRequestedCompactions?: Map<string, ToolRequestedCompaction> };
  if (!g.__openclawToolRequestedCompactions) {
    g.__openclawToolRequestedCompactions = new Map();
  }
  return g.__openclawToolRequestedCompactions;
}

/**
 * Tool that lets the model request a context compaction mid-conversation.
 * The actual compaction runs after the current turn completes (post-attempt),
 * so the model gets a confirmation and the next turn starts with a smaller context.
 */
export function createSessionCompactTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Session Compact",
    name: "session_compact",
    description:
      "Request context compaction for the current session. " +
      "Compaction summarizes older conversation history to free up context window space. " +
      "Use when the context is getting large or when switching topics. " +
      "The compaction runs after the current turn completes.",
    parameters: SessionCompactToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = opts?.agentSessionKey?.trim() ?? "";

      const instructions =
        typeof params.instructions === "string" ? params.instructions.trim() : undefined;

      if (!sessionKey) {
        const msg = "Compaction not scheduled (no active session in this context).";
        return {
          content: [{ type: "text", text: msg }],
          details: {
            ok: false,
            status: "no-session",
            scheduled: false,
            instructions: instructions ?? null,
          },
        };
      }

      try {
        getToolRequestedCompactionStore().set(sessionKey, {
          instructions,
          requestedAtMs: Date.now(),
        });

        // Set the flag; run.ts will pick it up after this attempt ends.
        requestSessionCompaction(sessionKey);

        const msg = instructions
          ? `Compaction queued (will run after this turn).\nCompaction instructions: ${instructions}`
          : "Compaction queued (will run after this turn).";

        return {
          content: [{ type: "text", text: msg }],
          details: {
            ok: true,
            status: "queued",
            scheduled: true,
            instructions: instructions ?? null,
          },
        };
      } catch (err) {
        const reason = describeUnknownError(err).trim() || "Unknown error";
        const msg = `Compaction request failed: ${reason}`;
        return {
          content: [{ type: "text", text: msg }],
          details: {
            ok: false,
            status: "failed",
            scheduled: false,
            reason,
            instructions: instructions ?? null,
          },
        };
      }
    },
  };
}
