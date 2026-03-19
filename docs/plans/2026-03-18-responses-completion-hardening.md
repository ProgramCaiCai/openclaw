# Responses Completion Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make OpenClaw treat every `openai-responses` and `openai-codex-responses` request as successful only after verified terminal completion across both WebSocket and non-WebSocket transports.

**Architecture:** Add a canonical OpenClaw-owned Responses transport that dispatches to strict WS and strict HTTP/SSE sub-drivers but owns terminal-state validation and retry budgeting in one place. Keep the existing higher-level empty-deliverable retry logic as a final hedge, not as the primary definition of stream completeness.

**Tech Stack:** TypeScript, Vitest, existing OpenClaw agent runtime, existing OpenAI WS manager, OpenAI-compatible Responses SSE streams.

---

### Task 1: Add shared Responses terminal-state primitives

**Files:**

- Create: `src/agents/openai-responses-state.ts`
- Test: `src/agents/openai-responses-state.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { classifyResponsesTerminal, isStrictResponsesSuccess } from "./openai-responses-state.js";

describe("classifyResponsesTerminal", () => {
  it("accepts only response.completed with status completed as success", () => {
    expect(
      classifyResponsesTerminal({
        terminalEvent: { type: "response.completed", response: { status: "completed" } },
      }),
    ).toMatchObject({ kind: "success" });

    expect(
      classifyResponsesTerminal({
        terminalEvent: { type: "response.completed", response: { status: "incomplete" } },
      }),
    ).toMatchObject({ kind: "incomplete" });
  });

  it("fails closed when the stream ends without a terminal completion", () => {
    expect(
      classifyResponsesTerminal({
        terminalEvent: null,
        prematureEnd: "eof_before_terminal",
      }),
    ).toMatchObject({ kind: "incomplete", retryable: true });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/agents/openai-responses-state.test.ts`

Expected: FAIL because `src/agents/openai-responses-state.ts` does not exist yet.

**Step 3: Write minimal implementation**

```ts
export type ResponsesTerminalResult =
  | { kind: "success" }
  | { kind: "incomplete"; reason: string; retryable: boolean }
  | { kind: "failed"; reason: string; retryable: boolean };

export function classifyResponsesTerminal(params: {
  terminalEvent:
    | { type: "response.completed"; response?: { status?: string | null } | null }
    | { type: "response.failed"; response?: { error?: { message?: string | null } | null } | null }
    | null;
  prematureEnd?: "eof_before_terminal" | "idle_timeout" | "close_before_terminal";
}): ResponsesTerminalResult {
  if (params.terminalEvent?.type === "response.completed") {
    const status = params.terminalEvent.response?.status ?? null;
    if (status === "completed") {
      return { kind: "success" };
    }
    return {
      kind: "incomplete",
      reason: `response.completed:${status ?? "missing-status"}`,
      retryable: true,
    };
  }
  if (params.terminalEvent?.type === "response.failed") {
    return {
      kind: "failed",
      reason: params.terminalEvent.response?.error?.message ?? "response.failed",
      retryable: true,
    };
  }
  return {
    kind: "incomplete",
    reason: params.prematureEnd ?? "missing-terminal-event",
    retryable: true,
  };
}

export function isStrictResponsesSuccess(result: ResponsesTerminalResult): boolean {
  return result.kind === "success";
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/agents/openai-responses-state.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
scripts/committer "feat: add strict responses terminal state primitives" src/agents/openai-responses-state.ts src/agents/openai-responses-state.test.ts
```

### Task 2: Build a strict HTTP/SSE Responses driver

**Files:**

- Create: `src/agents/openai-responses-http-stream.ts`
- Test: `src/agents/openai-responses-http-stream.test.ts`

**Step 1: Write the failing test**

```ts
it("fails closed when the HTTP stream ends before response.completed", async () => {
  const stream = createStrictResponsesHttpStream({
    model,
    context,
    responseStreamFactory: async function* () {
      yield { type: "response.created", response: { id: "resp_1", status: "in_progress" } };
      yield { type: "response.output_text.delta", delta: "partial" };
    },
  });

  const result = await collectAssistantStreamResult(stream);
  expect(result.type).toBe("error");
  expect(result.error?.errorMessage).toContain("missing terminal completion");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/agents/openai-responses-http-stream.test.ts`

Expected: FAIL because the strict HTTP driver does not exist yet.

**Step 3: Write minimal implementation**

