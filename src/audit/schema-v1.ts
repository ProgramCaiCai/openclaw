export const AUDIT_SCHEMA = "openclaw.audit";
export const AUDIT_SCHEMA_VERSION = 1;
export const AUDIT_HASH_ALGORITHM = "sha256";

export type AuditOutcome = "success" | "failure" | "timeout" | "skipped" | "unknown";

export type AuditActor = {
  type: "system" | "user" | "client" | "device";
  id?: string;
};

export type AuditSubject = {
  type: string;
  id?: string;
};

export type AuditCorrelation = {
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  approvalId?: string;
  requestId?: string;
  messageId?: string;
  chatId?: string;
};

export type AuditSource = {
  component: string;
  subsystem?: string;
  host?: string;
  pid?: number;
};

export type AuditEvidence = {
  algorithm: typeof AUDIT_HASH_ALGORITHM;
  prevHash: string | null;
  hash: string;
};

export type AuditEventV1 = {
  schema: typeof AUDIT_SCHEMA;
  version: typeof AUDIT_SCHEMA_VERSION;
  eventId: string;
  ts: string;
  eventType: string;
  action: string;
  outcome: AuditOutcome;
  actor: AuditActor;
  subject: AuditSubject;
  correlation?: AuditCorrelation;
  source: AuditSource;
  payload?: Record<string, unknown>;
  legacy?: {
    diagnosticType?: string;
    diagnosticSeq?: number;
  };
  evidence: AuditEvidence;
};

export type AuditEventV1Input = Omit<
  AuditEventV1,
  "schema" | "version" | "eventId" | "ts" | "evidence"
> & {
  eventId?: string;
  ts?: string;
};
