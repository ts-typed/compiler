import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PACKAGE_JSON_FILE = 'package.json';

interface PackageManifest {
  readonly scripts?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

interface NestScriptReplacement {
  readonly script: string;
  readonly nestCommands: readonly string[];
  readonly tsTypedCommand: string;
}

const NEST_SCRIPT_REPLACEMENTS: readonly NestScriptReplacement[] = [
  { script: 'build', nestCommands: ['nest build'], tsTypedCommand: 'ts-typed nest build' },
  { script: 'start', nestCommands: ['nest start'], tsTypedCommand: 'ts-typed nest start' },
  { script: 'start:dev', nestCommands: ['nest start --watch', 'nest start -w'], tsTypedCommand: 'ts-typed nest start --watch' },
  { script: 'start:debug', nestCommands: ['nest start --debug --watch'], tsTypedCommand: 'ts-typed nest start --debug --watch' },
];

export interface NestScriptSetupResult {
  readonly changed: boolean;
  readonly message: string;
}

/**
 * Replaces only conventional Nest CLI commands, retaining every script name,
 * flag, and unrelated package manifest field. Running it repeatedly is safe.
 */
export async function configureNestProjectScripts(projectRoot: string): Promise<NestScriptSetupResult> {
  const manifestPath = join(projectRoot, PACKAGE_JSON_FILE);
  let source: string;
  try {
    source = await readFile(manifestPath, 'utf8');
  } catch {
    return { changed: false, message: 'Could not find package.json; Nest npm scripts were not configured.' };
  }

  let manifest: PackageManifest;
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { changed: false, message: 'package.json is not an object; Nest npm scripts were not configured.' };
    }
    manifest = parsed as PackageManifest;
  } catch {
    return { changed: false, message: 'package.json is invalid JSON; Nest npm scripts were not configured.' };
  }

  if (manifest.scripts === undefined || !isStringRecord(manifest.scripts)) {
    return { changed: false, message: 'No conventional Nest npm scripts were found.' };
  }

  let changed = false;
  const scripts: Record<string, unknown> = { ...manifest.scripts };
  for (const replacement of NEST_SCRIPT_REPLACEMENTS) {
    const current = scripts[replacement.script];
    if (typeof current !== 'string') {
      continue;
    }
    const updated = replaceNestCommand(current, replacement);
    if (updated !== current) {
      scripts[replacement.script] = updated;
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, message: 'Nest npm scripts are already configured or use custom commands.' };
  }

  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, scripts }, null, 2)}\n`, 'utf8');
  return { changed: true, message: 'Configured Nest npm scripts to compile with ts-typed.' };
}

function isStringRecord(value: Record<string, unknown>): boolean {
  return Object.values(value).every((item) => typeof item === 'string');
}

function replaceNestCommand(command: string, replacement: NestScriptReplacement): string {
  return replacement.nestCommands.includes(command) ? replacement.tsTypedCommand : command;
}
