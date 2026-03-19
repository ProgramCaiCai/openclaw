# Responses Completion Hardening Design

**Date:** 2026-03-18

**Status:** Approved

**Owner:** Codex design pass

## Goal

Make OpenClaw treat OpenAI Responses requests as successful only when the request reaches a verified terminal completion state, across both WebSocket and non-WebSocket transports.

## Problem Statement

OpenClaw currently has two different completion models for Responses-based providers:

- The WebSocket path in `src/agents/openai-ws-stream.ts` already behaves close to Codex semantics by waiting for `response.completed` and rejecting on `response.failed` or mid-request close.
- The non-WebSocket path falls back to `streamSimple`, which ultimately inherits success/failure semantics from `@mariozechner/pi-ai` and the OpenAI SDK. That path can end without a verified terminal completion event and still be surfaced as success if the underlying stream stops without throwing.

This leaves a correctness gap:

- request-level completeness is not enforced uniformly,
- replay and retry logic is split between transport-specific logic and higher-level empty-deliverable retries,
- transcript safety depends on higher-level heuristics instead of a transport invariant.

The requirement for this hardening pass is stricter:

- a request must be considered successful only if OpenClaw verifies a complete terminal outcome,
- both `ws` and non-`ws` transports must obey the same rule,
- incomplete attempts must be retried inside the transport layer before any partial success reaches the session transcript.

## Relevant Prior Commits And What They Teach

### `980619b9be` - `fix: harden openai websocket replay`

This commit already identified that replay state is fragile. The important lessons are:

- replay state must be explicit and transport-local,
- stale `previous_response_id` / context deltas must be cleared on fallback or transport reset,
- reconnect accounting and replay accounting must not be mixed.

This design keeps those lessons, but moves them into a single Responses transport orchestrator instead of leaving them WS-specific.

### `44767321ad` - `fix: propagate pi-agent-core stream errors`

This commit proved that silent stream termination is unacceptable. The hardening pass should preserve that direction, but stop depending on downstream patch behavior for core correctness.

This design therefore keeps dependency behavior as an input, not as the source of truth:

- downstream exceptions are still propagated,
- but OpenClaw itself owns terminal completion validation.

### `4a22851e68`, `f2faf9ae37`, `3c9a0fa0ff`, `a930ef3d73`, `0f909f353c`

These commits created the current higher-level fail-closed and silent retry protections for empty or incomplete Responses runs. They remain valuable, but they should become the final hedge rather than the primary definition of completeness.

This design preserves them with a narrower responsibility:

- transport layer decides whether the request completed,
- upper layers still retry empty/no-deliverable outcomes after a complete transport run,
- transcript baseline restore remains the final safety net for pathological upstream behavior.

## Non-Negotiable Invariants

For every provider whose resolved `model.api` is `openai-responses` or `openai-codex-responses`:

1. Success requires a verified terminal event.
2. The verified terminal event must resolve to `status === "completed"`.
3. `status === "incomplete"` is not success.
4. `response.failed` is not success.
5. EOF or close before terminal completion is not success.
6. Idle timeout before terminal completion is not success.
7. Transport-internal retries must not leak intermediate assistant turns into the session transcript.
8. The upper layer may still apply empty-deliverable retries, but only after transport completeness has been established.

## Recommended Architecture

OpenClaw should own a canonical Responses transport entrypoint for all Responses-based models:

- `src/agents/openai-responses-stream.ts`

This file becomes the orchestrator and the single source of truth for:

- terminal-state validation,
- request-level retry budgets,
- stream-level retry budgets,
- transcript-safe replay behavior,
- dispatch to WS or strict HTTP/SSE sub-drivers.

### Transport Ownership Split

#### Canonical orchestrator

`src/agents/openai-responses-stream.ts`

Responsibilities:

- determine whether a request should use WS or HTTP/SSE,
- own retry budgets,
- own the terminal-state state machine,
- normalize all incomplete/failure cases into a shared error model,
- guarantee that only final success or final failure escapes the transport boundary.

#### WebSocket sub-driver

`src/agents/openai-ws-stream.ts`

Responsibilities after refactor:

- connect/send/receive via the existing manager,
- emit parsed stream events into the shared state machine,
- preserve existing replay-related fixes from `980619b9be`,
- stop being the only strict transport in the codebase.

#### Strict HTTP/SSE sub-driver

New file:

- `src/agents/openai-responses-http-stream.ts`

Responsibilities:

- issue Responses requests for non-WS and custom-provider paths,
- parse SSE/stream events directly,
- detect terminal completion explicitly,
- reject early EOF / premature stream end,
- avoid relying on `streamSimple` for completion correctness.

## Routing Changes

Current routing in `src/agents/pi-embedded-runner/run/attempt.ts` special-cases only:

- `params.model.api === "openai-responses" && params.provider === "openai"`

That is too narrow. The new routing rule should be:

- if `params.model.api` is `openai-responses` or `openai-codex-responses`, always use the canonical OpenClaw Responses transport,
- the canonical transport can still internally choose WS or HTTP/SSE based on provider and options,
- all other model APIs continue to use existing stream functions.

This is the key move that makes WS and non-WS semantics identical.

