# ctx-safe cherry-pick sync report (2026-02-24)

- Repo: `/Users/programcaicai/clawd/projects/openclaw`
- Target branch: `main`
- Start commit: `c15399c5c8`
- Source branch: `feat/ctx-safe` (tip `065f4776a`)
- Merge base (`main`, `feat/ctx-safe`): `b817600533129771ace2801d7c05901c7f850fb8`

## Candidate commits from `feat/ctx-safe`

`b8176005..065f4776a` contains:

1. `4b316c33d` Auto-reply: normalize stop matching and add multilingual triggers (#25103)
2. `44749c3a6` feat(ctx-safe): port tool context trimming from dev
3. `c02a81ce7` fix(ctx-safe): apply hard caps in event handlers and fix test assertions
4. `01da7d5ba` chore(ctx-safe): regenerate protocol schema for safeLimit param
5. `d851c5fb7` fix(ctx-safe): remove unused ToolCall type alias
6. `4a8dd8c76` fix(ctx-safe): remove non-existent timeoutSeconds assertion from sessions_spawn schema test
7. `ade0f6ef7` feat(ctx-safe): auto-save artifact on persistence truncation
8. `065f4776a` fix(rebase): restore web-fetch constants and AnyAgentTool import

## Applied to `main`

Cherry-picked (in order):

- `44749c3a6`
- `c02a81ce7`
- `d851c5fb7`
- `4a8dd8c76`
- `ade0f6ef7`
- `065f4776a`

Not applied:

- `4b316c33d` (non-ctx-safe upstream feature commit)
- `01da7d5ba` (empty when cherry-picking; changes already present)

## Build validation

- Ran `pnpm build` after cherry-picks and after conflict/parse fixes.
- Build status: **PASS**

## Additional fix commit

During cherry-pick integration, duplicate declarations were introduced and fixed with:

- `c1d9ffbb3` fix(ctx-safe-sync): resolve duplicate declarations after cherry-pick

## Final state

- Final `main` HEAD: `c1d9ffbb32fe870096ecc6ae5795e809f2c1b610`
