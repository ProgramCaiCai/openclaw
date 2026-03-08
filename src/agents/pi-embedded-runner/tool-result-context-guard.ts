import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
  getToolResultText,
  invalidateMessageCharsCacheEntry,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";

// Keep a conservative input budget to absorb tokenizer variance and provider framing overhead.
const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
const CONTEXT_LIMIT_TRUNCATION_SUFFIX = `\n${CONTEXT_LIMIT_TRUNCATION_NOTICE}`;
const CONTEXT_NOTICE_PREFIX = "[context:";
const READ_RECOVERY_HINT = "Use read with offset/limit for specific ranges.";
const EXEC_RECOVERY_HINT =
  "For shell output, rerun narrower commands with grep/jq/awk/head/tail to extract specific sections.";
const GENERIC_RECOVERY_HINT = "Rerun with narrower params or request specific sections.";

export const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[compacted: tool output removed to free context]";

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

type ToolResultMeta = {
  toolName?: string;
  toolCallId?: string;
};

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shortenContextToken(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  const head = Math.max(1, Math.floor((maxChars - 3) / 2));
  const tail = Math.max(1, maxChars - 3 - head);
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function getToolResultMeta(msg: AgentMessage): ToolResultMeta {
  const record = msg as {
    toolName?: unknown;
    tool_name?: unknown;
    toolCallId?: unknown;
    tool_call_id?: unknown;
  };
  const toolNameRaw = asTrimmedString(record.toolName) ?? asTrimmedString(record.tool_name);
  const toolCallIdRaw = asTrimmedString(record.toolCallId) ?? asTrimmedString(record.tool_call_id);
  return {
    toolName: toolNameRaw ? shortenContextToken(toolNameRaw.replace(/\s+/g, " "), 32) : undefined,
    toolCallId: toolCallIdRaw
      ? shortenContextToken(toolCallIdRaw.replace(/\s+/g, " "), 24)
      : undefined,
  };
}

function resolveRecoveryHint(toolName?: string): string {
  const normalized = toolName?.trim().toLowerCase();
  if (normalized === "read") {
    return READ_RECOVERY_HINT;
  }
  if (normalized === "exec" || normalized === "bash") {
    return EXEC_RECOVERY_HINT;
  }
  return GENERIC_RECOVERY_HINT;
}

function formatContextDetailLine(params: { msg: AgentMessage; detailParts: string[] }): string {
  const meta = getToolResultMeta(params.msg);
  const parts = [...params.detailParts];
  if (meta.toolName) {
    parts.unshift(`tool=${meta.toolName}`);
  }
  if (meta.toolCallId) {
    parts.unshift(`call=${meta.toolCallId}`);
  }
  const details = parts.filter((part) => part.length > 0).join("; ");
  const hint = resolveRecoveryHint(meta.toolName);
  const body = details ? `${details}. ${hint}` : hint;
  return `${CONTEXT_NOTICE_PREFIX} ${body}]`;
}

function buildContextLimitNotice(params: {
  msg: AgentMessage;
  originalChars: number;
  maxChars: number;
}): string {
  const detailLine = formatContextDetailLine({
    msg: params.msg,
    detailParts: [
      `original~${Math.max(0, Math.floor(params.originalChars))} chars`,
      `limit~${Math.max(0, Math.floor(params.maxChars))} chars`,
    ],
  });
  return `${CONTEXT_LIMIT_TRUNCATION_NOTICE}\n${detailLine}`;
}

function buildCompactionNotice(params: {
  msg: AgentMessage;
  removedChars: number;
  maxCharsHint: number;
}): string {
  const detailLine = formatContextDetailLine({
    msg: params.msg,
    detailParts: [`removed~${Math.max(0, Math.floor(params.removedChars))} chars`],
  });
  const detailed = `${PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER}\n${detailLine}`;
  if (detailed.length >= params.maxCharsHint) {
    return PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER;
  }
  return detailed;
}

function truncateTextToBudget(
  text: string,
  maxChars: number,
  suffix = CONTEXT_LIMIT_TRUNCATION_SUFFIX,
): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 0) {
    return CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  const normalizedSuffix = suffix || CONTEXT_LIMIT_TRUNCATION_SUFFIX;
  const bodyBudget = Math.max(0, maxChars - normalizedSuffix.length);
  if (bodyBudget <= 0) {
    return normalizedSuffix.length <= maxChars ? normalizedSuffix : CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  let cutPoint = bodyBudget;
  const newline = text.lastIndexOf("\n", bodyBudget);
  if (newline > bodyBudget * 0.7) {
    cutPoint = newline;
  }

  return text.slice(0, cutPoint) + normalizedSuffix;
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const replacementContent =
    typeof content === "string" || content === undefined ? text : [{ type: "text", text }];

  const sourceRecord = msg as unknown as Record<string, unknown>;
  const { details: _details, ...rest } = sourceRecord;
  return {
    ...rest,
    content: replacementContent,
  } as AgentMessage;
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) {
    return msg;
  }

  const estimatedChars = estimateMessageCharsCached(msg, cache);
  if (estimatedChars <= maxChars) {
    return msg;
  }

  const contextNotice = buildContextLimitNotice({
    msg,
    originalChars: estimatedChars,
    maxChars,
  });
  const rawText = getToolResultText(msg);
  if (!rawText) {
    return replaceToolResultText(msg, contextNotice);
  }

  const truncatedText = truncateTextToBudget(rawText, maxChars, `\n${contextNotice}`);
  return replaceToolResultText(msg, truncatedText);
}

