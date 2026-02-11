# Tool Output Hard Truncate (50KB / 2000 lines) + Overflow Auto-Recovery (Design)

Scope: OpenClaw source changes (no code in this task). Goal is a P0 "tool-layer" hard clamp on tool outputs (tool results + tool errors) at **50KB** and **2000 lines**, plus an automatic recovery path when provider requests still overflow.

---

## 1) Current State: Where Truncation / Limits Exist Today

### A. Tool result sanitization for streaming events (UI/subscribers)

- File: `src/agents/pi-embedded-subscribe.tools.ts`
- Function: `sanitizeToolResult(result: unknown): unknown`
- Limits:
  - `TOOL_RESULT_MAX_CHARS = 8000` (per text block via `truncateToolText()`)
  - `TOOL_ERROR_MAX_CHARS = 400` (first-line error preview via `normalizeToolErrorText()`)
- Notes:
  - This is _not_ a universal tool-layer clamp for model context. It is used when emitting tool execution events (`handleToolExecutionUpdate` / `handleToolExecutionEnd` in `src/agents/pi-embedded-subscribe.handlers.tools.ts`).
  - Images are stripped (`data` removed; `{ bytes, omitted: true }`).

### B. Hard cap during session persistence (toolResult guard)

- File: `src/agents/session-tool-result-guard.ts`
- Entry point: `installSessionToolResultGuard(sessionManager, opts)`
- Truncation logic: `capToolResultSize(msg: AgentMessage): AgentMessage`
- Limit:
  - Uses `HARD_MAX_TOOL_RESULT_CHARS` imported from `src/agents/pi-embedded-runner/tool-result-truncation.ts`
  - `HARD_MAX_TOOL_RESULT_CHARS = 400_000` (chars, distributed proportionally across text blocks)
  - Minimum keep per block: `2_000` chars (hardcoded inside `capToolResultSize`)
- Notes:
  - This runs _before persisting_ toolResult messages to the session transcript.
  - It is a safety net for extremely large tool outputs, but it is character-based (not bytes/lines) and far above the requested 50KB/2000 lines.
  - Guard can also run a persistence hook: `tool_result_persist` via `src/agents/session-tool-result-guard-wrapper.ts`.

### C. Context-overflow recovery: auto-compaction + tool-result truncation + retry

- File: `src/agents/pi-embedded-runner/run.ts`
- Logic:
  - Detect overflow via `isContextOverflowError()` from `src/agents/pi-embedded-helpers/errors.ts`
  - Auto-compaction retry loop:
    - `MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3`
    - Calls `compactEmbeddedPiSessionDirect(...)`
  - Fallback: session rewrite truncating oversized tool results:
    - `truncateOversizedToolResultsInSession(...)` from `src/agents/pi-embedded-runner/tool-result-truncation.ts`
    - Gated by `sessionLikelyHasOversizedToolResults(...)`
- Tool-result truncation module:
  - File: `src/agents/pi-embedded-runner/tool-result-truncation.ts`
  - Key constants:
    - `MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3`
    - `HARD_MAX_TOOL_RESULT_CHARS = 400_000`
    - `MIN_KEEP_CHARS = 2_000`
  - Behavior:
    - Computes a per-model maxChars from context window tokens (30% share), capped at 400k chars.
    - Truncation is applied either in-memory (`truncateOversizedToolResultsInMessages`) or by rewriting the session transcript (`truncateOversizedToolResultsInSession`).
- Notes:
  - This is already an "overflow auto-recovery" mechanism, but it is reactive and character-based.

### D. Per-tool output caps (example: exec)

- File: `src/agents/bash-tools.exec.ts`
- Limits:
  - `DEFAULT_MAX_OUTPUT` (env `PI_BASH_MAX_OUTPUT_CHARS`, default 200_000 chars)
  - `DEFAULT_PENDING_MAX_OUTPUT` (env `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`, default 200_000 chars)
- Notes:
  - This is tool-specific and still character-based.

### E. Other truncation that is _not_ tool-layer

- UTF-16 safe slicing helper:
  - File: `src/utils.ts`
  - Functions: `sliceUtf16Safe()`, `truncateUtf16Safe()`
- Transcript compaction by lines (gateway API):
  - File: `src/gateway/server-methods/sessions.ts`
  - Method: `sessions.compact` uses `maxLines` (default 400) to keep last N transcript lines.
- Outbound message chunking (channel delivery):
  - File: `src/channels/dock.ts`
  - Config: `outbound.textChunkLimit` varies by channel/plugin.

---

## 2) Proposed Minimal-Intrusion Implementation (Tool-Layer 50KB + 2000 Lines)

### Design goals