## Terminal Completion Model

The canonical transport must explicitly track:

- whether the request was started,
- whether any output was received,
- whether a terminal event was seen,
- what terminal status was seen,
- whether the request is replayable in the current attempt budget.

### Allowed success terminal

- `response.completed`
- terminal `response.status === "completed"`

### Explicit incomplete/failure terminals

- `response.completed` with `status === "incomplete"`
- `response.failed`
- terminal status `failed`
- terminal status `cancelled`

### Premature termination

These are treated as incomplete stream failures even if the underlying library does not throw:

- WS close before terminal success,
- SSE body end before terminal success,
- idle timeout before terminal success,
- iterator completion without terminal success.

This is the Codex-like semantic change that closes the current gap.

## Retry Model

Retries must be split into two budgets.

### Request retries

Used for:

- initial connect failure,
- request creation failure,
- pre-stream upstream errors such as 429/5xx/network failures before a stable stream is established.

Suggested config:

- `requestMaxRetries`
- `requestRetryBaseDelayMs`

### Stream retries

Used for:

- premature EOF,
- close mid-request,
- idle timeout,
- `response.completed` with `status === "incomplete"`,
- replayable protocol-level interruption after streaming began.

Suggested config:

- `streamMaxRetries`
- `streamRetryBaseDelayMs`
- `streamIdleTimeoutMs`

### Replay behavior

Replay must happen inside the transport boundary. That means:

- no intermediate assistant error message is appended to the session,
- no partial transcript state escapes,
- the caller sees only final success or final failure.

For WS, existing replay state can continue to use `previous_response_id` where safe.

For strict HTTP/SSE, replay should resend the same request payload from a clean transport attempt.

## Transcript Safety

The transport must not mutate persisted session state during a failed internal attempt.

The existing upper-layer baseline restore logic should stay in place because it protects against:

- empty deliverables after a formally complete transport run,
- legacy or third-party paths that still surface unexpected session mutations,
- subagent and managed-transcript retry flows already covered by `0f909f353c`.

But transcript correctness should no longer depend on it for ordinary premature stream endings.

## Configuration Strategy

The first hardened version should default to strict behavior for all Responses APIs:

- `openai-responses`
- `openai-codex-responses`

No legacy compatibility flag should be added in the first pass unless a known production provider demonstrably cannot emit terminal events correctly.

Reason:

- the user requirement is "must guarantee request completeness",
- an opt-out compatibility mode would reintroduce silent-success ambiguity.

If a carve-out is needed later, it should be provider-scoped and explicit in compat metadata rather than a global softening flag.

## Error Surfacing

Transport-layer terminal failures should surface as a specific, normalized failure category, for example:

- `responses_incomplete`
- `responses_premature_eof`
- `responses_terminal_failed`
- `responses_idle_timeout`

These should be distinguishable from:

- ordinary provider 429/5xx transient failures,
- empty-deliverable post-processing failures,
- context overflow or compaction failures.

That separation keeps existing upper-layer retry and failover logic coherent.

## Test Strategy

### WebSocket tests

Extend:

- `src/agents/openai-ws-stream.test.ts`

Cover:

- `response.completed + completed` succeeds,
- `response.completed + incomplete` retries, then fails if budget exhausted,
- mid-request close retries instead of immediately surfacing,
- replay state is cleared on fallback/reset,
- no duplicate assistant message is emitted across internal retries.

### HTTP/SSE strict tests

Add:

- `src/agents/openai-responses-http-stream.test.ts`

Cover:

- terminal completed succeeds,
- `response.failed` fails,
- terminal `status === "incomplete"` is treated as incomplete and retried,
- EOF before terminal completion fails closed,
- iterator completion without terminal event fails closed,
- idle timeout fails closed.

### Routing tests

Add or extend:

- `src/agents/pi-embedded-runner/...` tests

Cover:

- custom providers with `api: "openai-responses"` route into the canonical transport,
- `provider === "openai"` still chooses WS-capable behavior when allowed,
- fallback to strict HTTP path still preserves strict completion semantics.

### Higher-level retry regression tests

Keep and update:

- `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`
- `src/agents/pi-embedded-runner.run-incomplete-openai-retry.e2e.test.ts`

Confirm:

- empty-deliverable retry still works,
- baseline restore still works,
- transport-complete but empty-result retries still do not pollute transcripts,
- transport-internal retries do not create extra top-level attempts.

## Migration Notes

This design explicitly avoids introducing new wrapper layers around existing business logic. The new canonical transport is the primary path, not an adapter glued onto `streamSimple`.

That keeps with repository constraints:

- single canonical implementation,
- no shim-style compatibility layer,
- fail fast on invariant violations,
- long-term maintainability over opportunistic patches.

## Implementation Recommendation

Proceed in this order:

1. Add the canonical transport and shared terminal-state model.
2. Move non-WS Responses handling onto strict HTTP/SSE parsing.
3. Rewire WS handling to the same terminal-state contract and retry budgeting.
4. Route all Responses APIs through the canonical transport.
5. Keep current upper-layer empty-deliverable retry logic, but narrow its role to final hedge behavior.

This sequence provides the correctness guarantee first and preserves prior retry hardening as defense in depth.
