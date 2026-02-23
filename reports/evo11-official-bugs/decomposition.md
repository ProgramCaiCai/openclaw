# Decomposition - Round 1

## Scope
- scopeSlug: evo11-official-bugs
- files/patterns:
  - src/gateway/server-methods/exec-approvals.ts
  - src/browser/routes/basic.ts
  - src/browser/server.post-tabs-open-profile-unknown-returns-404.test.ts
  - extensions/feishu/src/reply-dispatcher.ts
  - extensions/feishu/src/reply-dispatcher.test.ts
- fileCount: 5
- totalLines: 918

## Constraints
- etaMax: 10min per subtask
- tokenMax: 2000 per worker prompt
- filesMax: 3 per subtask
- maxDepth: 3
- maxIterations: 30

## Subtasks
### D1-01 node-exec-approvals-persistence
- eta: 9min
- tokenBudget: 1500
- files:
  - src/gateway/server-methods/exec-approvals.ts
- goal: make node-targeted exec approvals writes fail-fast on malformed/empty node payloads instead of silently treating writes as success.
- acceptance:
  - node set path validates returned snapshot shape
  - malformed payload path returns explicit gateway error
  - no behavior change for valid payload flow
- depends: none

### D1-02 browser-cdp-ready-truthfulness
- eta: 10min
- tokenBudget: 1800
- files:
  - src/browser/routes/basic.ts
  - src/browser/server.post-tabs-open-profile-unknown-returns-404.test.ts
- goal: avoid false-positive `cdpReady: true` when action channel is stale by adding an actionability probe to status route.
- acceptance:
  - status adds actionability probe result
  - `cdpReady` derives from both handshake and actionability probe
  - test covers stale action channel case
- depends: none

### D1-03 feishu-duplicate-delivery-guard
- eta: 10min
- tokenBudget: 1700
- files:
  - extensions/feishu/src/reply-dispatcher.ts
  - extensions/feishu/src/reply-dispatcher.test.ts
- goal: dedupe repeated block/final sends with identical payload in non-streaming fallback path to stop duplicate Feishu replies.
- acceptance:
  - identical block/final payload only sends once
  - non-identical payload still sends normally
  - tests cover duplicate and non-duplicate cases
- depends: none

## DAG
D1-01 | D1-02 | D1-03 (parallel)

## Gate
- allEtaLe10: pass
- allTokenLe2000: pass
- allFilesLe3: pass
- dagAcyclic: pass
- scopeCovered: pass
- hasCodeLocalizationTask: pass