- Enforce a **single, uniform clamp** at the tool execution boundary (covers all tools, including partial updates).
- Apply **both** constraints:
  - `maxBytesUtf8 = 50 * 1024`
  - `maxLines = 2000`
- Truncate **UTF-16 safely** (no broken surrogate pairs) while respecting **UTF-8 byte budget**.
- Preserve structured tool result shape (keep `content` blocks; keep non-text blocks).
- When truncated, append a short ASCII hint explaining the clamp and how to get more via smaller reads/offsets.

### Where to implement (minimal touch points)

1. **Tool execute wrapper** (primary "tool-layer" enforcement)

- File to change: `src/agents/pi-tools.ts`
- Location: inside `createOpenClawCodingTools(...)` before returning tools.
- Add a wrapper in the tool pipeline similar to existing wrappers (`wrapToolWithBeforeToolCallHook`, `wrapToolWithAbortSignal`).

Proposed wrapper API:

- New file: `src/agents/tool-output-hard-truncate.ts`
- Export:
  - `hardTruncateToolPayload(result: unknown, opts: { maxBytesUtf8: number; maxLines: number; suffix: string }): unknown`
  - `hardTruncateToolError(err: unknown, opts: same): unknown` (optional; see below)
  - Helpers for UTF-8 byte truncation + newline/line truncation.

Wrapper behavior:

- `wrapToolWithHardOutputTruncate(tool, limits)` returns a tool with:
  - `execute(toolCallId, args, signal, onUpdate)` that:
    - Calls underlying `tool.execute` with an `onUpdate` proxy that truncates `partialResult` via `hardTruncateToolPayload`.
    - Truncates the final returned result via `hardTruncateToolPayload`.
    - If the underlying tool throws and the error message is huge, optionally rewrite the thrown error's message (keep stacks out of model context).

This is the smallest-surface place to guarantee every tool is clamped (including custom tools from `createOpenClawTools(...)`, channel tools, etc.).

2. **Session persistence guard** (secondary safety net)

- File to change: `src/agents/session-tool-result-guard.ts`
- Update `capToolResultSize` to apply the new hard limits (50KB/2000 lines) instead of (or before) the 400k-char guard.

Rationale:

- Even with a tool execute wrapper, legacy sessions or edge cases (tools not going through the wrapper, or future changes) can persist oversized toolResult blocks.

3. **Subscriber/UI sanitization** (optional alignment)

- File: `src/agents/pi-embedded-subscribe.tools.ts`
- Today it uses 8000 chars and strips image data.

Options:

- Keep as-is (it is for UI, and 8000 chars is intentionally smaller than 50KB).
- Or refactor to reuse the new truncation helper for text truncation, while still keeping a UI-specific lower limit.

### Truncation algorithm details

#### A. Line truncation (max 2000 lines)

- Apply line cap first because it is deterministic and avoids building huge arrays.
- Implementation detail:
  - Scan for newline boundaries until N lines, record the cut index.
  - Treat lines split on `\n` (normalize `\r\n` by handling `\r` before `\n` or by scanning for `\n` and ignoring preceding `\r`).

#### B. UTF-8 byte truncation (max 50KB) with UTF-16 safety

- Measure bytes using `Buffer.byteLength(text, "utf8")`.
- If bytes exceed budget:
  - Reserve space for suffix bytes: `budget = maxBytesUtf8 - byteLen(suffix)`.
  - Find the maximum UTF-16 code-unit index `i` such that `byteLen(sliceUtf16Safe(text, 0, i)) <= budget`.
  - Use binary search over `i in [0, text.length]`.
  - Return `sliceUtf16Safe(text, 0, i) + suffix`.

Note: `src/utils.ts` already provides `sliceUtf16Safe()`; reusing it avoids surrogate pair corruption.

#### C. Preserving structured tool results

Expected common shape for tool results in OpenClaw tools:

- `{ content: [{ type: "text", text: string }, { type: "image", ... }, ...], details?: ... }`

Proposed handling:

- If `result` is an object with `content: Array<...>`:
  - Iterate blocks in order.
  - Maintain shared remaining budgets: `remainingLines`, `remainingBytes`.
  - For each text block:
    - Truncate its text against remaining budgets.
    - Decrease budgets by actual kept lines/bytes.
    - If budgets are exhausted, replace subsequent text blocks with a short placeholder (or empty string) to preserve structure.
  - Non-text blocks:
    - Keep as-is (image payloads are already handled elsewhere by `sanitizeToolResultImages` in `src/agents/tool-images.ts`).

- If `result` is a plain string:
  - Truncate string directly (line + byte) and return a string.

Truncation suffix (ASCII):

