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

function writeProject(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-server-populated-'));
  const sourceRoot = join(projectRoot, 'src');
  const declarationRoot = join(projectRoot, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarationRoot, { recursive: true });
  writeFileSync(
    join(declarationRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {',
      '  readonly isServerPopulated?: boolean;',
      '}',
      'export function ServerPopulated(): ClassDecorator;',
    ].join('\n'),
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

function runMain(source) {
  const project = emitProject({ 'main.ts': source });
  const result = spawnSync(process.execPath, [join(project.outputRoot, 'main.js')], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Captures the thrown StrictTypeError from a wrong-type field write and reports
// its isServerPopulated flag (as a string, to distinguish undefined from false),
// plus the serialized forms, so the test can assert on each.
function captureFieldViolation(classSource, instanceExpression) {
  return runMain([
    "import { StrictTypeError, ServerPopulated } from 'ts-typed';",
    classSource,
    'let caught: any = undefined;',
    'try { (' + instanceExpression + ' as any).status = 42; }',
    'catch (error) { caught = error; }',
    'const results = {',
    '  isStrictTypeError: caught instanceof StrictTypeError,',
    '  flagType: caught === undefined ? "none" : typeof caught.isServerPopulated,',
    '  flagValue: caught === undefined ? null : caught.isServerPopulated ?? null,',
    '  json: caught === undefined ? "" : JSON.stringify(caught),',
    '  toJSONKeys: caught === undefined ? [] : Object.keys(caught.toJSON()),',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));
}

test('a @ServerPopulated class exposes isServerPopulated === true on the thrown StrictTypeError', () => {
  const result = captureFieldViolation(
    [
      '@ServerPopulated()',
      'class Entity { protected status: string = "ok"; }',
      'const entity = new Entity();',
    ].join('\n'),
    'entity',
  );

  assert.equal(result.isStrictTypeError, true);
  assert.equal(result.flagType, 'boolean');
  assert.equal(result.flagValue, true);
});

test('an unmarked class leaves isServerPopulated genuinely absent (undefined, not false)', () => {
  const result = captureFieldViolation(
    [
      'class Plain { protected status: string = "ok"; }',
      'const plain = new Plain();',
    ].join('\n'),
    'plain',
  );

  assert.equal(result.isStrictTypeError, true);
  assert.equal(result.flagType, 'undefined');
  assert.equal(result.flagValue, null);
});

test('a public field on a @ServerPopulated class also carries isServerPopulated === true', () => {
  const result = captureFieldViolation(
    [
      '@ServerPopulated()',
      'class Entity { status: string = "ok"; }',
      'const entity = new Entity();',
    ].join('\n'),
    'entity',
  );

  assert.equal(result.isStrictTypeError, true);
  assert.equal(result.flagValue, true);
});

test('isServerPopulated is inherited through a subclass prototype chain', () => {
  const result = captureFieldViolation(
    [
      '@ServerPopulated()',
      'class Base { protected status: string = "ok"; }',
      'class Child extends Base {}',
      'const child = new Child();',
    ].join('\n'),
    'child',
  );

  assert.equal(result.isStrictTypeError, true);
  assert.equal(result.flagValue, true);
});

test('isServerPopulated never leaks into toJSON() or JSON.stringify output', () => {
  const result = captureFieldViolation(
    [
      '@ServerPopulated()',
      'class Entity { protected status: string = "ok"; }',
      'const entity = new Entity();',
    ].join('\n'),
    'entity',
  );

  assert.equal(result.flagValue, true, 'precondition: the flag is set on the instance');
  assert.equal(result.json.includes('isServerPopulated'), false, result.json);
  assert.equal(result.toJSONKeys.includes('isServerPopulated'), false);
  assert.equal(result.toJSONKeys.includes('contractKind'), true);
});
