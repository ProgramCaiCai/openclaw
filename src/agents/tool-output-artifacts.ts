import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const EXCLUDED_CONTEXT_PREVIEW_CHARS = 4000;

function safeArtifactId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return crypto.randomBytes(4).toString("hex");
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}

function safeToolDir(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "tool";
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function tailText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  // Try to cut at a line boundary to avoid splitting mid-line/mid-char
  const raw = text.slice(text.length - max);
  const firstNewline = raw.indexOf("\n");
  if (firstNewline > 0 && firstNewline < max * 0.1) {
    return raw.slice(firstNewline + 1);
  }
  return raw;
}

export function formatExcludedFromContextHeader(params: {
  toolName: string;
  outputFile: string | null;
}): string {
  const name = params.toolName || "tool";
  if (params.outputFile) {
    return `⚠️ [${name} output excluded from context; saved to ${params.outputFile}]`;
  }
  return `⚠️ [${name} output excluded from context; failed to save artifact]`;
}

export async function writeToolOutputArtifact(params: {
  preferredCwd?: string;
  toolName: string;
  toolCallId: string;
  output: string;
  extension?: string;
}): Promise<string | null> {
  const baseCwd = params.preferredCwd?.trim() || process.cwd();
  const toolDir = safeToolDir(params.toolName);
  const candidates = [
    path.join(baseCwd, ".openclaw", "artifacts", toolDir),
    path.join(os.tmpdir(), "openclaw", "artifacts", toolDir),
  ];
  const fileId = safeArtifactId(params.toolCallId);
  const rawExt = (params.extension ?? "log").replace(/^[.]+/, "");
  const ext = path.basename(rawExt).replace(/[^a-zA-Z0-9_-]/g, "") || "log";
  const fileName = `${toolDir}-${Date.now()}-${fileId}.${ext}`;

  const errors: string[] = [];
  for (const dir of candidates) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, fileName);
      await fs.writeFile(filePath, params.output ?? "", "utf-8");
      return filePath;
    } catch (err) {
      errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.warn(`[tool-output-artifacts] Failed to write artifact: ${errors.join("; ")}`);
  return null;
}