```ts
export function createStrictResponsesHttpStreamFn(opts: {
  idleTimeoutMs: number;
  requestMaxRetries: number;
  streamMaxRetries: number;
}): StreamFn {
  return (model, context, options) => {
    return createAssistantMessageEventStream(async (eventStream) => {
      const attempt = async () => {
        let terminalEvent: {
          type: "response.completed" | "response.failed";
          response?: unknown;
        } | null = null;

        for await (const event of createResponsesEventIterator({ model, context, options })) {
          if (event.type === "response.completed" || event.type === "response.failed") {
            terminalEvent = event;
          }
          forwardStrictResponsesEvent(eventStream, event, model);
        }

        const terminal = classifyResponsesTerminal({
          terminalEvent,
          prematureEnd: terminalEvent ? undefined : "eof_before_terminal",
        });

        if (!isStrictResponsesSuccess(terminal)) {
          throw new Error(`Responses stream incomplete: ${terminal.reason}`);
        }
      };

      await runResponsesAttemptLoop({ attempt, eventStream, options, model });
    });
  };
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/agents/openai-responses-http-stream.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
scripts/committer "feat: add strict responses HTTP stream driver" src/agents/openai-responses-http-stream.ts src/agents/openai-responses-http-stream.test.ts
```

### Task 3: Refactor WebSocket Responses stream onto the same strict completion contract

**Files:**

- Modify: `src/agents/openai-ws-stream.ts`
- Test: `src/agents/openai-ws-stream.test.ts`

**Step 1: Write the failing test**

```ts
it("retries mid-request websocket close until stream retry budget is exhausted", async () => {
  const streamFn = createOpenAIWebSocketStreamFn("sk-test", "sess-drop", {
    streamMaxRetries: 2,
  });

  const stream = streamFn(model, context, options);
  manager.simulateClose(1006, "dropped");
  const result = await collectAssistantStreamResult(stream);

  expect(manager.sendCount).toBe(3);
  expect(result.type).toBe("error");
  expect(result.error?.errorMessage).toContain("close_before_terminal");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/agents/openai-ws-stream.test.ts -t "retries mid-request websocket close until stream retry budget is exhausted"`

Expected: FAIL because the current WS path rejects immediately instead of consuming shared stream retry budget.

**Step 3: Write minimal implementation**

```ts
const terminal = classifyResponsesTerminal({
  terminalEvent,
  prematureEnd: closedMidRequest ? "close_before_terminal" : undefined,
});

if (!isStrictResponsesSuccess(terminal)) {
  throw createResponsesRetryableError({
    phase: "stream",
    reason: terminal.reason,
    retryable: terminal.retryable,
  });
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/agents/openai-ws-stream.test.ts`

Expected: PASS, including existing replay and fallback coverage.

**Step 5: Commit**

```bash
scripts/committer "fix: enforce strict completion in websocket responses stream" src/agents/openai-ws-stream.ts src/agents/openai-ws-stream.test.ts
```

### Task 4: Add a canonical Responses transport orchestrator and route all Responses APIs through it

**Files:**

- Create: `src/agents/openai-responses-stream.ts`
- Modify: `src/agents/pi-embedded-runner/run/attempt.ts`
- Test: `src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.e2e.test.ts`
- Test: `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`

**Step 1: Write the failing test**

```ts
it("routes custom openai-responses providers through the canonical strict transport", async () => {
  const result = await runEmbeddedAttemptWithModel({
    provider: "custom-openai",
    api: "openai-responses",
  });

  expect(result.debug?.responsesTransport).toBe("canonical");
  expect(result.debug?.responsesDriver).toBe("http");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts -t "routes custom openai-responses providers through the canonical strict transport"`

Expected: FAIL because only `provider === "openai"` currently uses OpenClaw-owned special handling.

**Step 3: Write minimal implementation**

```ts
if (params.model.api === "openai-responses" || params.model.api === "openai-codex-responses") {
  activeSession.agent.streamFn = createOpenAIResponsesStreamFn({
    provider: params.provider,
    sessionId: params.sessionId,
    authStorage: params.authStorage,
    abortSignal: runAbortController.signal,
  });
} else {
  activeSession.agent.streamFn = streamSimple;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`

Expected: PASS, including existing custom-provider incomplete retry scenarios.

**Step 5: Commit**

```bash
scripts/committer "feat: route all responses APIs through canonical strict transport" src/agents/openai-responses-stream.ts src/agents/pi-embedded-runner/run/attempt.ts src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts
```

### Task 5: Preserve upper-layer empty-deliverable retry as a final hedge, not the primary completion check

**Files:**

- Modify: `src/auto-reply/reply/agent-runner-execution.ts`
- Test: `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`
- Test: `src/agents/pi-embedded-runner.run-incomplete-openai-retry.e2e.test.ts`

**Step 1: Write the failing test**

