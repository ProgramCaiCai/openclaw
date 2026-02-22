| ruleId           | 场景               | 输入                 | 期望           | 判定     |
| ---------------- | ------------------ | -------------------- | -------------- | -------- |
| IMG-01           | 重复同图 sanitize  | 同一 base64 重复调用 | 第二次命中缓存 | PASS     |
| IMG-02           | 缓存按限制参数区分 | maxDimension 改变    | 触发 miss      | PASS     |
| PROMPT-01        | 同安装稳定前缀     | 相同 workspace+agent | 首行一致       | PASS     |
| PROMPT-02        | 跨安装差异前缀     | 不同 workspace       | 首行不同       | UNTESTED |
| LOCK-01..LOCK-09 | 锁专项             | N/A                  | 覆盖存在       | PASS     |

死规则列表：无
覆盖率：12/13 (92.3%)
