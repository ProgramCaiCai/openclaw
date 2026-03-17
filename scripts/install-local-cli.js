#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  process.stderr.write(
    "Usage: node scripts/install-local-cli.js --prefix <path> [--repo-root <path>] [--expected-version <version>] [--json]\n",
  );
}

function readPackageVersion(repoRoot) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const version = packageJson?.version;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(`Missing package.json version at ${packageJsonPath}`);
  }
  return version.trim();
}

function resolveLocalPnpm(repoRoot) {
  const candidate = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  );
  return fs.existsSync(candidate) ? candidate : "pnpm";
}

function buildCommandEnv(repoRoot) {
  const localBin = path.join(repoRoot, "node_modules", ".bin");
  const currentPath = process.env.PATH ?? "";
  const nextPath = [localBin, currentPath].filter(Boolean).join(path.delimiter);
  return { ...process.env, PATH: nextPath };
}

function shouldUseWindowsShell(command, platform = process.platform) {
  if (platform !== "win32") {
    return false;
  }
  return /\.(cmd|bat|com)$/i.test(command);
}

function runCommand(command, options) {
  const [program, ...args] = command;
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: "pipe",
    shell: shouldUseWindowsShell(program),
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    error: result.error,
  };
}

function commandFailure(label, command, result) {
  const detail = [result.stderr, result.stdout]
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  const commandText = command.join(" ");
  const exitText = result.error
    ? result.error.message
    : result.status == null
      ? "unknown exit"
      : `exit ${result.status}`;
  return `${label} failed (${exitText}): ${detail ?? commandText}`;
}

function emitEvent(json, event) {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  if (event.event === "error") {
    process.stderr.write(`${event.message}\n`);
    return;
  }

  if (event.message) {
    process.stdout.write(`${event.message}\n`);
  }
}

export function buildLocalCliBuildCommand(pnpmBin = "pnpm") {
  return [pnpmBin, "build"];
}

export function buildLocalCliPackCommand({ packDir, npmBin = "npm" }) {
  if (!packDir) {
    throw new Error("packDir is required");
  }

  return [npmBin, "pack", "--ignore-scripts", "--json", "--pack-destination", packDir];
}

export function buildLocalCliInstallCommand({ prefix, tarballPath, npmBin = "npm" }) {
  if (!prefix) {
    throw new Error("prefix is required");
  }
  if (!tarballPath) {
    throw new Error("tarballPath is required");
  }

  return [npmBin, "install", "-g", "--prefix", prefix, "--no-fund", "--no-audit", tarballPath];
}

export function resolveInstalledCliPath(prefix, platform = process.platform) {
  return platform === "win32"
    ? path.join(prefix, "openclaw.cmd")
    : path.join(prefix, "bin", "openclaw");
}

export function parseNpmPackJson(output) {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("npm pack returned empty output");
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Unable to parse npm pack json output");
    }
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  }

  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || typeof entry.filename !== "string" || entry.filename.trim().length === 0) {
    throw new Error("npm pack json missing filename");
  }

  return {
    filename: entry.filename.trim(),
    id: typeof entry.id === "string" ? entry.id.trim() : undefined,
  };
}

function installLocalCli({ repoRoot, prefix, expectedVersion, json }) {
  const normalizedRepoRoot = path.resolve(repoRoot);
  const normalizedPrefix = path.resolve(prefix);
  const packageVersion = readPackageVersion(normalizedRepoRoot);

  if (expectedVersion && packageVersion !== expectedVersion) {
    throw new Error(
      `Local package version ${packageVersion} does not match expected ${expectedVersion}`,
    );
  }

  const env = buildCommandEnv(normalizedRepoRoot);
  const pnpmBin = resolveLocalPnpm(normalizedRepoRoot);
  const tempPackDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-pack."));

  try {
    const buildCommand = buildLocalCliBuildCommand(pnpmBin);
    emitEvent(json, {
      event: "step",
      message: "Building current checkout with pnpm build…",
    });
    const buildResult = runCommand(buildCommand, { cwd: normalizedRepoRoot, env });
    if (buildResult.error || buildResult.status !== 0) {
      throw new Error(commandFailure("pnpm build", buildCommand, buildResult));
    }

    const packCommand = buildLocalCliPackCommand({ packDir: tempPackDir });
    emitEvent(json, {
      event: "step",
      message: "Packing current checkout with npm pack…",
    });
    const packResult = runCommand(packCommand, { cwd: normalizedRepoRoot, env });
    if (packResult.error || packResult.status !== 0) {
      throw new Error(commandFailure("npm pack", packCommand, packResult));
    }

    const packed = parseNpmPackJson(packResult.stdout);
    const tarballPath = path.join(tempPackDir, packed.filename);
    if (!fs.existsSync(tarballPath)) {
      throw new Error(`Packed tarball missing at ${tarballPath}`);
    }

    const installCommand = buildLocalCliInstallCommand({
      prefix: normalizedPrefix,
      tarballPath,
    });
    emitEvent(json, {
      event: "step",
      message: `Installing ${packed.filename} into ${normalizedPrefix} via npm install…`,
    });
    const installResult = runCommand(installCommand, { cwd: normalizedRepoRoot, env });
    if (installResult.error || installResult.status !== 0) {
      throw new Error(commandFailure("npm install", installCommand, installResult));
    }

    const installedCliPath = resolveInstalledCliPath(normalizedPrefix);
    if (!fs.existsSync(installedCliPath)) {
      throw new Error(`Installed CLI missing at ${installedCliPath}`);
    }

    const verifyResult = runCommand([installedCliPath, "--version"], {
      cwd: normalizedRepoRoot,
      env,
    });
    if (verifyResult.error || verifyResult.status !== 0) {
      throw new Error(
        commandFailure("openclaw --version", [installedCliPath, "--version"], verifyResult),
      );
    }

    const installedVersion = verifyResult.stdout.trim() || packageVersion;
    emitEvent(json, {
      event: "done",
      version: installedVersion,
      message: `Installed openclaw ${installedVersion}.`,
    });
  } finally {
    fs.rmSync(tempPackDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    prefix: "",
    expectedVersion: undefined,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--repo-root") {
      options.repoRoot = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--prefix") {
      options.prefix = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--expected-version") {
      options.expectedVersion = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.prefix) {
    throw new Error("--prefix is required");
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    usage();
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }

  try {
    installLocalCli(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitEvent(options.json, { event: "error", message });
    process.exit(1);
  }
}

const isDirectExecution = (() => {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
})();

if (isDirectExecution) {
  main();
}