```ts
it("still retries empty deliverables after a transport-complete responses run", async () => {
  runEmbeddedPiAgentMock
    .mockResolvedValueOnce(createTransportCompleteEmptyResponsesRun())
    .mockResolvedValueOnce(createSuccessfulResponsesRun("Recovered"));

  const payload = await runReplyAgentTurn();
  expect(payload.text).toBe("Recovered");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts -t "still retries empty deliverables after a transport-complete responses run"`

Expected: FAIL until the transport-complete and empty-deliverable semantics are made explicit in tests and code.

**Step 3: Write minimal implementation**

```ts
if (
  isIncompleteOpenAiResponsesRun({
    runResult,
    fallbackProvider,
    fallbackModel,
    followupRun: params.followupRun,
  })
) {
  // Keep existing baseline restore + continue fallback logic.
  // This now runs only after transport completeness has already been enforced.
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
scripts/committer "fix: keep empty-deliverable responses retries as final hedge" src/auto-reply/reply/agent-runner-execution.ts src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts src/agents/pi-embedded-runner.run-incomplete-openai-retry.e2e.test.ts
```

### Task 6: Add regression coverage for transcript safety and verify the full hardening set

**Files:**

- Modify: `src/agents/openai-ws-stream.test.ts`
- Modify: `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`
- Modify: `src/agents/pi-embedded-runner.run-incomplete-openai-retry.e2e.test.ts`
- Create: `src/agents/openai-responses-http-stream.test.ts` if not already created in Task 2

**Step 1: Write the failing tests**

```ts
it("does not append intermediate failed retries to transcript state", async () => {
  const transcript = await runResponsesTurnWithPrematureFailures();
  expect(transcript).toEqual([
    { role: "user", text: "hello" },
    { role: "assistant", text: "final answer" },
  ]);
});

it("surfaces a single final error after strict transport retry budget is exhausted", async () => {
  const payload = await runResponsesTurnThatAlwaysEndsPrematurely();
  expect(payload.isError).toBe(true);
  expect(payload.text).toContain("ended before terminal completion");
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/agents/openai-ws-stream.test.ts src/agents/openai-responses-http-stream.test.ts src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts src/agents/pi-embedded-runner.run-incomplete-openai-retry.e2e.test.ts`

Expected: FAIL until all strict completion invariants are wired through.

**Step 3: Write minimal implementation**

```ts
// Ensure transport-internal retries do not publish assistant error turns.
// Only publish final success or final failure after retry budget resolution.
throw new Error(`Responses request ended before terminal completion: ${failure.reason}`);
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/agents/openai-ws-stream.test.ts src/agents/openai-responses-http-stream.test.ts src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts src/agents/pi-embedded-runner.run-incomplete-openai-retry.e2e.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
scripts/committer "test: harden responses completion invariants" src/agents/openai-ws-stream.test.ts src/agents/openai-responses-http-stream.test.ts src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts src/agents/pi-embedded-runner.run-incomplete-openai-retry.e2e.test.ts
```

### Task 7: Run full verification and inspect for regressions

**Files:**

- Modify: none expected
- Test: `src/agents/openai-ws-stream.test.ts`
- Test: `src/agents/openai-responses-http-stream.test.ts`
- Test: `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`
- Test: `src/agents/pi-embedded-runner.run-incomplete-openai-retry.e2e.test.ts`

**Step 1: Run focused transport and retry tests**

Run: `pnpm test -- src/agents/openai-ws-stream.test.ts src/agents/openai-responses-http-stream.test.ts src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts src/agents/pi-embedded-runner.run-incomplete-openai-retry.e2e.test.ts`

Expected: PASS

**Step 2: Run typecheck/build**

Run: `pnpm build`

Expected: PASS with no `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings introduced by the new transport files.

**Step 3: Run repository checks if touched files require it**

Run: `pnpm check`

Expected: PASS

**Step 4: Review diff for forbidden regressions**

Run: `git diff -- src/agents/openai-ws-stream.ts src/agents/openai-responses-http-stream.ts src/agents/openai-responses-stream.ts src/agents/pi-embedded-runner/run/attempt.ts src/auto-reply/reply/agent-runner-execution.ts`

Expected:

- no fallback path that can silently succeed without terminal completion,
- no transcript mutation from internal retries,
- no dependency patch changes.

**Step 5: Commit**

```bash
scripts/committer "fix: enforce strict completion across responses transports" src/agents/openai-responses-state.ts src/agents/openai-responses-state.test.ts src/agents/openai-responses-http-stream.ts src/agents/openai-responses-http-stream.test.ts src/agents/openai-responses-stream.ts src/agents/openai-ws-stream.ts src/agents/openai-ws-stream.test.ts src/agents/pi-embedded-runner/run/attempt.ts src/auto-reply/reply/agent-runner-execution.ts src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts src/agents/pi-embedded-runner.run-incomplete-openai-retry.e2e.test.ts
```
