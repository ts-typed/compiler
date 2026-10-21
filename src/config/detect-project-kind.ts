import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ProjectKind = 'nest' | 'express' | 'typescript';

interface PackageManifest {
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
}

export async function detectProjectKind(projectRoot: string): Promise<ProjectKind> {
  if (await hasNestMarker(projectRoot)) {
    return 'nest';
  }
  if (await hasDependency(projectRoot, 'express')) {
    return 'express';
  }
  return 'typescript';
}

async function hasNestMarker(projectRoot: string): Promise<boolean> {
  try {
    await readFile(join(projectRoot, 'nest-cli.json'), 'utf8');
    return true;
  } catch {
    // A Nest project can omit nest-cli.json, particularly in a monorepo.
  }
  return await hasDependency(projectRoot, '@nestjs/core');
}

async function hasDependency(projectRoot: string, packageName: string): Promise<boolean> {
  const manifest = await readPackageManifest(projectRoot);
  if (manifest === undefined) {
    return false;
  }
  return packageName in (manifest.dependencies ?? {}) || packageName in (manifest.devDependencies ?? {});
}

async function readPackageManifest(projectRoot: string): Promise<PackageManifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageManifest) : undefined;
  } catch {
    return undefined;
  }
}
