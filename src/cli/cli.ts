import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { buildProject } from '../compiler/build';
import type { CoverageReport } from '../compiler/report';
import { createCoverageReport, formatCoverageReport } from '../compiler/report';
import type { ConfigOverrides } from '../config';
import {
  ConfigError,
  configureNestProjectScripts,
  detectProjectKind,
  initializeProject,
  loadConfig,
} from '../config';
import { loadIntegration } from '../integration';
import type { CliResult } from './cli-result.interface';
import { runNestCommand, validateNestBuilder } from './nest-command';
import { runApplication, runWatch } from './run-application';

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
  '  ts-typed start [--root <path>] [--config <path>] [--watch] [--debug]',
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

  if (command === 'start') {
    return await runStart(rest);
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
    const projectKind = await detectProjectKind(parsed.root);
    const isNestProject = projectKind === 'nest';
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

function tryLoadNestIntegration(root: string) {
  try {
    return loadIntegration('@ts-typed/nestjs', root);
  } catch {
    return undefined;
  }
}

async function runStart(args: readonly string[]): Promise<CliResult> {
  const parsed = parseStartArgs(args);
  if (parsed.error !== undefined) {
    return { exitCode: EXIT_USAGE, stdout: [], stderr: [parsed.error] };
  }

  try {
    const kind = await detectProjectKind(parsed.projectRoot);
    if (kind === 'nest') {
      const builderError = await validateNestBuilder(parsed.projectRoot);
      if (builderError !== undefined) {
        return { exitCode: EXIT_FAILURE, stdout: [], stderr: [builderError] };
      }
    }

    // start runs the unbundled entry point, so bundling is always disabled here.
    const config = await loadConfig(parsed.configPath, { ncc: { enabled: false } });
    const report = await buildProject(config);
    if (!report.success) {
      return { exitCode: EXIT_FAILURE, stdout: [], stderr: [...report.errors] };
    }
    const buildResult: CliResult = {
      exitCode: EXIT_SUCCESS,
      stdout: [`Build succeeded: ${report.outDir}`],
      stderr: [],
    };

    if (parsed.watch) {
      return await runWatch(config, parsed.projectRoot, parsed.debug, buildResult, 'ts-typed');
    }

    const exitCode = await runApplication(config, parsed.projectRoot, parsed.debug);
    return {
      exitCode,
      stdout: [...buildResult.stdout, exitCode === 0
        ? 'Application exited successfully.'
        : `Application exited with code ${exitCode}.`],
      stderr: [],
    };
  } catch (error: unknown) {
    return { exitCode: EXIT_FAILURE, stdout: [], stderr: [describeError(error)] };
  }
}

interface ParsedStartArgs {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly debug: boolean;
  readonly watch: boolean;
  readonly error?: string;
}

function parseStartArgs(args: readonly string[]): ParsedStartArgs {
  let projectRoot = process.cwd();
  let configPath: string | undefined;
  let debug = false;
  let watch = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--root') {
      const value = args[index + 1];
      if (value === undefined) {
        return invalidStartArguments(projectRoot, '--root requires a path argument.');
      }
      projectRoot = resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--config') {
      const value = args[index + 1];
      if (value === undefined) {
        return invalidStartArguments(projectRoot, '--config requires a path argument.');
      }
      configPath = resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--watch' || arg === '-w') {
      watch = true;
      continue;
    }
    if (arg === '--debug') {
      debug = true;
      continue;
    }
    return invalidStartArguments(projectRoot, `Unknown start option "${arg}".`);
  }

  return { projectRoot, configPath: configPath ?? join(projectRoot, CONFIG_FILE_NAME), debug, watch };
}

function invalidStartArguments(projectRoot: string, error: string): ParsedStartArgs {
  return { projectRoot, configPath: join(projectRoot, CONFIG_FILE_NAME), debug: false, watch: false, error };
}

async function runBuild(args: readonly string[]): Promise<CliResult> {
  const parsed = parseBuildArgs(args);
  if (parsed.error !== undefined) {
    return { exitCode: EXIT_USAGE, stdout: [], stderr: [parsed.error] };
  }

  try {
    const projectRoot = dirname(parsed.configPath);
    const kind = await detectProjectKind(projectRoot);
    if (kind === 'nest') {
      const builderError = await validateNestBuilder(projectRoot);
      if (builderError !== undefined) {
        return { exitCode: EXIT_FAILURE, stdout: [], stderr: [builderError] };
      }
    }
    const overrides: ConfigOverrides = kind === 'nest'
      ? { ...parsed.overrides, ncc: { ...parsed.overrides.ncc, enabled: false } }
      : parsed.overrides;
    const config = await loadConfig(parsed.configPath, overrides);
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
