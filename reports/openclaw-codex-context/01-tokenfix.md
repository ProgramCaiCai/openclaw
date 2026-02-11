# T1 TokenFix (derivePromptTokens excludes cacheRead)

Branch: `codex/tokenfix-no-cacheread`
Commit: `053ce32b7` (`fix(agents): exclude cacheRead from prompt tokens`)

## What Changed

- Updated `src/agents/usage.ts`:
  - `derivePromptTokens()` now computes `input + cacheWrite` (no longer counts `cacheRead`).
  - `deriveSessionTotalTokens()` no longer passes `cacheRead` into `derivePromptTokens()`.
- Updated `src/agents/usage.test.ts`:
  - Added a focused test asserting `derivePromptTokens()` ignores `cacheRead` even when present on the usage object.
  - Updated expectations for `deriveSessionTotalTokens()` to match the new prompt token definition.
  - Adjusted the existing context-window capping test so it still exercises the capping behavior when `cacheRead` is excluded.

## Why

Anthropic cache reads represent previously-seen tokens and should not be treated as "prompt tokens" for prompt sizing. Counting `cacheRead` inflated prompt size estimates and could trigger incorrect context-window behavior.

## Verification

Ran the minimal unit tests:

```bash
cd /Users/programcaicai/clawd/projects/openclaw
pnpm vitest src/agents/usage.test.ts
```
