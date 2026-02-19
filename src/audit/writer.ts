import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOG_DIR } from "../logging/logger.js";
import {
  AUDIT_HASH_ALGORITHM,
  AUDIT_SCHEMA,
  AUDIT_SCHEMA_VERSION,
  type AuditEventV1,
  type AuditEventV1Input,
} from "./schema-v1.js";

const AUDIT_DIR = "audit";
const AUDIT_PREFIX = "openclaw-audit-v1-";
const AUDIT_SUFFIX = ".ndjson";

type AuditWriterState = {
  filePath: string;
  prevHash: string | null;
  useDefaultPath: boolean;
};

const state: AuditWriterState = {
  filePath: defaultAuditFilePath(),
  prevHash: null,
  useDefaultPath: true,
};

let initialized = false;

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultAuditFilePath(date = new Date()): string {
  const file = `${AUDIT_PREFIX}${formatLocalDate(date)}${AUDIT_SUFFIX}`;
  return path.join(DEFAULT_LOG_DIR, AUDIT_DIR, file);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const ordered = Object.keys(obj)
    .toSorted()
    .reduce<Record<string, unknown>>((acc, key) => {
      const next = obj[key];
      if (next !== undefined) {
        acc[key] = stableValue(next);
      }
      return acc;
    }, {});
  return ordered;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function readLastHash(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat || stat.size <= 0) {
      return null;
    }

    const maxTailBytes = 64 * 1024;
    const size = stat.size;
    const length = Math.min(size, maxTailBytes);
    const start = Math.max(0, size - length);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      let text = buffer.toString("utf8");
      if (start > 0) {
        // The first line may be truncated when reading a tail slice.
        const firstNewline = text.indexOf("\n");
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
      }
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]?.trim();
        if (!line) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as { evidence?: { hash?: unknown } };
          if (typeof parsed.evidence?.hash === "string" && parsed.evidence.hash.length > 0) {
            return parsed.evidence.hash;
          }
        } catch {
          // Skip malformed trailing lines and keep searching older valid records.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return null;
  } catch {
    return null;
  }
}

export function configureAuditWriter(filePath?: string): void {
  const explicitPath = filePath?.trim();
  state.filePath = explicitPath ? path.resolve(explicitPath) : defaultAuditFilePath();
  state.prevHash = null;
  state.useDefaultPath = !explicitPath;
  initialized = false;
}

function maybeRotateDefaultPath(): void {
  if (!state.useDefaultPath) {
    return;
  }
  const todayPath = defaultAuditFilePath();
  if (todayPath === state.filePath) {
    return;
  }
  state.filePath = todayPath;
  state.prevHash = null;
  initialized = false;
}

function initWriterIfNeeded(): void {
  if (initialized) {
    return;
  }
  fs.mkdirSync(path.dirname(state.filePath), { recursive: true });
  state.prevHash = readLastHash(state.filePath);
  initialized = true;
}

function buildHash(base: Omit<AuditEventV1, "evidence">, prevHash: string | null): string {
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

export function appendAuditEvent(input: AuditEventV1Input): AuditEventV1 {
  maybeRotateDefaultPath();
  initWriterIfNeeded();
  const base: Omit<AuditEventV1, "evidence"> = {
    schema: AUDIT_SCHEMA,
    version: AUDIT_SCHEMA_VERSION,
    eventId: input.eventId ?? randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    eventType: input.eventType,
    action: input.action,
    outcome: input.outcome,
    actor: input.actor,
    subject: input.subject,
    correlation: input.correlation,
    source: {
      host: os.hostname(),
      pid: process.pid,
      ...input.source,
    },
    payload: input.payload,
    legacy: input.legacy,
  };

  const prevHash = state.prevHash;
  const hash = buildHash(base, prevHash);
  const event: AuditEventV1 = {
    ...base,
    evidence: {
      algorithm: AUDIT_HASH_ALGORITHM,
      prevHash,
      hash,
    },
  };

  try {
    fs.appendFileSync(state.filePath, `${JSON.stringify(event)}\n`, "utf8");
    state.prevHash = hash;
  } catch {
    // Do not block main runtime if audit logging fails.
  }

  return event;
}

export function getAuditWriterStateForTest(): {
  filePath: string;
  prevHash: string | null;
  useDefaultPath: boolean;
} {
  return {
    filePath: state.filePath,
    prevHash: state.prevHash,
    useDefaultPath: state.useDefaultPath,
  };
}

export function resetAuditWriterForTest(): void {
  state.filePath = defaultAuditFilePath();
  state.prevHash = null;
  state.useDefaultPath = true;
  initialized = false;
}
