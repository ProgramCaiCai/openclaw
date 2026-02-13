import { afterEach, beforeEach } from "vitest";

const GATEWAY_AUTH_ENV_KEYS = [
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "CLAWDBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_PASSWORD",
] as const;

/**
 * Browser server tests should not inherit developer machine gateway auth env vars.
 * Many server tests mock config but do not include auth headers; isolating env
 * keeps the suite deterministic.
 */
export function isolateGatewayAuthEnvForBrowserServerTests(): void {
  let prev: Record<string, string | undefined> | null = null;

  beforeEach(() => {
    prev = {};
    for (const key of GATEWAY_AUTH_ENV_KEYS) {
      prev[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (!prev) {
      return;
    }
    for (const key of GATEWAY_AUTH_ENV_KEYS) {
      const value = prev[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    prev = null;
  });
}
