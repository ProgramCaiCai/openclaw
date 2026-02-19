import type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import { onDiagnosticEvent } from "../infra/diagnostic-events.js";
import type { AuditEventV1Input, AuditOutcome } from "./schema-v1.js";
import { appendAuditEvent } from "./writer.js";

let stopListener: (() => void) | null = null;

function mapOutcome(event: DiagnosticEventPayload): AuditOutcome {
  if (event.type === "webhook.error" || event.type === "session.stuck") {
    return "failure";
  }
  if (event.type === "message.processed") {
    if (event.outcome === "error") {
      return "failure";
    }
    if (event.outcome === "skipped") {
      return "skipped";
    }
    return "success";
  }
  return "success";
}

function mapAction(type: string): string {
  const parts = type.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : type;
}

function mapSubjectType(event: DiagnosticEventPayload): string {
  if (event.type.startsWith("webhook.")) {
    return "webhook";
  }
  if (event.type.startsWith("message.")) {
    return "message";
  }
  if (event.type.startsWith("session.")) {
    return "session";
  }
  if (event.type.startsWith("run.")) {
    return "run";
  }
  if (event.type.startsWith("queue.")) {
    return "queue";
  }
  if (event.type === "model.usage") {
    return "model";
  }
  return "event";
}

function mapSubjectId(event: DiagnosticEventPayload): string | undefined {
  if ("runId" in event && typeof event.runId === "string") {
    return event.runId;
  }
  if ("sessionId" in event && typeof event.sessionId === "string") {
    return event.sessionId;
  }
  if ("sessionKey" in event && typeof event.sessionKey === "string") {
    return event.sessionKey;
  }
  if ("messageId" in event && event.messageId != null) {
    return String(event.messageId);
  }
  return undefined;
}

function toAuditEvent(event: DiagnosticEventPayload): AuditEventV1Input {
  return {
    ts: new Date(event.ts).toISOString(),
    eventType: event.type,
    action: mapAction(event.type),
    outcome: mapOutcome(event),
    actor: {
      type: "system",
      id: "openclaw",
    },
    subject: {
      type: mapSubjectType(event),
      id: mapSubjectId(event),
    },
    correlation: {
      sessionKey: "sessionKey" in event ? event.sessionKey : undefined,
      sessionId: "sessionId" in event ? event.sessionId : undefined,
      runId: "runId" in event ? event.runId : undefined,
      messageId:
        "messageId" in event && event.messageId != null ? String(event.messageId) : undefined,
      chatId: "chatId" in event && event.chatId != null ? String(event.chatId) : undefined,
    },
    source: {
      component: "diagnostic-events",
      subsystem: "logging/diagnostic",
    },
    payload: event,
    legacy: {
      diagnosticType: event.type,
      diagnosticSeq: event.seq,
    },
  };
}

export function startDiagnosticAuditBridge(): void {
  if (stopListener) {
    return;
  }
  stopListener = onDiagnosticEvent((event) => {
    appendAuditEvent(toAuditEvent(event));
  });
}

export function stopDiagnosticAuditBridge(): void {
  if (!stopListener) {
    return;
  }
  stopListener();
  stopListener = null;
}

export function resetDiagnosticAuditBridgeForTest(): void {
  stopDiagnosticAuditBridge();
}
