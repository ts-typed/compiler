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


const TEMPLATE_PROLOGUE = [
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

function runTemplateScenario(scenario) {
  const project = emitProject({
    'main.ts': [...TEMPLATE_PROLOGUE, ...scenario, 'process.stdout.write(results.join(","));'].join('\n'),
  });
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  return { project, results: result.stdout.split(',') };
}

test('a `${number}px` template literal type accepts a numeric px string and rejects strings without the suffix or a number', () => {
  const { results } = runTemplateScenario([
    'type Pixels = `${number}px`;',
    'function usa(p: Pixels): void { void p; }',
    'expectAccepted("px", () => usa("10px" as Pixels));',
    'expectAccepted("px-decimal", () => usa("1.5px" as Pixels));',
    'expectAccepted("px-negative", () => usa("-3px" as Pixels));',
    'expectTypeError("no-suffix", () => usa("10" as any));',
    'expectTypeError("not-number", () => usa("abcpx" as any));',
  ]);
  assert.deepEqual(results, [
    'accepted:px',
    'accepted:px-decimal',
    'accepted:px-negative',
    'rejected:no-suffix',
    'rejected:not-number',
  ]);
});

test('a `user_${string}` template literal type accepts any suffix including empty and rejects a different prefix', () => {
  const { results } = runTemplateScenario([
    'type Id = `user_${string}`;',
    'function usa(id: Id): void { void id; }',
    'expectAccepted("with-suffix", () => usa("user_123" as Id));',
    'expectAccepted("empty-suffix", () => usa("user_" as Id));',
    'expectTypeError("reversed", () => usa("123_user" as any));',
    'expectTypeError("other", () => usa("other" as any));',
  ]);
  assert.deepEqual(results, ['accepted:with-suffix', 'accepted:empty-suffix', 'rejected:reversed', 'rejected:other']);
});

test('a template literal over a finite union is resolved by TypeScript to literals and validates as a union', () => {
  const { results, project } = runTemplateScenario([
    "type Greeting = `Hello, ${'world' | 'there'}!`;",
    'function usa(g: Greeting): void { void g; }',
    'expectAccepted("world", () => usa("Hello, world!" as Greeting));',
    'expectTypeError("everyone", () => usa("Hello, everyone!" as any));',
  ]);
  assert.deepEqual(results, ['accepted:world', 'rejected:everyone']);
  // Ignore the harness's own `action`/`expect*` callables and void-return notes; the Greeting contract must be clean.
  const unsupported = project.analysisDiagnostics.filter(
    (diagnostic) =>
      diagnostic.status === 'unsupported' &&
      !['action', 'expectTypeError', 'expectAccepted', '<anonymous>', 'usa'].includes(diagnostic.name) &&
      !/void return|Callable/.test(diagnostic.message),
  );
  assert.deepEqual(unsupported.map((diagnostic) => diagnostic.message), []);
});

test('`${boolean}-flag` and `${bigint}` placeholders validate their textual form', () => {
  const { results } = runTemplateScenario([
    'type Flag = `${boolean}-flag`;',
    'type Count = `${bigint}`;',
    'function usaFlag(f: Flag): void { void f; }',
    'function usaCount(c: Count): void { void c; }',
    'expectAccepted("true-flag", () => usaFlag("true-flag" as Flag));',
    'expectAccepted("false-flag", () => usaFlag("false-flag" as Flag));',
    'expectTypeError("maybe-flag", () => usaFlag("maybe-flag" as any));',
    'expectAccepted("bigint", () => usaCount("12" as Count));',
    'expectTypeError("bigint-decimal", () => usaCount("1.5" as any));',
  ]);
  assert.deepEqual(results, [
    'accepted:true-flag',
    'accepted:false-flag',
    'rejected:maybe-flag',
    'accepted:bigint',
    'rejected:bigint-decimal',
  ]);
});

test('a template literal placeholder with no runtime pattern stays unsupported with a clear reason', () => {
  const project = emitProject({
    'main.ts': [
      'type Shout = `${Uppercase<string>}-x`;',
      'function usa(s: Shout): void { void s; }',
      'usa("ABC-x" as Shout);',
    ].join('\n'),
  });
  // The same unsupported type is reported at its parameter, expression and type-level sites; each must carry the reason.
  const unsupported = project.analysisDiagnostics.filter(
    (diagnostic) => diagnostic.status === 'unsupported' && /Template literal/.test(diagnostic.message),
  );
  assert.ok(unsupported.length > 0, JSON.stringify(project.analysisDiagnostics));
  for (const diagnostic of unsupported) {
    assert.match(diagnostic.message, /no runtime pattern/);
  }
  assert.ok(unsupported.some((diagnostic) => diagnostic.kind === 'parameter' && diagnostic.name === 's'));
});
