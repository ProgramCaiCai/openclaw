import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type TelegramWebhookSpoolEntry = {
  id: string;
  updateId?: number;
  receivedAtMs: number;
  update: unknown;
};

type TelegramWebhookSpoolOptions = {
  accountId?: string;
  rootDir?: string;
};

const DEFAULT_SPOOL_DIR = path.join(os.tmpdir(), "openclaw-telegram-webhook-spool");

function resolveSpoolRoot(opts: TelegramWebhookSpoolOptions): string {
  return (
    (opts.rootDir ?? process.env.OPENCLAW_TELEGRAM_WEBHOOK_SPOOL_DIR)?.trim() || DEFAULT_SPOOL_DIR
  );
}

function sanitizeSpoolAccountId(accountId?: string): string {
  const raw = accountId?.trim();
  if (!raw) {
    return "default";
  }

  // Force a single safe path segment (no separators). Prevent "."/".." traversal.
  const normalized = raw.replace(/[^a-z0-9._-]+/gi, "_").trim() || "default";
  if (normalized === "." || normalized === "..") {
    return "default";
  }
  return normalized;
}

function resolveLegacyAccountId(accountId?: string): string {
  const raw = (accountId ?? "default").trim() || "default";
  // Legacy behavior used the raw string directly; only support single-segment legacy ids.
  if (raw.includes("/") || raw.includes("\\") || raw === "." || raw === "..") {
    return "default";
  }
  return raw;
}

function isRecordFile(name: string): boolean {
  return name.endsWith(".json");
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function atomicWriteFile(filePath: string, content: string) {
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

export function createTelegramWebhookSpool(opts: TelegramWebhookSpoolOptions = {}) {
  const root = resolveSpoolRoot(opts);
  const primaryAccountId = sanitizeSpoolAccountId(opts.accountId);
  const legacyAccountId = resolveLegacyAccountId(opts.accountId);

  const dir = path.join(root, primaryAccountId);
  const deadLetterDir = path.join(dir, "dead-letter");

  // Backward compatibility: if sanitization changes the directory name, still replay from the old dir.
  const legacyDir = legacyAccountId !== primaryAccountId ? path.join(root, legacyAccountId) : null;
  const replayDirs = legacyDir ? [dir, legacyDir] : [dir];

  const append = async (entry: Omit<TelegramWebhookSpoolEntry, "id">) => {
    await ensureDir(dir);
    const id = crypto.randomUUID();
    const safeUpdateId = typeof entry.updateId === "number" ? entry.updateId : "unknown";
    const fileName = `${entry.receivedAtMs}-${safeUpdateId}-${id}.json`;
    const filePath = path.join(dir, fileName);
    const payload: TelegramWebhookSpoolEntry = { ...entry, id };
    await atomicWriteFile(filePath, JSON.stringify(payload));
    return { id, filePath };
  };

  const ack = async (filePath: string) => {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    }
  };

  // R1-02: Move permanently-failed spool files to dead-letter directory.
  const moveToDeadLetter = async (filePath: string) => {
    await ensureDir(deadLetterDir);
    const baseName = path.basename(filePath);
    const dest = path.join(deadLetterDir, baseName);
    await fs.rename(filePath, dest);
    return dest;
  };

  const list = async (): Promise<string[]> => {
    const out: string[] = [];

    for (const replayDir of replayDirs) {
      try {
        const names = await fs.readdir(replayDir);
        for (const name of names) {
          if (isRecordFile(name)) {
            out.push(path.join(replayDir, name));
          }
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
          continue;
        }
        throw err;
      }
    }

    // Deterministic replay ordering: filename begins with receivedAtMs.
    out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    return out;
  };

  const read = async (filePath: string): Promise<TelegramWebhookSpoolEntry> => {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as TelegramWebhookSpoolEntry;
  };

  return { dir, deadLetterDir, append, ack, moveToDeadLetter, list, read };
}
