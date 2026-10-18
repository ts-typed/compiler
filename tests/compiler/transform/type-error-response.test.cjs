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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-type-error-response-'));
  const sourceRoot = join(projectRoot, 'src');
  const declarationRoot = join(projectRoot, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarationRoot, { recursive: true });
  writeFileSync(
    join(declarationRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {',
      '  readonly isServerPopulated?: boolean;',
      '  readonly typeErrorResponseMessage?: string;',
      '  readonly typeErrorResponseStatus?: number;',
      '}',
      'export function ServerPopulated(): ClassDecorator;',
      'export function TypeErrorResponse(message: string, status?: number): PropertyDecorator;',
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
// the response fields (as strings, to distinguish undefined from set values),
// plus the serialized forms, so the test can assert on each.
function captureFieldViolation(classSource, instanceExpression, field = 'status') {
  return runMain([
    "import { StrictTypeError, ServerPopulated, TypeErrorResponse } from 'ts-typed';",
    classSource,
    'let caught: any = undefined;',
    'try { (' + instanceExpression + ' as any).' + field + ' = 42; }',
    'catch (error) { caught = error; }',
    'const results = {',
    '  isStrictTypeError: caught instanceof StrictTypeError,',
    '  messageType: caught === undefined ? "none" : typeof caught.typeErrorResponseMessage,',
    '  messageValue: caught === undefined ? null : caught.typeErrorResponseMessage ?? null,',
    '  statusType: caught === undefined ? "none" : typeof caught.typeErrorResponseStatus,',
    '  statusValue: caught === undefined ? null : caught.typeErrorResponseStatus ?? null,',
    '  serverPopulated: caught === undefined ? null : caught.isServerPopulated ?? null,',
    '  json: caught === undefined ? "" : JSON.stringify(caught),',
    '  toJSONKeys: caught === undefined ? [] : Object.keys(caught.toJSON()),',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));
}

test('a @TypeErrorResponse field exposes its message and status on the thrown StrictTypeError', () => {
  const result = captureFieldViolation(
    [
      'class Entity { @TypeErrorResponse("Custom message", 422) protected status: string = "ok"; }',
      'const entity = new Entity();',
    ].join('\n'),
    'entity',
  );

  assert.equal(result.isStrictTypeError, true);
  assert.equal(result.messageType, 'string');
  assert.equal(result.messageValue, 'Custom message');
  assert.equal(result.statusType, 'number');
  assert.equal(result.statusValue, 422);
});

test('a @TypeErrorResponse field without a status leaves typeErrorResponseStatus undefined', () => {
  const result = captureFieldViolation(
    [
      'class Entity { @TypeErrorResponse("Custom message") protected status: string = "ok"; }',
      'const entity = new Entity();',
    ].join('\n'),
    'entity',
  );

  assert.equal(result.isStrictTypeError, true);
  assert.equal(result.messageValue, 'Custom message');
  assert.equal(result.statusType, 'undefined');
  assert.equal(result.statusValue, null);
});

test('an undecorated field on a decorated class leaves both response fields genuinely undefined', () => {
  const result = captureFieldViolation(
    [
      'class Entity {',
      '  @TypeErrorResponse("Other message", 400) protected title: string = "ok";',
      '  protected status: string = "ok";',
      '}',
      'const entity = new Entity();',
    ].join('\n'),
    'entity',
    'status',
  );

  assert.equal(result.isStrictTypeError, true);
  assert.equal(result.messageType, 'undefined');
  assert.equal(result.messageValue, null);
  assert.equal(result.statusType, 'undefined');
  assert.equal(result.statusValue, null);
});

test('a @TypeErrorResponse field on a base class applies when violated through a subclass instance', () => {
  const result = captureFieldViolation(
    [
      'class Base { @TypeErrorResponse("Inherited message", 409) protected status: string = "ok"; }',
      'class Child extends Base {}',
      'const child = new Child();',
    ].join('\n'),
    'child',
  );

  assert.equal(result.isStrictTypeError, true);
  assert.equal(result.messageValue, 'Inherited message');
  assert.equal(result.statusValue, 409);
});

test('typeErrorResponse fields never leak into toJSON() or JSON.stringify output', () => {
  const result = captureFieldViolation(
    [
      'class Entity { @TypeErrorResponse("Secret message", 422) protected status: string = "ok"; }',
      'const entity = new Entity();',
    ].join('\n'),
    'entity',
  );

  assert.equal(result.messageValue, 'Secret message', 'precondition');
  assert.equal(result.statusValue, 422, 'precondition');
  for (const forbidden of ['typeErrorResponseMessage', 'typeErrorResponseStatus', 'Secret message']) {
    assert.equal(result.json.includes(forbidden), false, result.json);
  }
  assert.equal(result.toJSONKeys.includes('typeErrorResponseMessage'), false);
  assert.equal(result.toJSONKeys.includes('typeErrorResponseStatus'), false);
  assert.equal(result.toJSONKeys.includes('contractKind'), true);
});

test('@TypeErrorResponse combines with @ServerPopulated on the same class', () => {
  const result = captureFieldViolation(
    [
      '@ServerPopulated()',
      'class Entity { @TypeErrorResponse("Combined message", 422) protected status: string = "ok"; }',
      'const entity = new Entity();',
    ].join('\n'),
    'entity',
  );

  assert.equal(result.isStrictTypeError, true);
  assert.equal(result.serverPopulated, true);
  assert.equal(result.messageValue, 'Combined message');
  assert.equal(result.statusValue, 422);
});

test('a nested child field does not inherit the response of its decorated parent property', () => {
  const result = captureFieldViolation(
    [
      'class Outer {',
      '  @TypeErrorResponse("Parent message", 400) protected profile: { name: string; tag: string } = { name: "a", tag: "b" };',
      '}',
      'const outer = new Outer();',
    ].join('\n'),
    '(outer as any).profile',
    'name',
  );

  assert.equal(result.isStrictTypeError, true);
  assert.equal(result.messageType, 'undefined', result.json);
  assert.equal(result.statusType, 'undefined');
});
