import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { createGatewayRequest, createHooksConfig } from "./hooks-test-helpers.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));

vi.mock("./hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hooks.js")>();
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

import { createHooksRequestHandler } from "./server-http.js";

type HooksHandlerDeps = Parameters<typeof createHooksRequestHandler>[0];

function createRequest(params?: {
  authorization?: string;
  remoteAddress?: string;
  url?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return createGatewayRequest({
    method: "POST",
    url: params?.url ?? "/hooks/wake",
    headers: {
      host: "127.0.0.1:18789",
      authorization: params?.authorization ?? "Bearer hook-secret",
      ...(params?.headers ?? {}),
    },
    socket: { remoteAddress: params?.remoteAddress ?? "127.0.0.1" },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, end, setHeader };
}

function createHandler(params?: {
  dispatchWakeHook?: HooksHandlerDeps["dispatchWakeHook"];
  dispatchAgentHook?: HooksHandlerDeps["dispatchAgentHook"];
  bindHost?: string;
}) {
  return createHooksRequestHandler({
    getHooksConfig: () => createHooksConfig(),
    bindHost: params?.bindHost ?? "127.0.0.1",
    port: 18789,
    logHooks: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as ReturnType<typeof createSubsystemLogger>,
    dispatchWakeHook:
      params?.dispatchWakeHook ??
      ((() => {
        return;
      }) as HooksHandlerDeps["dispatchWakeHook"]),
    dispatchAgentHook:
      params?.dispatchAgentHook ?? ((() => "run-1") as HooksHandlerDeps["dispatchAgentHook"]),
  });
}

describe("createHooksRequestHandler timeout status mapping", () => {
  beforeEach(() => {
    readJsonBodyMock.mockClear();
    delete process.env.OPENCLAW_HOOKS_IDEMPOTENCY_ENABLED;
    delete process.env.OPENCLAW_HOOKS_SIGNATURE_ENABLED;
    delete process.env.OPENCLAW_HOOKS_SIGNATURE_SECRET;
    delete process.env.OPENCLAW_HOOKS_SIGNATURE_SHADOW_MODE;
  });

  test("returns 408 for request body timeout", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: false, error: "request body timeout" });
    const dispatchWakeHook = vi.fn();
    const dispatchAgentHook = vi.fn(() => "run-1");
    const handler = createHandler({ dispatchWakeHook, dispatchAgentHook });
    const req = createRequest();
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(408);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "request body timeout" }));
    expect(dispatchWakeHook).not.toHaveBeenCalled();
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });

  test("shares hook auth rate-limit bucket across ipv4 and ipv4-mapped ipv6 forms", async () => {
    const handler = createHandler();

    for (let i = 0; i < 20; i++) {
      const req = createRequest({
        authorization: "Bearer wrong",
        remoteAddress: "1.2.3.4",
      });
      const { res } = createResponse();
      const handled = await handler(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    }

    const mappedReq = createRequest({
      authorization: "Bearer wrong",
      remoteAddress: "::ffff:1.2.3.4",
    });
    const { res: mappedRes, setHeader } = createResponse();
    const handled = await handler(mappedReq, mappedRes);

    expect(handled).toBe(true);
    expect(mappedRes.statusCode).toBe(429);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  test.each(["0.0.0.0", "::"])(
    "does not throw when bindHost=%s while parsing non-hook request URL",
    async (bindHost) => {
      const handler = createHandler({ bindHost });
      const req = createRequest({ url: "/" });
      const { res, end } = createResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(false);
      expect(end).not.toHaveBeenCalled();
    },
  );

  test("replays successful responses for duplicate idempotency keys", async () => {
    process.env.OPENCLAW_HOOKS_IDEMPOTENCY_ENABLED = "1";
    const dispatchAgentHook = vi.fn(() => "run-42");
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: { message: "test" },
      rawBody: JSON.stringify({ message: "test" }),
    });
    const handler = createHandler({ dispatchAgentHook });

    const requestHeaders = { "idempotency-key": "idem-42" };
    const req1 = createRequest({ url: "/hooks/agent", headers: requestHeaders });
    const first = createResponse();
    const handledFirst = await handler(req1, first.res);
    expect(handledFirst).toBe(true);
    expect(first.res.statusCode).toBe(202);

    const req2 = createRequest({ url: "/hooks/agent", headers: requestHeaders });
    const replay = createResponse();
    const handledReplay = await handler(req2, replay.res);
    expect(handledReplay).toBe(true);
    expect(replay.res.statusCode).toBe(202);
    expect(replay.setHeader).toHaveBeenCalledWith("X-Idempotency-Replayed", "true");
    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
  });

  test("rejects hooks with invalid signatures when verification is enabled", async () => {
    process.env.OPENCLAW_HOOKS_SIGNATURE_ENABLED = "1";
    process.env.OPENCLAW_HOOKS_SIGNATURE_SECRET = "test-secret";
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: { text: "Ping" },
      rawBody: JSON.stringify({ text: "Ping" }),
    });
    const dispatchWakeHook = vi.fn();
    const handler = createHandler({ dispatchWakeHook });

    const req = createRequest({
      headers: {
        "x-openclaw-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-openclaw-signature": "sha256=invalid",
      },
    });
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ ok: false, error: "hook signature mismatch" }),
    );
    expect(dispatchWakeHook).not.toHaveBeenCalled();
  });
});
