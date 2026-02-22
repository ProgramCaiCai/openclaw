# Decomposition - Round 1

## Scope

- scopeSlug: openclaw-issue-evo10
- issues: #23590, #23715
- fileCount: 4, totalLines: 1150

## Constraints

- etaMax: 10min per subtask
- tokenMax: 2000 per worker prompt
- filesMax: 3 per subtask

## Subtasks

### D1-01 image-resize-cache-core

- eta: 9min
- tokenBudget: 1500
- files: src/agents/tool-images.ts
- goal: avoid repeated resize work for the same image payload across turns
- acceptance: repeated sanitize call for identical payload returns cached result
- depends: none

### D1-02 image-cache-regression-tests

- eta: 8min
- tokenBudget: 1200
- files: src/agents/tool-images.cache.test.ts
- goal: verify cache hit/miss behavior and limits-aware invalidation
- acceptance: tests pass and prevent regression of #23590
- depends: D1-01

### D1-03 prompt-prefix-cache-partition

- eta: 8min
- tokenBudget: 1200
- files: src/agents/system-prompt.ts, src/agents/system-prompt.e2e.test.ts
- goal: make opening system prompt line stable-per-installation to reduce cross-tenant cache dilution
- acceptance: first line stable for same install and different for different installs
- depends: none

## DAG

D1-01 -> D1-02; D1-03 parallel

## Gate

- allEtaLe10: pass
- allTokenLe2000: pass
- allFilesLe3: pass
- dagAcyclic: pass
- scopeCovered: pass
