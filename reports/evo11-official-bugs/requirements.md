# evo11-official-bugs 需求清单（Top 10）

- 数据来源：`gh issue list -R openclaw/openclaw --label bug --state open --limit 50`（含 issue 详情补充查询）
- 排序规则：`score = reactions + comments + labelBonus`，其中 `labelBonus`: `P0/critical=+8`、`P1=+5`、`security=+4`。

## 1. #23909 [Bug]: openclaw update fails on Raspberry Pi (arm64) — @discordjs/opus NEON build error
- Issue 编号：`#23909`
- 标题：[Bug]: openclaw update fails on Raspberry Pi (arm64) — @discordjs/opus NEON build error
- 简要描述：`openclaw update` fails on Raspberry Pi 5 (arm64) because `@discordjs/opus` has no prebuilt binary for linux-arm64 and the fallback source compile fails on an ARM NEON intrinsics bug.
- 严重程度评估：**高**；社区关注度高且会导致安装/升级或核心流程失败。（comments=5, reactions=3, labels=bug）

## 2. #23861 [Bug]: Open claw installation fails on npm: ! npm install failed for openclaw@latest
- Issue 编号：`#23861`
- 标题：[Bug]: Open claw installation fails on npm: ! npm install failed for openclaw@latest
- 简要描述：OpenClaw somehow consistently and methodologically was able to ruin my 3 raspberry pi devices during the latest installation process: curl -fsSL https://openclaw.ai/install.sh | bash 🦞 OpenClaw Installer Gateway onlin...
- 严重程度评估：**高**；社区关注度高且会导致安装/升级或核心流程失败。（comments=6, reactions=0, labels=bug）

## 3. #23939 Dashboard node exec security settings don't persist to node's exec-approvals.json
- Issue 编号：`#23939`
- 标题：Dashboard node exec security settings don't persist to node's exec-approvals.json
- 简要描述：When changing a node's exec security settings via the OpenClaw dashboard, the changes appear to save in the UI but are not written to the node's ~/.openclaw/exec-approvals.json file — the node continues enforcing the...
- 严重程度评估：**高（安全）**；涉及安全配置或敏感信息暴露风险，优先级应最高。（comments=1, reactions=0, labels=bug, security）

## 4. #23335 [Bug]: Gateway restart failed health checks.
- Issue 编号：`#23335`
- 标题：[Bug]: Gateway restart failed health checks.
- 简要描述：How can I fix this Error: Gateway restart failed health checks. <img width="1126" height="311" alt="Image" src="https://github.com/user-attachments/assets/f3bc7b58-070e-413c-ad36-dbc4613fcbee" /> I deleted google anti...
- 严重程度评估：**中高**；影响主流程稳定性或成本，需在近期迭代中修复。（comments=2, reactions=2, labels=bug）

## 5. #23715 [Bug]: 5x API costs due to ineffective prompt caching
- Issue 编号：`#23715`
- 标题：[Bug]: 5x API costs due to ineffective prompt caching
- 简要描述：Prompt caching ineffective due to shared system prompt prefix across all users
- 严重程度评估：**中高**；影响主流程稳定性或成本，需在近期迭代中修复。（comments=2, reactions=1, labels=bug）

## 6. #23575 [Bug]:  HTTP 400 Error with DashScope (Aliyun) models when reasoning: true due to unsupported developer role
- Issue 编号：`#23575`
- 标题：[Bug]:  HTTP 400 Error with DashScope (Aliyun) models when reasoning: true due to unsupported developer role
- 简要描述：Description (描述): When configuring the qwen3.5-plus model via the DashScope (Aliyun) provider with "reasoning": true, the application fails to communicate with the API. It appears that OpenClaw attempts to send a mess...
- 严重程度评估：**高**；社区关注度高且会导致安装/升级或核心流程失败。（comments=2, reactions=0, labels=bug）

## 7. #23307 [Bug]: Config migration on upgrade resolves ${ENV_VAR} references to plaintext values
- Issue 编号：`#23307`
- 标题：[Bug]: Config migration on upgrade resolves ${ENV_VAR} references to plaintext values
- 简要描述：After upgrading from 2026.2.19-2 to 2026.2.21-2 via npm install -g openclaw@latest, my openclaw.json was rewritten with live values in place of ${...} env var references. Specifically, my Telegram bot token (previousl...
- 严重程度评估：**高（安全）**；涉及安全配置或敏感信息暴露风险，优先级应最高。（comments=2, reactions=0, labels=bug）

## 8. #23471 [Bug]: Gateway config: schema clarity, valid values, and subagent pairing in Docker
- Issue 编号：`#23471`
- 标题：[Bug]: Gateway config: schema clarity, valid values, and subagent pairing in Docker
- 简要描述：When running OpenClaw in Docker (compose with gateway + CLI/agents), we hit three related areas: 1. **Subagent tools** (`sessions_spawn`, etc.) fail with **gateway closed (1008): pairing required** when the connection...
- 严重程度评估：**高（安全）**；涉及安全配置或敏感信息暴露风险，优先级应最高。（comments=1, reactions=0, labels=bug）

## 9. #23427 [Bug]: Browser CDP connection silently dies after idle period — gateway reports cdpReady but act/snapshot times out
- Issue 编号：`#23427`
- 标题：[Bug]: Browser CDP connection silently dies after idle period — gateway reports cdpReady but act/snapshot times out
- 简要描述：After ~5-6 hours of browser idle time, the Playwright-to-Chrome CDP WebSocket connection silently dies. `browser status` continues reporting `cdpReady: true`, but all `browser act` and `browser snapshot` commands time...
- 严重程度评估：**高**；社区关注度高且会导致安装/升级或核心流程失败。（comments=1, reactions=0, labels=bug）

## 10. #23801 [Bug]: Feishu消息重复发送 - 带Emoji的消息会收到两条
- Issue 编号：`#23801`
- 标题：[Bug]: Feishu消息重复发送 - 带Emoji的消息会收到两条
- 简要描述：使用Feishu通道时，带Emoji或特殊格式的回复会收到两条： 1. 一条是直接发送的消息 2. 另一条显示为"回复" 纯文本消息正常，只有带Emoji/表情符号/卡片格式的消息会重复。 - OpenClaw版本：2026.2.21-2 - 通道：Feishu (cli_a91da767a8785cc7) - 模型：MiniMax-M2.5
- 严重程度评估：**中**；影响明确但范围相对可控，建议纳入本轮修复队列。（comments=1, reactions=0, labels=bug）
