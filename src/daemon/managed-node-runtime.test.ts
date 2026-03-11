import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  chmod: vi.fn(),
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    chmod: fsMocks.chmod,
    copyFile: fsMocks.copyFile,
    mkdir: fsMocks.mkdir,
    readdir: fsMocks.readdir,
    realpath: fsMocks.realpath,
    rename: fsMocks.rename,
    rm: fsMocks.rm,
    stat: fsMocks.stat,
  },
  chmod: fsMocks.chmod,
  copyFile: fsMocks.copyFile,
  mkdir: fsMocks.mkdir,
  readdir: fsMocks.readdir,
  realpath: fsMocks.realpath,
  rename: fsMocks.rename,
  rm: fsMocks.rm,
  stat: fsMocks.stat,
}));

import { resolveManagedNodeRuntimePath } from "./managed-node-runtime.js";

function createMissingError(): NodeJS.ErrnoException {
  const err = new Error("missing") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

beforeEach(() => {
  fsMocks.realpath.mockImplementation(async (target: string) => target);
  fsMocks.readdir.mockResolvedValue(["libnode.127.dylib"]);
  fsMocks.mkdir.mockResolvedValue(undefined);
  fsMocks.copyFile.mockResolvedValue(undefined);
  fsMocks.chmod.mockResolvedValue(undefined);
  fsMocks.stat.mockResolvedValue({
    isFile: () => true,
    mode: 0o755,
  });
  fsMocks.rm.mockResolvedValue(undefined);
  fsMocks.rename.mockImplementation(async (source: string) => {
    if (source === "/Users/test/.openclaw/tools/node") {
      throw createMissingError();
    }
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveManagedNodeRuntimePath", () => {
  it("materializes when /opt node resolves into Cellar and copies resolved dylib files", async () => {
    const optNode = "/opt/homebrew/opt/node/bin/node";
    const cellarNode = "/opt/homebrew/Cellar/node/25.7.0/bin/node";
    const cellarLibDir = "/opt/homebrew/Cellar/node/25.7.0/lib";
    const resolvedDylib = `${cellarLibDir}/libnode.127.dylib`;
    const symlinkDylib = `${cellarLibDir}/libnode.dylib`;

    fsMocks.realpath.mockImplementation(async (target: string) => {
      if (target === optNode) {
        return cellarNode;
      }
      if (target === symlinkDylib) {
        return resolvedDylib;
      }
      return target;
    });
    fsMocks.readdir.mockResolvedValue(["libnode.dylib"]);

    const result = await resolveManagedNodeRuntimePath({
      env: { HOME: "/Users/test" },
      nodePath: optNode,
      platform: "darwin",
      runtime: "node",
    });

    expect(result).toBe("/Users/test/.openclaw/tools/node/bin/node");
    const copiedSources = fsMocks.copyFile.mock.calls.map(([source]) => String(source));
    expect(copiedSources).toContain(cellarNode);
    expect(copiedSources).toContain(resolvedDylib);
    expect(copiedSources).not.toContain(symlinkDylib);
  });

  it("materializes Homebrew Cellar node into ~/.openclaw/tools/node on macOS", async () => {
    const cellarNode = "/opt/homebrew/Cellar/node/25.7.0/bin/node";
    const cellarLibDir = "/opt/homebrew/Cellar/node/25.7.0/lib";
    fsMocks.realpath.mockImplementation(async (target: string) => {
      if (target === "/opt/homebrew/bin/node") {
        return cellarNode;
      }
      return target;
    });
    fsMocks.readdir.mockResolvedValue(["libnode.127.dylib", "libnode.dylib", "libssl.3.dylib"]);

    const result = await resolveManagedNodeRuntimePath({
      env: { HOME: "/Users/test" },
      nodePath: "/opt/homebrew/bin/node",
      platform: "darwin",
      runtime: "node",
    });

    expect(result).toBe("/Users/test/.openclaw/tools/node/bin/node");
    expect(fsMocks.readdir).toHaveBeenCalledWith(cellarLibDir);
    const copiedSources = fsMocks.copyFile.mock.calls.map(([source]) => source);
    expect(copiedSources).toEqual(
      expect.arrayContaining([
        cellarNode,
        `${cellarLibDir}/libnode.127.dylib`,
        `${cellarLibDir}/libnode.dylib`,
      ]),
    );
    expect(copiedSources).not.toContain(`${cellarLibDir}/libssl.3.dylib`);
    const copiedTargets = fsMocks.copyFile.mock.calls.map(([, target]) => String(target));
    expect(copiedTargets.some((target) => target.endsWith("/bin/node"))).toBe(true);
    expect(copiedTargets.some((target) => target.endsWith("/lib/libnode.127.dylib"))).toBe(true);
    expect(fsMocks.rename.mock.calls.at(-1)?.[1]).toBe("/Users/test/.openclaw/tools/node");
  });

  it("returns original path when runtime is not node", async () => {
    const result = await resolveManagedNodeRuntimePath({
      env: { HOME: "/Users/test" },
      nodePath: "/opt/homebrew/bin/node",
      platform: "darwin",
      runtime: "bun",
    });

    expect(result).toBe("/opt/homebrew/bin/node");
    expect(fsMocks.copyFile).not.toHaveBeenCalled();
  });

  it("returns original path when not on macOS", async () => {
    const result = await resolveManagedNodeRuntimePath({
      env: { HOME: "/Users/test" },
      nodePath: "/opt/homebrew/bin/node",
      platform: "linux",
      runtime: "node",
    });

    expect(result).toBe("/opt/homebrew/bin/node");
    expect(fsMocks.copyFile).not.toHaveBeenCalled();
  });

  it("returns original path when node realpath is not in Homebrew Cellar", async () => {
    fsMocks.realpath.mockResolvedValue("/usr/local/bin/node");

    const result = await resolveManagedNodeRuntimePath({
      env: { HOME: "/Users/test" },
      nodePath: "/opt/homebrew/bin/node",
      platform: "darwin",
      runtime: "node",
    });

    expect(result).toBe("/opt/homebrew/bin/node");
    expect(fsMocks.copyFile).not.toHaveBeenCalled();
  });

  it("fails fast when no libnode*.dylib exists in the Cellar runtime", async () => {
    fsMocks.realpath.mockImplementation(async (target: string) => {
      if (target === "/opt/homebrew/bin/node") {
        return "/opt/homebrew/Cellar/node/25.7.0/bin/node";
      }
      return target;
    });
    fsMocks.readdir.mockResolvedValue(["libssl.3.dylib"]);

    await expect(
      resolveManagedNodeRuntimePath({
        env: { HOME: "/Users/test" },
        nodePath: "/opt/homebrew/bin/node",
        platform: "darwin",
        runtime: "node",
      }),
    ).rejects.toThrow("Missing libnode*.dylib");
  });
});
