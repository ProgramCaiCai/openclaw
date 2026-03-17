import { describe, expect, it } from "vitest";
import { formatIncompleteOpenAiResponsesUserMessage } from "./agent-runner-execution.js";

describe("formatIncompleteOpenAiResponsesUserMessage", () => {
  it("keeps the incomplete-stream wording when retries ended early", () => {
    expect(formatIncompleteOpenAiResponsesUserMessage(1)).toContain(
      "ended before the automatic retry sequence finished",
    );
  });

  it("uses an exhausted-retries wording after the default silent retries fail", () => {
    expect(formatIncompleteOpenAiResponsesUserMessage(3)).toContain(
      "Automatic retry failed 3 times",
    );
  });

  it("uses the configured silent retry count in the user-facing error", () => {
    expect(formatIncompleteOpenAiResponsesUserMessage(1, 1)).toContain(
      "Automatic retry failed 1 times",
    );
  });
});
