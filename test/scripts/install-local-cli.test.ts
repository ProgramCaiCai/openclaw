import { describe, expect, it } from "vitest";
import {
  buildLocalCliBuildCommand,
  buildLocalCliInstallCommand,
  buildLocalCliPackCommand,
  parseNpmPackJson,
  resolveInstalledCliPath,
} from "../../scripts/install-local-cli.js";

describe("scripts/install-local-cli", () => {
  it("uses the canonical build then pack command sequence", () => {
    expect(buildLocalCliBuildCommand()).toEqual(["pnpm", "build"]);
    expect(buildLocalCliPackCommand({ packDir: "/tmp/openclaw-pack" })).toEqual([
      "npm",
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      "/tmp/openclaw-pack",
    ]);
  });

  it("installs the packed tarball via npm prefix install", () => {
    expect(
      buildLocalCliInstallCommand({
        prefix: "/Users/test/.openclaw",
        tarballPath: "/tmp/openclaw-pack/openclaw-2026.3.15.tgz",
      }),
    ).toEqual([
      "npm",
      "install",
      "-g",
      "--prefix",
      "/Users/test/.openclaw",
      "--no-fund",
      "--no-audit",
      "/tmp/openclaw-pack/openclaw-2026.3.15.tgz",
    ]);
  });

  it("parses npm pack json output and returns the tarball name", () => {
    const packed = parseNpmPackJson(`
      [
        {
          "id": "openclaw@2026.3.15",
          "filename": "openclaw-2026.3.15.tgz"
        }
      ]
    `);

    expect(packed).toEqual({
      filename: "openclaw-2026.3.15.tgz",
      id: "openclaw@2026.3.15",
    });
  });

  it("resolves the installed openclaw binary path under the npm prefix", () => {
    expect(resolveInstalledCliPath("/Users/test/.openclaw", "darwin")).toBe(
      "/Users/test/.openclaw/bin/openclaw",
    );
    expect(resolveInstalledCliPath("C:/Users/test/.openclaw", "win32")).toBe(
      "C:/Users/test/.openclaw/openclaw.cmd",
    );
  });
});
