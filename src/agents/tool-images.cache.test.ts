import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getImageMetadata: vi.fn(),
  resizeToJpeg: vi.fn(),
}));

vi.mock("../media/image-ops.js", () => ({
  buildImageResizeSideGrid: () => [1200],
  getImageMetadata: mocks.getImageMetadata,
  IMAGE_REDUCE_QUALITY_STEPS: [85],
  resizeToJpeg: mocks.resizeToJpeg,
}));

import { __clearImageResizeCacheForTests, sanitizeImageBlocks } from "./tool-images.js";

describe("tool image resize cache", () => {
  beforeEach(() => {
    __clearImageResizeCacheForTests();
    mocks.getImageMetadata.mockReset();
    mocks.resizeToJpeg.mockReset();
  });

  it("reuses resized output for identical image + limits", async () => {
    mocks.getImageMetadata.mockResolvedValue({ width: 2600, height: 1400 });
    mocks.resizeToJpeg.mockResolvedValue(Buffer.from("resized-1"));

    const raw = Buffer.from("raw-image-data-1").toString("base64");
    const images = [{ type: "image" as const, data: raw, mimeType: "image/png" }];

    const first = await sanitizeImageBlocks(images, "test", {
      maxDimensionPx: 1200,
      maxBytes: 1024,
    });
    const second = await sanitizeImageBlocks(images, "test", {
      maxDimensionPx: 1200,
      maxBytes: 1024,
    });

    expect(first.images).toHaveLength(1);
    expect(second.images).toHaveLength(1);
    expect(second.images[0]?.data).toBe(first.images[0]?.data);
    expect(mocks.getImageMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.resizeToJpeg).toHaveBeenCalledTimes(1);
  });

  it("invalidates cache when limits change", async () => {
    mocks.getImageMetadata.mockResolvedValue({ width: 2600, height: 1400 });
    mocks.resizeToJpeg.mockResolvedValue(Buffer.from("resized-2"));

    const raw = Buffer.from("raw-image-data-2").toString("base64");
    const images = [{ type: "image" as const, data: raw, mimeType: "image/png" }];

    await sanitizeImageBlocks(images, "test", { maxDimensionPx: 1200, maxBytes: 1024 });
    await sanitizeImageBlocks(images, "test", { maxDimensionPx: 1000, maxBytes: 1024 });

    expect(mocks.getImageMetadata).toHaveBeenCalledTimes(2);
    expect(mocks.resizeToJpeg).toHaveBeenCalledTimes(2);
  });
});
