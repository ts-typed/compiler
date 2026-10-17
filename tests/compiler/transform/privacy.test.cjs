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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-privacy-'));
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
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath, enforcePrivate: transformerOptions.enforcePrivate === true });
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

test('compiler.enforceReadonly locks a readonly field after its declaring constructor finishes, rejecting further writes', () => {
  const project = emitProject(
    {
      'main.ts': [
        "import { StrictTypeError } from 'ts-typed';",
        'function expectTypeError(action: () => void): void {',
        '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
        '  throw new Error("missing StrictTypeError");',
        '}',
        'class Box {',
        '  readonly id: number;',
        '  constructor(initial: number) { this.id = initial; }',
        '}',
        'const box = new Box(42);',
        'if (box.id !== 42) throw new Error("wrong initial value: " + box.id);',
        'expectTypeError(() => { (box as any).id = 99; });',
        'if (box.id !== 42) throw new Error("locked write changed value");',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { enforceReadonly: true },
  );

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('compiler.enforceReadonly tolerates an early return in the constructor, still locking the field', () => {
  const project = emitProject(
    {
      'main.ts': [
        "import { StrictTypeError } from 'ts-typed';",
        'function expectTypeError(action: () => void): void {',
        '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
        '  throw new Error("missing StrictTypeError");',
        '}',
        'class Box {',
        '  readonly id: number;',
        '  constructor(initial: number) {',
        '    this.id = initial;',
        '    if (initial > 0) { return; }',
        '    this.id = -1;',
        '  }',
        '}',
        'const box = new Box(7);',
        'expectTypeError(() => { (box as any).id = 1; });',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { enforceReadonly: true },
  );

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('without compiler.enforceReadonly, readonly fields remain unprotected as before (default-off regression guard)', () => {
  const project = emitProject(
    {
      'main.ts': [
        'class Box {',
        '  readonly id: number;',
        '  constructor(initial: number) { this.id = initial; }',
        '}',
        'const box = new Box(42);',
        '(box as any).id = 99;',
        'if (box.id !== 99) throw new Error("expected unenforced readonly to be writable");',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { enforceReadonly: false },
  );

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('compiler.enforcePrivate rewrites a private field into a real #private field, still validated and readable from within the class', () => {
  const project = emitProject(
    {
      'main.ts': [
        'class Box {',
        '  private count: number = 1;',
        '  increment(step: number): void { this.count += step; }',
        '  read(): number { return this.count; }',
        '  compareTo(other: Box): boolean { return this.count === other.count; }',
        '}',
        'const box = new Box();',
        'if (box.read() !== 1) throw new Error("wrong initial value: " + box.read());',
        'box.increment(4);',
        'if (box.read() !== 5) throw new Error("increment failed: " + box.read());',
        'const sameAsBox = new Box();',
        'sameAsBox.increment(4);',
        'if (!box.compareTo(sameAsBox)) throw new Error("cross-instance read failed");',
        'const different = new Box();',
        'if (box.compareTo(different)) throw new Error("cross-instance read incorrectly matched");',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { enforcePrivate: true },
  );

  assert.equal(project.emitSkipped, false);
  const emittedClass = require('node:fs').readFileSync(join(project.outputRoot, 'main.js'), 'utf8');
  assert.match(emittedClass, /#count\$storage/);
  assert.doesNotMatch(emittedClass, /[^#]\bcount\b\s*[=:]/);

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('compiler.enforcePrivate validates the converted field and rejects an invalid write with StrictTypeError', () => {
  const project = emitProject(
    {
      'main.ts': [
        "import { StrictTypeError } from 'ts-typed';",
        'function expectTypeError(action: () => void): void {',
        '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
        '  throw new Error("missing StrictTypeError");',
        '}',
        'class Box {',
        '  private count: number = 1;',
        '  setUnsafe(value: any): void { this.count = value; }',
        '}',
        'const box = new Box();',
        'expectTypeError(() => box.setUnsafe("bad"));',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { enforcePrivate: true },
  );

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('compiler.enforcePrivate combined with enforceReadonly locks a private readonly field after construction, even against access from an any-typed alias within the class', () => {
  const project = emitProject(
    {
      'main.ts': [
        'class Service {',
        '  private readonly label: string;',
        '  constructor(label: string) { this.label = label; }',
        '  read(): string { return this.label; }',
        '  tryMutate(action: (self: any) => void): void { action(this); }',
        '}',
        'const svc = new Service("hello");',
        'if (svc.read() !== "hello") throw new Error("wrong initial value: " + svc.read());',
        'svc.tryMutate((self) => { self.label = "bad"; });',
        'if (svc.read() !== "hello") throw new Error("real private value changed via any-typed access: " + svc.read());',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { enforcePrivate: true, enforceReadonly: true },
  );

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('compiler.enforcePrivate fails the build when a private field being converted is accessed through bracket notation anywhere in the program', () => {
  const project = writeProject({
    'main.ts': [
      'class Box {',
      '  private count: number = 1;',
      '  read(): number { return this["count"]; }',
      '}',
      'const box = new Box();',
      'void box.read();',
    ].join('\n'),
  });
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath, enforcePrivate: true });
  assert.equal(analysis.tsDiagnostics.length, 0);

  assert.throws(
    () => {
      analysis.program.emit(undefined, undefined, undefined, false, {
        before: [createContractTransformer({ analysis, runtimeModule, enforcePrivate: true })],
      });
    },
    /bracket notation/,
  );
});

test('without compiler.enforcePrivate, private fields remain unprotected as before (default-off regression guard)', () => {
  const project = emitProject(
    {
      'main.ts': [
        'class Box {',
        '  private count: number = 1;',
        '  read(): number { return this.count; }',
        '}',
        'const box = new Box();',
        '(box as any).count = "bad";',
        'if ((box.read() as any) !== "bad") throw new Error("expected unenforced private to be a plain writable field");',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { enforcePrivate: false },
  );

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});
