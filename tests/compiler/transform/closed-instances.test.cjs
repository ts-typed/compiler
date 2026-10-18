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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-closed-'));
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
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath, enforcePrivate: false });
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

function runSnippet(source, transformerOptions) {
  const project = emitProject({ 'main.ts': source }, transformerOptions);
  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('compiler.enforceClosedInstances defaults off: instances keep accepting undeclared string and symbol keys', () => {
  const body = [
    'class Box { value = 1; }',
    'const box: any = new Box();',
    'const sym = Symbol("s");',
    'box.extra = 2;',
    'box[sym] = 3;',
    'if (box.extra !== 2 || box[sym] !== 3) throw new Error("extra properties were rejected");',
    'process.stdout.write("OK");',
  ].join('\n');

  assert.equal(runSnippet(body), 'OK');
  assert.equal(runSnippet(body, { enforceClosedInstances: false }), 'OK');
});

test('compiler.enforceClosedInstances rejects a new string-keyed property on a plain class instance via Reflect.set', () => {
  const stdout = runSnippet(
    [
      'class Box { value = 1; }',
      'const box = new Box();',
      'if (Reflect.set(box, "undeclaredProp", 1) !== false) throw new Error("new property was accepted");',
      'if ("undeclaredProp" in box) throw new Error("property was added");',
      'if (box.value !== 1) throw new Error("declared field changed");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceClosedInstances: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceClosedInstances rejects a direct assignment of an undeclared property with a native TypeError', () => {
  const stdout = runSnippet(
    [
      'class Box { value = 1; }',
      'const box: any = new Box();',
      'let caught: unknown;',
      'try { box.undeclaredProp = 1; } catch (error) { caught = error; }',
      'if (!(caught instanceof TypeError)) throw new Error("expected a TypeError, got " + String(caught));',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceClosedInstances: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceClosedInstances also rejects a symbol-keyed write on a sealed instance', () => {
  const stdout = runSnippet(
    [
      'class Box { value = 1; }',
      'const box = new Box();',
      'const sym = Symbol("s");',
      'if (Reflect.set(box, sym, 1) !== false) throw new Error("symbol-keyed property was accepted");',
      'if (sym in box) throw new Error("symbol-keyed property was added");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceClosedInstances: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceClosedInstances seals a named class that declares no fields and has no constructor', () => {
  const stdout = runSnippet(
    [
      'class Empty {}',
      'const empty = new Empty();',
      'if (Reflect.set(empty, "x", 1) !== false) throw new Error("empty instance accepted a property");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceClosedInstances: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceClosedInstances seals only once the most-derived constructor finishes, so subclass fields still install', () => {
  const stdout = runSnippet(
    [
      'class Base {',
      '  baseValue: number;',
      '  constructor(value: number) { this.baseValue = value; }',
      '}',
      'class Derived extends Base {',
      '  derivedTag = "T";',
      '  derivedValue: string;',
      '  constructor(value: number) {',
      '    super(value);',
      '    this.derivedValue = "D" + value;',
      '  }',
      '}',
      'const derived = new Derived(7);',
      'if (derived.baseValue !== 7 || derived.derivedTag !== "T" || derived.derivedValue !== "D7") {',
      '  throw new Error("subclass fields were not installed: " + JSON.stringify(derived));',
      '}',
      'if (Reflect.set(derived, "undeclaredProp", 1) !== false) throw new Error("derived instance accepted a property");',
      'const base = new Base(3);',
      'if (Reflect.set(base, "undeclaredProp", 1) !== false) throw new Error("base instance accepted a property");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceClosedInstances: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceClosedInstances still allows reassigning an existing declared field after construction', () => {
  const stdout = runSnippet(
    [
      'class Box {',
      '  value: number;',
      '  label!: string;',
      '  constructor(value: number) { this.value = value; }',
      '}',
      'const box = new Box(1);',
      'box.value = 5;',
      'box.label = "after";',
      'if (box.value !== 5 || box.label !== "after") throw new Error("declared field write was rejected");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceClosedInstances: true },
  );
  assert.equal(stdout, 'OK');
});
