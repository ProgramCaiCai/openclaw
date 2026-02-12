import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { FileOperations } from "@mariozechner/pi-coding-agent";

const POSSIBLE_SHELL_SIDE_FILE_CHANGES = "possible shell-side file changes";

const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filepath",
  // Common tool params across runners/providers.
  "cwd",
  "workdir",
  "workDir",
  "directory",
  "dir",
] as const;

const PATHS_KEYS = ["paths", "filePaths", "file_paths"] as const;

const MAX_PATH_EXTRACTION_DEPTH = 2;
const MAX_PATH_EXTRACTION_NODES = 20;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function addPath(set: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  set.add(trimmed);
}

function addPaths(set: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    addPath(set, item);
  }
}

function normalizeToolName(name: unknown): string {
  if (typeof name !== "string") {
    return "";
  }
  // Some providers may namespace tool names (e.g. "functions.read").
  const base = name.split(".").pop() ?? name;
  return base.trim().toLowerCase();
}

function extractPathsFromArgs(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const pathKeys = new Set<string>(PATH_KEYS);
  const pathsKeys = new Set<string>(PATHS_KEYS);
  const visited = new Set<object>();

  let nodes = 0;

  const walk = (value: unknown, depth: number): void => {
    if (nodes >= MAX_PATH_EXTRACTION_NODES) {
      return;
    }
    if (depth > MAX_PATH_EXTRACTION_DEPTH) {
      return;
    }

    if (Array.isArray(value)) {
      nodes += 1;
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }

    const rec = asRecord(value);
    if (!rec) {
      return;
    }

    if (visited.has(rec)) {
      return;
    }
    visited.add(rec);
    nodes += 1;

    for (const [key, child] of Object.entries(rec)) {
      if (pathKeys.has(key)) {
        addPath(out, child);
      }
      if (pathsKeys.has(key)) {
        addPaths(out, child);
      }
      if (depth < MAX_PATH_EXTRACTION_DEPTH) {
        walk(child, depth + 1);
      }
    }
  };

  walk(args, 0);

  return [...out];
}

export function createFileOps(): FileOperations {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
}

export function mergeFileOps(target: FileOperations, source: FileOperations): void {
  for (const p of source.read) {
    target.read.add(p);
  }
  for (const p of source.written) {
    target.written.add(p);
  }
  for (const p of source.edited) {
    target.edited.add(p);
  }
}

function markPossibleShellSideChanges(fileOps: FileOperations): void {
  fileOps.written.add(POSSIBLE_SHELL_SIDE_FILE_CHANGES);
}

export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (!message || typeof message !== "object") {
    return;
  }
  if (message.role !== "assistant") {
    return;
  }

  const assistant = message as { content?: unknown };
  if (!Array.isArray(assistant.content)) {
    return;
  }

  for (const block of assistant.content) {
    const rec = asRecord(block);
    if (!rec) {
      continue;
    }

    const toolType = typeof rec.type === "string" ? rec.type : "";
    if (toolType !== "toolCall" && toolType !== "toolUse") {
      continue;
    }

    const toolName = normalizeToolName(rec.name);
    if (!toolName) {
      continue;
    }

    // toolCall uses "arguments" (OpenAI/Gemini style), toolUse uses "input" (Anthropic style).
    const args = asRecord(rec.arguments ?? rec.input);
    if (!args) {
      continue;
    }

    const paths = extractPathsFromArgs(args);

    switch (toolName) {
      case "read":
        for (const p of paths) {
          fileOps.read.add(p);
        }
        break;
      case "write":
        for (const p of paths) {
          fileOps.written.add(p);
        }
        break;
      case "edit":
        for (const p of paths) {
          fileOps.edited.add(p);
        }
        break;
      case "exec":
      case "bash":
      case "shell": {
        markPossibleShellSideChanges(fileOps);
        for (const p of paths) {
          fileOps.written.add(p);
        }
        break;
      }
      default: {
        // Only mark unknown tools when they look like shell execution.
        const hasShellLikePayload =
          typeof args.command === "string" ||
          typeof args.cmd === "string" ||
          typeof args.script === "string";
        if (hasShellLikePayload) {
          markPossibleShellSideChanges(fileOps);
        }
        break;
      }
    }
  }
}

export function extractFileOpsFromMessages(
  messages: AgentMessage[],
  fileOps: FileOperations,
): void {
  for (const message of messages) {
    extractFileOpsFromMessage(message, fileOps);
  }
}

export function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles, modifiedFiles };
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}
