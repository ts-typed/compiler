import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { FSWatcher } from 'node:fs';

import { buildProject } from '../compiler/build';
import type { ProjectConfig } from '../config';
import type { CliResult } from './cli-result.interface';

export function startApplication(config: ProjectConfig, projectRoot: string, debug: boolean): ChildProcess {
  const entryFile = join(resolve(config.outDir), `${entryFileName(config.entry)}.js`);
  return spawn(process.execPath, [...(debug ? ['--inspect'] : []), entryFile], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
}

export async function terminateApplication(application: ChildProcess): Promise<void> {
  if (application.exitCode !== null || application.signalCode !== null) {
    return;
  }
  application.kill('SIGTERM');
  await new Promise<void>((resolveExit) => application.once('exit', () => resolveExit()));
}

export function entryFileName(entry: string): string {
  const fileName = entry.split(/[\\/]/).at(-1) ?? 'main.ts';
  return fileName.endsWith('.ts') ? fileName.slice(0, -3) : fileName;
}

export async function runApplication(config: ProjectConfig, projectRoot: string, debug: boolean): Promise<number> {
  const child = startApplication(config, projectRoot, debug);
  return await new Promise<number>((resolveExit) => {
    child.once('error', () => resolveExit(1));
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

export async function runWatch(
  config: ProjectConfig,
  projectRoot: string,
  debug: boolean,
  initialResult: CliResult,
  label: string,
): Promise<CliResult> {
  const sourceDirectory = dirname(resolve(config.entry));
  let application = startApplication(config, projectRoot, debug);
  let isRebuilding = false;
  let rebuildTimer: NodeJS.Timeout | undefined;

  return await new Promise<CliResult>((resolveWatch) => {
    let watcher: FSWatcher | undefined;
    const finish = async (): Promise<void> => {
      if (rebuildTimer !== undefined) {
        clearTimeout(rebuildTimer);
      }
      watcher?.close();
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      await terminateApplication(application);
      resolveWatch({
        exitCode: 0,
        stdout: [...initialResult.stdout, `${label} watch stopped.`],
        stderr: [],
      });
    };

    const onSignal = (): void => {
      void finish();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const rebuild = async (): Promise<void> => {
      if (isRebuilding) {
        return;
      }
      isRebuilding = true;
      try {
        const report = await buildProject(config);
        if (!report.success) {
          process.stderr.write(`${report.errors.join('\n')}\n`);
          return;
        }
        await terminateApplication(application);
        application = startApplication(config, projectRoot, debug);
      } finally {
        isRebuilding = false;
      }
    };

    try {
      watcher = watch(sourceDirectory, { recursive: true }, () => {
        if (rebuildTimer !== undefined) {
          clearTimeout(rebuildTimer);
        }
        rebuildTimer = setTimeout(() => {
          void rebuild();
        }, 80);
      });
    } catch (error: unknown) {
      void terminateApplication(application);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      const detail = error instanceof Error ? `: ${error.message}` : '';
      resolveWatch({
        exitCode: 1,
        stdout: [],
        stderr: [`Could not watch ${sourceDirectory}${detail}`],
      });
    }
  });
}
