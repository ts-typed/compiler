import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface InstallDependencyResult {
  readonly installed: boolean;
  readonly message: string;
}

interface PackageManifest {
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
}

type InstallRunner = (command: string, args: readonly string[], cwd: string) => void;

const defaultRunner: InstallRunner = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(' ')}" exited with code ${result.status ?? 'unknown'}.`);
  }
};

export async function isDependencyInstalled(projectRoot: string, packageName: string): Promise<boolean> {
  const manifest = await readPackageManifest(projectRoot);
  if (manifest === undefined) {
    return false;
  }
  return packageName in (manifest.dependencies ?? {}) || packageName in (manifest.devDependencies ?? {});
}

export async function installDependency(
  projectRoot: string,
  packageName: string,
  run: InstallRunner = defaultRunner,
): Promise<InstallDependencyResult> {
  if (await isDependencyInstalled(projectRoot, packageName)) {
    return { installed: false, message: `${packageName} is already installed.` };
  }

  const { command, addArgs } = detectPackageManager(projectRoot);
  try {
    run(command, [...addArgs, packageName], projectRoot);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    return { installed: false, message: `Could not install ${packageName}: ${detail}` };
  }

  return { installed: true, message: `Installed ${packageName}.` };
}

function detectPackageManager(projectRoot: string): { readonly command: string; readonly addArgs: readonly string[] } {
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) {
    return { command: 'pnpm', addArgs: ['add'] };
  }
  if (existsSync(join(projectRoot, 'yarn.lock'))) {
    return { command: 'yarn', addArgs: ['add'] };
  }
  return { command: 'npm', addArgs: ['install'] };
}

async function readPackageManifest(projectRoot: string): Promise<PackageManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageManifest) : undefined;
  } catch {
    return undefined;
  }
}
