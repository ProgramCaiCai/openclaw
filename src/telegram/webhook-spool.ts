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

function normalizeAccountDirSegment(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }

  // File system path segments must not be allowed to traverse with '.'/'..'.
  const normalized = trimmed.replace(/[^a-z0-9_-]+/gi, "_");
  const cleaned = normalized.replace(/^_+|_+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "default";
  }
  return cleaned;
}

function resolveSpoolDir(opts: TelegramWebhookSpoolOptions): string {
  const root =
    (opts.rootDir ?? process.env.OPENCLAW_TELEGRAM_WEBHOOK_SPOOL_DIR)?.trim() || DEFAULT_SPOOL_DIR;
  const accountPart = normalizeAccountDirSegment(opts.accountId);
  return path.join(root, accountPart);
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
  const dir = resolveSpoolDir(opts);
  const deadLetterDir = path.join(dir, "dead-letter");

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
    try {
      await fs.rename(filePath, dest);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        return dest;
      }
      throw err;
    }
    return dest;
  };

  const list = async (): Promise<string[]> => {
    try {
      const names = await fs.readdir(dir);
      return names
        .filter(isRecordFile)
        .toSorted((a, b) => a.localeCompare(b))
        .map((name) => path.join(dir, name));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        return [];
      }
      throw err;
    }
  };

  const read = async (filePath: string): Promise<TelegramWebhookSpoolEntry> => {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as TelegramWebhookSpoolEntry;
  };

  return { dir, deadLetterDir, append, ack, moveToDeadLetter, list, read };
}
