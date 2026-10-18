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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-predicate-transform-'));
  const sourceRoot = join(projectRoot, 'src');
  const declarationRoot = join(projectRoot, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarationRoot, { recursive: true });
  writeFileSync(
    join(declarationRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {}',
      'export function StrictClass(): ClassDecorator;',
      'export function StructuralClass(): ClassDecorator;',
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

function emitProject(files, transformerOptions = {}) {
  const project = writeProject(files);
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath });
  assert.equal(
    analysis.tsDiagnostics.length,
    0,
    analysis.tsDiagnostics.map((diagnostic) => diagnostic.messageText).join('\n'),
  );
  const diagnostics = [];
  const emitResult = analysis.program.emit(undefined, undefined, undefined, false, {
    before: [
      createContractTransformer({
        analysis,
        runtimeModule,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        ...transformerOptions,
      }),
    ],
  });
  assert.equal(emitResult.emitSkipped, false);
  return {
    ...project,
    diagnostics,
    analysisDiagnostics: analysis.diagnostics,
    outputRoot: join(project.projectRoot, 'out'),
  };
}

function runEntry(project, relativePath = 'main.js') {
  return spawnSync(process.execPath, [join(project.outputRoot, relativePath)], {
    cwd: project.projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
}

const PREDICATE_PROLOGUE = [
  "import { StrictTypeError } from 'ts-typed';",
  'const results: string[] = [];',
  'function expectTypeError(name: string, action: () => unknown): void {',
  '  try { action(); } catch (error) {',
  '    if (error instanceof StrictTypeError) { results.push(`rejected:${name}`); return; }',
  '    throw error;',
  '  }',
  '  throw new Error(`missing error: ${name}`);',
  '}',
  'function expectAccepted(name: string, action: () => unknown): void {',
  '  action();',
  '  results.push(`accepted:${name}`);',
  '}',
];

function runPredicateScenario(scenario) {
  const project = emitProject({
    'main.ts': [...PREDICATE_PROLOGUE, ...scenario, 'process.stdout.write(results.join(","));'].join('\n'),
  });
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(',');
}

test('a type guard that lies (returns true for a non-string) is rejected at the moment it returns true', () => {
  const results = runPredicateScenario([
    'function isString(x: unknown): x is string { return true; }',
    'expectTypeError("lying-guard", () => isString(123));',
  ]);
  assert.deepEqual(results, ['rejected:lying-guard']);
});

test('a truthful type guard returning true for a string is accepted without throwing', () => {
  const results = runPredicateScenario([
    'function isString(x: unknown): x is string { return true; }',
    'expectAccepted("truthful-guard", () => isString("ok"));',
  ]);
  assert.deepEqual(results, ['accepted:truthful-guard']);
});

test('a type guard returning false performs no validation and returns false', () => {
  const results = runPredicateScenario([
    'function isStr(x: unknown): x is string { return typeof x === "string"; }',
    'expectAccepted("negative-guard", () => { if (isStr(123) !== false) throw new Error("wrong result"); });',
  ]);
  assert.deepEqual(results, ['accepted:negative-guard']);
});

test('an expression-bodied arrow type guard that lies is rejected', () => {
  const results = runPredicateScenario([
    'const isNum = (x: unknown): x is number => true;',
    'expectTypeError("lying-arrow", () => isNum("x"));',
  ]);
  assert.deepEqual(results, ['rejected:lying-arrow']);
});

test('an assertion function that returns normally for a non-string is rejected', () => {
  const results = runPredicateScenario([
    'function assertIsString(x: unknown): asserts x is string { }',
    'expectTypeError("lying-assertion", () => assertIsString(123));',
  ]);
  assert.deepEqual(results, ['rejected:lying-assertion']);
});

test('an assertion function that returns normally for a string is accepted', () => {
  const results = runPredicateScenario([
    'function assertIsString(x: unknown): asserts x is string { }',
    'expectAccepted("truthful-assertion", () => assertIsString("ok"));',
  ]);
  assert.deepEqual(results, ['accepted:truthful-assertion']);
});

test('a truthiness assertion rejects a falsy value and accepts a truthy one', () => {
  const results = runPredicateScenario([
    'function assertTruthy(x: unknown): asserts x { }',
    'expectTypeError("falsy", () => assertTruthy(0));',
    'expectAccepted("truthy", () => assertTruthy(1));',
  ]);
  assert.deepEqual(results, ['rejected:falsy', 'accepted:truthy']);
});

test('an assertion is checked on both an early bare return and the fall-through end of the body', () => {
  const results = runPredicateScenario([
    'function assertStringUnlessEarly(x: unknown, early: boolean): asserts x is string {',
    '  if (early) return;',
    '  void x;',
    '}',
    'expectTypeError("early-return-exit", () => assertStringUnlessEarly(123, true));',
    'expectTypeError("fall-through-exit", () => assertStringUnlessEarly(123, false));',
    'expectAccepted("early-return-valid", () => assertStringUnlessEarly("ok", true));',
    'expectAccepted("fall-through-valid", () => assertStringUnlessEarly("ok", false));',
  ]);
  assert.deepEqual(results, [
    'rejected:early-return-exit',
    'rejected:fall-through-exit',
    'accepted:early-return-valid',
    'accepted:fall-through-valid',
  ]);
});

test('a plain function without a predicate is unchanged by the transform', () => {
  const results = runPredicateScenario([
    'function plain(x: unknown): boolean { return typeof x === "string"; }',
    'expectAccepted("plain-false", () => { if (plain(123) !== false) throw new Error("wrong result"); });',
    'expectAccepted("plain-true", () => { if (plain("ok") !== true) throw new Error("wrong result"); });',
  ]);
  assert.deepEqual(results, ['accepted:plain-false', 'accepted:plain-true']);
});

test('a predicate on this is out of scope and is left unchecked', () => {
  const results = runPredicateScenario([
    'class Box { isReady(): this is { ready: true } { return true; } }',
    'expectAccepted("this-predicate-unchecked", () => new Box().isReady());',
  ]);
  assert.deepEqual(results, ['accepted:this-predicate-unchecked']);
});
