'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { runCli } = require('../../dist/cli');

const PACKAGE_DIST = join(__dirname, '../../dist');

function writeConsumerProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-cli-'));
  const sourceRoot = join(projectRoot, 'src');
  const nodeModulesRoot = join(projectRoot, 'node_modules', '@ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(nodeModulesRoot, { recursive: true });
  symlinkSync(PACKAGE_DIST, join(nodeModulesRoot, 'compiler'), 'dir');

  writeFileSync(
    join(sourceRoot, 'globals.d.ts'),
    'declare const process: { stdout: { write(chunk: string): boolean } };\n',
  );
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Node',
        rootDir: './src',
        outDir: './unused',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(
    join(sourceRoot, 'main.ts'),
    [
      "import { StrictTypeError } from '@ts-typed/compiler';",
      'const value: number = 1;',
      'try { const invalid: any = "bad"; const n: number = invalid; void n; }',
      'catch (error) { if (!(error instanceof StrictTypeError)) throw error; }',
      'process.stdout.write(String(value));',
    ].join('\n'),
  );

  const configPath = join(projectRoot, 'typets.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      $schema: './node_modules/@ts-typed/compiler/schema.json',
      integration: 'typescript',
      extends: null,
      entry: 'src/main.ts',
      tsconfig: 'tsconfig.json',
      outDir: 'dist',
      allowExtraPropertiesAll: false,
      compiler: { sourceMap: false, onUnsupported: 'warn', strictClass: false },
      ncc: {
        enabled: false,
        minify: false,
        sourceMap: false,
        sourceMapRegister: false,
        target: 'es2022',
        externals: [],
        cache: false,
        license: null,
        quiet: true,
        debugLog: false,
      },
      assets: [],
      diagnostics: { format: 'pretty', coverage: 'summary', reportFile: null },
    }),
  );

  return { projectRoot, configPath };
}

test('no command and "help" print usage and exit 0', async () => {
  const noArgs = await runCli([]);
  assert.equal(noArgs.exitCode, 0);
  assert.match(noArgs.stdout.join('\n'), /Usage:/);

  const help = await runCli(['help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout.join('\n'), /Usage:/);
});

test('an unknown command exits with the usage exit code', async () => {
  const result = await runCli(['bogus-command']);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr.join('\n'), /Unknown command/);
});

test('init creates typets.config.json once and is idempotent on a second run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-cli-init-'));

  const first = await runCli(['init', '--root', root]);
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout.join('\n'), /Created/);
  const configPath = join(root, 'typets.config.json');
  assert.equal(existsSync(configPath), true);
  const firstContent = readFileSync(configPath, 'utf8');

  const second = await runCli(['init', '--root', root]);
  assert.equal(second.exitCode, 0);
  assert.match(second.stdout.join('\n'), /already exists/);
  assert.equal(readFileSync(configPath, 'utf8'), firstContent);
});

test('init asks to install the Nest global filter and delegates the opted-in setup to the Nest adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-cli-nest-init-'));
  const adapterDirectory = join(root, 'node_modules', '@ts-typed', 'nestjs');
  mkdirSync(adapterDirectory, { recursive: true });
  writeFileSync(join(root, 'nest-cli.json'), JSON.stringify({ sourceRoot: 'src' }));
  writeFileSync(
    join(adapterDirectory, 'index.js'),
    [
      "const { writeFileSync } = require('node:fs');",
      'module.exports = {',
      '  apiVersion: 1,',
      "  name: 'nestjs',",
      '  resolveProject: (context) => ({ apiVersion: 1, integration: "nestjs", projectRoot: context.projectRoot }),',
      '  installGlobalStrictTypeErrorFilter: (context) => {',
      "    writeFileSync(require('node:path').join(context.projectRoot, 'filter-installed'), 'yes');",
      "    return { changed: true, message: 'Registered global filter.' };",
      '  },',
      '};',
    ].join('\n'),
  );

  let asked = '';
  const result = await runCli(['init', '--root', root], {
    confirm: async (question) => {
      asked = question;
      return true;
    },
  });

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(asked, /Register StrictTypeErrorFilter globally/);
  assert.equal(readFileSync(join(root, 'filter-installed'), 'utf8'), 'yes');
  assert.equal(JSON.parse(readFileSync(join(root, 'typets.config.json'), 'utf8')).integration, '@ts-typed/nestjs');
  assert.match(result.stdout.join('\n'), /Registered global filter/);
});

