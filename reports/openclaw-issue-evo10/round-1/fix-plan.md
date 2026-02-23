# Fix Plan - Round 1

## Groups

### Group A - image history cache

- Findings: R1-01
- Files:
  - src/agents/tool-images.ts
  - src/agents/tool-images.cache.test.ts
- 验证：pnpm exec vitest run src/agents/tool-images.cache.test.ts

### Group B - prompt cache prefix partition

- Findings: R1-02
- Files:
  - src/agents/system-prompt.ts
  - src/agents/system-prompt.e2e.test.ts
- 验证：pnpm exec vitest run --config vitest.e2e.config.ts src/agents/system-prompt.e2e.test.ts

## 串行合并顺序

A -> B
