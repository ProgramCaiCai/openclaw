# T2 ToolTruncate (hard-cap tool output to 50KB / 2000 lines)

Branch: `codex/tool-truncate-50kb-2000lines`
Commits:

- `7f81e85c2` `fix(agents): hard-cap tool outputs to 50KB/2000 lines`
- `07c1ce90d` `test(agents): avoid any in tool output hard cap tests`

## What Changed

### Tool output hard caps (core)

- Added `src/agents/tool-output-hard-cap.ts`
  - `hardTruncateText()` enforces a strict hard limit: <= 50KB UTF-8 bytes and <= 2000 lines.
  - `hardCapToolOutput()` deep-caps all strings in arbitrary tool payload objects and ensures the serialized payload stays <= 50KB (falls back to a bounded preview object when needed).

### Tool execution event stream (partial + final + error)

- Updated `src/agents/pi-embedded-subscribe.handlers.tools.ts`
  - `tool_execution_update` partial results: `partialResult` is now passed through `hardCapToolOutput()` before `emitAgentEvent()`.
  - `tool_execution_end` final results (including errors): `result` is now passed through `hardCapToolOutput()` before `emitAgentEvent()`.
  - Internal error extraction continues to use the sanitized (pre-cap) result so error detection remains stable.

### Tool result sanitization (line cap)

- Updated `src/agents/pi-embedded-subscribe.tools.ts`
  - `sanitizeToolResult()` text blocks now run through `hardTruncateText()` first, preventing pathological cases where <=8000 chars could still exceed 2000 lines.

### Session persistence guard (prevents huge tool results in context)

- Updated `src/agents/session-tool-result-guard.ts`
  - ToolResult messages are normalized to a flattened, text-only form when required, and then hard-capped via `hardTruncateText()` (bytes + lines).
  - This prevents oversized tool results (and potential binary payloads) from being persisted into the session transcript/context.

### Overflow auto-recovery path (no re-injection)

- Updated `src/agents/pi-embedded-runner/tool-result-truncation.ts`
  - `truncateToolResultText()` now enforces the global hard cap as a final safety net.
  - Oversize detection now considers both context-window sizing and the fixed 50KB/2000-line hard cap.
  - Truncation rewrite path uses a flattened single text block and therefore cannot re-append oversized tool output.

### Tool wrapper layer

- Added `src/agents/tool-output-hard-truncate.ts` and `src/agents/tool-output-hard-truncate.test.ts`.
- Updated `src/agents/pi-tools.ts` to wrap all tools with `wrapToolWithHardOutputTruncate()`.
  - This clamps tool `onUpdate` partial results, final results, and tool errors at the tool execution layer.

## Tests / Verification

Ran the minimal targeted unit tests:

```bash
cd /Users/programcaicai/clawd/projects/openclaw
pnpm vitest \
  src/agents/session-tool-result-guard.test.ts \
  src/agents/pi-embedded-runner/tool-result-truncation.test.ts \
  src/agents/pi-embedded-subscribe.handlers.tools.hard-cap.test.ts \
  src/agents/tool-output-hard-truncate.test.ts
```

## Notes / Risks

- The hard caps are enforced in multiple layers (tool wrapper, agent-event emission, and session persistence) to protect both real-time streams and persisted context.
- The persistence guard normalizes toolResult messages to text-only when caps must be enforced; if any downstream depends on non-text toolResult blocks in the transcript, validate that behavior.
