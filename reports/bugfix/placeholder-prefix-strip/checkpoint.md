# Placeholder Prefix Strip Bugfix Checkpoint

## Phase 1 - Root Cause

- Existing filter only used `isLowValuePlaceholderText()` exact-equivalence matching after normalization.
- Real responses like `answer for user question\n\n正常内容` were not equal to the placeholder token, so they were not transformed.
- The same exact-match-only behavior existed in both streaming normalization (`agent-runner-execution.ts`) and final payload normalization (`agent-runner-payloads.ts`).

## Phase 2 - Pattern Analysis

- Existing token utilities already separate exact token checks (`isSilentReplyText`) from prefix checks (`isSilentReplyPrefixText`).
- Heartbeat handling (`stripHeartbeatToken`) demonstrates strip-then-filter behavior, which matches this bugfix direction.

## Phase 3 - Hypothesis

- Hypothesis: introducing a robust placeholder-prefix stripper and applying it before exact-match fallback in both stages will preserve substantive content while still filtering empty placeholder-only messages.

## Phase 4 - Implementation

- Added `stripLowValuePlaceholderPrefix(text: string): string` in `src/auto-reply/tokens.ts`.
- Updated streaming normalization in `src/auto-reply/reply/agent-runner-execution.ts` to:
  - strip placeholder prefix first,
  - skip when stripped text is empty and no media,
  - clear text but keep media when stripped text is empty and media exists,
  - replace text with stripped content when non-empty,
  - keep exact-match `isLowValuePlaceholderText()` as fallback.
- Updated final payload normalization in `src/auto-reply/reply/agent-runner-payloads.ts` with the same strip-first behavior and exact-match fallback.
- Added/updated tests in:
  - `src/auto-reply/tokens.test.ts`
  - `src/auto-reply/reply/agent-runner-payloads.test.ts`
  - `src/auto-reply/reply/agent-runner.runreplyagent.test.ts`

## Verification

- Targeted tests passed:
  - `pnpm vitest src/auto-reply/tokens.test.ts src/auto-reply/reply/agent-runner-payloads.test.ts src/auto-reply/reply/agent-runner.runreplyagent.test.ts`
- Auto-reply regression passed:
  - `pnpm vitest src/auto-reply`
- Result: 0 fail, 0 error in executed regression scope.
