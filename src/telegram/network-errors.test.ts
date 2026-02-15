import { describe, expect, it } from "vitest";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

describe("telegram network error taxonomy", () => {
  it("treats response.status 5xx as recoverable in polling/webhook contexts", () => {
    expect(
      isRecoverableTelegramNetworkError(
        { response: { status: 502 } },
        { context: "polling", allowMessageMatch: false },
      ),
    ).toBe(true);

    expect(
      isRecoverableTelegramNetworkError(
        { response: { status: 503 } },
        { context: "webhook", allowMessageMatch: false },
      ),
    ).toBe(true);
  });

  it("does not treat 5xx as recoverable in send context", () => {
    expect(
      isRecoverableTelegramNetworkError(
        { response: { status: 502 } },
        { context: "send", allowMessageMatch: false },
      ),
    ).toBe(false);

    expect(
      isRecoverableTelegramNetworkError(
        { statusCode: 504 },
        { context: "send", allowMessageMatch: false },
      ),
    ).toBe(false);
  });

  it("recognizes statusCode 5xx in polling context", () => {
    expect(
      isRecoverableTelegramNetworkError(
        { statusCode: 504 },
        { context: "polling", allowMessageMatch: false },
      ),
    ).toBe(true);
  });
});