- Example: `"\n\n[tool output truncated: exceeded 50KB or 2000 lines; request smaller chunks (offset/limit) or specific sections]"`

---

## 3) Overflow Auto-Recovery: Existing Hooks and Proposed Placement

### What exists today

- Context overflow detection:
  - File: `src/agents/pi-embedded-helpers/errors.ts`
  - Function: `isContextOverflowError(errorMessage?: string): boolean`
- Retry loop + auto-compaction:
  - File: `src/agents/pi-embedded-runner/run.ts`
  - Functionality: on overflow -> `compactEmbeddedPiSessionDirect(...)` -> retry (up to 3)
- Second-stage recovery:
  - File: `src/agents/pi-embedded-runner/run.ts`
  - Fallback: if session likely contains oversized toolResult -> `truncateOversizedToolResultsInSession(...)` -> retry

### What is missing / why it still matters

- The current truncation fallback is character-based and aims at "fit in context window". It does not implement the requested fixed hard limits (50KB/2000 lines).
- Provider-side failures may also be triggered by payload size limits that are effectively byte-based (HTTP 413 / request too large). Hard truncation by bytes is the more robust preemptive solution.

### Proposed recovery flow (minimal change)

Primary: **prevent** overflow by clamping tool outputs at execution time.

Secondary: if a provider call still fails with an overflow-like error:

1. Keep existing `compactEmbeddedPiSessionDirect(...)` retry loop.
2. Replace or extend the current "toolResult truncation" fallback to apply the new hard truncation to toolResult messages in the session:

- Update `src/agents/pi-embedded-runner/tool-result-truncation.ts`:
  - Add a new session rewrite helper (or modify existing) that truncates toolResult text blocks by `{ maxBytesUtf8: 50KB, maxLines: 2000 }`.
  - Reuse `sliceUtf16Safe()` from `src/utils.ts`.

3. Extend overflow detection if needed:

- File: `src/agents/pi-embedded-helpers/errors.ts`
- If there are known provider strings like "tool output too large" / "tool_result too large", add them to `isContextOverflowError()` (or add a sibling `isPayloadTooLargeError()` used by the retry loop in `src/agents/pi-embedded-runner/run.ts`).

---

## 4) Next Steps (Concrete File/Test Touch List)

### A. New module

- Add: `src/agents/tool-output-hard-truncate.ts`
  - Implement:
    - `truncateTextByLinesAndBytesUtf8(text, limits)`
    - `hardTruncateToolPayload(result, limits)`
  - Use `sliceUtf16Safe()` / `truncateUtf16Safe()` from `src/utils.ts`.

### B. Apply at tool layer

- Edit: `src/agents/pi-tools.ts`
  - Add `wrapToolWithHardOutputTruncate()` and apply it across the final tool list (after policy filtering / schema normalization, but before returning).
  - Ensure it truncates both final results and `onUpdate` partial results.

### C. Persistence safety net

- Edit: `src/agents/session-tool-result-guard.ts`
  - Replace `capToolResultSize()` logic (400k chars) with the new `{ 50KB, 2000 lines }` clamp, or apply the new clamp first and keep 400k as an additional ceiling.

### D. Overflow recovery alignment

- Edit: `src/agents/pi-embedded-runner/tool-result-truncation.ts`
  - Either:
    - Extend truncation logic to support the new line+byte clamp; or
    - Add a sibling rewrite function used only for recovery.

- Edit: `src/agents/pi-embedded-runner/run.ts`
  - Call the new recovery truncation when overflow persists.

### E. Tests

- Add: `src/agents/tool-output-hard-truncate.test.ts`
  - Cases:
    - Under limit (no change)
    - Over byte limit (UTF-8) (binary search correctness)
    - Over line limit
    - Both limits hit
    - UTF-16 surrogate boundary safety (no invalid pair)
    - Multi-block `content` preserves structure

- Update/add integration-style tests:
  - `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts` (or add a new one) to cover: overflow -> recovery truncation -> retry.

---

## Quick checklist for Dispatcher review

- Found current truncation points:
  - Tool event sanitization: `src/agents/pi-embedded-subscribe.tools.ts` (8000 chars / 400 chars)
  - Persistence guard: `src/agents/session-tool-result-guard.ts` (400k chars)
  - Overflow recovery truncation: `src/agents/pi-embedded-runner/tool-result-truncation.ts` + `src/agents/pi-embedded-runner/run.ts`
  - Per-tool caps: `src/agents/bash-tools.exec.ts` (200k chars)
- Proposed minimal-intrusion placement:
  - Tool execute wrapper in `src/agents/pi-tools.ts` + shared truncation helper module
  - Keep persistence guard as backstop
  - Align overflow recovery rewrite with the new clamp
