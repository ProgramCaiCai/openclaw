# OpenAI Responses cache params implementation checkpoint

## Scope

- Implement `prompt_cache_retention` and `prompt_cache_key` injection for all `openai-responses` providers.
- Implement `previous_response_id` chaining based on prior Responses API outputs.
- Extend model params typing/schema for new OpenAI Responses cache fields.

## Key changes

- `src/agents/pi-embedded-runner/extra-params.ts`
  - Added Responses cache-control wrapper that injects:
    - `prompt_cache_retention` from `params.promptCacheRetention` (`in_memory` | `24h`)
    - `prompt_cache_key` from `params.promptCacheKey`, or auto key derived from session id
    - `previous_response_id` resolved from prior assistant messages / tracked session state
  - Added in-memory tracking keyed by `provider + sessionId` for robust chaining when context is compacted.
  - Kept existing direct OpenAI `store=true` logic intact.
- `patches/@mariozechner__pi-ai@0.54.0.patch`
  - Patched `openai-responses-shared.js` to persist `response.id` onto assistant output as `responseId`, enabling session-level reuse.
- `src/config/types.models.ts`
  - Added `OpenAIResponsesPromptCacheRetention` type.
- `src/config/types.agent-defaults.ts`
  - Added typed `AgentModelParamsConfig` including `promptCacheKey` and `promptCacheRetention`.
- `src/config/zod-schema.core.ts`
  - Added `OpenAIResponsesPromptCacheRetentionSchema` and `AgentModelParamsSchema`.
- `src/config/zod-schema.agent-defaults.ts`
  - Switched model `params` validation to `AgentModelParamsSchema`.
- `src/agents/pi-embedded-runner/extra-params.openai-responses-cache.test.ts`
  - Added focused tests for retention/key/previous_response_id/store behavior.

## Validation

- Passed:
  - `pnpm vitest --run src/agents/pi-embedded-runner/extra-params*.test.ts`
- Known unrelated baseline issue observed:
  - `src/config/config.pruning-defaults.test.ts` has an existing syntax error (unexpected `}`), unrelated to this change.
