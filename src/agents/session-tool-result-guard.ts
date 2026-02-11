import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import {
  hardTruncateText,
  TOOL_OUTPUT_HARD_MAX_BYTES,
  TOOL_OUTPUT_HARD_MAX_LINES,
} from "./tool-output-hard-cap.js";

type ToolCall = { id: string; name?: string };

const GUARD_TRUNCATION_SUFFIX =
  "⚠️ [Content truncated during persistence - exceeded hard limit (50KB / 2000 lines). " +
  "Use offset/limit parameters or request specific sections for large content.]";

/**
 * Apply the system toolResult hard-cap policy before persisting to a session transcript.
 * Returns the original message reference when no changes are needed.
 */
function hardCapToolResultMessageForPersistence(msg: AgentMessage): AgentMessage {
  const role = (msg as { role?: string }).role;
  if (role !== "toolResult") {
    return msg;
  }

  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  // Flatten text blocks so we can enforce a strict global cap (bytes + lines).
  // If we need to cap, we also drop non-text blocks to avoid persisting large
  // binary payloads (e.g. base64 images) into the session context.
  let combined = "";
  let nonTextBlocks = 0;
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      nonTextBlocks += 1;
      continue;
    }
    const text = (block as TextContent).text;
    if (typeof text !== "string" || !text) {
      continue;
    }
    combined = combined ? `${combined}\n${text}` : text;
  }

  if (!combined) {
    return msg;
  }

  let forceTextOnly = nonTextBlocks > 0;
  if (!forceTextOnly) {
    try {
      const bytes = Buffer.byteLength(JSON.stringify(msg), "utf8");
      forceTextOnly = bytes > TOOL_OUTPUT_HARD_MAX_BYTES;
    } catch {
      forceTextOnly = true;
    }
  }

  const prefix = forceTextOnly
    ? `${combined}\n⚠️ [Tool result normalized during persistence to enforce output caps.]`
    : combined;

  const capped = hardTruncateText(prefix, {
    maxBytes: TOOL_OUTPUT_HARD_MAX_BYTES,
    maxLines: TOOL_OUTPUT_HARD_MAX_LINES,
    suffix: GUARD_TRUNCATION_SUFFIX,
  });

  if (!forceTextOnly && !capped.truncated) {
    return msg;
  }

  return {
    ...msg,
    content: [{ type: "text", text: capped.text }],
  } as AgentMessage;
}

function extractAssistantToolCalls(msg: Extract<AgentMessage, { role: "assistant" }>): ToolCall[] {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) {
      continue;
    }
    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(msg: Extract<AgentMessage, { role: "toolResult" }>): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) {
    return toolCallId;
  }
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) {
    return toolUseId;
  }
  return null;
}

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
  },
): {
  flushPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;

  const flushPendingToolResults = () => {
    if (pending.size === 0) {
      return;
    }
    if (allowSyntheticToolResults) {
      for (const [id, name] of pending.entries()) {
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        const transformed = persistToolResult(synthetic, {
          toolCallId: id,
          toolName: name,
          isSynthetic: true,
        });
        // Apply the hard cap *after* any hook transforms so plugins can't re-inflate tool results.
        const capped = hardCapToolResultMessageForPersistence(transformed);
        originalAppend(capped as never);
      }
    }
    pending.clear();
  };

  const guardedAppend = (message: AgentMessage) => {
    let nextMessage = message;
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message]);
      if (sanitized.length === 0) {
        if (allowSyntheticToolResults && pending.size > 0) {
          flushPendingToolResults();
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = (nextMessage as { role?: unknown }).role;

    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pending.get(id) : undefined;
      if (id) {
        pending.delete(id);
      }
      // Apply the hard cap before + after hook transforms so persisted tool results
      // always conform to the system limits.
      const preCapped = hardCapToolResultMessageForPersistence(nextMessage);
      const transformed = persistToolResult(preCapped, {
        toolCallId: id ?? undefined,
        toolName,
        isSynthetic: false,
      });
      const postCapped = hardCapToolResultMessageForPersistence(transformed);
      return originalAppend(postCapped as never);
    }

    const toolCalls =
      nextRole === "assistant"
        ? extractAssistantToolCalls(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    if (allowSyntheticToolResults) {
      // If previous tool calls are still pending, flush before non-tool results.
      if (pending.size > 0 && (toolCalls.length === 0 || nextRole !== "assistant")) {
        flushPendingToolResults();
      }
      // If new tool calls arrive while older ones are pending, flush the old ones first.
      if (pending.size > 0 && toolCalls.length > 0) {
        flushPendingToolResults();
      }
    }

    const result = originalAppend(nextMessage as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        pending.set(call.id, call.name);
      }
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
  };
}
