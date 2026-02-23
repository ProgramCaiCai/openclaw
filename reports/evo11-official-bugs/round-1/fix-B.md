# Fix Group B - browser-status-actionability-probe

## Changed
- src/browser/routes/basic.ts
  - added `isActionPathReady(profileCtx)` probe using `listTabs`.
  - status route now computes `cdpReady = cdpReachable && actionReady`.
  - response now includes `actionReady` for diagnostics.
- src/browser/client.ts
  - `BrowserStatus` type extended with optional `actionReady` field.
- src/browser/server.post-tabs-open-profile-unknown-returns-404.test.ts
  - added regression test: handshake reachable but `/json/list` failing must produce `actionReady=false`, `cdpReady=false`, `running=false`.

## Why
- Addresses #23427 false-positive readiness report after idle/stale action channel.

## Verification
- Static verification:
  - `rg -n "actionReady|isActionPathReady" src/browser/routes/basic.ts src/browser/client.ts`
- Dynamic tests:
  - targeted test command attempted but blocked by missing local dependencies (`vitest` not installed).
