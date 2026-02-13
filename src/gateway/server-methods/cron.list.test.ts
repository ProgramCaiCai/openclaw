import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { cronHandlers } from "./cron.js";

const noop = () => false;

describe("cron.list", () => {
  it("omits payload message/text by default", async () => {
    const jobs = [
      { id: "job-1", payload: { kind: "agentTurn", message: "hello" } },
      { id: "job-2", payload: { kind: "systemEvent", text: "hi" } },
    ];
    const respond = vi.fn();

    await cronHandlers["cron.list"]({
      params: {},
      respond,
      context: {
        cron: {
          list: vi.fn().mockResolvedValue(jobs),
        },
      } as any,
      client: null,
      req: { id: "req-1", type: "req", method: "cron.list" },
      isWebchatConnect: noop,
    } as any);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        jobs: [
          { id: "job-1", payload: { kind: "agentTurn" } },
          { id: "job-2", payload: { kind: "systemEvent" } },
        ],
      },
      undefined,
    );
  });

  it("rejects includePayload without jobId", async () => {
    const respond = vi.fn();

    await cronHandlers["cron.list"]({
      params: { includePayload: true },
      respond,
      context: { cron: { list: vi.fn() } } as any,
      client: null,
      req: { id: "req-2", type: "req", method: "cron.list" },
      isWebchatConnect: noop,
    } as any);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
    const err = respond.mock.calls[0]?.[2] as { message?: string };
    expect(err?.message ?? "").toMatch(/includePayload requires jobId/);
  });

  it("supports includePayload when jobId is provided", async () => {
    const jobs = [
      { id: "job-1", payload: { kind: "agentTurn", message: "hello" } },
      { id: "job-2", payload: { kind: "systemEvent", text: "hi" } },
    ];
    const respond = vi.fn();

    await cronHandlers["cron.list"]({
      params: { includePayload: true, jobId: "job-1" },
      respond,
      context: {
        cron: {
          list: vi.fn().mockResolvedValue(jobs),
        },
      } as any,
      client: null,
      req: { id: "req-3", type: "req", method: "cron.list" },
      isWebchatConnect: noop,
    } as any);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        jobs: [{ id: "job-1", payload: { kind: "agentTurn", message: "hello" } }],
      },
      undefined,
    );
  });

  it("errors when jobId is unknown", async () => {
    const jobs = [{ id: "job-1", payload: { kind: "agentTurn", message: "hello" } }];
    const respond = vi.fn();

    await cronHandlers["cron.list"]({
      params: { jobId: "nope" },
      respond,
      context: {
        cron: {
          list: vi.fn().mockResolvedValue(jobs),
        },
      } as any,
      client: null,
      req: { id: "req-4", type: "req", method: "cron.list" },
      isWebchatConnect: noop,
    } as any);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "unknown cron job id: nope",
      }),
    );
  });
});
