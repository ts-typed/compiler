import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { buildProject } from '../compiler/build';
import type { CoverageReport } from '../compiler/report';
import { createCoverageReport, formatCoverageReport } from '../compiler/report';
import type { ConfigOverrides } from '../config';
import { ConfigError, configureNestProjectScripts, initializeProject, loadConfig } from '../config';
import { loadIntegration } from '../integration';
import type { CliResult } from './cli-result.interface';
import { runNestCommand } from './nest-command';

const CONFIG_FILE_NAME = 'typets.config.json';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const HELP_TEXT = [
  'ts-typed — runtime-protected TypeScript contracts',
  '',
  'Usage:',
  '  ts-typed init [--root <path>]',
  '  ts-typed build [--config <path>] [--no-bundle] [--minify] [--sourcemap]',
  '  ts-typed nest build [--root <path>] [--config <path>]',
  '  ts-typed help',
  '',
  'Options:',
  '  --root <path>      Project root for init (default: current directory)',
  '  --config <path>    Path to typets.config.json (default: ./typets.config.json)',
  '  --no-bundle        Disable ncc bundling for this run (ncc.enabled=false)',
  '  --minify           Enable bundle minification for this run (ncc.minify=true)',
  '  --sourcemap        Enable source maps for this run (compiler and bundle)',
].join('\n');

export interface RunCliOptions {
  /** Provided by the executable only when it has an interactive terminal. */
  readonly confirm?: (question: string) => Promise<boolean>;
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const [command, ...rest] = argv;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { exitCode: EXIT_SUCCESS, stdout: [HELP_TEXT], stderr: [] };
  }

  if (command === 'init') {
    return await runInit(rest, options);
  }

  if (command === 'build') {
    return await runBuild(rest);
  }

  if (command === 'nest') {
    return await runNestCommand(rest);
  }

  return {
    exitCode: EXIT_USAGE,
    stdout: [],
    stderr: [`Unknown command "${command}".`, HELP_TEXT],
  };
}

async function runInit(args: readonly string[], options: RunCliOptions): Promise<CliResult> {
  const parsed = parseInitArgs(args);
  if (parsed.error !== undefined) {
    return { exitCode: EXIT_USAGE, stdout: [], stderr: [parsed.error] };
  }

  try {
    const isNestProject = await hasNestProjectMarker(parsed.root);
    const nestAdapter = isNestProject ? tryLoadNestIntegration(parsed.root) : undefined;
    const result = await initializeProject(parsed.root, {
      ...(nestAdapter === undefined ? {} : { integration: '@ts-typed/nestjs' }),
    });
    const stdout = [result.created
      ? `Created ${result.configPath}`
      : `Configuration already exists at ${result.configPath}`];

    if (!isNestProject) {
      stdout.push(
        'Suggested package.json scripts:',
        ...result.suggestedScripts.map((script) => `  ${script}`),
      );
    }

    if (isNestProject) {
      const scripts = await configureNestProjectScripts(parsed.root);
      stdout.push(scripts.message);
      const installFilter = nestAdapter?.installGlobalStrictTypeErrorFilter;
      if (installFilter === undefined) {
        stdout.push('NestJS detected, but @ts-typed/nestjs is unavailable; global filter was not configured.');
      } else if (options.confirm !== undefined) {
        const accepted = await options.confirm(
          'NestJS detected. Register StrictTypeErrorFilter globally to return HTTP 400 errors? [y/N] ',
        );
        if (accepted) {
          const setup = installFilter({ projectRoot: parsed.root });
          stdout.push(setup.message);
        } else {
          stdout.push('Global StrictTypeErrorFilter was not registered.');
        }
      }
    }
    return { exitCode: EXIT_SUCCESS, stdout, stderr: [] };
  } catch (error: unknown) {
    return { exitCode: EXIT_FAILURE, stdout: [], stderr: [describeError(error)] };
  }
}

interface PackageManifest {
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
}

