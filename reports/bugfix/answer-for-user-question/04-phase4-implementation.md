# Phase 4 - Implementation

## Code Changes (via Codex CLI)

1. `src/auto-reply/tokens.ts`
   - Added `isLowValuePlaceholderText(text)`.
   - Normalizes text by lowercasing and collapsing non-alphanumeric separators.
   - Matches canonical low-value placeholder: `answer for user question`.

2. `src/auto-reply/reply/agent-runner-execution.ts`
   - Integrated placeholder filter into `normalizeStreamingText`.
   - Behavior:
     - placeholder text + no media => skip
     - placeholder text + media => clear text, keep media

3. `src/auto-reply/reply/agent-runner-payloads.ts`
   - Integrated same placeholder filter in final payload sanitization.
   - Behavior mirrors streaming path to avoid leakage in final reply payloads.

## Added Regression Tests

- `src/auto-reply/tokens.test.ts`
  - Positive/negative coverage for `isLowValuePlaceholderText`.
- `src/auto-reply/reply/agent-runner.runreplyagent.test.ts`
  - Added placeholder cases in partial/tool-result suppression suites.
- `src/auto-reply/reply/agent-runner-payloads.test.ts`
  - Added tests for dropping placeholder-only payload and preserving media-only payload.

## Scope Control

- No prompt template text was modified.
- No inbound pipeline contract changes; only outbound sanitization filter path updated.
