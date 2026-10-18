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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-function-transform-'));
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


const FUNCTION_PROLOGUE = [
  "import { StrictTypeError } from 'ts-typed';",
  'const results: string[] = [];',
  'function expectTypeError(name: string, action: () => void): void {',
  '  try { action(); } catch (error) {',
  '    if (error instanceof StrictTypeError) { results.push(`rejected:${name}`); return; }',
  '    throw error;',
  '  }',
  '  throw new Error(`missing error: ${name}`);',
  '}',
  'function expectAccepted(name: string, action: () => void): void {',
  '  action();',
  '  results.push(`accepted:${name}`);',
  '}',
];

function runFunctionScenario(scenario) {
  const project = emitProject({
    'main.ts': [...FUNCTION_PROLOGUE, ...scenario, 'process.stdout.write(results.join(","));'].join('\n'),
  });
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  return { project, results: result.stdout.split(',') };
}

test('a callback field in a typed boundary accepts a real function and rejects a non-function, while sibling fields stay validated', () => {
  const { results } = runFunctionScenario([
    'interface Widget { onClick: () => void; label: string; }',
    'function usa(w: Widget): void { void w; }',
    'expectAccepted("real-callback", () => usa({ onClick: () => {}, label: "ok" }));',
    'expectTypeError("string-callback", () => usa({ onClick: "not a function" as any, label: "ok" }));',
    'expectTypeError("missing-sibling", () => usa({ onClick: () => {} } as any));',
  ]);
  assert.deepEqual(results, ['accepted:real-callback', 'rejected:string-callback', 'rejected:missing-sibling']);
});

test('an interface method signature accepts a real function and rejects a non-function', () => {
  const { results } = runFunctionScenario([
    'interface Greeter { greet(): string; }',
    'function usa(g: Greeter): void { void g; }',
    'expectAccepted("real-method", () => usa({ greet: () => "oi" }));',
    'expectTypeError("string-method", () => usa({ greet: "oi" as any }));',
  ]);
  assert.deepEqual(results, ['accepted:real-method', 'rejected:string-method']);
});

test('an overloaded callable type is treated as a plain function leaf', () => {
  const { results, project } = runFunctionScenario([
    'interface Overloaded { (x: string): string; (x: number): number; }',
    'interface Holder { fn: Overloaded; }',
    'function usa(h: Holder): void { void h; }',
    'expectAccepted("overloaded", () => usa({ fn: ((x: any) => x) as Overloaded }));',
    'expectTypeError("overloaded-non-fn", () => usa({ fn: 42 as any }));',
  ]);
  assert.deepEqual(results, ['accepted:overloaded', 'rejected:overloaded-non-fn']);
  const unsupported = project.analysisDiagnostics.filter(
    (diagnostic) =>
      diagnostic.status === 'unsupported' &&
      diagnostic.name !== 'action' &&
      diagnostic.name !== 'Overloaded' && // the standalone top-level callable interface itself stays unsupported
      !/void return/.test(diagnostic.message),
  );
  assert.deepEqual(unsupported.map((diagnostic) => diagnostic.message), []);
});

test('a callable type with a genuine extra property stays unsupported (unchanged behavior)', () => {
  const project = emitProject({
    'main.ts': [
      'interface Tagged { (): void; extra: string; }',
      'interface Holder { t: Tagged; }',
      'function usa(h: Holder): void { void h; }',
      'usa({ t: null as any });',
    ].join('\n'),
  });
  const messages = project.analysisDiagnostics.map((diagnostic) => diagnostic.message);
  assert.ok(
    messages.some((message) => /Callable and constructable/.test(message)),
    `expected a callable-contract limitation, got: ${JSON.stringify(messages)}`,
  );
});

test('a contract with a callback field is protected with no callable-contract warning', () => {
  const project = emitProject({
    'main.ts': [
      'interface Widget { onClick: () => void; label: string; }',
      'function usa(w: Widget): void { void w; }',
      'usa({ onClick: () => {}, label: "x" });',
    ].join('\n'),
  });
  const warnings = project.analysisDiagnostics.filter((diagnostic) => /Callable|function/.test(diagnostic.message));
  assert.deepEqual(warnings.map((diagnostic) => diagnostic.message), []);
  assert.equal(project.diagnostics.length, 0, JSON.stringify(project.diagnostics));
});

test('a class field whose own type is a pure function is guarded (not just its interface/object-literal counterpart)', () => {
  // Regression: the `function` leaf was only applied when a property was
  // resolved AS PART OF its containing object's structural shape
  // (_resolvePropertyType, used by _resolveObject's member loop). A class
  // field's OWN top-level contract candidate — the one installFieldGuard
  // is built from — went through the general _resolveType/_resolveDirectType
  // path instead, which didn't know about the function leaf and resolved it
  // as fully unsupported, so installFieldGuard was never even generated for
  // the field: a later `instance.field = "not a function"` went through
  // completely unguarded.
  const { results } = runFunctionScenario([
    'class WithArrowProperty { format: (x: number) => string = (x) => String(x); }',
    'const w = new WithArrowProperty();',
    'expectAccepted("initial-call", () => { if (w.format(1) !== "1") throw new Error("wrong result"); });',
    'expectTypeError("non-function-write", () => { (w as any).format = "not a function"; });',
    'expectAccepted("reassign-function", () => { w.format = (x) => `#${x}`; if (w.format(2) !== "#2") throw new Error("wrong result"); });',
  ]);
  assert.deepEqual(results, ['accepted:initial-call', 'rejected:non-function-write', 'accepted:reassign-function']);
});

test('an optional callback field accepts absence, undefined and a real function, and rejects a non-function', () => {
  const { results } = runFunctionScenario([
    'interface Opcional { onClick?: () => void; label: string; }',
    'function usa(o: Opcional): void { void o; }',
    'expectAccepted("absent", () => usa({ label: "a" }));',
    'expectAccepted("undefined", () => usa({ onClick: undefined, label: "a" }));',
    'expectAccepted("function", () => usa({ onClick: () => {}, label: "a" }));',
    'expectTypeError("string", () => usa({ onClick: "x" as any, label: "a" }));',
  ]);
  assert.deepEqual(results, ['accepted:absent', 'accepted:undefined', 'accepted:function', 'rejected:string']);
});
