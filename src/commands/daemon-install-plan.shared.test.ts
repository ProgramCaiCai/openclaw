import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePreferredNodePath: vi.fn(),
  resolveManagedNodeRuntimePath: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  resolvePreferredNodePath: mocks.resolvePreferredNodePath,
}));

vi.mock("../daemon/managed-node-runtime.js", () => ({
  resolveManagedNodeRuntimePath: mocks.resolveManagedNodeRuntimePath,
}));
import {
  resolveDaemonInstallRuntimeInputs,
  resolveGatewayDevMode,
} from "./daemon-install-plan.shared.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("resolveGatewayDevMode", () => {
  it("detects src ts entrypoints", () => {
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/src/cli/index.ts"])).toBe(true);
    expect(resolveGatewayDevMode(["node", "C:\\Users\\me\\openclaw\\src\\cli\\index.ts"])).toBe(
      true,
    );
    expect(resolveGatewayDevMode(["node", "/Users/me/openclaw/dist/cli/index.js"])).toBe(false);
  });
});

describe("resolveDaemonInstallRuntimeInputs", () => {
  it("materializes a managed node runtime path for node runtime", async () => {
    mocks.resolvePreferredNodePath.mockResolvedValue("/opt/homebrew/bin/node");
    mocks.resolveManagedNodeRuntimePath.mockResolvedValue(
      "/Users/me/.openclaw/tools/node/bin/node",
    );

    await expect(
      resolveDaemonInstallRuntimeInputs({
        env: { HOME: "/Users/me" },
        runtime: "node",
      }),
    ).resolves.toEqual({
      devMode: false,
      nodePath: "/Users/me/.openclaw/tools/node/bin/node",
    });

    expect(mocks.resolvePreferredNodePath).toHaveBeenCalledWith({
      env: { HOME: "/Users/me" },
      runtime: "node",
    });
    expect(mocks.resolveManagedNodeRuntimePath).toHaveBeenCalledWith({
      env: { HOME: "/Users/me" },
      nodePath: "/opt/homebrew/bin/node",
      runtime: "node",
    });
  });

  it("does not materialize a node runtime for non-node runtimes", async () => {
    mocks.resolvePreferredNodePath.mockResolvedValue(undefined);

    await expect(
      resolveDaemonInstallRuntimeInputs({
        env: {},
        runtime: "bun",
      }),
    ).resolves.toEqual({
      devMode: false,
      nodePath: undefined,
    });

    expect(mocks.resolveManagedNodeRuntimePath).not.toHaveBeenCalled();
  });

  it("keeps explicit devMode and nodePath overrides", async () => {
    mocks.resolveManagedNodeRuntimePath.mockResolvedValue("/custom/node");

    await expect(
      resolveDaemonInstallRuntimeInputs({
        env: { HOME: "/Users/me" },
        runtime: "node",
        devMode: false,
        nodePath: "/custom/node",
      }),
    ).resolves.toEqual({
      devMode: false,
      nodePath: "/custom/node",
    });

    expect(mocks.resolvePreferredNodePath).not.toHaveBeenCalled();
    expect(mocks.resolveManagedNodeRuntimePath).toHaveBeenCalledWith({
      env: { HOME: "/Users/me" },
      nodePath: "/custom/node",
      runtime: "node",
    });
  });
});
