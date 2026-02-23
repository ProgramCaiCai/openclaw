# Fix Plan - Round 1

## 输入
- cross-comparison: reports/evo11-official-bugs/round-1/cross-comparison.md
- test-matrix: reports/evo11-official-bugs/round-1/test-matrix.md

## 计划摘要
- fixReadiness: ready
- fixableFindings: 3
- blockedFindings: 1

## Groups

### Group A - exec-approvals-node-set-hardening
- Type: code-fix
- Findings: R1-01
- Files:
  - src/gateway/server-methods/exec-approvals.ts
- 约束: code-fix 组包含非 reports 文件（满足）
- Worker prompt: <=2000 tokens
- 验证:
  - existing gateway tests pass
  - malformed node payload path returns error
- 风险: low, isolated response normalization/validation

### Group B - browser-status-actionability-probe
- Type: code-fix
- Findings: R1-02
- Files:
  - src/browser/routes/basic.ts
  - src/browser/server.post-tabs-open-profile-unknown-returns-404.test.ts
- 约束: code-fix 组包含非 reports 文件（满足）
- Worker prompt: <=2000 tokens
- 验证:
  - browser control server test includes stale action probe case
- 风险: medium, status semantics change for stale CDP sessions

### Group C - feishu-duplicate-fallback-guard
- Type: code-fix
- Findings: R1-03
- Files:
  - extensions/feishu/src/reply-dispatcher.ts
  - extensions/feishu/src/reply-dispatcher.test.ts
- 约束: code-fix 组包含非 reports 文件（满足）
- Worker prompt: <=2000 tokens
- 验证:
  - new unit tests for duplicate suppression and non-duplicate control
- 风险: low, channel-local dedupe state handling

### Group D - config-migration-localization-gap
- Type: blocked
- Findings: R1-04
- Files:
  - src/config/** (not in current scoped set)
- 验证: n/a
- 风险: cannot claim fix in this round without re-scoping

## 串行合并顺序（建议）
A -> B -> C

## 需要用户决策
- R1-04 needs dedicated scope expansion for config migration path.
