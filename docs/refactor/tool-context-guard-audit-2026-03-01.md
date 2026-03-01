# Tool Context Guard Audit (2026-03-01)

## Scope

- Baseline commit: `0050300f9a9b36f6953d57aa78755cec259fbedf`
- Target: audit all tool execution paths for context blow-up risk and missing safeguards.
- Focus areas:
  - tool output truncation/hard cap
  - pre-LLM context guard
  - session persistence guard
  - non-embedded direct tool execution paths

## Existing safeguards (confirmed)

- Hard truncate wrapper for coding tools:
  - `src/agents/pi-tools.ts` (`wrapToolWithHardOutputTruncate(...)`)
- Event stream hard cap:
  - `src/agents/pi-embedded-subscribe.handlers.tools.ts` (`hardCapToolOutput(...)` on update/result)
- Session persistence cap for toolResult:
  - `src/agents/session-tool-result-guard.ts` (`truncateToolResultMessage(...)`)
- Pre-LLM tool result context guard on main run path:
  - `src/agents/pi-embedded-runner/run/attempt.ts` (`installToolResultContextGuard(...)`)

## Findings

### 1) High: non-standard object payload can bypass hard truncate before adapter coercion

- Risk:
  - A tool returning a large object without `content` is not truncated in `hardTruncateToolPayload`.
  - Later adapter coercion serializes this object into `content[0].text`, reintroducing oversized text into model context.
- Evidence:
  - `src/agents/tool-output-hard-truncate.ts`:
    - `hardTruncateToolPayload(...)` early-returns unchanged when payload has no `content`.
  - `src/agents/pi-tool-definition-adapter.ts`:
    - `normalizeToolExecutionResult(...)` coerces non-standard result into text via `JSON.stringify(...)`.
- Repro (local):
  - Returning a large plain object from a wrapped tool produced `contentChars=20015` with no truncate marker.
  - Returning a large string under same limits was truncated and produced artifact preview marker.

### 2) Medium: compaction path does not install pre-LLM tool-result context guard

- Risk:
  - Main run path installs `installToolResultContextGuard(...)`, but compaction path does not.
  - If large tool results survive upstream guards, compaction call can still carry inflated context.
- Evidence:
  - Guard installed in `src/agents/pi-embedded-runner/run/attempt.ts`.
  - No corresponding install call in `src/agents/pi-embedded-runner/compact.ts` before `session.compact(...)`.

### 3) Low: direct tool execution paths are not wrapped with hard truncate

- Risk:
  - These paths execute `createOpenClawTools(...)` tools directly and do not apply `wrapToolWithHardOutputTruncate(...)`.
  - They are not the primary LLM-context path, but still lack the same output-size envelope.
- Evidence:
  - `src/gateway/tools-invoke-http.ts` executes tool directly from `createOpenClawTools(...)`.
  - `src/auto-reply/reply/get-reply-inline-actions.ts` executes tool directly for slash skill dispatch.

## Already improved in this branch (context marker UX)

- File: `src/agents/pi-embedded-runner/tool-result-context-guard.ts`
- Kept canonical markers unchanged for compatibility:
  - `[truncated: output exceeded context limit]`
  - `[compacted: tool output removed to free context]`
- Added second-line structured context details:
  - call/tool id where available
  - original/limit or removed char estimates
  - tool-specific recovery hint
- Tool-specific hints now include:
  - `read`: `Use read with offset/limit for specific ranges.`
  - `exec`/`bash`: `For shell output, rerun narrower commands with grep/jq/awk/head/tail to extract specific sections.`

## Recommended remediation order

1. Fix high-risk gap:
   - Ensure large non-standard object results are bounded before/at normalization.
2. Add parity guard to compaction path:
   - Install `installToolResultContextGuard(...)` in `compact.ts`.
3. Add output cap parity for direct execution paths:
   - Apply equivalent hard truncate/hard cap in `tools-invoke-http.ts` and inline skill tool dispatch path.

## Cross-Project Reference (codex)

### What codex does well (borrowable)

1. Layered protection model:
   - runtime output capping (head+tail)
   - pre-LLM truncation with token/byte policy
   - formatting/serialization-time clipping
2. Truncation marker consistency:
   - stable marker templates (chars/tokens removed, total lines)
   - strong test coverage for shell/MCP/unified_exec paths
3. Tool capability-level recovery knobs:
   - `max_output_tokens` (exec-like paths)
   - `offset/limit` (read/list-like paths)

### Risks observed in codex (avoid copying as-is)

1. Raw event/persistence paths can retain pre-truncated payloads.
2. Non-standard MCP outputs can be adapted without hard size constraints.
3. Image payloads may bypass text-focused truncation budgets.
4. Event channel uses unbounded transport in key path.

### OpenClaw implementation takeaways

1. Keep marker strings stable, add metadata as secondary line (already done in this branch).
2. Enforce a single canonical hard-cap function across:
   - pre-LLM context
   - event streaming
   - transcript persistence
   - direct HTTP/inline tool execution paths
3. Add structure-aware capping for non-text payloads (images/base64/objects), not only text blocks.
4. Keep tool-specific recovery hints, but generate them from a centralized policy map.
5. Add regression tests for bypass shapes:
   - object-without-content
   - large image/data URL payloads
   - direct invocation paths not using embedded runner

## Extra Reference Material

- `/Users/programcaicai/clawd/memory/KNOWLEDGE_BASE/BLACKANGER_TWEET_2027345330505924638.md`
- Useful principle alignment for this topic:
  - treat context as managed memory
  - prefer append-only flow and locality
  - use demand loading and zone-based budget control
  - treat pruning/RAG as safety nets, not primary design

## Implementation Status (2026-03-01)

- Completed in this branch:
  - Added shared hard-limit resolver:
    - `src/agents/tool-output-hard-limits.ts`
  - Fixed non-content object bypass in hard truncation:
    - `src/agents/tool-output-hard-truncate.ts`
  - Added adapter-level coercion bounds for large non-standard tool results:
    - `src/agents/pi-tool-definition-adapter.ts`
  - Routed direct execution paths through hard truncation policy:
    - `src/gateway/tools-invoke-http.ts`
    - `src/auto-reply/reply/get-reply-inline-actions.ts`
  - Added pre-LLM tool-result context guard to compaction path:
    - `src/agents/pi-embedded-runner/compact.ts`
- Added/updated tests:
  - `src/agents/tool-output-hard-truncate.test.ts`
  - `src/agents/pi-tool-definition-adapter.test.ts`
  - `src/gateway/tools-invoke-http.test.ts`
  - `src/auto-reply/reply/get-reply-inline-actions.skip-when-config-empty.test.ts`
