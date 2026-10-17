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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-assign-targets-'));
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
  const diagnostics = [];
  const emitResult = analysis.program.emit(undefined, undefined, undefined, false, {
    before: [
      createContractTransformer({
        analysis,
        runtimeModule,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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

const HELPERS = [
  "import { StrictTypeError } from 'ts-typed';",
  'function expectTypeError(name: string, action: () => void): void {',
  '  try { action(); } catch (error) {',
  '    if (error instanceof StrictTypeError) return;',
  '    throw error;',
  '  }',
  '  throw new Error(`missing StrictTypeError: ${name}`);',
  '}',
];

test('a type-asserted assignment target emits valid JS and still validates the variable contract', () => {
  const project = emitProject({
    'main.ts': [
      ...HELPERS,
      'let x = 1;',
      '(x as number) = 2;',
      'if (x !== 2) throw new Error("valid assignment through cast was lost");',
      'expectTypeError("invalid", () => { (x as any) = "bad"; });',
      'if (x !== 2) throw new Error("rejected assignment changed the variable");',
      '(x) = 3;',
      'if (x !== 3) throw new Error("parenthesized assignment target failed");',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('a type-asserted compound assignment target emits valid JS and runs', () => {
  const project = emitProject({
    'main.ts': [
      'let c = 1;',
      '(c as number) += 1;',
      'if (c !== 2) throw new Error("compound assignment through cast failed");',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('type-asserted increment and decrement targets emit valid JS and run', () => {
  const project = emitProject({
    'main.ts': [
      'let n = 1;',
      '(n as any)++;',
      '++(n as any);',
      '(n as any)--;',
      'if (n !== 2) throw new Error("postfix/prefix update through cast failed");',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('a type assertion on the object of a member assignment is still validated as a read', () => {
  const project = emitProject({
    'main.ts': [
      ...HELPERS,
      'interface IUser { name: string; }',
      'const valid: unknown = { name: "Ada" };',
      '(valid as IUser).name = "Grace";',
      'if ((valid as IUser).name !== "Grace") throw new Error("member assignment through cast failed");',
      'const invalid: unknown = { name: 1 };',
      'expectTypeError("member object", () => { (invalid as IUser).name = "Grace"; });',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('a comparison against a guarded variable does not emit a false compound-assignment warning (B7)', () => {
  const project = emitProject({
    'main.ts': [
      'const MIN = 10;',
      'let port: number = 20;',
      'if (port >= MIN) { process.stdout.write("OK"); }',
      'void (port === MIN);',
      'void (port && MIN);',
    ].join('\n'),
  });

  assert.equal(project.emitSkipped, false);
  const falsePositives = project.diagnostics.filter(
    (diagnostic) => diagnostic.message.includes('Compound assignments and increments'),
  );
  assert.deepEqual(falsePositives, []);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('a compound arithmetic assignment that breaks the variable contract throws instead of corrupting it (B11)', () => {
  const project = emitProject({
    'main.ts': [
      ...HELPERS,
      'let n: number = 1;',
      'const valorAny: any = "x";',
      'expectTypeError("string into number", () => { n += (valorAny as any); });',
      'if (n !== 1) throw new Error(`variable was corrupted: ${String(n)}`);',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  assert.equal(project.emitSkipped, false);
  const falsePositives = project.diagnostics.filter(
    (diagnostic) => diagnostic.message.includes('Compound assignments and increments'),
  );
  assert.deepEqual(falsePositives, []);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('a valid compound arithmetic assignment on a guarded variable still updates it', () => {
  const project = emitProject({
    'main.ts': [
      'let n: number = 1;',
      'n += 2;',
      'if (n !== 3) throw new Error(`+= failed: ${String(n)}`);',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  assert.equal(project.emitSkipped, false);
  const falsePositives = project.diagnostics.filter(
    (diagnostic) => diagnostic.message.includes('Compound assignments and increments'),
  );
  assert.deepEqual(falsePositives, []);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('other arithmetic and bitwise compound assignments are guarded for invalid and valid values', () => {
  const project = emitProject({
    'main.ts': [
      ...HELPERS,
      // Literal-union contracts make invalid results reachable for -=, *=, &=.
      'let a: 10 | 20 = 20;',
      'let m: 2 | 4 = 4;',
      'let b: 5 | 6 = 5;',
      'let s: number = 3;',
      'const bad: any = 3;',
      // 20 - 3 = 17, 4 * 3 = 12, 5 & 3 = 1: none is in the contract.
      'expectTypeError("-= invalid", () => { a -= (bad as any); });',
      'expectTypeError("*= invalid", () => { m *= (bad as any); });',
      'expectTypeError("&= invalid", () => { b &= (bad as any); });',
      'if (a !== 20 || m !== 4 || b !== 5) throw new Error("rejected compound assignment changed a variable");',
      'const ten: any = 10;',
      'a -= (ten as any);',
      'const half: any = 0.5;',
      'm *= (half as any);',
      'const seven: any = 7;',
      'b &= (seven as any);',
      's **= 2;',
      'if (a !== 10) throw new Error("-= failed");',
      'if (m !== 2) throw new Error("*= failed");',
      'if (b !== 5) throw new Error("&= failed");',
      'if (s !== 9) throw new Error("**= failed");',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  assert.equal(project.emitSkipped, false);
  const falsePositives = project.diagnostics.filter(
    (diagnostic) => diagnostic.message.includes('Compound assignments and increments'),
  );
  assert.deepEqual(falsePositives, []);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('logical compound assignments keep the unsupported warning and are not rewritten', () => {
  const project = emitProject({
    'main.ts': [
      'let flag: boolean = true;',
      'let other: boolean = false;',
      'let maybe: number | null = null;',
      'flag &&= false;',
      'other ||= true;',
      'maybe ??= 5;',
      'if (flag !== false || other !== true || maybe !== 5) throw new Error("logical assignment failed");',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  assert.equal(project.emitSkipped, false);
  const warnings = project.diagnostics.filter(
    (diagnostic) => diagnostic.message.includes('Compound assignments and increments'),
  );
  assert.equal(warnings.length, 3);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});

test('logical compound assignments preserve short-circuit evaluation of the right-hand side', () => {
  const project = emitProject({
    'main.ts': [
      'const counter = { calls: 0 };',
      'function efeito(): boolean { counter.calls++; return true; }',
      'let flag: boolean = false;',
      'flag &&= efeito();',
      'const callsNow = (): number => counter.calls;',
      'if (callsNow() !== 0) throw new Error("&&= evaluated right side while left was falsy");',
      'flag = true;',
      'flag &&= efeito();',
      'if (callsNow() !== 1) throw new Error("&&= did not evaluate right side while left was truthy");',
      'let other: boolean = true;',
      'other ||= efeito();',
      'if (callsNow() !== 1) throw new Error("||= evaluated right side while left was truthy");',
      'process.stdout.write("OK");',
    ].join('\n'),
  });

  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});
