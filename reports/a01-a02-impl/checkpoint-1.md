# A01/A02 implementation checkpoint

## Scope

- Implemented hard guardrails for A01 (no silent NO_REPLY on user-triggered turns without visible output).
- Implemented hard guardrails for A02 (send visible short ack after 15s for long user-triggered turns with no visible output).

## Changed files

- `src/auto-reply/reply/agent-runner.ts`
- `src/auto-reply/reply/agent-runner-execution.ts`
- `src/auto-reply/types.ts`
- `src/auto-reply/reply/agent-runner.runreplyagent.test.ts`

## Validation

- Ran:
  - `node node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts src/auto-reply/reply/agent-runner.runreplyagent.test.ts`
- Result:
  - `41 passed` in `src/auto-reply/reply/agent-runner.runreplyagent.test.ts`

## Notes

- A01 fallback text: `Got it.`
- A02 watchdog ack text: `Working on it...`
- A02 watchdog only arms for user-triggered turns and only when a visible callback channel exists (`onBlockReply`, `onToolResult`, or `onPartialReply`).
