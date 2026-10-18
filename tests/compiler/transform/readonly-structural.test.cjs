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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-readonly-structural-'));
  const sourceRoot = join(projectRoot, 'src');
  const declarationRoot = join(projectRoot, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarationRoot, { recursive: true });
  writeFileSync(join(declarationRoot, 'index.d.ts'), 'export class StrictTypeError extends TypeError {}\n');
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
  return {
    ...project,
    emitSkipped: emitResult.emitSkipped,
    diagnostics,
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

/**
 * Shared harness: `attempt(label, action)` runs `action` and records the
 * StrictTypeError code it throws (or `null` if it did not throw). The script
 * prints a single JSON line so each test asserts on exact outcomes.
 */
const HARNESS = [
  'const outcomes: Record<string, unknown> = {};',
  'function attempt(label: string, action: () => void): void {',
  '  try { action(); outcomes[label] = null; }',
  '  catch (error: any) { outcomes[label] = error && error.code !== undefined ? error.code : "UNEXPECTED:" + String(error); }',
  '}',
].join('\n');

function runScenario(body) {
  const project = emitProject({
    'main.ts': [HARNESS, body, 'process.stdout.write(JSON.stringify(outcomes));'].join('\n'),
  });
  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('a readonly interface member rejects writes after the object crossed a typed boundary (READONLY_PROPERTY)', () => {
  const outcomes = runScenario([
    'interface Config { readonly version: string; }',
    'function accept(config: Config): Config { return config; }',
    'const config = accept({ version: "1.0" });',
    'attempt("valid", () => { (config as any).version = "2.0"; });',
    'attempt("invalid", () => { (config as any).version = 42; });',
    'outcomes.stillOriginal = config.version === "1.0";',
  ].join('\n'));

  assert.equal(outcomes.valid, 'READONLY_PROPERTY');
  assert.equal(outcomes.invalid, 'READONLY_PROPERTY');
  assert.equal(outcomes.stillOriginal, true);
});

test('a non-readonly sibling of a readonly member stays writable, with normal type checking', () => {
  const outcomes = runScenario([
    'interface Config { readonly version: string; name: string; }',
    'function accept(config: Config): Config { return config; }',
    'const config = accept({ version: "1.0", name: "a" });',
    'attempt("validSibling", () => { (config as any).name = "b"; });',
    'attempt("invalidSibling", () => { (config as any).name = 7; });',
    'outcomes.nameValue = config.name;',
  ].join('\n'));

  assert.equal(outcomes.validSibling, null);
  assert.equal(outcomes.invalidSibling, 'TYPE_MISMATCH');
  assert.equal(outcomes.nameValue, 'b');
});

test('the readonly flag is respected on a nested object reached through a readonly member', () => {
  const outcomes = runScenario([
    'interface Wrapper { readonly inner: { readonly value: number; }; }',
    'function accept(wrapper: Wrapper): Wrapper { return wrapper; }',
    'const wrapper = accept({ inner: { value: 1 } });',
    'attempt("innerWrite", () => { (wrapper.inner as any).value = 2; });',
    'attempt("innerInvalid", () => { (wrapper.inner as any).value = "x"; });',
    'outcomes.innerValue = wrapper.inner.value;',
  ].join('\n'));

  assert.equal(outcomes.innerWrite, 'READONLY_PROPERTY');
  assert.equal(outcomes.innerInvalid, 'READONLY_PROPERTY');
  assert.equal(outcomes.innerValue, 1);
});

test('a readonly member declared through a type alias is protected like an interface member', () => {
  const outcomes = runScenario([
    'type Point = { readonly x: number; readonly y: number; };',
    'function accept(point: Point): Point { return point; }',
    'const point = accept({ x: 1, y: 2 });',
    'attempt("writeX", () => { (point as any).x = 5; });',
    'attempt("writeY", () => { (point as any).y = 5; });',
    'outcomes.x = point.x;',
    'outcomes.y = point.y;',
  ].join('\n'));

  assert.equal(outcomes.writeX, 'READONLY_PROPERTY');
  assert.equal(outcomes.writeY, 'READONLY_PROPERTY');
  assert.equal(outcomes.x, 1);
  assert.equal(outcomes.y, 2);
});

test('crossing several typed boundaries with the same readonly shape is idempotent and stays locked', () => {
  const outcomes = runScenario([
    'interface Config { readonly version: string; }',
    'interface Labelled { readonly version: string; label?: string; }',
    'function first(config: Config): Config { return config; }',
    'function second(config: Config): Config { return config; }',
    'function third(config: Labelled): Labelled { return config; }',
    'const config = first({ version: "1.0" });',
    'second(config);',
    'third(config);',
    'second(config);',
    'attempt("write", () => { (config as any).version = "9"; });',
    'outcomes.version = config.version;',
  ].join('\n'));

  assert.equal(outcomes.write, 'READONLY_PROPERTY');
  assert.equal(outcomes.version, '1.0');
});

test('a readonly contract arriving after a non-readonly one on the same plain object still locks it', () => {
  const outcomes = runScenario([
    'interface Loose { version: string; }',
    'interface Strict { readonly version: string; }',
    'function loose(value: Loose): Loose { return value; }',
    'function strict(value: Strict): Strict { return value; }',
    'const value = { version: "1.0" };',
    'loose(value);',
    'strict(value);',
    'attempt("write", () => { value.version = "2.0"; });',
    'outcomes.version = value.version;',
  ].join('\n'));

  assert.equal(outcomes.write, 'READONLY_PROPERTY');
  assert.equal(outcomes.version, '1.0');
});

test('a plain object with no readonly members is unchanged: writes still work and type-check as before', () => {
  const outcomes = runScenario([
    'interface Plain { version: string; count: number; }',
    'function accept(value: Plain): Plain { return value; }',
    'const value = accept({ version: "1.0", count: 0 });',
    'attempt("validWrite", () => { (value as any).version = "2.0"; });',
    'attempt("invalidWrite", () => { (value as any).count = "many"; });',
    'outcomes.version = value.version;',
  ].join('\n'));

  assert.equal(outcomes.validWrite, null);
  assert.equal(outcomes.invalidWrite, 'TYPE_MISMATCH');
  assert.equal(outcomes.version, '2.0');
});

test('a class instance structurally matching a readonly interface keeps its own mutable fields writable by its methods', () => {
  const outcomes = runScenario([
    'interface ReadCounter { readonly count: number; }',
    'class Counter { count = 0; increment(): void { this.count++; } }',
    'function view(counter: ReadCounter): number { return counter.count; }',
    'const counter = new Counter();',
    'view(counter);',
    'attempt("methodWrite", () => counter.increment());',
    'outcomes.count = counter.count;',
  ].join('\n'));

  assert.equal(outcomes.methodWrite, null);
  assert.equal(outcomes.count, 1);
});
