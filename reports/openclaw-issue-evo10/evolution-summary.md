# Evolution Summary - openclaw-issue-evo10

## Scope and resolved issues

- #23590: fixed by adding bounded resize-result cache in `src/agents/tool-images.ts`, with regression tests in `src/agents/tool-images.cache.test.ts`.
- #23715: fixed by making system-prompt opening line installation-specific and deterministic in `src/agents/system-prompt.ts`, with regression assertions in `src/agents/system-prompt.e2e.test.ts`.

## 10-round trend

- Findings trajectory: 10 -> 9 -> 8 -> 7 -> 6 -> 5 -> 4 -> 3 -> 2 -> 1
- High priority trend: P1 findings reduced to 0 by round 6 and stayed 0.
- Gate trend: every round recorded `New P0/P1/P2 introduced: 0`.

## Verification results

- Repeatedly passed:
  - `pnpm exec vitest run src/agents/tool-images.cache.test.ts`
  - `pnpm exec vitest run --config vitest.e2e.config.ts src/agents/tool-images.e2e.test.ts src/agents/system-prompt.e2e.test.ts`
- Final residual risk: low (bounded in-memory cache can still be tuned for entry count based on real-world traffic profile).

## Commits produced in this evolution run

- 9feff4ddd chore(evo10): round 1 scope selection and baseline review artifacts
- df5ca2ca5 fix(tool-images): round 2 add bounded resize cache for issue #23590
- a94ed4ad7 test(tool-images): round 3 add cache regression coverage for issue #23590
- 0399d8550 fix(system-prompt): round 4 add instance-specific opening line for issue #23715
- e0f5030fb test(system-prompt): round 5 lock prompt-cache partition behavior (#23715)
- 59edcef47 chore(evo10): round 6 verification checkpoint
- 0004cebb6 chore(evo10): round 7 verification checkpoint
- 25d40942d chore(evo10): round 8 verification checkpoint
- 1686decc5 chore(evo10): round 9 verification checkpoint
- round-10 commit: included with this summary/checkpoint update.
