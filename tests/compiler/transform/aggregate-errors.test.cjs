'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { analyzeProject } = require('../../../dist/compiler/analysis');
const { createContractTransformer } = require('../../../dist/compiler/transform');

const runtimeModule = join(__dirname, '../../../dist/runtime');
const runtimeIndex = join(runtimeModule, 'index.js');

// The `@AggregateErrors()` decorator's provenance check (mirroring the
// ValueObject one in value-object-embedding.test.cjs) requires its
// declaration to live under a `.../@ts-typed/compiler/.../runtime/
// aggregate-errors.decorator.d.ts` path, the same way a real installed copy
// of this package would be laid out. The friendlier `ts-typed` package only
// re-exports the error classes used for type-checking the fixture; the
// decorator itself is imported straight from `@ts-typed/compiler`, same as
// `ValueObject` is in the value-object fixture.
function writeProject(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-aggregate-errors-'));
  const sourceRoot = join(projectRoot, 'src');
  const tsTypedRoot = join(projectRoot, 'node_modules', 'ts-typed');
  const compilerRoot = join(projectRoot, 'node_modules', '@ts-typed', 'compiler');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(tsTypedRoot, { recursive: true });
  mkdirSync(join(compilerRoot, 'dist', 'runtime'), { recursive: true });

  writeFileSync(
    join(tsTypedRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {}',
      'export class AggregateStrictTypeError extends StrictTypeError {',
      '  readonly errors: readonly { propertyPath: string }[];',
      '}',
    ].join('\n'),
  );
  writeFileSync(
    join(compilerRoot, 'package.json'),
    JSON.stringify({ name: '@ts-typed/compiler', main: 'dist/index.js', types: 'dist/index.d.ts' }),
  );
  writeFileSync(
    join(compilerRoot, 'dist', 'index.js'),
    `module.exports = require(${JSON.stringify(runtimeIndex)});\n`,
  );
  writeFileSync(
    join(compilerRoot, 'dist', 'index.d.ts'),
    "export { AggregateErrors } from './runtime/aggregate-errors.decorator';\n",
  );
  writeFileSync(
    join(compilerRoot, 'dist', 'runtime', 'aggregate-errors.decorator.d.ts'),
    'export declare function AggregateErrors(): ClassDecorator;\n',
  );
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
        outDir: './out',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = join(sourceRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source);
  }
  return { projectRoot, tsconfigPath: join(projectRoot, 'tsconfig.json') };
}

function emitProject(files) {
  const project = writeProject(files);
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath });
  assert.equal(
    analysis.tsDiagnostics.length,
    0,
    analysis.tsDiagnostics.map((diagnostic) => diagnostic.messageText).join('\n'),
  );
  const emitResult = analysis.program.emit(
    undefined,
    undefined,
    undefined,
    false,
    {
      before: [
        createContractTransformer({
          analysis,
          runtimeModule,
          onDiagnostic: () => undefined,
        }),
      ],
    },
  );
  assert.equal(emitResult.emitSkipped, false);
  return { ...project, outputRoot: join(project.projectRoot, 'out') };
}

function runMain(files) {
  const project = emitProject(files);
  const result = spawnSync(process.execPath, [join(project.outputRoot, 'main.js')], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('a plain object literal (never instantiated) crossing a parameter typed by a cross-file @AggregateErrors() DTO is fully aggregated', () => {
  const result = runMain({
    'dto.ts': [
      "import { AggregateErrors } from '@ts-typed/compiler';",
      '',
      '@AggregateErrors()',
      'export class CreateUserDto {',
      "  name: string = '';",
      '  age: number = 0;',
      '}',
    ].join('\n'),
    'main.ts': [
      "import { AggregateStrictTypeError } from 'ts-typed';",
      "import { CreateUserDto } from './dto';",
      '',
      'function createUser(dto: CreateUserDto): void { /* noop */ }',
      '',
      'let caught: any = undefined;',
      'try {',
      "  createUser({ name: 42, age: 'old' } as any);",
      '} catch (error) {',
      '  caught = error;',
      '}',
      'const results = {',
      '  isAggregate: caught instanceof AggregateStrictTypeError,',
      '  errorCount: caught === undefined ? 0 : caught.errors.length,',
      '  paths: caught === undefined ? [] : caught.errors.map((e: any) => e.propertyPath),',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isAggregate, true, JSON.stringify(result));
  assert.equal(result.errorCount, 2, JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('.name')), JSON.stringify(result));
  assert.ok(result.paths.some((path) => path.endsWith('.age')), JSON.stringify(result));
});

test('a plain object literal crossing a parameter typed by an undecorated cross-file DTO stays fail-fast', () => {
  const result = runMain({
    'dto.ts': [
      'export class PlainDto {',
      "  name: string = '';",
      '  age: number = 0;',
      '}',
    ].join('\n'),
    'main.ts': [
      "import { StrictTypeError, AggregateStrictTypeError } from 'ts-typed';",
      "import { PlainDto } from './dto';",
      '',
      'function createUser(dto: PlainDto): void { /* noop */ }',
      '',
      'let caught: any = undefined;',
      'try {',
      "  createUser({ name: 42, age: 'old' } as any);",
      '} catch (error) {',
      '  caught = error;',
      '}',
      'const results = {',
      '  isStrictTypeError: caught instanceof StrictTypeError,',
      '  isAggregate: caught instanceof AggregateStrictTypeError,',
      '};',
      'process.stdout.write(JSON.stringify(results));',
    ].join('\n'),
  });

  assert.equal(result.isStrictTypeError, true, JSON.stringify(result));
  assert.equal(result.isAggregate, false, JSON.stringify(result));
});
