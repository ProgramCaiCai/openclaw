# Fix Plan - Round 8

### Group A

- Findings: R8-01
- Files: none (verification-only)
- Verify:
  - pnpm exec vitest run src/agents/tool-images.cache.test.ts
  - pnpm exec vitest run --config vitest.e2e.config.ts src/agents/tool-images.e2e.test.ts src/agents/system-prompt.e2e.test.ts
