# Phase 1 - Root Cause Investigation

## Scope

- Investigated bug: assistant outputs filler text `answer for user question` before real reply.
- Repo scope checked: `src/` and `dist/` under this project.

## Evidence Collected

1. Codebase search in `src/` and `dist/` found **no hardcoded literal** `answer for user question`.
2. Historical runtime/session logs outside this repo show repeated instances of:
   - assistant emits `answer for user question`
   - immediately followed by tool call traces (`[TOOL: exec]`), then actual content.
3. Streaming pipeline currently forwards any non-empty sanitized text via:
   - `src/auto-reply/reply/agent-runner-execution.ts` (`normalizeStreamingText` -> `onPartialReply`)
   - no quality gate for low-value placeholder scaffolding text.
4. Final payload pipeline in `src/auto-reply/reply/agent-runner-payloads.ts` filters heartbeat/silent token, but also has no low-value placeholder filter.

## Reproduction Insight

- The phrase appears to be model-generated scaffolding/preamble, not prompt-template literal injection in source code.
- Because current code treats it as valid text, it can be surfaced to users.

## Root Cause (Phase 1 conclusion)

- Missing placeholder-quality filter in outbound text normalization path (streaming partials + final payloads).
