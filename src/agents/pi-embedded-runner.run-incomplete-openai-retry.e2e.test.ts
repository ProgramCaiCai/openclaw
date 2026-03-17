import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptPath } from "../config/sessions.js";
import { onAgentEvent } from "../infra/agent-events.js";
import type { EmbeddedRunAttemptResult } from "./pi-embedded-runner/run/types.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const sleepWithAbortMock = vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined);

vi.mock("./pi-embedded-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: (params: unknown) => runEmbeddedAttemptMock(params),
}));

vi.mock("../infra/backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/backoff.js")>();
  return {
    ...actual,
    sleepWithAbort: (ms: number, abortSignal?: AbortSignal) => sleepWithAbortMock(ms, abortSignal),
  };
});

vi.mock("./pi-embedded-runner/compact.js", () => ({
  compactEmbeddedPiSessionDirect: vi.fn(async () => {
    throw new Error("compact should not run in incomplete-run retry tests");
  }),
}));

vi.mock("./models-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models-config.js")>();
  return {
    ...actual,
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  };
});

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let tempRoot: string;
let agentDir: string;
let workspaceDir: string;
let sessionCounter = 0;
let runCounter = 0;

beforeAll(async () => {
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
});

beforeEach(async () => {
  runEmbeddedAttemptMock.mockReset();
  sleepWithAbortMock.mockClear();
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-incomplete-run-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  agentDir = path.join(tempRoot, "agent");
  workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const baseUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function buildAssistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "mock-1",
    usage: baseUsage,
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeAttempt(overrides?: Partial<EmbeddedRunAttemptResult>): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    timedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    sessionIdUsed: "session:test",
    systemPromptReport: undefined,
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    ...overrides,
  };
}

