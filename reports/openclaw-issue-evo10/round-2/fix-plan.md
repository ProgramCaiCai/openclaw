# Fix Plan - Round 2

### Group A

- Findings: R2-01
- Files: src/agents/tool-images.cache.test.ts
- Verify: pnpm exec vitest run src/agents/tool-images.cache.test.ts

### Group B

- Findings: R2-02
- Files: src/agents/system-prompt.ts, src/agents/system-prompt.e2e.test.ts
- Verify: pnpm exec vitest run --config vitest.e2e.config.ts src/agents/system-prompt.e2e.test.ts
