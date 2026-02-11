# Review (T1 + T2)

Reviewer: Dispatcher (note: runtime lacks `sessions_spawn`, so this is a self-review rather than an independent subagent).

## T1 TokenFix (`codex/tokenfix-no-cacheread` / `053ce32b7`)

### Looks Good

- `derivePromptTokens()` now excludes `cacheRead` and still includes `cacheWrite`.
- Call sites updated (object-literal call in `deriveSessionTotalTokens()` no longer passes `cacheRead`).
- Unit coverage updated and includes a direct assertion that `cacheRead` is ignored.

### Potential Regression Points

- Any downstream relying on the previous definition (input + cacheRead + cacheWrite) will observe lower `promptTokens` and potentially lower derived totals in UIs that display prompt token counts.
  - Call sites appear limited (`src/agents/usage.ts`, `src/auto-reply/status.ts`), but if other dashboards assume `cacheRead` is included, validate expectations.

### Tests

- `pnpm vitest src/agents/usage.test.ts` is sufficient and targeted.

## T2 ToolTruncate (`codex/tool-truncate-50kb-2000lines` / HEAD `07c1ce90d`)

### Meets Stated Requirements

- Hard caps are enforced for tool output in multiple layers:
  - Tool wrapper: `src/agents/pi-tools.ts` wraps tools with `wrapToolWithHardOutputTruncate()` so tool `onUpdate`, final result, and thrown errors are bounded.
  - Tool event stream: `src/agents/pi-embedded-subscribe.handlers.tools.ts` caps `partialResult` and `result` before emitting agent events.
  - Session persistence guard: `src/agents/session-tool-result-guard.ts` ensures toolResult transcript messages cannot exceed the hard cap.
  - Overflow recovery: `src/agents/pi-embedded-runner/tool-result-truncation.ts` now includes the hard cap as a safety net to avoid re-appending oversized output.

### Potential Regression Points

- `src/agents/session-tool-result-guard.ts` now normalizes toolResult messages to text-only when caps are enforced, dropping non-text blocks (e.g. images/metadata) to prevent large/binary persistence.
  - If any workflow expects non-text toolResult blocks to be preserved in the session transcript, this is a behavior change; validate with any known image-producing tool flows.
- Two truncation implementations now exist:
  - `src/agents/tool-output-hard-truncate.ts` (tool wrapper) truncates strings and `{content:[...]}` payloads.
  - `src/agents/tool-output-hard-cap.ts` (event emission + overflow safety) deep-caps arbitrary objects and enforces a strict serialized size ceiling.
  - This is defensible as belt-and-suspenders, but it increases maintenance surface.

### Missing / Nice-to-Have Tests

- Add a unit test that proves the tool wrapper clamps a tool result object that does _not_ have a `content` array (if such outputs exist in practice). Current wrapper logic only truncates strings and `{content: [...]}` payloads.
- Add a thin test around `createOpenClawCodingTools()` confirming the wrapper is actually applied (i.e. tool.execute output is truncated) to prevent future refactors from dropping the wrapper.

### Tests Run

- `pnpm vitest src/agents/session-tool-result-guard.test.ts`
- `pnpm vitest src/agents/pi-embedded-runner/tool-result-truncation.test.ts`
- `pnpm vitest src/agents/pi-embedded-subscribe.handlers.tools.hard-cap.test.ts`
- `pnpm vitest src/agents/tool-output-hard-truncate.test.ts`

## Merge Recommendation

- T1: OK to merge.
- T2: OK to merge, with the caveat to validate any flows that rely on non-text toolResult blocks in transcripts (images/metadata) and consider adding the two tests listed above.
