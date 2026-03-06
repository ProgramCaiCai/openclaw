import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchWithHttpRetry, retryHttpRequest } from "./http-retry.js";

describe("http retry integration", () => {
  let server: Server;
  let baseUrl = "";
  let flakyCount = 0;
  let rateLimitedCount = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/flaky") {
        flakyCount += 1;
        if (flakyCount <= 2) {
          res.statusCode = 503;
          res.end("temporary");
          return;
        }
        res.statusCode = 200;
        res.end("ok");
        return;
      }

      if (req.url === "/rate-limit") {
        rateLimitedCount += 1;
        if (rateLimitedCount === 1) {
          res.statusCode = 429;
          res.setHeader("retry-after", "0.05");
          res.end("slow down");
          return;
        }
        res.statusCode = 200;
        res.end("ok");
        return;
      }

      res.statusCode = 200;
      res.end("ok");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("retries real fetch calls until a flaky endpoint recovers", async () => {
    flakyCount = 0;

    const response = await fetchWithHttpRetry(
      `${baseUrl}/flaky`,
      {},
      {
        attempts: 4,
        minDelayMs: 5,
        maxDelayMs: 20,
        jitter: 0,
        timeoutMs: 1_000,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(flakyCount).toBe(3);
  });

  it("supports non-fetch clients through the generic retry executor", async () => {
    flakyCount = 0;

    const response = await retryHttpRequest(
      async ({ signal }) => {
        const result = await fetch(`${baseUrl}/flaky`, { signal });
        if (result.status >= 500) {
          throw Object.assign(new Error("server error"), { status: result.status });
        }
        return result;
      },
      {
        attempts: 4,
        minDelayMs: 5,
        maxDelayMs: 20,
        jitter: 0,
        timeoutMs: 1_000,
      },
    );

    expect(response.status).toBe(200);
    expect(flakyCount).toBe(3);
  });

  it("respects Retry-After from a real endpoint", async () => {
    rateLimitedCount = 0;

    const startedAt = Date.now();
    const response = await fetchWithHttpRetry(
      `${baseUrl}/rate-limit`,
      {},
      {
        attempts: 3,
        minDelayMs: 0,
        maxDelayMs: 1_000,
        jitter: 0,
        timeoutMs: 1_000,
      },
    );

    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(45);
    expect(rateLimitedCount).toBe(2);
  });
});
