import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { buildProject } from '../compiler/build';
import { createCoverageReport, formatCoverageReport } from '../compiler/report';
import { ConfigError, loadConfig } from '../config';
import type { ProjectConfig } from '../config';
import type { CliResult } from './cli-result.interface';
import { runApplication, runWatch } from './run-application';

const CONFIG_FILE_NAME = 'typets.config.json';
const NEST_CLI_FILE_NAME = 'nest-cli.json';

interface ParsedNestCommand {
  readonly command: 'build' | 'start';
  readonly configPath: string;
  readonly debug: boolean;
  readonly projectRoot: string;
  readonly watch: boolean;
  readonly error?: string;
}

interface NestBuildExecution {
  readonly result: CliResult;
  readonly config?: ProjectConfig;
}

interface NestCliConfig {
  readonly compilerOptions?: {
    readonly builder?: unknown;
    readonly webpack?: unknown;
  };
}

export async function runNestCommand(argv: readonly string[]): Promise<CliResult> {
  const parsed = parseNestCommand(argv);
  if (parsed.error !== undefined) {
    return { exitCode: 2, stdout: [], stderr: [parsed.error] };
  }

  try {
    const builderError = await validateNestBuilder(parsed.projectRoot);
    if (builderError !== undefined) {
      return { exitCode: 1, stdout: [], stderr: [builderError] };
    }

    const build = await runNestBuild(parsed);
    if (build.result.exitCode !== 0 || parsed.command === 'build' || build.config === undefined) {
      return build.result;
    }

    if (parsed.watch) {
      return await runWatch(build.config, parsed.projectRoot, parsed.debug, build.result, 'Nest');
    }

    const exitCode = await runApplication(build.config, parsed.projectRoot, parsed.debug);
    return {
      exitCode,
      stdout: [...build.result.stdout, exitCode === 0
        ? 'Nest application exited successfully.'
        : `Nest application exited with code ${exitCode}.`],
      stderr: build.result.stderr,
    };
  } catch (error: unknown) {
    return { exitCode: 1, stdout: [], stderr: [describeError(error)] };
  }
}

async function runNestBuild(parsed: ParsedNestCommand): Promise<NestBuildExecution> {
  const config = await loadConfig(parsed.configPath, { ncc: { enabled: false } });
  const report = await buildProject(config);
  if (!report.success) {
    return { result: { exitCode: 1, stdout: [], stderr: [...report.errors] } };
  }

  const coverage = report.coverage ?? createCoverageReport([], []);
  return {
    config,
    result: {
      exitCode: 0,
      stdout: [
        `Nest build succeeded: ${report.outDir}`,
        formatCoverageReport(coverage, resolve(config.tsconfig, '..')),
      ].filter((line) => line.length > 0),
      stderr: [],
    },
  };
}

export function parseNestCommand(argv: readonly string[]): ParsedNestCommand {
  const command = argv[0];
  if (command !== 'build' && command !== 'start') {
    return {
      command: 'build',
      configPath: join(process.cwd(), CONFIG_FILE_NAME),
      debug: false,
      projectRoot: process.cwd(),
      watch: false,
      error: command === undefined
        ? 'The Nest command is required. Use "ts-typed nest build" or "ts-typed nest start".'
        : `Unsupported Nest command "${command}". Use "ts-typed nest build" or "ts-typed nest start".`,
    };
  }

  let projectRoot = process.cwd();
  let configPath: string | undefined;
  let debug = false;
  let isWatchMode = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[index + 1];
      if (value === undefined) {
        return invalidNestArguments(projectRoot, '--root requires a path argument.');
      }
      projectRoot = resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--config') {
      const value = argv[index + 1];
      if (value === undefined) {
        return invalidNestArguments(projectRoot, '--config requires a path argument.');
      }
      configPath = resolve(value);
      index += 1;
      continue;
    }
    if (argument === '--debug') {
      debug = true;
      continue;
    }
    if (argument === '--watch' || argument === '-w') {
      isWatchMode = true;
      continue;
    }
    return invalidNestArguments(projectRoot, `Unsupported Nest build option "${argument}".`);
  }

  return {
    command,
    configPath: configPath ?? join(projectRoot, CONFIG_FILE_NAME),
    debug,
    projectRoot,
    watch: isWatchMode,
  };
}

function invalidNestArguments(projectRoot: string, error: string): ParsedNestCommand {
  return {
    command: 'build',
    configPath: join(projectRoot, CONFIG_FILE_NAME),
    debug: false,
    projectRoot,
    watch: false,
    error,
  };
}

export async function validateNestBuilder(projectRoot: string): Promise<string | undefined> {
  const configPath = join(projectRoot, NEST_CLI_FILE_NAME);
  let source: string;
  try {
    source = await readFile(configPath, 'utf8');
  } catch {
    return `Could not find ${NEST_CLI_FILE_NAME} in ${projectRoot}.`;
  }

  let config: NestCliConfig;
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return `${NEST_CLI_FILE_NAME} must contain a JSON object.`;
    }
    config = parsed as NestCliConfig;
  } catch {
    return `${NEST_CLI_FILE_NAME} is invalid JSON.`;
  }

  const builder = getNestBuilder(config);
  if (builder === undefined || builder === 'tsc') {
    return undefined;
  }
  return `Nest builder "${builder}" is not supported by ts-typed yet. Use the TypeScript "tsc" builder because SWC, Rspack, and webpack cannot run the TS Typed TypeScript transformer.`;
}

function getNestBuilder(config: NestCliConfig): string | undefined {
  if (config.compilerOptions?.webpack === true) {
    return 'webpack';
  }
  const builder = config.compilerOptions?.builder;
  if (typeof builder === 'string') {
    return builder;
  }
  if (typeof builder === 'object' && builder !== null && !Array.isArray(builder)) {
    const type = (builder as { readonly type?: unknown }).type;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

function describeError(error: unknown): string {
  if (error instanceof ConfigError) {
    return `Configuration error: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}
