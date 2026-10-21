import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PACKAGE_JSON_FILE = 'package.json';

const STANDARD_SCRIPTS: Readonly<Record<string, string>> = {
  build: 'ts-typed build',
  start: 'ts-typed start',
  dev: 'ts-typed start --watch',
  'start:prod': 'node dist/index.js',
};

interface PackageManifest {
  readonly scripts?: unknown;
  readonly [key: string]: unknown;
}

export interface ProjectScriptSetupResult {
  readonly changed: boolean;
  readonly message: string;
}

/**
 * Fills in whichever of `build`/`start`/`dev`/`start:prod` is absent from
 * `package.json`. Every existing script entry is kept exactly as it is, under
 * any value, so a custom command with the same name is never overwritten.
 */
export async function configureProjectScripts(projectRoot: string): Promise<ProjectScriptSetupResult> {
  const manifestPath = join(projectRoot, PACKAGE_JSON_FILE);
  let source: string;
  try {
    source = await readFile(manifestPath, 'utf8');
  } catch {
    return { changed: false, message: 'Could not find package.json; npm scripts were not configured.' };
  }

  let manifest: PackageManifest;
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { changed: false, message: 'package.json is not an object; npm scripts were not configured.' };
    }
    manifest = parsed as PackageManifest;
  } catch {
    return { changed: false, message: 'package.json is invalid JSON; npm scripts were not configured.' };
  }

  if (manifest.scripts !== undefined && (typeof manifest.scripts !== 'object' || manifest.scripts === null || Array.isArray(manifest.scripts))) {
    return { changed: false, message: 'package.json "scripts" is not an object; npm scripts were not configured.' };
  }

  const existingScripts = (manifest.scripts ?? {}) as Record<string, unknown>;
  const scripts: Record<string, unknown> = { ...existingScripts };
  let changed = false;
  for (const [name, command] of Object.entries(STANDARD_SCRIPTS)) {
    if (!Object.prototype.hasOwnProperty.call(scripts, name)) {
      scripts[name] = command;
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, message: 'build/start/dev/start:prod scripts are already configured.' };
  }

  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, scripts }, null, 2)}\n`, 'utf8');
  return { changed: true, message: 'Configured build/start/dev/start:prod npm scripts to use ts-typed.' };
}
