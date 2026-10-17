#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runCli } from './cli';

export { runCli } from './cli';
export type { CliResult } from './cli-result.interface';

// Guarded so requiring this module (e.g. from tests) never triggers the
// process-level side effects below; only running it directly as the `bin`
// executable does.
if (require.main === module) {
  const confirm = stdin.isTTY && stdout.isTTY
    ? async (question: string): Promise<boolean> => {
        const terminal = createInterface({ input: stdin, output: stdout });
        try {
          const answer = (await terminal.question(question)).trim().toLowerCase();
          return answer === 'y' || answer === 'yes' || answer === 's' || answer === 'sim';
        } finally {
          terminal.close();
        }
      }
    : undefined;

  runCli(process.argv.slice(2), { ...(confirm === undefined ? {} : { confirm }) })
    .then((result) => {
      for (const line of result.stdout) {
        process.stdout.write(`${line}\n`);
      }
      for (const line of result.stderr) {
        process.stderr.write(`${line}\n`);
      }
      process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
      process.exitCode = 1;
    });
}