test('build runs an unbundled project end to end and reports success', async () => {
  const { configPath } = writeConsumerProject();
  const result = await runCli(['build', '--config', configPath]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(result.stdout.join('\n'), /Build succeeded/);
});

test('build reports a non-zero exit code and the configuration error for a missing config file', async () => {
  const missingPath = join(tmpdir(), `does-not-exist-${Date.now()}.json`);
  const result = await runCli(['build', '--config', missingPath]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr.length > 0, true);
});

test('build --no-bundle overrides ncc.enabled for a single run without persisting the override', async () => {
  const { configPath } = writeConsumerProject();

  const result = await runCli(['build', '--config', configPath, '--no-bundle']);
  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.doesNotMatch(result.stdout.join('\n'), /bundled/);

  const configOnDisk = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(configOnDisk.ncc.enabled, false, 'unchanged: config already had ncc disabled');
});

test('an unrecognized build flag exits with the usage exit code', async () => {
  const { configPath } = writeConsumerProject();
  const result = await runCli(['build', '--config', configPath, '--does-not-exist']);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr.join('\n'), /Unknown build option/);
});

function configureDiagnosticsReport(configPath, reportFile) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.diagnostics = { ...config.diagnostics, reportFile };
  writeFileSync(configPath, JSON.stringify(config));
}

test('build writes the coverage report as JSON to diagnostics.reportFile, creating missing parent directories', async () => {
  const { projectRoot, configPath } = writeConsumerProject();
  configureDiagnosticsReport(configPath, './reports/coverage.json');

  const result = await runCli(['build', '--config', configPath]);
  assert.equal(result.exitCode, 0, result.stderr.join('\n'));

  const reportPath = join(projectRoot, 'reports', 'coverage.json');
  assert.equal(existsSync(reportPath), true);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.ok(Array.isArray(report.items));
  assert.ok(Array.isArray(report.warnings));
  assert.ok(Array.isArray(report.files));
  const stdoutText = result.stdout.join('\n');
  assert.match(stdoutText, /Diagnostics report written to .*reports\/coverage\.json$/m);

  const summary = stdoutText.match(/^(\S+): (\d+) protected, (\d+) partial, (\d+) unsupported, (\d+) open$/m);
  assert.ok(summary, 'stdout contains a per-file coverage summary');
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].file.endsWith(summary[1]), true);
  assert.deepEqual(
    [report.files[0].protected, report.files[0].partial, report.files[0].unsupported, report.files[0].open],
    [Number(summary[2]), Number(summary[3]), Number(summary[4]), Number(summary[5])],
  );
});

test('build without diagnostics.reportFile writes no report file', async () => {
  const { projectRoot, configPath } = writeConsumerProject();

  const result = await runCli(['build', '--config', configPath]);
  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.doesNotMatch(result.stdout.join('\n'), /Diagnostics report written/);
  assert.equal(existsSync(join(projectRoot, 'reports')), false);
});

test('build reports a failure when diagnostics.reportFile cannot be written', async () => {
  const { projectRoot, configPath } = writeConsumerProject();
  // A regular file where the report's parent directory should be cannot be created as a directory.
  writeFileSync(join(projectRoot, 'blocker'), 'not a directory');
  configureDiagnosticsReport(configPath, './blocker/coverage.json');

  const result = await runCli(['build', '--config', configPath]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.join('\n'), /Could not write diagnostics report to .*blocker/);
});
