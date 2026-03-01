# Tool Output Hardcap Upgrade Report

## Scope

Implemented stricter hard truncation for LLM tool context, per-tool exec limits, and automatic artifact persistence for oversized tool output.

## Changes

1. **Lowered default LLM hard limits** (`src/agents/tool-output-hard-truncate.ts`)
   - `DEFAULT_TOOL_OUTPUT_HARD_LIMITS`: `12KB / 400 lines` (from `50KB / 2000 lines`).
   - Updated guidance suffix to explicitly instruct:
     - use `read` with `offset`/`limit`
     - or rerun with `excludeFromContext=true`.

2. **Added stricter exec limits**
   - Added `EXEC_TOOL_OUTPUT_HARD_LIMITS` (`6KB / 200 lines`) in `tool-output-hard-truncate.ts`.
   - In `src/agents/pi-tools.ts`, added `resolveToolHardOutputLimits(tool.name)` and wired `wrapToolWithHardOutputTruncate(...)` so `exec`/`bash` get `6KB/200`, other tools use `12KB/400`.

3. **Added automatic artifact fallback on truncation** (`src/agents/tool-output-hard-truncate.ts`)
   - On overflow, write full output synchronously to `/tmp/openclaw/artifacts/` via `mkdirSync` + `writeFileSync`.
   - Filename format: `<timestamp>-<toolName>-<shortId>.txt`.
   - Returned context now includes:
     - header: `[Full output (XX KB / YY lines) saved to <path>; showing head+tail preview]`
     - optional guidance suffix
     - bounded head+tail preview body.
   - If artifact write fails, behavior falls back to previous pure hard truncation (no tool call failure).

4. **Tests updated/added**
   - `src/agents/tool-output-hard-truncate.test.ts`
     - validates new default limits (`12KB/400`) and exec limits (`6KB/200`)
     - validates artifact file creation and full-content persistence
     - validates head+tail preview marker and bounded output
   - `src/agents/pi-tools.workspace-paths.test.ts`
     - added exec integration test to assert stricter hard truncation (`<=200` lines) and artifact hint.

## Verification

- Targeted:
  - `pnpm vitest run src/agents/tool-output-hard-truncate.test.ts src/agents/pi-tools.workspace-paths.test.ts`
  - Result: passed.

- Full regression:
  - `pnpm test`
  - Result: passed with 0 failures.
  - Observed suite summaries:
    - run A: `1401 passed, 1 skipped`
    - run B: `106 passed`

## Merge

- Branch: `feat/tool-output-hardcap-upgrade`
- Ready and merged to `main` after full green tests.
