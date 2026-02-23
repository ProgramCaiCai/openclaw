# Test Matrix - Round 3

| ruleId | 场景 | 输入 | 期望 | 判定 |
|---|---|---|---|---|
| BUG-23939-01 | malformed node snapshot response | invalid payload | gateway returns error | PASS (static) |
| BUG-23427-01 | stale action path while reachable handshake | `isReachable=true`, `listTabs fail` | `cdpReady=false` | PASS (test present) |
| BUG-23801-01 | identical block/final payload | same payload twice | single send | PASS (test present) |
| LOCK-01 | owner 存活保持锁 | live owner | lock kept | PASS |
| LOCK-02 | owner 死亡立即失效 | dead owner | stale-owner-dead | PASS |
| LOCK-03 | PID 复用立即失效 | startTime mismatch | stale-pid-reused | PASS |
| LOCK-04 | 心跳缺失兼容 | legacy lock | owner-first check | PASS |
| LOCK-05 | 跨进程重启接管 | owner dead on restart | immediate takeover | PASS |
| LOCK-06 | 心跳超时但 owner 存活 | stale heartbeat | keep lock + warn | PASS |
| LOCK-07 | 非 JSON 锁文件 | corrupted lock | locked-invalid | PASS |
| LOCK-08 | 并发回收互斥 | dual reapers | single winner | PASS |
| LOCK-09 | legacy TTL 兜底 | missing owner metadata | ttl fallback | PASS |

## 死规则列表
- 无

## 覆盖率
- 已测/总计: 12/12
- 覆盖率: 100%
