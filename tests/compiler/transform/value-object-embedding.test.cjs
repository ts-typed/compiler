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
const runtimeIndex = join(runtimeModule, 'index.js');

// The ValueObject declaration is installed the way a consumer would have it:
// node_modules/@ts-typed/core/dist/runtime/value-object.class.d.ts. The
// runtime itself resolves to this repository's built dist, so the class
// identity the transformer and the fixture see is the same.
function emitProject(files, { esm = false } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-value-object-'));
  const sourceRoot = join(projectRoot, 'src');
  const tsTypedRoot = join(projectRoot, 'node_modules', 'ts-typed');
  const compilerRoot = join(projectRoot, 'node_modules', '@ts-typed', 'core');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(tsTypedRoot, { recursive: true });
  mkdirSync(join(compilerRoot, 'dist', 'runtime'), { recursive: true });

  writeFileSync(
    join(tsTypedRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {',
      '  readonly contractKind: string;',
      '  readonly operation: string;',
      '}',
      'export function StrictClass(): ClassDecorator;',
      'export function StructuralClass(): ClassDecorator;',
    ].join('\n'),
  );
  writeFileSync(
    join(compilerRoot, 'package.json'),
    JSON.stringify(
      esm
        ? {
          name: '@ts-typed/core',
          type: 'commonjs',
          exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } },
        }
        : { name: '@ts-typed/core', main: 'dist/index.js', types: 'dist/index.d.ts' },
    ),
  );
  if (esm) {
    writeFileSync(
      join(compilerRoot, 'dist', 'index.mjs'),
      [
        "import { createRequire } from 'node:module';",
        `const runtime = createRequire(import.meta.url)(${JSON.stringify(runtimeIndex)});`,
        'export const ValueObject = runtime.ValueObject;',
        'export const StrictTypeError = runtime.StrictTypeError;',
        '',
      ].join('\n'),
    );
  } else {
    writeFileSync(
      join(compilerRoot, 'dist', 'index.js'),
      `module.exports = require(${JSON.stringify(runtimeIndex)});\n`,
    );
  }
  writeFileSync(
    join(compilerRoot, 'dist', 'index.d.ts'),
    "export { ValueObject } from './runtime/value-object.class';\n",
  );
  writeFileSync(
    join(compilerRoot, 'dist', 'runtime', 'value-object.class.d.ts'),
    [
      'export declare abstract class ValueObject extends String {',
      '  protected constructor(raw: string, context?: unknown);',
      '  protected abstract isValid(raw: string): boolean;',
      '  toJSON(): string;',
      '}',
      '',
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
        module: esm ? 'ESNext' : 'CommonJS',
        moduleResolution: esm ? 'Bundler' : 'Node',
        rootDir: './src',
        outDir: './out',
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  if (esm) {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = join(sourceRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source);
  }

  const analysis = analyzeProject({ tsconfigPath: join(projectRoot, 'tsconfig.json') });
  assert.equal(
    analysis.tsDiagnostics.length,
    0,
    analysis.tsDiagnostics.map((diagnostic) => diagnostic.messageText).join('\n'),
  );
  const diagnostics = [];
  const emitResult = analysis.program.emit(
    undefined,
    undefined,
    undefined,
    false,
    {
      before: [
        createContractTransformer({
          analysis,
          // ESM resolves a bare directory import to nothing; CommonJS does not need the index.
          runtimeModule: esm ? runtimeIndex : runtimeModule,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      ],
    },
  );
  assert.equal(emitResult.emitSkipped, false);
  return { projectRoot, outputRoot: join(projectRoot, 'out'), diagnostics, emitted: emitResult };
}

const VALUE_OBJECTS = [
  "import { ValueObject } from '@ts-typed/core';",
  'export class CPF extends ValueObject {',
  '  protected isValid(raw: string): boolean { return raw.length === 11; }',
  "  public masked(): string { return '***' + this.toString().slice(-2); }",
  '}',
  'export class Code extends ValueObject {',
  "  protected isValid(raw: string): boolean { return raw.startsWith('A'); }",
  '}',
  'export class Tagged extends Code {',
  "  public tag(): string { return 'tagged'; }",
  '}',
  'export function makeCpf(raw: string): CPF { return raw as any; }',
].join('\n');

// Runs the app against the value-object fixture and returns its JSON output.
function runApp(appLines, extraFiles = {}, options = {}) {
  const project = emitProject({
    'value-objects.ts': VALUE_OBJECTS,
    'app.ts': appLines.join('\n'),
    ...extraFiles,
  }, options);
  const result = spawnSync(process.execPath, [join(project.outputRoot, 'app.js')], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('a ValueObject parameter auto-constructs from a raw string across files, with no explicit new', () => {
  const out = runApp([
    "import { CPF } from './value-objects';",
    'function searchByCPF(cpf: CPF): { isObject: boolean; masked: string } {',
    "  return { isObject: typeof cpf === 'object', masked: cpf.masked() };",
    '}',
    "process.stdout.write(JSON.stringify(searchByCPF('12345678901' as any)));",
  ]);
  assert.deepEqual(out, { isObject: true, masked: '***01' });
});

test('a ValueObject nested in an interface parameter auto-constructs from a raw string', () => {
  const out = runApp([
    "import { CPF } from './value-objects';",
    'interface SearchInput { cpf: CPF; }',
    'function searchByInput(input: SearchInput): { isObject: boolean; masked: string } {',
    "  return { isObject: typeof input.cpf === 'object', masked: input.cpf.masked() };",
    '}',
    "process.stdout.write(JSON.stringify(searchByInput({ cpf: '12345678901' } as any)));",
  ]);
  assert.deepEqual(out, { isObject: true, masked: '***01' });
});

test('a ValueObject nested in an array property auto-constructs each raw string', () => {
  const out = runApp([
    "import { CPF } from './value-objects';",
    'interface SearchInput { cpfs: CPF[]; }',
    'function searchByInput(input: SearchInput): string[] {',
    '  return input.cpfs.map((cpf) => cpf.masked());',
    '}',
    "process.stdout.write(JSON.stringify(searchByInput({ cpfs: ['12345678901', '10987654321'] } as any)));",
  ]);
  assert.deepEqual(out, ['***01', '***21']);
});

test('a ValueObject class field auto-constructs when assigned a raw string', () => {
  const out = runApp([
    "import { CPF } from './value-objects';",
    'class Holder {',
    '  cpf!: CPF;',
    '}',
    'const holder = new Holder();',
    "holder.cpf = '12345678901' as any;",
    "process.stdout.write(JSON.stringify({ isObject: typeof holder.cpf === 'object', masked: holder.cpf.masked() }));",
  ]);
  assert.deepEqual(out, { isObject: true, masked: '***01' });
});

test('an invalid raw string throws StrictTypeError when auto-constructed as a parameter', () => {
  const out = runApp([
    "import { StrictTypeError } from 'ts-typed';",
    "import { CPF } from './value-objects';",
    'function searchByCPF(cpf: CPF): string { return cpf.masked(); }',
    'let outcome = "none";',
    "try { searchByCPF('123' as any); } catch (error) { outcome = error instanceof StrictTypeError ? 'StrictTypeError' : 'other'; }",
    'process.stdout.write(JSON.stringify({ outcome }));',
  ]);
  assert.deepEqual(out, { outcome: 'StrictTypeError' });
});

test('an invalid raw string throws StrictTypeError when assigned to a ValueObject field', () => {
  const out = runApp([
    "import { StrictTypeError } from 'ts-typed';",
    "import { CPF } from './value-objects';",
    'class Holder {',
    '  cpf!: CPF;',
    '}',
    'const holder = new Holder();',
    'let outcome = "none";',
    "try { holder.cpf = '123' as any; } catch (error) { outcome = error instanceof StrictTypeError ? 'StrictTypeError' : 'other'; }",
    'process.stdout.write(JSON.stringify({ outcome }));',
  ]);
  assert.deepEqual(out, { outcome: 'StrictTypeError' });
});

test('a class that does not extend ValueObject keeps structural validation and does not auto-construct', () => {
  const out = runApp([
    "import { StrictTypeError } from 'ts-typed';",
    'class Person {',
    '  name!: string;',
    '  age!: number;',
    '}',
    'function takePerson(person: Person): string { return person.name; }',
    "const valid = takePerson(Object.assign(new Person(), { name: 'ana', age: 3 }));",
    'let mismatch = "none";',
    "try { takePerson({ name: 'x', age: 'no' } as any); } catch (error) { mismatch = error instanceof StrictTypeError ? 'StrictTypeError' : 'other'; }",
    'let rawString = "none";',
    "try { takePerson('ana' as any); } catch (error) { rawString = error instanceof StrictTypeError ? 'StrictTypeError' : 'other'; }",
    'process.stdout.write(JSON.stringify({ valid, mismatch, rawString }));',
  ]);
  assert.deepEqual(out, { valid: 'ana', mismatch: 'StrictTypeError', rawString: 'StrictTypeError' });
});

test('a class extending an intermediate ValueObject subclass is detected through the full chain', () => {
  const out = runApp([
    "import { StrictTypeError } from 'ts-typed';",
    "import { Tagged } from './value-objects';",
    'function takeTagged(value: Tagged): string { return value.tag() + ":" + value.toString(); }',
    "const valid = takeTagged('Aabc' as any);",
    'let outcome = "none";',
    "try { takeTagged('Babc' as any); } catch (error) { outcome = error instanceof StrictTypeError ? 'StrictTypeError' : 'other'; }",
    'process.stdout.write(JSON.stringify({ valid, outcome }));',
  ]);
  assert.deepEqual(out, { valid: 'tagged:Aabc', outcome: 'StrictTypeError' });
});

test('an ordinary class with compiler.strictClass still enforces nominal instanceOf', () => {
  const out = runApp([
    "import { StrictClass, StrictTypeError } from 'ts-typed';",
    '@StrictClass()',
    'class Account {',
    '  balance!: number;',
    '}',
    'function takeAccount(account: Account): number { return account.balance; }',
    'const valid = takeAccount(Object.assign(new Account(), { balance: 5 }));',
    'let outcome = "none";',
    "try { takeAccount({ balance: 1 } as any); } catch (error) { outcome = error instanceof StrictTypeError ? 'StrictTypeError' : 'other'; }",
    'process.stdout.write(JSON.stringify({ valid, outcome }));',
  ]);
  assert.deepEqual(out, { valid: 5, outcome: 'StrictTypeError' });
});

test('a ValueObject class declared in the same file is embedded and deferred past its declaration', () => {
  const out = runApp([
    "import { ValueObject } from '@ts-typed/core';",
    'function takeLocal(value: Local): string { return value.label(); }',
    'class Local extends ValueObject {',
    "  protected isValid(raw: string): boolean { return raw.startsWith('L'); }",
    "  public label(): string { return 'local:' + this.toString(); }",
    '}',
    "process.stdout.write(JSON.stringify({ out: takeLocal('Labc' as any) }));",
  ]);
  assert.deepEqual(out, { out: 'local:Labc' });
});

test('a ValueObject parameter auto-constructs across files under ESM output', () => {
  const out = runApp(
    [
      "import { CPF } from './value-objects.js';",
      'function searchByCPF(cpf: CPF): string { return cpf.masked(); }',
      "process.stdout.write(JSON.stringify({ masked: searchByCPF('12345678901' as any) }));",
    ],
    {},
    { esm: true },
  );
  assert.deepEqual(out, { masked: '***01' });
});

test('a ValueObject reached without a named import degrades to no check and reports a diagnostic', () => {
  const project = emitProject({
    'value-objects.ts': VALUE_OBJECTS,
    'app.ts': [
      "import { makeCpf } from './value-objects';",
      "const made = makeCpf('12345678901');",
      'process.stdout.write(JSON.stringify({ masked: made.masked() }));',
    ].join('\n'),
  });
  const result = spawnSync(process.execPath, [join(project.outputRoot, 'app.js')], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { masked: '***01' });
  const limit = project.diagnostics.find((diagnostic) => diagnostic.name === 'CPF');
  assert.ok(limit, 'expected a limitation diagnostic for CPF');
  assert.match(limit.message, /not imported by name into this file/);
});
