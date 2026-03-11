import fs from "node:fs/promises";
import path from "node:path";
import { resolveHomeDir } from "./paths.js";

const HOMEBREW_CELLAR_NODE_PATH = /^(.+?)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/;
const LIBNODE_DYLIB = /^libnode.*\.dylib$/;

function normalizeNodePath(inputPath: string): string {
  return path.posix.normalize(inputPath.replaceAll("\\", "/"));
}

function isHomebrewCellarNodePath(nodePath: string): boolean {
  return HOMEBREW_CELLAR_NODE_PATH.test(normalizeNodePath(nodePath));
}

function hasErrnoCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return (error as NodeJS.ErrnoException).code === code;
}

async function resolveRealpathSafe(inputPath: string): Promise<string> {
  try {
    return await fs.realpath(inputPath);
  } catch {
    return inputPath;
  }
}

async function copyMaterializedFile(sourcePath: string, targetPath: string): Promise<void> {
  const resolvedSource = await resolveRealpathSafe(sourcePath);
  const sourceStat = await fs.stat(resolvedSource);
  if (!sourceStat.isFile()) {
    throw new Error(`Expected a file at ${resolvedSource}`);
  }
  await fs.copyFile(resolvedSource, targetPath);
  await fs.chmod(targetPath, sourceStat.mode);
}

async function replaceManagedRuntimeDirectory(params: {
  managedRoot: string;
  stageRoot: string;
}): Promise<void> {
  const backupRoot = `${params.managedRoot}.backup-${process.pid}-${Date.now()}`;
  let movedExisting = false;
  try {
    await fs.rename(params.managedRoot, backupRoot);
    movedExisting = true;
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }

  try {
    await fs.rename(params.stageRoot, params.managedRoot);
  } catch (error) {
    if (movedExisting) {
      await fs.rename(backupRoot, params.managedRoot).catch(() => undefined);
    }
    throw error;
  }

  if (movedExisting) {
    await fs.rm(backupRoot, { recursive: true, force: true });
  }
}

async function materializeCellarNodeRuntime(params: {
  managedRoot: string;
  sourceNodePath: string;
}): Promise<void> {
  const sourceRoot = path.dirname(path.dirname(params.sourceNodePath));
  const sourceLibDir = path.join(sourceRoot, "lib");
  const sourceLibEntries = await fs.readdir(sourceLibDir);
  const nodeDylibNames = sourceLibEntries.filter((entry) => LIBNODE_DYLIB.test(entry)).toSorted();
  if (nodeDylibNames.length === 0) {
    throw new Error(`Missing libnode*.dylib under ${sourceLibDir}`);
  }

  const managedParentDir = path.dirname(params.managedRoot);
  const stageRoot = path.join(managedParentDir, `node.stage-${process.pid}-${Date.now()}`);

  await fs.mkdir(path.join(stageRoot, "bin"), { recursive: true });
  await fs.mkdir(path.join(stageRoot, "lib"), { recursive: true });

  try {
    await copyMaterializedFile(params.sourceNodePath, path.join(stageRoot, "bin", "node"));
    for (const dylibName of nodeDylibNames) {
      await copyMaterializedFile(
        path.join(sourceLibDir, dylibName),
        path.join(stageRoot, "lib", dylibName),
      );
    }
    await replaceManagedRuntimeDirectory({
      managedRoot: params.managedRoot,
      stageRoot,
    });
  } catch (error) {
    await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function resolveManagedNodeRuntimePath(params: {
  env: Record<string, string | undefined>;
  nodePath?: string;
  platform?: NodeJS.Platform;
  runtime?: string;
}): Promise<string | undefined> {
  if (!params.nodePath || params.runtime !== "node") {
    return params.nodePath;
  }
  if ((params.platform ?? process.platform) !== "darwin") {
    return params.nodePath;
  }

  const realNodePath = await resolveRealpathSafe(params.nodePath);
  if (!isHomebrewCellarNodePath(realNodePath)) {
    return params.nodePath;
  }

  const home = resolveHomeDir(params.env);
  const managedRoot = path.join(home, ".openclaw", "tools", "node");
  await fs.mkdir(path.dirname(managedRoot), { recursive: true });
  await materializeCellarNodeRuntime({
    managedRoot,
    sourceNodePath: realNodePath,
  });
  return path.join(managedRoot, "bin", "node");
}
