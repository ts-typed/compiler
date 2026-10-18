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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-map-set-transform-'));
  const sourceRoot = join(projectRoot, 'src');
  const declarationRoot = join(projectRoot, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarationRoot, { recursive: true });
  writeFileSync(
    join(declarationRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError { readonly expected: string; }',
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

const COLLECTION_PROLOGUE = [
  "import { StrictTypeError } from 'ts-typed';",
  'const results: string[] = [];',
  'function expectTypeError(name: string, action: () => void): void {',
  '  try { action(); } catch (error) {',
  '    if (error instanceof StrictTypeError) { results.push(`rejected:${name}`); return; }',
  '    throw error;',
  '  }',
  '  throw new Error(`missing error: ${name}`);',
  '}',
  'function expectRejectedExpecting(name: string, expected: string, action: () => void): void {',
  '  try { action(); } catch (error) {',
  '    if (error instanceof StrictTypeError && error.expected === expected) { results.push(`rejected:${name}`); return; }',
  '    throw error;',
  '  }',
  '  throw new Error(`missing error: ${name}`);',
  '}',
  'function expectAccepted(name: string, action: () => void): void {',
  '  action();',
  '  results.push(`accepted:${name}`);',
  '}',
];

function runCollectionScenario(scenario) {
  const project = emitProject({
    'main.ts': [...COLLECTION_PROLOGUE, ...scenario, 'process.stdout.write(results.join(","));'].join('\n'),
  });
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  return { project, results: result.stdout.split(',') };
}

test('a Map<string, number> field accepts valid entries and rejects a bad value or a bad key', () => {
  const { results } = runCollectionScenario([
    'interface Store { entries: Map<string, number>; }',
    'function usa(s: Store): void { void s; }',
    'expectAccepted("valid-map", () => usa({ entries: new Map([["a", 1], ["b", 2]]) }));',
    'expectTypeError("bad-value", () => usa({ entries: new Map([["a", "not a number" as any]]) }));',
    'expectTypeError("bad-key", () => usa({ entries: new Map<any, number>([[1, 1]]) }));',
  ]);
  assert.deepEqual(results, ['accepted:valid-map', 'rejected:bad-value', 'rejected:bad-key']);
});

test('a value that is not a real Map is rejected with a Map expectation', () => {
  const { results } = runCollectionScenario([
    'interface Store { entries: Map<string, number>; }',
    'function usa(s: Store): void { void s; }',
    'expectRejectedExpecting("plain-object", "Map", () => usa({ entries: {} as any }));',
    'expectRejectedExpecting("array", "Map", () => usa({ entries: [["a", 1]] as any }));',
  ]);
  assert.deepEqual(results, ['rejected:plain-object', 'rejected:array']);
});

test('a Set<number> field accepts valid items and rejects an invalid item', () => {
  const { results } = runCollectionScenario([
    'interface Store { tags: Set<number>; }',
    'function usa(s: Store): void { void s; }',
    'expectAccepted("valid-set", () => usa({ tags: new Set([1, 2, 3]) }));',
    'expectTypeError("bad-item", () => usa({ tags: new Set(["x" as any]) }));',
    'expectRejectedExpecting("not-a-set", "Set", () => usa({ tags: [1] as any }));',
  ]);
  assert.deepEqual(results, ['accepted:valid-set', 'rejected:bad-item', 'rejected:not-a-set']);
});

test('ReadonlyMap and ReadonlySet are detected and validated like their mutable counterparts', () => {
  const { results } = runCollectionScenario([
    'interface Store { entries: ReadonlyMap<string, number>; tags: ReadonlySet<number>; }',
    'function usa(s: Store): void { void s; }',
    'expectAccepted("readonly-valid", () => usa({ entries: new Map([["a", 1]]), tags: new Set([1]) }));',
    'expectTypeError("readonly-map-bad-value", () => usa({ entries: new Map([["a", "x" as any]]), tags: new Set([1]) }));',
    'expectTypeError("readonly-set-bad-item", () => usa({ entries: new Map([["a", 1]]), tags: new Set(["x" as any]) }));',
  ]);
  assert.deepEqual(results, ['accepted:readonly-valid', 'rejected:readonly-map-bad-value', 'rejected:readonly-set-bad-item']);
});

test('a directly typed Map variable rejects a bad entry on reassignment', () => {
  const { results } = runCollectionScenario([
    'let scores: Map<string, number> = new Map();',
    'expectTypeError("reassign-bad", () => { scores = new Map([["a", "x" as any]]); });',
    'expectAccepted("reassign-good", () => { scores = new Map([["a", 1]]); });',
    'void scores;',
  ]);
  assert.deepEqual(results, ['rejected:reassign-bad', 'accepted:reassign-good']);
});

test('Map and Set nested inside a larger object keep the enclosing contract protected, not unsupported', () => {
  const { project, results } = runCollectionScenario([
    'interface Store { entries: Map<string, number>; tags: Set<number>; }',
    'function usa(s: Store): void { void s; }',
    'expectAccepted("nested-valid", () => usa({ entries: new Map([["a", 1]]), tags: new Set([1]) }));',
    'expectTypeError("nested-bad", () => usa({ entries: new Map([["a", 1]]), tags: new Set(["x" as any]) }));',
  ]);
  assert.deepEqual(results, ['accepted:nested-valid', 'rejected:nested-bad']);

  // `usa` has a pre-existing void-return note and the harness has its own `action` callable; neither is about collections.
  const unsupported = project.analysisDiagnostics.filter(
    (diagnostic) =>
      diagnostic.status === 'unsupported' && diagnostic.name !== 'action' && !/void return/.test(diagnostic.message),
  );
  assert.deepEqual(unsupported.map((diagnostic) => diagnostic.message), []);
});

test('a Map contract is covered as partial (alias-limited), not unsupported, with no transform diagnostics', () => {
  const project = emitProject({
    'main.ts': [
      'interface Store { entries: Map<string, number>; tags: Set<number>; }',
      'function usa(s: Store): void { void s; }',
      'usa({ entries: new Map([["a", 1]]), tags: new Set([1]) });',
    ].join('\n'),
  });

  assert.equal(
    project.analysisDiagnostics.some((diagnostic) => diagnostic.status === 'unsupported' && /Map|Set|Symbol-named/.test(diagnostic.message)),
    false,
    JSON.stringify(project.analysisDiagnostics),
  );
  assert.ok(
    project.analysisDiagnostics.some((diagnostic) => diagnostic.status === 'partial' && diagnostic.name === 's'),
    JSON.stringify(project.analysisDiagnostics),
  );
  assert.equal(project.diagnostics.length, 0, JSON.stringify(project.diagnostics));
});

test('WeakMap and WeakSet stay unsupported (out of scope for this adapter)', () => {
  const project = emitProject({
    'main.ts': [
      'interface Weak { m: WeakMap<object, number>; s: WeakSet<object>; }',
      'function usa(w: Weak): void { void w; }',
      'usa({ m: new WeakMap<object, number>(), s: new WeakSet<object>() });',
    ].join('\n'),
  });

  const unsupported = project.analysisDiagnostics.filter(
    (diagnostic) => diagnostic.status === 'unsupported' && diagnostic.name === 'w',
  );
  assert.equal(unsupported.length, 1, JSON.stringify(project.analysisDiagnostics));
  assert.match(unsupported[0].message, /Property m is unsupported: Symbol-named properties/);
});
