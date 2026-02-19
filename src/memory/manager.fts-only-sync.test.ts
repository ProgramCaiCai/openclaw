import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import "./test-runtime-mocks.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: null,
    providerUnavailableReason: "No API key configured",
  }),
}));

describe("memory sync in FTS-only mode", () => {
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-02-19.md"),
      "Project notes about kiwi cache invalidation behavior.",
    );
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("indexes chunks even when embeddings are unavailable", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: {
              minScore: 0,
              hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as MemoryIndexManager;

    await manager.sync({ reason: "test" });

    const status = manager.status();
    expect(status.custom?.searchMode).toBe("fts-only");
    expect(status.chunks).toBeGreaterThan(0);

    if (!status.fts?.available) {
      return;
    }

    const results = await manager.search("kiwi cache invalidation");
    expect(results.some((entry) => entry.path.endsWith("memory/2026-02-19.md"))).toBe(true);
  });

  it("does not force full reindex on repeated sync in FTS-only mode", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: { path: indexPath, vector: { enabled: true } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as MemoryIndexManager;

    (manager as unknown as { ensureVectorReady: () => Promise<boolean> }).ensureVectorReady =
      async () => true;

    await manager.sync({ reason: "first" });
    const dbFirst = new DatabaseSync(indexPath);
    const firstRow = dbFirst.prepare("SELECT MAX(updated_at) as updatedAt FROM chunks").get() as {
      updatedAt: number | null;
    };
    dbFirst.close();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.sync({ reason: "second" });
    const dbSecond = new DatabaseSync(indexPath);
    const secondRow = dbSecond.prepare("SELECT MAX(updated_at) as updatedAt FROM chunks").get() as {
      updatedAt: number | null;
    };
    dbSecond.close();

    expect(firstRow.updatedAt).toBeTruthy();
    expect(secondRow.updatedAt).toBe(firstRow.updatedAt);
  });
});
