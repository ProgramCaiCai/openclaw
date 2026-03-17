import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type DeliverablePayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  channelData?: Record<string, unknown>;
};

export function hasDeliverablePayload(payloads: DeliverablePayload[] | undefined): boolean {
  return (
    payloads?.some(
      (payload) =>
        Boolean(payload.text?.trim()) ||
        Boolean(payload.mediaUrl?.trim()) ||
        (payload.mediaUrls?.length ?? 0) > 0 ||
        Object.keys(payload.channelData ?? {}).length > 0,
    ) ?? false
  );
}

export function isEmptyAssistantMessageContent(
  message: Extract<AgentMessage, { role: "assistant" }>,
): boolean {
  const content = message.content;
  if (content == null) {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.every((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text") {
      return false;
    }
    return typeof record.text !== "string" || record.text.trim().length === 0;
  });
}

export function isInvalidEmptyAssistantShell(
  message: Extract<AgentMessage, { role: "assistant" }> | undefined,
): boolean {
  if (!message || message.stopReason === "error") {
    return false;
  }
  return isEmptyAssistantMessageContent(message);
}

export function hasMessagingToolDeliveryEvidence(params: {
  didSendViaMessagingTool?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: Array<Record<string, unknown>>;
}): boolean {
  return (
    params.didSendViaMessagingTool === true ||
    (params.messagingToolSentTexts?.length ?? 0) > 0 ||
    (params.messagingToolSentMediaUrls?.length ?? 0) > 0 ||
    (params.messagingToolSentTargets?.length ?? 0) > 0
  );
}

export function shouldRetryEmptyAssistantShell(params: {
  lastAssistant: Extract<AgentMessage, { role: "assistant" }> | undefined;
  payloads: DeliverablePayload[] | undefined;
  didSendViaMessagingTool?: boolean;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: Array<Record<string, unknown>>;
  hasEmbeddedError?: boolean;
}): boolean {
  if (
    params.hasEmbeddedError ||
    hasMessagingToolDeliveryEvidence(params) ||
    hasDeliverablePayload(params.payloads)
  ) {
    return false;
  }
  return isInvalidEmptyAssistantShell(params.lastAssistant);
}

export function formatEmptyAssistantRetryLog(params: {
  retryAttempt: number;
  maxSilentRetries: number;
  restoredBaseline: boolean;
  reason?: string;
}): string {
  const strategy = params.restoredBaseline
    ? "replaying the original prompt from the restored pre-turn baseline"
    : `falling back to literal continue${params.reason ? ` (${params.reason})` : ""}`;
  return `Assistant run ended with no deliverable payload. Retrying ${params.retryAttempt}/${params.maxSilentRetries} in 2500ms, ${strategy}.`;
}

export function formatEmptyAssistantRetryLimitUserMessage(maxSilentRetries: number): string {
  return `⚠️ Automatic retry failed ${maxSilentRetries} times because the assistant run kept producing no deliverable payload. Please try again later or switch to another model/provider.`;
}

export function buildNoDeliverablePayloadErrorMessage(context: string): string {
  return `${context} produced no deliverable payload.`;
}
