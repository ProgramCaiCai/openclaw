import crypto from "node:crypto";
import {
  AUDIT_HASH_ALGORITHM,
  AUDIT_SCHEMA,
  AUDIT_SCHEMA_VERSION,
  type AuditEventV1,
} from "./schema-v1.js";
import { AUDIT_SCHEMA_VERSION_V2, type AuditEventV2 } from "./schema-v2.js";

export type VerifyInputEvent = AuditEventV1 | AuditEventV2;

export type VerifyIssue = {
  index: number;
  message: string;
};

export type VerifyResult = {
  ok: boolean;
  issues: VerifyIssue[];
};

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

function computeHash(event: VerifyInputEvent): string {
  const { evidence, ...base } = event;
  return sha256(
    stableJson({
      ...base,
      evidence: {
        algorithm: evidence.algorithm,
        prevHash: evidence.prevHash,
      },
    }),
  );
}

function isSupportedVersion(version: number): boolean {
  return version === AUDIT_SCHEMA_VERSION || version === AUDIT_SCHEMA_VERSION_V2;
}

export function verifyAuditChain(events: readonly VerifyInputEvent[]): VerifyResult {
  const issues: VerifyIssue[] = [];
  let expectedPrevHash: string | null = null;

  for (const [index, event] of events.entries()) {
    if (event.schema !== AUDIT_SCHEMA) {
      issues.push({ index, message: `unexpected schema: ${String(event.schema)}` });
      continue;
    }
    if (!isSupportedVersion(event.version)) {
      issues.push({ index, message: `unsupported version: ${event.version}` });
      continue;
    }
    if (event.evidence.algorithm !== AUDIT_HASH_ALGORITHM) {
      issues.push({
        index,
        message: `unsupported hash algorithm: ${String(event.evidence.algorithm)}`,
      });
      continue;
    }
    if (event.evidence.prevHash !== expectedPrevHash) {
      issues.push({
        index,
        message: `broken prevHash chain: got ${String(event.evidence.prevHash)} expected ${String(expectedPrevHash)}`,
      });
      expectedPrevHash = event.evidence.hash;
      continue;
    }
    const expectedHash = computeHash(event);
    if (event.evidence.hash !== expectedHash) {
      issues.push({
        index,
        message: `hash mismatch: got ${event.evidence.hash} expected ${expectedHash}`,
      });
      expectedPrevHash = event.evidence.hash;
      continue;
    }
    expectedPrevHash = event.evidence.hash;
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}
