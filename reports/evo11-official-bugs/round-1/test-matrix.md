# Test Matrix - Round 1

| ruleId | 场景 | 输入 | 期望 | 判定 |
|---|---|---|---|---|
| BUG-23939-01 | node set 返回 malformed payload | `exec.approvals.node.set` 返回空对象 | 网关拒绝并返回错误 | UNTESTED |
| BUG-23427-01 | cdp handshake 成功但 action probe 失败 | `isReachable=true`, `listTabs throws` | `cdpReady=false` | UNTESTED |
| BUG-23801-01 | block/final 同内容 | 两次 deliver 内容相同 | 仅发送一次 | UNTESTED |
| LOCK-01 | owner 存活保持锁 | ownerPid live + startTime match | lock 保持 | PASS |
| LOCK-02 | owner 死亡立即失效 | ownerPid dead | stale-owner-dead | PASS |
| LOCK-03 | PID 复用立即失效 | ownerPid live + startTime mismatch | stale-pid-reused | PASS |
| LOCK-04 | 心跳缺失兼容 | legacy lock 无 heartbeat | 先 owner 存活判定 | PASS |
| LOCK-05 | 跨进程重启接管 | dispatcher crash 后新进程接管 | stale 后可续跑 | PASS |
| LOCK-06 | 心跳超时但 owner 存活 | heartbeat old + owner alive | 保持互斥并告警 | PASS |
| LOCK-07 | 非 JSON 锁文件 | lock 内容损坏 | locked-invalid | PASS |
| LOCK-08 | 并发回收互斥 | 双竞争者 stale 回收 | 仅一方成功回收 | PASS |
| LOCK-09 | legacy TTL 兜底 | 无 owner 元数据且 ttl 过期 | stale-ttl-expired | PASS |

## 死规则列表
- 无（在当前技能文档中，LOCK-01..LOCK-09 均可检索到对应规则）

## 覆盖率
- 已测/总计: 9/12
- 覆盖率: 75%
