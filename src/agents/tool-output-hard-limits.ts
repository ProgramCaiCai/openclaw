import {
  DEFAULT_TOOL_OUTPUT_HARD_LIMITS,
  EXEC_TOOL_OUTPUT_HARD_LIMITS,
  type ToolOutputHardLimits,
} from "./tool-output-hard-truncate.js";

export function resolveToolHardOutputLimits(toolName: string): ToolOutputHardLimits {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "exec" || normalized === "bash") {
    return EXEC_TOOL_OUTPUT_HARD_LIMITS;
  }
  return DEFAULT_TOOL_OUTPUT_HARD_LIMITS;
}
