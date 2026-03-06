import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithHttpRetry, HttpRequestTimeoutError, retryHttpRequest } from "./http-retry.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("retryHttpRequest", () => {
  it("retries transient connection errors", async () => {
    const transientError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const executor = vi
      .fn<({ attempt }: { attempt: number; signal: AbortSignal }) => Promise<string>>()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce("ok");

    const result = await retryHttpRequest(executor, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      jitter: 0,
    });

    expect(result).toBe("ok");
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    const executor = vi
      .fn<({ attempt }: { attempt: number; signal: AbortSignal }) => Promise<string>>()
      .mockRejectedValue(new Error("validation failed"));

    await expect(
      retryHttpRequest(executor, {
        attempts: 3,
        minDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
      }),
    ).rejects.toThrow("validation failed");

    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("times out long-running requests and retries", async () => {
    vi.useFakeTimers();

    const executor = vi
      .fn<({ attempt }: { attempt: number; signal: AbortSignal }) => Promise<string>>()
      .mockImplementation(
        () =>
          new Promise(() => {
            // Never resolves to force timeout path.
          }),
      );

    const promise = retryHttpRequest(executor, {
      attempts: 2,
      timeoutMs: 5,
      minDelayMs: 0,
      maxDelayMs: 0,
      jitter: 0,
    });

    const assertion = expect(promise).rejects.toBeInstanceOf(HttpRequestTimeoutError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when external signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = vi
      .fn<({ attempt }: { attempt: number; signal: AbortSignal }) => Promise<string>>()
      .mockResolvedValue("ok");

    await expect(retryHttpRequest(executor, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("fetchWithHttpRetry", () => {
  it("retries retryable HTTP status codes", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await fetchWithHttpRetry(
      "https://example.com/flaky",
      {},
      {
        fetchFn,
        attempts: 2,
        minDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
      },
    );

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After for 429 responses", async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const delays: number[] = [];
    const promise = fetchWithHttpRetry(
      "https://example.com/rate",
      {},
      {
        fetchFn,
        attempts: 2,
        minDelayMs: 0,
        maxDelayMs: 10_000,
        jitter: 0,
        onRetry: (info) => delays.push(info.delayMs),
      },
    );

    await vi.runAllTimersAsync();
    const response = await promise;
    expect(response.status).toBe(200);
    expect(delays[0]).toBe(1000);
  });

  it("does not retry POST by default", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("failed", { status: 503 }));

    const response = await fetchWithHttpRetry(
      "https://example.com/write",
      {
        method: "POST",
      },
      {
        fetchFn,
        attempts: 3,
        minDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
      },
    );

    expect(response.status).toBe(503);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("allows retrying POST when explicitly enabled", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("failed", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await fetchWithHttpRetry(
      "https://example.com/write",
      {
        method: "POST",
      },
      {
        fetchFn,
        attempts: 2,
        minDelayMs: 0,
        maxDelayMs: 0,
        jitter: 0,
        retryNonIdempotent: true,
      },
    );

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
