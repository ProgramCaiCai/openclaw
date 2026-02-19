import type { AuditEventV1, AuditOutcome } from "./schema-v1.js";

export const AUDIT_SCHEMA_VERSION_V2 = 2;
export const AUDIT_SCHEMA_MINOR_V2 = 0;

export type AuditMigrationInfo = {
  fromVersion: 1;
  migratedAt: string;
  sourceHash: string;
};

export type AuditEventV2 = Omit<AuditEventV1, "version" | "payload"> & {
  version: typeof AUDIT_SCHEMA_VERSION_V2;
  schemaMinor: typeof AUDIT_SCHEMA_MINOR_V2;
  payload?: Record<string, unknown>;
  migration: AuditMigrationInfo;
  normalized: {
    outcome: AuditOutcome;
    category: string;
  };
};
