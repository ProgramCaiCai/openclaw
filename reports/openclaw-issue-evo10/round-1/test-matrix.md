| ruleId    | 场景                  | 输入                 | 期望           | 判定     |
| --------- | --------------------- | -------------------- | -------------- | -------- |
| IMG-01    | 重复同图 sanitize     | 同一 base64 重复调用 | 第二次命中缓存 | UNTESTED |
| IMG-02    | 缓存按限制参数区分    | maxDimension 改变    | 触发 miss      | UNTESTED |
| PROMPT-01 | 同安装稳定前缀        | 相同 workspace+agent | 首行一致       | UNTESTED |
| PROMPT-02 | 跨安装差异前缀        | 不同 workspace       | 首行不同       | UNTESTED |
| LOCK-01   | owner 存活保持锁      | N/A                  | PASS           | PASS     |
| LOCK-02   | owner 死亡立即失效    | N/A                  | PASS           | PASS     |
| LOCK-03   | PID 复用立即失效      | N/A                  | PASS           | PASS     |
| LOCK-04   | 心跳缺失兼容          | N/A                  | PASS           | PASS     |
| LOCK-05   | 跨进程重启接管        | N/A                  | PASS           | PASS     |
| LOCK-06   | 心跳超时但 owner 存活 | N/A                  | PASS           | PASS     |
| LOCK-07   | 非 JSON 锁文件处理    | N/A                  | PASS           | PASS     |
| LOCK-08   | 并发回收互斥          | N/A                  | PASS           | PASS     |
| LOCK-09   | legacy TTL 兜底       | N/A                  | PASS           | PASS     |

死规则列表：无
覆盖率：9/13 (69.2%)
