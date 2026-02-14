import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs = new Set<string>();

async function createPngFile(rootDir: string, name = "sample.png"): Promise<string> {
  const filePath = path.join(rootDir, name);
  const pngBuffer = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "#00ff00" },
  })
    .png()
    .toBuffer();
  await fs.writeFile(filePath, pngBuffer);
  return filePath;
}

async function importLoadWebMediaWithRoots(localRoots?: string[]) {
  vi.resetModules();
  vi.doMock("../config/config.js", () => ({
    loadConfig: () => ({
      tools: {
        media: {
          localRoots,
        },
      },
    }),
  }));
  const mod = await import("./media.js");
  return mod.loadWebMedia;
}

afterEach(async () => {
  vi.resetModules();
  vi.unmock("../config/config.js");
  await Promise.all(
    [...tempDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      tempDirs.delete(dir);
    }),
  );
});

describe("loadWebMedia configured local roots", () => {
  it("allows local file paths under tools.media.localRoots", async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), "tmp-media-local-root-"));
    tempDirs.add(dir);
    const filePath = await createPngFile(dir);
    const loadWebMedia = await importLoadWebMediaWithRoots([dir]);

    const result = await loadWebMedia(filePath, 1024 * 1024);

    expect(result.kind).toBe("image");
  });

  it("keeps explicit localRoots option authoritative", async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), "tmp-media-local-root-"));
    tempDirs.add(dir);
    const filePath = await createPngFile(dir);
    const loadWebMedia = await importLoadWebMediaWithRoots([dir]);

    await expect(
      loadWebMedia(filePath, 1024 * 1024, { localRoots: [path.join(dir, "different")] }),
    ).rejects.toThrow(/not under an allowed directory/i);
  });
});