function makeConfig(
  paramsOrRetries?:
    | number
    | {
        incompleteRunMaxSilentRetries?: number;
        provider?: string;
        api?: string;
      },
): OpenClawConfig {
  const params =
    typeof paramsOrRetries === "number"
      ? { incompleteRunMaxSilentRetries: paramsOrRetries }
      : paramsOrRetries;
  const incompleteRunMaxSilentRetries = params?.incompleteRunMaxSilentRetries ?? 3;
  const provider = params?.provider ?? "openai";
  const api = params?.api ?? "openai-responses";
  return {
    agents: {
      defaults: {
        embeddedPi: {
          incompleteRunMaxSilentRetries,
        },
      },
    },
    models: {
      providers: {
        [provider]: {
          api,
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: [
            {
              id: "mock-1",
              name: "Mock 1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
}

function nextSessionFile() {
  sessionCounter += 1;
  return path.join(tempRoot, `session-${sessionCounter}.jsonl`);
}

function nextRunId(prefix = "embedded-incomplete") {
  runCounter += 1;
  return `${prefix}-${runCounter}`;
}

type TranscriptMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
};

type TranscriptAppendMessage = {
  role: string;
  content: Array<{ type: "text"; text: string }>;
  stopReason?: string;
  api?: string;
  provider?: string;
  model?: string;
  usage?: typeof baseUsage;
  timestamp?: number;
};

async function readTranscriptMessages(sessionFile: string): Promise<TranscriptMessage[]> {
  const raw = await fs.readFile(sessionFile, "utf-8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: TranscriptMessage })
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message ?? {});
}

async function readTranscriptSnapshot(sessionFile: string) {
  const messages = await readTranscriptMessages(sessionFile);
  return messages.map((message) => ({
    role: message.role,
    text:
      Array.isArray(message.content) && message.content[0]?.type === "text"
        ? message.content[0]?.text
        : undefined,
  }));
}

async function appendTranscriptMessage(sessionFile: string, message: TranscriptAppendMessage) {
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.appendFile(
    sessionFile,
    `${JSON.stringify({
      type: "message",
      message: {
        ...message,
        timestamp: message.timestamp ?? Date.now(),
      },
    })}\n`,
    "utf-8",
  );
}

async function runTurn(params?: {
  config?: OpenClawConfig;
  runId?: string;
  sessionFile?: string;
  sessionId?: string;
  prompt?: string;
  provider?: string;
  model?: string;
}) {
  return await runEmbeddedPiAgent({
    sessionId: params?.sessionId ?? "session-test",
    sessionKey: "agent:main:subagent:test",
    sessionFile: params?.sessionFile ?? nextSessionFile(),
    workspaceDir,
    config: params?.config ?? makeConfig(),
    prompt: params?.prompt ?? "hello",
    provider: params?.provider ?? "openai",
    model: params?.model ?? "mock-1",
    timeoutMs: 5_000,
    agentDir,
    runId: params?.runId ?? nextRunId(),
    enqueue: async (task) => await task(),
  });
}

describe("runEmbeddedPiAgent incomplete openai-responses retries", () => {
  it("retries incomplete openai-responses runs before returning a final reply", async () => {
    runEmbeddedAttemptMock
      .mockResolvedValueOnce(
        makeAttempt({
          lastAssistant: buildAssistant({
            content: [{ type: "text", text: "" }],
          }),
        }),
      )
      .mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["Recovered after managed retry"],
          lastAssistant: buildAssistant({
            content: [{ type: "text", text: "Recovered after managed retry" }],
          }),
        }),
      );

    const runId = nextRunId("managed-retry-success");
    const phases: string[] = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== runId || evt.stream !== "lifecycle") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    const result = await runTurn({ runId });
    stop();

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({
      text: "Recovered after managed retry",
    });
    expect(phases).toEqual(["start", "end"]);
  });

  it("surfaces a final error only after incomplete openai-responses retries are exhausted", async () => {
    runEmbeddedAttemptMock.mockResolvedValue(
      makeAttempt({
        lastAssistant: buildAssistant({
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    const runId = nextRunId("managed-retry-exhausted");
    const phases: string[] = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== runId || evt.stream !== "lifecycle") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    const result = await runTurn({
      config: makeConfig(1),
      runId,
    });
    stop();

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: expect.stringContaining("Automatic retry failed 1 times"),
    });
    expect(phases).toEqual(["start", "end"]);
  });

  it("restores the pre-turn transcript before replaying an incomplete openai-responses run", async () => {
    const sessionId = "session-managed-retry";
    const sessionFile = resolveSessionTranscriptPath(sessionId);
    await appendTranscriptMessage(sessionFile, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    });
    await appendTranscriptMessage(sessionFile, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
      stopReason: "stop",
      api: "openai-responses",
      provider: "openai",
      model: "mock-1",
      usage: baseUsage,
    });

    const initialSnapshot = await readTranscriptSnapshot(sessionFile);
    const attemptBaselines: Array<Awaited<ReturnType<typeof readTranscriptSnapshot>>> = [];
    const prompts: string[] = [];

    runEmbeddedAttemptMock
      .mockImplementationOnce(async (params) => {
        const attempt = params as { prompt?: string; sessionFile?: string };
        prompts.push(attempt.prompt ?? "");
        attemptBaselines.push(await readTranscriptSnapshot(sessionFile));
        await appendTranscriptMessage(sessionFile, {
          role: "user",
          content: [{ type: "text", text: attempt.prompt ?? "" }],
        });
        await appendTranscriptMessage(sessionFile, {
          role: "assistant",
          content: [{ type: "text", text: "bad tail from incomplete attempt" }],
          stopReason: "error",
          api: "openai-responses",
          provider: "openai",
          model: "mock-1",
          usage: baseUsage,
        });
        return makeAttempt({
          lastAssistant: buildAssistant({
            content: [{ type: "text", text: "" }],
          }),
        });
      })
      .mockImplementationOnce(async (params) => {
        const attempt = params as { prompt?: string; sessionFile?: string };
        prompts.push(attempt.prompt ?? "");
        attemptBaselines.push(await readTranscriptSnapshot(sessionFile));
        await appendTranscriptMessage(sessionFile, {
          role: "user",
          content: [{ type: "text", text: attempt.prompt ?? "" }],
        });
        await appendTranscriptMessage(sessionFile, {
          role: "assistant",
          content: [{ type: "text", text: "Recovered after managed retry" }],
          stopReason: "stop",
          api: "openai-responses",
          provider: "openai",
          model: "mock-1",
          usage: baseUsage,
        });
        return makeAttempt({
          assistantTexts: ["Recovered after managed retry"],
          lastAssistant: buildAssistant({
            content: [{ type: "text", text: "Recovered after managed retry" }],
          }),
        });
      });

    const result = await runTurn({
      config: makeConfig(1),
      runId: nextRunId("managed-retry-transcript"),
      sessionId,
      sessionFile,
    });

    expect(result.payloads?.[0]).toMatchObject({
      text: "Recovered after managed retry",
    });
    expect(prompts).toEqual(["hello", "hello"]);
    expect(attemptBaselines).toEqual([initialSnapshot, initialSnapshot]);
    await expect(readTranscriptSnapshot(sessionFile)).resolves.toEqual([
      ...initialSnapshot,
      { role: "user", text: "hello" },
      { role: "assistant", text: "Recovered after managed retry" },
    ]);
  });
});

describe("runEmbeddedPiAgent empty assistant contract", () => {
  it("retries invalid empty assistant shells for non-openai providers and restores the pre-turn transcript", async () => {
    const sessionId = "session-empty-shell-retry";
    const sessionFile = resolveSessionTranscriptPath(sessionId);
    await appendTranscriptMessage(sessionFile, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    });
    await appendTranscriptMessage(sessionFile, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
      stopReason: "stop",
      api: "anthropic",
      provider: "anthropic",
      model: "mock-1",
      usage: baseUsage,
    });

    const initialSnapshot = await readTranscriptSnapshot(sessionFile);
    const attemptBaselines: Array<Awaited<ReturnType<typeof readTranscriptSnapshot>>> = [];
    const prompts: string[] = [];

    runEmbeddedAttemptMock
      .mockImplementationOnce(async (params) => {
        const attempt = params as { prompt?: string };
        prompts.push(attempt.prompt ?? "");
        attemptBaselines.push(await readTranscriptSnapshot(sessionFile));
        await appendTranscriptMessage(sessionFile, {
          role: "user",
          content: [{ type: "text", text: attempt.prompt ?? "" }],
        });
        await fs.appendFile(
          sessionFile,
          JSON.stringify({
            type: "message",
            message: buildAssistant({
              api: "anthropic",
              provider: "anthropic",
              content: [],
              timestamp: Date.now(),
            }),
          }) + "\n",
          "utf-8",
        );
        return makeAttempt({
          lastAssistant: buildAssistant({
            api: "anthropic",
            provider: "anthropic",
            content: [],
          }),
        });
      })
      .mockImplementationOnce(async (params) => {
        const attempt = params as { prompt?: string };
        prompts.push(attempt.prompt ?? "");
        attemptBaselines.push(await readTranscriptSnapshot(sessionFile));
        await appendTranscriptMessage(sessionFile, {
          role: "user",
          content: [{ type: "text", text: attempt.prompt ?? "" }],
        });
        await appendTranscriptMessage(sessionFile, {
          role: "assistant",
          content: [{ type: "text", text: "Recovered after empty-shell retry" }],
          stopReason: "stop",
          api: "anthropic",
          provider: "anthropic",
          model: "mock-1",
          usage: baseUsage,
        });
        return makeAttempt({
          assistantTexts: ["Recovered after empty-shell retry"],
          lastAssistant: buildAssistant({
            api: "anthropic",
            provider: "anthropic",
            content: [{ type: "text", text: "Recovered after empty-shell retry" }],
          }),
        });
      });

    const result = await runTurn({
      config: makeConfig({
        provider: "anthropic",
        api: "anthropic",
        incompleteRunMaxSilentRetries: 1,
      }),
      provider: "anthropic",
      runId: nextRunId("empty-shell-retry"),
      sessionId,
      sessionFile,
    });

    expect(result.payloads?.[0]).toMatchObject({
      text: "Recovered after empty-shell retry",
    });
    expect(prompts).toEqual(["hello", "hello"]);
    expect(attemptBaselines).toEqual([initialSnapshot, initialSnapshot]);
    await expect(readTranscriptSnapshot(sessionFile)).resolves.toEqual([
      ...initialSnapshot,
      { role: "user", text: "hello" },
      { role: "assistant", text: "Recovered after empty-shell retry" },
    ]);
  });

  it("fails closed after invalid empty assistant retries are exhausted for non-openai providers", async () => {
    runEmbeddedAttemptMock.mockResolvedValue(
      makeAttempt({
        lastAssistant: buildAssistant({
          api: "anthropic",
          provider: "anthropic",
          content: [],
        }),
      }),
    );

    const result = await runTurn({
      config: makeConfig({
        provider: "anthropic",
        api: "anthropic",
        incompleteRunMaxSilentRetries: 1,
      }),
      provider: "anthropic",
      runId: nextRunId("empty-shell-exhausted"),
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({
      isError: true,
      text: expect.stringContaining("no deliverable payload"),
    });
  });
});
