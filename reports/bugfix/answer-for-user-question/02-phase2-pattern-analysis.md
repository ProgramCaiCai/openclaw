# Phase 2 - Pattern Analysis

## Working Pattern in Codebase

- Existing safeguards already classify and suppress special control tokens:
  - `NO_REPLY` exact text (`isSilentReplyText`)
  - streaming token prefixes (`isSilentReplyPrefixText`)
  - heartbeat token stripping (`stripHeartbeatToken`)
- These checks are integrated in:
  - `src/auto-reply/reply/agent-runner-execution.ts` for streaming/tool callbacks
  - `src/auto-reply/reply/agent-runner-payloads.ts` for final payloads

## Difference vs Broken Case

- Control-token filters exist, but no equivalent filter for low-value model scaffolding text.
- Therefore model-generated filler like `answer for user question` is treated as normal user-visible content.

## Dependency/Impact Surface

- Minimal-impact insertion points:
  1. `src/auto-reply/tokens.ts` (shared text classification helper)
  2. `src/auto-reply/reply/agent-runner-execution.ts` (streaming suppression)
  3. `src/auto-reply/reply/agent-runner-payloads.ts` (final payload suppression)
- Related tests to extend:
  - `src/auto-reply/tokens.test.ts`
  - `src/auto-reply/reply/agent-runner.runreplyagent.test.ts`
  - `src/auto-reply/reply/agent-runner-payloads.test.ts`