function compactExistingToolResultsInPlace(params: {
  messages: AgentMessage[];
  charsNeeded: number;
  cache: MessageCharEstimateCache;
}): number {
  const { messages, charsNeeded, cache } = params;
  if (charsNeeded <= 0) {
    return 0;
  }

  let reduced = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) {
      continue;
    }

    const before = estimateMessageCharsCached(msg, cache);
    if (before <= PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER.length) {
      continue;
    }

    const compacted = replaceToolResultText(
      msg,
      buildCompactionNotice({
        msg,
        removedChars: before,
        maxCharsHint: before,
      }),
    );
    applyMessageMutationInPlace(msg, compacted, cache);
    const after = estimateMessageCharsCached(msg, cache);
    if (after >= before) {
      continue;
    }

    reduced += before - after;
    if (reduced >= charsNeeded) {
      break;
    }
  }

  return reduced;
}

function applyMessageMutationInPlace(
  target: AgentMessage,
  source: AgentMessage,
  cache?: MessageCharEstimateCache,
): void {
  if (target === source) {
    return;
  }

  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) {
      delete targetRecord[key];
    }
  }
  Object.assign(targetRecord, sourceRecord);
  if (cache) {
    invalidateMessageCharsCacheEntry(cache, target);
  }
}

function enforceToolResultContextBudgetInPlace(params: {
  messages: AgentMessage[];
  contextBudgetChars: number;
  maxSingleToolResultChars: number;
}): void {
  const { messages, contextBudgetChars, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();

  // Ensure each tool result has an upper bound before considering total context usage.
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    applyMessageMutationInPlace(message, truncated, estimateCache);
  }

  let currentChars = estimateContextChars(messages, estimateCache);
  if (currentChars <= contextBudgetChars) {
    return;
  }

  // Compact oldest tool outputs first until the context is back under budget.
  compactExistingToolResultsInPlace({
    messages,
    charsNeeded: currentChars - contextBudgetChars,
    cache: estimateCache,
  });
}

export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
}): () => void {
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const contextBudgetChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_INPUT_HEADROOM_RATIO),
  );
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(
      contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE,
    ),
  );

  // Agent.transformContext is private in pi-coding-agent, so access it via a
  // narrow runtime view to keep callsites type-safe while preserving behavior.
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const contextMessages = Array.isArray(transformed) ? transformed : messages;
    enforceToolResultContextBudgetInPlace({
      messages: contextMessages,
      contextBudgetChars,
      maxSingleToolResultChars,
    });

    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
