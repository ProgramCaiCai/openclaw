# Test Gate - Round 1

## Gate result
- result: pass-with-manual-verification
- reason: local test dependencies are unavailable (`node_modules` missing, `vitest` not found), so fallback manual verification was applied.

## Command evidence
- attempted: `pnpm test -- src/browser/server.post-tabs-open-profile-unknown-returns-404.test.ts extensions/feishu/src/reply-dispatcher.test.ts`
- output: `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found` and `node_modules missing`

## Manual verification checklist
- round-delta idle-spin gate: PASS (`changedFilesExcludingReports=6`, `added+deleted=142`)
- #23939 path now fails closed on malformed node payload:
  - `src/gateway/server-methods/exec-approvals.ts` contains strict payload parser and explicit `UNAVAILABLE` error.
- #23427 status actionability:
  - `src/browser/routes/basic.ts` computes `cdpReady = cdpReachable && actionReady`.
  - `src/browser/server.post-tabs-open-profile-unknown-returns-404.test.ts` includes stale action probe case.
- #23801 duplicate fallback send:
  - `extensions/feishu/src/reply-dispatcher.ts` dedupes identical block/final fallback payload.
  - `extensions/feishu/src/reply-dispatcher.test.ts` includes duplicate and control tests.

## Locked P0 verification
- R1-01 (#23939, redteam locked P0): verification evidence present via explicit fail-closed parser path + gateway error response on malformed payload.

## LOCK-01..LOCK-09 matrix status
- carried from tester matrix: all present with判定列; no missing lock rule rows.
