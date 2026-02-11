import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const FILTER_COMMAND_PREFIX_WHITELIST = new Set([
  "jq",
  "grep",
  "head",
  "tail",
  "sed",
  "awk",
  "cut",
  "rg",
  "wc",
]);

type CtxSafeCallPolicy = {
  allowWrapping?: boolean;
  allowedParams?: Set<string>;
};

const CtxSafeCallToolSchema = Type.Object({
  tool: Type.String(),
  params: Type.Optional(Type.Object({}, { additionalProperties: true })),
  filterCommand: Type.Optional(Type.String()),
});

type CtxSafeCallToolOptions = {
  resolveTool: (name: string) => AnyAgentTool | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createNullProtoRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function serializeOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseFilterCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escape = false;

  for (const char of command) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escape || quote) {
    throw new Error("Invalid filterCommand syntax");
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

type FilterCommandResult = {
  output: string;
  applied: boolean;
  fallbackReason?: string;
};

function runFilterCommand(rawOutput: string, filterCommand: string): FilterCommandResult {
  const tokens = parseFilterCommand(filterCommand);
  if (tokens.length === 0) {
    throw new Error("filterCommand required");
  }

  const [command, ...commandArgs] = tokens;
  if (!FILTER_COMMAND_PREFIX_WHITELIST.has(command)) {
    throw new Error(`filterCommand prefix not allowed: ${command}`);
  }

  try {
    const result = spawnSync(command, commandArgs, {
      input: rawOutput,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      return {
        output: rawOutput,
        applied: false,
        fallbackReason: result.error.message,
      };
    }

    if (result.status !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
      return {
        output: rawOutput,
        applied: false,
        fallbackReason: stderr || `exit code ${result.status}`,
      };
    }

    return {
      output: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
      applied: true,
    };
  } catch (error) {
    return {
      output: rawOutput,
      applied: false,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractPayload(result: unknown): unknown {
  if (!isRecord(result)) {
    return result;
  }
  if ("details" in result && result.details != null) {
    return result.details;
  }

  const content = result.content;
  if (Array.isArray(content)) {
    const textBlocks = content
      .filter((entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string")
      .map((entry) => String((entry as { text?: unknown }).text));
    if (textBlocks.length > 0) {
      return textBlocks.join("\n");
    }
  }

  return result;
}

function readCtxSafeCallPolicy(tool: AnyAgentTool): CtxSafeCallPolicy {
  const toolRecord = tool as unknown as Record<string, unknown>;
  const policyRaw = toolRecord.safeCall;
  if (!isRecord(policyRaw)) {
    return {};
  }

  const allowWrapping =
    typeof policyRaw.allowWrapping === "boolean" ? policyRaw.allowWrapping : undefined;

  const allowedParamsRaw = policyRaw.allowedParams;
  const allowedParams = Array.isArray(allowedParamsRaw)
    ? new Set(
        allowedParamsRaw
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean),
      )
    : undefined;

  return { allowWrapping, allowedParams };
}

function selectTargetParams(
  params: Record<string, unknown>,
  allowedParams: Set<string> | undefined,
): Record<string, unknown> {
  if (!allowedParams || allowedParams.size === 0) {
    return params;
  }
  const selected = createNullProtoRecord();
  for (const key of allowedParams) {
    if (Object.hasOwn(params, key)) {
      selected[key] = params[key];
    }
  }
  return selected;
}

export function createCtxSafeCallTool(options: CtxSafeCallToolOptions): AnyAgentTool {
  return {
    label: "Safe Call",
    name: "ctx_safe_call",
    description: "Call another tool and optionally filter its output with a unix-style command.",
    parameters: CtxSafeCallToolSchema,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const params = args as Record<string, unknown>;
      const toolName = readStringParam(params, "tool", { required: true });
      if (toolName === "ctx_safe_call") {
        throw new Error("ctx_safe_call cannot wrap itself");
      }

      const target = options.resolveTool(toolName);
      if (!target) {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      const policy = readCtxSafeCallPolicy(target);
      if (policy.allowWrapping === false) {
        throw new Error(`Tool does not allow ctx_safe_call wrapping: ${toolName}`);
      }

      const targetParamsRaw = params.params;
      const targetParamsSource = isRecord(targetParamsRaw) ? targetParamsRaw : {};
      // Security boundary: ctx_safe_call forwards tool-specific params by default; target tools may
      // opt into stricter wrapping via `safeCall.allowWrapping` and `safeCall.allowedParams`.
      const targetParams = selectTargetParams(targetParamsSource, policy.allowedParams);

      const targetResult = await target.execute(
        `${toolCallId}:ctx_safe_call:${toolName}`,
        targetParams,
        signal,
        onUpdate,
      );

      const rawOutput = serializeOutput(extractPayload(targetResult));
      const filterCommand = readStringParam(params, "filterCommand");

      let output = rawOutput;
      let filterApplied = false;
      let filterFallbackReason: string | null = null;

      if (filterCommand) {
        const filterResult = runFilterCommand(rawOutput, filterCommand);
        output = filterResult.output;
        filterApplied = filterResult.applied;
        if (!filterResult.applied) {
          filterFallbackReason = filterResult.fallbackReason ?? "filter command failed";
        }
      }

      return jsonResult({
        tool: toolName,
        filterCommand: filterCommand ?? null,
        filterApplied,
        filterFallbackReason,
        output,
      });
    },
  };
}
