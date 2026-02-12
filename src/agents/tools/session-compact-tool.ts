import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { requestSessionCompaction } from "../pi-embedded-runner/runs.js";

const SessionCompactToolSchema = Type.Object({
  instructions: Type.Optional(
    Type.String({
      description:
        "Optional instructions for the compaction summary (e.g. what to preserve or emphasize).",
    }),
  ),
});

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
      const sessionKey = opts?.agentSessionKey?.trim();
      if (!sessionKey) {
        throw new Error("session_compact requires a session key (not available in this context).");
      }

      const instructions =
        typeof params.instructions === "string" ? params.instructions.trim() : undefined;

      // Set the flag; run.ts will pick it up after this attempt ends.
      requestSessionCompaction(sessionKey);

      const msg = instructions
        ? `Compaction scheduled (will run after this turn). Instructions noted: "${instructions}"`
        : "Compaction scheduled (will run after this turn).";

      return {
        content: [{ type: "text", text: msg }],
        details: {
          ok: true,
          scheduled: true,
          instructions: instructions ?? null,
        },
      };
    },
  };
}
