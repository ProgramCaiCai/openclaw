# Fix Group A - exec-approvals-node-set-hardening

## Changed
- src/gateway/server-methods/exec-approvals.ts
  - added `parseExecApprovalsSnapshotPayload` to validate node snapshot payload shape.
  - `exec.approvals.node.set` now parses `payloadJSON ?? payload` and fails closed with `UNAVAILABLE` when payload is malformed.
  - success path now returns normalized/redacted snapshot payload.

## Why
- Addresses #23939 silent-success risk where invalid node response could still appear successful in UI.

## Verification
- Static verification:
  - `rg -n "parseExecApprovalsSnapshotPayload|node returned invalid exec approvals snapshot payload" src/gateway/server-methods/exec-approvals.ts`
- Dynamic tests:
  - `pnpm test -- ...` blocked due missing `node_modules`/`vitest` in this environment.
