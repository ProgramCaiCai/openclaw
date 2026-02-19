import crypto from "node:crypto";
import {
  AUDIT_HASH_ALGORITHM,
  AUDIT_SCHEMA,
  type AuditEventV1,
  type AuditOutcome,
} from "./schema-v1.js";
import { AUDIT_SCHEMA_MINOR_V2, AUDIT_SCHEMA_VERSION_V2, type AuditEventV2 } from "./schema-v2.js";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .toSorted()
    .reduce<Record<string, unknown>>((acc, key) => {
      const next = obj[key];
      if (next !== undefined) {
        acc[key] = stableValue(next);
      }
      return acc;
    }, {});
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function inferCategory(eventType: string): string {
  const first = eventType.split(".")[0];
  return first && first.length > 0 ? first : "event";
}

function normalizeOutcome(outcome: AuditOutcome): AuditOutcome {
  if (
    outcome === "success" ||
    outcome === "failure" ||
    outcome === "timeout" ||
    outcome === "skipped"
  ) {
    return outcome;
  }
  return "unknown";
}

function buildHash(base: Omit<AuditEventV2, "evidence">, prevHash: string | null): string {
  return sha256(
    stableJson({
      ...base,
      evidence: {
        algorithm: AUDIT_HASH_ALGORITHM,
        prevHash,
      },
    }),
  );
}

export function upgradeAuditEventV1ToV2(
  event: AuditEventV1,
  prevHash: string | null,
  migratedAt = new Date().toISOString(),
): AuditEventV2 {
  const base: Omit<AuditEventV2, "evidence"> = {
    schema: AUDIT_SCHEMA,
    version: AUDIT_SCHEMA_VERSION_V2,
    schemaMinor: AUDIT_SCHEMA_MINOR_V2,
    eventId: event.eventId,
    ts: event.ts,
    eventType: event.eventType,
    action: event.action,
    outcome: event.outcome,
    actor: event.actor,
    subject: event.subject,
    correlation: event.correlation,
    source: event.source,
    payload: event.payload,
    legacy: event.legacy,
    migration: {
      fromVersion: 1,
      migratedAt,
      sourceHash: event.evidence.hash,
    },
    normalized: {
      outcome: normalizeOutcome(event.outcome),
      category: inferCategory(event.eventType),
    },
  };
  const hash = buildHash(base, prevHash);
  return {
    ...base,
    evidence: {
      algorithm: AUDIT_HASH_ALGORITHM,
      prevHash,
      hash,
    },
  };
}

export function upgradeAuditEventsV1ToV2(
  events: readonly AuditEventV1[],
  migratedAt = new Date().toISOString(),
): AuditEventV2[] {
  let prevHash: string | null = null;
  return events.map((event) => {
    const upgraded = upgradeAuditEventV1ToV2(event, prevHash, migratedAt);
    prevHash = upgraded.evidence.hash;
    return upgraded;
  });
}
