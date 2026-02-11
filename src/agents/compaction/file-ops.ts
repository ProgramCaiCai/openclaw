import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { FileOperations } from "@mariozechner/pi-coding-agent";

type ToolCallBlock = {
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
};

export function createFileOps(): FileOperations {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
}

export function mergeFileOps(target: FileOperations, source: FileOperations | undefined): void {
  if (!source) {
    return;
  }
  for (const f of source.read) {
    target.read.add(f);
  }
  for (const f of source.written) {
    target.written.add(f);
  }
  for (const f of source.edited) {
    target.edited.add(f);
  }
}

function asNonEmptyPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function collectPathsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== "object") {
    return [];
  }
  const rec = args as Record<string, unknown>;

  const directKeys = ["path", "file_path", "filePath", "filepath"] as const;
  for (const key of directKeys) {
    const single = asNonEmptyPath(rec[key]);
    if (single) {
      return [single];
    }
  }

  const arrayKeys = ["paths", "filePaths"] as const;
  for (const key of arrayKeys) {
    const arr = rec[key];
    if (!Array.isArray(arr)) {
      continue;
    }
    const out: string[] = [];
    for (const entry of arr) {
      const p = asNonEmptyPath(entry);
      if (p) {
        out.push(p);
      }
    }
    if (out.length > 0) {
      return out;
    }
  }

  return [];
}

export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant") {
    return;
  }
  if (!("content" in message) || !Array.isArray(message.content)) {
    return;
  }

  for (const block of message.content as unknown[]) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const toolCall = block as ToolCallBlock;
    // Recognize all tool block variants: toolCall, toolUse, functionCall
    if (
      toolCall.type !== "toolCall" &&
      toolCall.type !== "toolUse" &&
      toolCall.type !== "functionCall"
    ) {
      continue;
    }

    const toolName = typeof toolCall.name === "string" ? toolCall.name : undefined;
    if (!toolName) {
      continue;
    }

    // Support both `arguments` (toolCall) and `input` (toolUse) fields
    const args = toolCall.arguments ?? (toolCall as Record<string, unknown>).input;
    const paths = collectPathsFromArgs(args);
    if (paths.length === 0) {
      continue;
    }

    for (const p of paths) {
      switch (toolName) {
        case "read":
          fileOps.read.add(p);
          break;
        case "write":
          fileOps.written.add(p);
          break;
        case "edit":
          fileOps.edited.add(p);
          break;
      }
    }
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
