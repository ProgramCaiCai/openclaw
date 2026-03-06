import { describe, expect, it, vi } from "vitest";
import { createSqlDataLoader } from "./sql-dataloader.js";

describe("createSqlDataLoader", () => {
  it("batches keys requested in the same microtask", async () => {
    const batchLoad = vi.fn(async (keys: readonly string[]) => {
      const rows = new Map<string, string>();
      for (const key of keys) {
        rows.set(key, `row:${key}`);
      }
      return rows;
    });

    const loader = createSqlDataLoader(batchLoad);
    const pending = [loader.load("a"), loader.load("b"), loader.load("a")];
    await expect(Promise.all(pending)).resolves.toEqual(["row:a", "row:b", "row:a"]);
    expect(batchLoad).toHaveBeenCalledTimes(1);
    expect(batchLoad).toHaveBeenCalledWith(["a", "b"]);
  });

  it("supports cache bypass when cache=false", async () => {
    const batchLoad = vi.fn(async (keys: readonly string[]) => {
      const rows = new Map<string, number>();
      for (const key of keys) {
        rows.set(key, keys.length);
      }
      return rows;
    });

    const loader = createSqlDataLoader(batchLoad, { cache: false });
    await loader.load("k1");
    await loader.load("k1");

    expect(batchLoad).toHaveBeenCalledTimes(2);
  });
});