async function hasNestProjectMarker(root: string): Promise<boolean> {
  try {
    await readFile(join(root, 'nest-cli.json'), 'utf8');
    return true;
  } catch {
    // A Nest project can omit nest-cli.json, particularly in a monorepo.
  }

  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null) {
      return false;
    }
    const packageManifest = manifest as PackageManifest;
    return '@nestjs/core' in (packageManifest.dependencies ?? {})
      || '@nestjs/core' in (packageManifest.devDependencies ?? {});
  } catch {
    return false;
  }
}

function tryLoadNestIntegration(root: string) {
  try {
    return loadIntegration('@ts-typed/nestjs', root);
  } catch {
    return undefined;
  }
}

async function runBuild(args: readonly string[]): Promise<CliResult> {
  const parsed = parseBuildArgs(args);
  if (parsed.error !== undefined) {
    return { exitCode: EXIT_USAGE, stdout: [], stderr: [parsed.error] };
  }

  try {
    const config = await loadConfig(parsed.configPath, parsed.overrides);
    const report = await buildProject(config);

    if (!report.success) {
      return { exitCode: EXIT_FAILURE, stdout: [], stderr: [...report.errors] };
    }

    const coverage = report.coverage ?? createCoverageReport([], []);
    const stdout = [
      `Build succeeded: ${report.outDir}${report.bundled ? ' (bundled)' : ''}`,
      formatCoverageReport(coverage, resolve(config.tsconfig, '..')),
    ].filter((line) => line.length > 0);

    const reportFile = config.diagnostics.reportFile;
    if (reportFile !== null) {
      await writeDiagnosticsReport(reportFile, coverage);
      stdout.push(`Diagnostics report written to ${reportFile}`);
    }

    return { exitCode: EXIT_SUCCESS, stdout, stderr: [] };
  } catch (error: unknown) {
    return { exitCode: EXIT_FAILURE, stdout: [], stderr: [describeError(error)] };
  }
}

async function writeDiagnosticsReport(filePath: string, coverage: CoverageReport): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(coverage, null, 2)}\n`, 'utf8');
  } catch (error: unknown) {
    throw new Error(`Could not write diagnostics report to ${filePath}: ${describeError(error)}`);
  }
}

interface ParsedInitArgs {
  readonly root: string;
  readonly error?: string;
}

function parseInitArgs(args: readonly string[]): ParsedInitArgs {
  let root = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--root') {
      const value = args[index + 1];
      if (value === undefined) {
        return { root, error: '--root requires a path argument.' };
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    return { root, error: `Unknown init option "${arg}".` };
  }
  return { root };
}

interface ParsedBuildArgs {
  readonly configPath: string;
  readonly overrides: ConfigOverrides;
  readonly error?: string;
}

function parseBuildArgs(args: readonly string[]): ParsedBuildArgs {
  let configPath = join(process.cwd(), CONFIG_FILE_NAME);
  let noBundle = false;
  let minify = false;
  let sourcemap = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') {
      const value = args[index + 1];
      if (value === undefined) {
        return { configPath, overrides: {}, error: '--config requires a path argument.' };
      }
      configPath = resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--no-bundle') {
      noBundle = true;
      continue;
    }
    if (arg === '--minify') {
      minify = true;
      continue;
    }
    if (arg === '--sourcemap') {
      sourcemap = true;
      continue;
    }
    return { configPath, overrides: {}, error: `Unknown build option "${arg}".` };
  }

  const overrides: ConfigOverrides = {
    ...(noBundle || minify || sourcemap
      ? {
          ncc: {
            ...(noBundle ? { enabled: false } : {}),
            ...(minify ? { minify: true } : {}),
            ...(sourcemap ? { sourceMap: true } : {}),
          },
        }
      : {}),
    ...(sourcemap ? { compiler: { sourceMap: true } } : {}),
  };

  return { configPath, overrides };
}

function describeError(error: unknown): string {
  if (error instanceof ConfigError) {
    return `Configuration error: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}
