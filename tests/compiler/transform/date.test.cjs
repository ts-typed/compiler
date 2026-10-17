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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-date-transform-'));
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


const DATE_PROLOGUE = [
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

function runDateScenario(scenario) {
  const project = emitProject({
    'main.ts': [...DATE_PROLOGUE, ...scenario, 'process.stdout.write(results.join(","));'].join('\n'),
  });
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  return { project, results: result.stdout.split(',') };
}

test('a Date field in a typed boundary accepts a real Date and rejects a string that only looks like one', () => {
  const { results } = runDateScenario([
    'interface Entity { criadoEm: Date; }',
    'function usa(e: Entity): void { void e; }',
    'expectAccepted("real-date", () => usa({ criadoEm: new Date() }));',
    'expectTypeError("string-date", () => usa({ criadoEm: "2024-01-01" as any }));',
  ]);
  assert.deepEqual(results, ['accepted:real-date', 'rejected:string-date']);
});

test('an Invalid Date is rejected explicitly with StrictTypeError at a Date field boundary', () => {
  const { results } = runDateScenario([
    'interface Entity { criadoEm: Date; }',
    'function usa(e: Entity): void { void e; }',
    'expectTypeError("invalid-date", () => usa({ criadoEm: new Date("not-a-real-date") }));',
  ]);
  assert.deepEqual(results, ['rejected:invalid-date']);
});

test('a directly typed Date variable rejects an Invalid Date on reassignment and accepts a valid one', () => {
  const { results } = runDateScenario([
    'let data: Date = new Date(0);',
    'expectTypeError("reassign-invalid", () => { data = new Date("garbage"); });',
    'expectAccepted("reassign-valid", () => { data = new Date(1000); });',
    'expectTypeError("reassign-string", () => { data = "2024" as any; });',
    'void data;',
  ]);
  assert.deepEqual(results, ['rejected:reassign-invalid', 'accepted:reassign-valid', 'rejected:reassign-string']);
});

test('Date composes inside unions, arrays and nested objects without breaking the enclosing contract', () => {
  const { project, results } = runDateScenario([
    'interface Historico { data: Date; }',
    'interface Registro { fim: Date | null; datas: Date[]; historico: { eventos: Historico[] }; }',
    'function usa(r: Registro): void { void r; }',
    'const ok: Registro = { fim: null, datas: [new Date(0)], historico: { eventos: [{ data: new Date(1) }] } };',
    'expectAccepted("composite-valid", () => usa(ok));',
    'expectTypeError("composite-bad-array-item", () => usa({ ...ok, datas: ["x" as any] }));',
    'expectTypeError("composite-bad-nested", () => usa({ ...ok, historico: { eventos: [{ data: new Date("nope") }] } }));',
  ]);
  assert.deepEqual(results, ['accepted:composite-valid', 'rejected:composite-bad-array-item', 'rejected:composite-bad-nested']);

  // Partial (alias-limit) notes are expected for composites. Ignore the harness's own `action` callable and the
  // pre-existing `void` return note on `usa`: nothing in this Date composite may be unsupported.
  const unsupported = project.analysisDiagnostics.filter(
    (diagnostic) =>
      diagnostic.status === 'unsupported' && diagnostic.name !== 'action' && !/void return/.test(diagnostic.message),
  );
  assert.deepEqual(unsupported.map((diagnostic) => diagnostic.message), []);
});

test('a contract containing Date is protected rather than unsupported, with no callable-contract warning', () => {
  const project = emitProject({
    'main.ts': [
      'interface Entity { criadoEm: Date; atualizadoEm: Date | undefined; }',
      'function usa(e: Entity): void { void e; }',
      'usa({ criadoEm: new Date(0), atualizadoEm: undefined });',
    ].join('\n'),
  });

  const warnings = project.analysisDiagnostics.filter((diagnostic) => /Date|Callable/.test(diagnostic.message));
  assert.deepEqual(warnings.map((diagnostic) => diagnostic.message), []);
  assert.equal(project.diagnostics.length, 0, JSON.stringify(project.diagnostics));
});

test('a user-declared class named Date in a module is not mistaken for the built-in Date and stays unsupported', () => {
  const project = emitProject({
    'date.ts': 'export class Date { constructor(public ano: number) {} shift(): number { return this.ano + 1; } }',
    'main.ts': [
      "import { Date } from './date';",
      'interface Evento { quando: Date; }',
      'function usa(e: Evento): void { void e; }',
      'usa({ quando: new Date(2024) });',
    ].join('\n'),
  });

  // The user's own `Date` class has a method, so it must stay unsupported (not short-circuited as the built-in).
  const userDate = project.analysisDiagnostics.filter((diagnostic) =>
    /Property quando is unsupported: Property shift is unsupported: Callable and constructable/.test(diagnostic.message),
  );
  assert.equal(userDate.length, 1, JSON.stringify(project.analysisDiagnostics));
  assert.equal(userDate[0].status, 'unsupported');
});
