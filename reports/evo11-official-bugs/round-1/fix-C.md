# Fix Group C - feishu-duplicate-fallback-guard

## Changed
- extensions/feishu/src/reply-dispatcher.ts
  - added per-dispatch fallback dedupe state (`lastFallbackSend`).
  - skip final delivery when it exactly repeats the immediately preceding block payload in non-streaming fallback path.
  - reset dedupe state at `onReplyStart`.
- extensions/feishu/src/reply-dispatcher.test.ts
  - added regression test for identical block/final payload dedupe.
  - added control test proving different block/final payloads still send twice.

## Why
- Addresses #23801 duplicate Feishu replies when fallback path emits both block and final with identical content.

## Verification
- Static verification:
  - `rg -n "lastFallbackSend|dedupes identical block/final" extensions/feishu/src/reply-dispatcher.ts extensions/feishu/src/reply-dispatcher.test.ts`
- Dynamic tests:
  - targeted test command attempted but blocked by missing local dependencies (`vitest` not installed).
