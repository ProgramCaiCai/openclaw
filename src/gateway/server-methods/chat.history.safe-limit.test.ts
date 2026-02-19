import { afterEach, describe, expect, it, vi } from "vitest";

const sessionUtilsMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  readSessionMessages: vi.fn(),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-4o" })),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: sessionUtilsMocks.loadSessionEntry,
    readSessionMessages: sessionUtilsMocks.readSessionMessages,
    resolveSessionModelRef: sessionUtilsMocks.resolveSessionModelRef,
  };
});

import { chatHandlers } from "./chat.js";

type ChatHistoryHandlerArgs = Parameters<(typeof chatHandlers)["chat.history"]>[0];

const noop = () => false;

function firstContentText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const first = content[0];
  if (!first || typeof first !== "object") {
    return undefined;
  }
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

describe("chat.history safeLimit", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps legacy defaults without safeLimit", async () => {
    const rawMessages = Array.from({ length: 300 }, (_, idx) => ({
      role: "user",
      content: [{ type: "text", text: `m${idx}` }],
      timestamp: idx,
    }));
    sessionUtilsMocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-main", thinkingLevel: "minimal" },
    });
    sessionUtilsMocks.readSessionMessages.mockReturnValue(rawMessages);

    const respond = vi.fn();
    await chatHandlers["chat.history"]({
      params: { sessionKey: "main" },
      respond,
      context: { loadGatewayModelCatalog: vi.fn() },
      client: null,
      req: { id: "req-1", type: "req", method: "chat.history" },
      isWebchatConnect: noop,
    } as unknown as ChatHistoryHandlerArgs);

    const payload = respond.mock.calls[0]?.[1] as { messages?: unknown[] } | undefined;
    const messages = payload?.messages ?? [];
    expect(messages).toHaveLength(200);
    expect(firstContentText(messages[0])).toBe("m100");
  });

  it("applies safe defaults and clamps oversized limits when safeLimit=true", async () => {
    const rawMessages = Array.from({ length: 300 }, (_, idx) => ({
      role: "user",
      content: [{ type: "text", text: `m${idx}` }],
      timestamp: idx,
    }));
    sessionUtilsMocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-main", thinkingLevel: "minimal" },
    });
    sessionUtilsMocks.readSessionMessages.mockReturnValue(rawMessages);

    const defaultRespond = vi.fn();
    await chatHandlers["chat.history"]({
      params: { sessionKey: "main", safeLimit: true },
      respond: defaultRespond,
      context: { loadGatewayModelCatalog: vi.fn() },
      client: null,
      req: { id: "req-2", type: "req", method: "chat.history" },
      isWebchatConnect: noop,
    } as unknown as ChatHistoryHandlerArgs);

    const defaultPayload = defaultRespond.mock.calls[0]?.[1] as
      | { messages?: unknown[] }
      | undefined;
    const defaultMessages = defaultPayload?.messages ?? [];
    expect(defaultMessages).toHaveLength(10);
    expect(firstContentText(defaultMessages[0])).toBe("m290");

    const cappedRespond = vi.fn();
    await chatHandlers["chat.history"]({
      params: { sessionKey: "main", safeLimit: true, limit: 500 },
      respond: cappedRespond,
      context: { loadGatewayModelCatalog: vi.fn() },
      client: null,
      req: { id: "req-3", type: "req", method: "chat.history" },
      isWebchatConnect: noop,
    } as unknown as ChatHistoryHandlerArgs);

    const cappedPayload = cappedRespond.mock.calls[0]?.[1] as { messages?: unknown[] } | undefined;
    const cappedMessages = cappedPayload?.messages ?? [];
    expect(cappedMessages).toHaveLength(50);
    expect(firstContentText(cappedMessages[0])).toBe("m250");
  });
});
