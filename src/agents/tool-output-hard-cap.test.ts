import { describe, expect, it } from "vitest";
import { hardCapToolOutput, hardTruncateText } from "./tool-output-hard-cap.js";

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

  it("returns input unchanged when already within limits", () => {
    const out = hardTruncateText("", { maxBytes: 100, maxLines: 10 });
    expect(out).toEqual({ text: "", truncated: false });
  });

  it("does not break emoji surrogate pairs when byte-truncating", () => {
    const input = "🙂".repeat(4_000);
    const out = hardTruncateText(input, { maxBytes: 1_024, maxLines: 20 });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(1_024);
    expect(out.text).not.toContain("\uFFFD");
  });

  it("keeps both ends for long single-line payloads", () => {
    const head = "HEAD-LINE-SENTINEL";
    const tail = "TAIL-LINE-SENTINEL";
    const input = `${head}${"x".repeat(20_000)}${tail}`;
    const out = hardTruncateText(input, { maxBytes: 2_000, maxLines: 8 });
    expect(out.truncated).toBe(true);
    expect(out.text).toContain(head);
    expect(out.text).toContain(tail);
  });
});

describe("hardCapToolOutput", () => {
  it("returns small JSON payloads unchanged via fast path", () => {
    const payload = { ok: true, list: [1, 2, 3] };
    const out = hardCapToolOutput(payload, { maxBytes: 4_096, maxLines: 400 });
    expect(out).toBe(payload);
  });

  it("keeps deeper nested values with the default depth", () => {
    const payload = {
      a: {
        b: {
          c: {
            d: {
              e: {
                f: {
                  g: {
                    h: {
                      i: "deep-leaf",
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const out = hardCapToolOutput(payload) as Record<string, unknown>;
    const outJson = JSON.stringify(out);
    expect(outJson).toContain("deep-leaf");
  });
});
