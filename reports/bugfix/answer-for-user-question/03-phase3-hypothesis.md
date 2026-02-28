# Phase 3 - Hypothesis and Minimal Test Plan

## Hypothesis

If we classify the normalized phrase `answer for user question` as low-value placeholder text and suppress it in both streaming and final payload pipelines, then the unwanted preamble will not reach users while normal replies remain unaffected.

## Minimal Change Plan

1. Add helper in `src/auto-reply/tokens.ts`:
   - normalize text (`lowercase`, collapse non-alnum to spaces)
   - return true for known placeholder phrase(s)
2. Call helper in:
   - `normalizeStreamingText` inside `agent-runner-execution.ts`
   - `buildReplyPayloads` sanitization flow inside `agent-runner-payloads.ts`
3. Add focused tests for:
   - placeholder detection utility
   - streaming partial suppression
   - tool-result suppression
   - final payload suppression (while keeping media-only payloads)

## Success Criteria

- No `answer for user question` forwarded via partial/final pipeline.
- Existing NO_REPLY behavior unchanged.
- Test suite for touched modules passes.
