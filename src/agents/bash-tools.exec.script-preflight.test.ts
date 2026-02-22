import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const isWin = process.platform === "win32";

describe("exec script preflight", () => {
  it("blocks shell env var injection tokens in python scripts before execution", async () => {
    if (isWin) {
      return;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-preflight-"));
    const pyPath = path.join(tmp, "bad.py");

    await fs.writeFile(
      pyPath,
      [
        "import json",
        "# model accidentally wrote shell syntax:",
        "payload = $DM_JSON",
        "print(payload)",
      ].join("\n"),
      "utf-8",
    );

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "python bad.py",
        workdir: tmp,
      }),
    ).rejects.toThrow(/exec preflight: detected likely shell variable injection \(\$DM_JSON\)/);
  });

  it("allows env var tokens inside string literals", async () => {
    if (isWin) {
      return;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-preflight-"));
    const jsPath = path.join(tmp, "ok.js");

    await fs.writeFile(
      jsPath,
      ['console.log("echo $HOME")', "console.log('done')"].join("\n"),
      "utf-8",
    );

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "node ok.js",
        workdir: tmp,
      }),
    ).resolves.toBeTruthy();
  });

  it("allows valid Node identifiers that start with $", async () => {
    if (isWin) {
      return;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-preflight-"));
    const jsPath = path.join(tmp, "ok-ident.js");

    await fs.writeFile(
      jsPath,
      ["const $FOO = 1", "console.log($FOO)", "console.log('done')"].join("\n"),
      "utf-8",
    );

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "node ok-ident.js",
        workdir: tmp,
      }),
    ).resolves.toBeTruthy();
  });

  it("blocks obvious shell-as-js output before node execution", async () => {
    if (isWin) {
      return;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-preflight-"));
    const jsPath = path.join(tmp, "bad.js");

    await fs.writeFile(
      jsPath,
      ['NODE "$TMPDIR/hot.json"', "console.log('hi')"].join("\n"),
      "utf-8",
    );

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call1", {
        command: "node bad.js",
        workdir: tmp,
      }),
    ).rejects.toThrow(
      /exec preflight: (detected likely shell variable injection|JS file starts with shell syntax)/,
    );
  });

  it("skips preflight file reads for script paths outside the workdir", async () => {
    if (isWin) {
      return;
    }

    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-preflight-parent-"));
    const outsidePath = path.join(parent, "outside.js");
    const workdir = path.join(parent, "workdir");
    await fs.mkdir(workdir, { recursive: true });
    await fs.writeFile(outsidePath, "const value = $DM_JSON;", "utf-8");

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    const result = await tool.execute("call-outside", {
      command: "node ../outside.js",
      workdir,
    });
    const text = result.content.find((block) => block.type === "text")?.text ?? "";
    expect(text).not.toMatch(/exec preflight:/);
  });
});
