import { describe, expect, it } from "vitest";
import { hardTruncateText } from "./tool-output-hard-cap.js";

describe("hardTruncateText", () => {
  it("preserves both head and tail when truncating", () => {
    const head = "HEAD-SENTINEL";
    const tail = "TAIL-SENTINEL";
    const hugeMiddle = "x".repeat(20_000);

    const input = `${head}\n${hugeMiddle}\n${tail}`;

    const out = hardTruncateText(input, { maxBytes: 2_000, maxLines: 50 });
    expect(out.truncated).toBe(true);

    // Head+tail truncation should keep the beginning and the end of the text.
    expect(out.text).toContain(head);
    expect(out.text).toContain(tail);

    // The suffix should explain why truncation happened.
    expect(out.text).toContain("exceeded hard limit");
  });
});
