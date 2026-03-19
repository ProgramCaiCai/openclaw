# Codex streaming response completion, failure, and retry notes

Date: 2026-03-18

This note summarizes how `~/clawd/projects/codex` decides whether a streaming
Responses API request succeeded, failed, or ended incompletely and should be
retried.

## Core success rule

Codex treats a streamed request as successful only when it receives and parses
`response.completed`.

- SSE path: `codex-rs/codex-api/src/sse/responses.rs`
- WebSocket path: `codex-rs/codex-api/src/endpoint/responses_websocket.rs`

Receiving partial assistant text, tool calls, or `response.created` is not
enough. If the stream ends before `response.completed`, the request is treated
as incomplete.

## Event classification

### Successful completion

- `response.completed` becomes `ResponseEvent::Completed`.
- Once this event is emitted, the stream is considered complete immediately.
- Codex does not require a graceful stream close after `response.completed`.

### Incomplete or disconnected stream

These cases are treated as stream errors:

- EOF before `response.completed`
- idle timeout waiting for more SSE events
- idle timeout waiting for more WebSocket events
- WebSocket close before `response.completed`
- `response.incomplete`

Typical error strings include:

- `stream closed before response.completed`
- `idle timeout waiting for SSE`
- `idle timeout waiting for websocket`
- `websocket closed by server before response.completed`
- `Incomplete response returned, reason: <reason>`

### `response.failed`

`response.failed` is mapped by error code:

- `context_length_exceeded` -> fatal context window error
- `insufficient_quota` -> fatal quota error
- `usage_not_included` -> fatal usage-plan error
- `invalid_prompt` -> fatal invalid request
- `server_is_overloaded` or `slow_down` -> fatal overloaded error
- anything else -> retryable stream error, optionally with parsed retry delay

For rate-limit style messages such as `Please try again in 11.054s`, Codex
extracts the delay and carries it into the retry path.

## Retry model

Codex has two different retry layers.

### Request retry budget

This covers failures before a stable stream is established.

- Config key: `request_max_retries`
- Defaults to `4`
- Applied through `codex-client` retry policy
- Retries transport errors and HTTP 5xx
- Does not retry HTTP 429 in the default Responses provider policy

### Stream retry budget

This covers failures after the request has started streaming but before
`response.completed`.

- Config key: `stream_max_retries`
- Defaults to `5`
- Used by the core turn loop after a retryable stream error
- `0` means no reconnect attempts after the initial try

If a retryable stream error includes an upstream retry delay, Codex uses that
delay. Otherwise it falls back to exponential backoff with jitter.

## Core retryability rule

At the core layer, the key transient error is `CodexErr::Stream(...)`.

This error represents a request whose stream disconnected or failed before
completion. The session loop treats it as retryable.

Non-retryable examples include:

- context window exceeded
- quota exceeded
- usage not included
- invalid request
- retry limit already exhausted
- server overloaded

Retryable examples include:

- stream disconnected before completion
- timeout
- connection failed
- unexpected HTTP status
- internal server error

## WebSocket-specific behavior

For Responses WebSocket transport:

- stream-level failures are handled with the same completion rule:
  `response.completed` is required
- if stream retries are exhausted, Codex can permanently fall back from
  WebSockets to HTTPS for the rest of the session
- wrapped WebSocket error events can also map to retryable errors

## SDK surface behavior

The TypeScript SDK does not independently decide whether a stream is complete.
It relies on events produced by the Rust implementation.

- `turn.completed` means success
- `turn.failed` means failure
- intermediate `error` events can describe reconnecting or stream issues
  without necessarily terminating the turn

In practice, the Rust core owns the real success and retry logic.

## Important implementation locations

- `codex-rs/codex-api/src/sse/responses.rs`
- `codex-rs/codex-api/src/endpoint/responses_websocket.rs`
- `codex-rs/core/src/api_bridge.rs`
- `codex-rs/core/src/error.rs`
- `codex-rs/core/src/codex.rs`
- `codex-rs/core/src/model_provider_info.rs`
- `codex-rs/codex-client/src/retry.rs`

## Short summary

Codex uses a strict rule:

- success: `response.completed`
- incomplete: anything that ends the stream before `response.completed`
- retry: retryable stream and transport failures, within separate request and
  stream retry budgets
- fail fast: context, quota, plan, invalid prompt, and similar hard failures
