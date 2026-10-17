'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { analyzeProject } = require('../../../dist/compiler/analysis');
const { createContractTransformer } = require('../../../dist/compiler/transform');

const runtimeModule = join(__dirname, '../../../dist/runtime');

function writeProject(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-transform-'));
  const sourceRoot = join(projectRoot, 'src');
  const declarationRoot = join(projectRoot, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarationRoot, { recursive: true });
  writeFileSync(
    join(declarationRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {}',
      'export function AllowExtraProperties(): ClassDecorator & PropertyDecorator;',
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
  const emitResult = analysis.program.emit(
    undefined,
    undefined,
    undefined,
    false,
    {
      before: [
        createContractTransformer({
          analysis,
          runtimeModule,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
          ...transformerOptions,
        }),
      ],
    },
  );
  assert.equal(emitResult.emitSkipped, false);
  return { ...project, diagnostics, outputRoot: join(project.projectRoot, 'out') };
}

function runEntry(project, relativePath = 'main.js') {
  return spawnSync(process.execPath, [join(project.outputRoot, relativePath)], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
}

test('emitted contracts reject invalid variables, parameters, returns and assertions', () => {
  const project = emitProject({
    'main.ts': [
      "import { StrictTypeError } from 'ts-typed';",
      'interface IUser { name: string; age: number; }',
      'interface IResponse<T> { data: T; ok: true; }',
      'const failures: string[] = [];',
      'function expectTypeError(name: string, action: () => void): void {',
      '  try { action(); } catch (error) {',
      '    if (error instanceof StrictTypeError) { failures.push(name); return; }',
      '    throw error;',
      '  }',
      '  throw new Error(`missing error: ${name}`);',
      '}',
      'const invalidResponse: any = { data: { name: "Ada", age: "bad" }, ok: true };',
      'expectTypeError("generic", () => { const response: IResponse<IUser> = invalidResponse; void response; });',
      'let inferred = 1;',
      'expectTypeError("write", () => { inferred = "bad" as any; });',
      'if (inferred !== 1) throw new Error("failed assignment changed the variable");',
      'function parameter(value: IUser): string { return value.name; }',
      'expectTypeError("parameter", () => parameter({ name: "Ada" } as any));',
      'function result(): IUser { return { name: "Ada" } as any; }',
      'expectTypeError("return", () => result());',
      'const assertedInput: unknown = { name: "Ada" };',
      'expectTypeError("assertion", () => { const asserted = assertedInput as IUser; void asserted; });',
      'process.stdout.write(JSON.stringify(failures.sort()));',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['assertion', 'generic', 'parameter', 'return', 'write']);
});
test('class fields validate initialization, constructor writes and later mutation', () => {
  const project = emitProject({
    'main.ts': [
      "import { StrictTypeError } from 'ts-typed';",
      'function expectTypeError(action: () => void): void {',
      '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
      '  throw new Error("missing StrictTypeError");',
      '}',
      'class Box {',
      '  value: number = 1;',
      '  pending!: number;',
      '  constructor(initial?: any) { if (initial !== undefined) this.pending = initial; }',
      '}',
      'class InvalidInitializer { value: number = "bad" as any; }',
      'expectTypeError(() => new InvalidInitializer());',
      'const box = new Box(2);',
      'expectTypeError(() => { (box as any).value = "bad"; });',
      'if (box.value !== 1) throw new Error("failed write changed field");',
      'expectTypeError(() => Object.assign(box, { pending: "bad" }));',
      'const deferred = new Box();',
      'deferred.pending = 3;',
      'if (deferred.pending !== 3) throw new Error("first valid write failed");',
    ].join('\n'),
  });

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
});
test('preserves decorator metadata, recursive definitions and one runtime identity across files', () => {
  const project = emitProject({
    'model.ts': [
      "import { AllowExtraProperties } from 'ts-typed';",
      'function Field(): PropertyDecorator { return () => undefined; }',
      'export interface INode { value: string; next?: INode; }',
      '@AllowExtraProperties()',
      'export class Model {',
      '  @Field() value: number = 1;',
      '  node: INode = { value: "root", next: { value: "leaf" } };',
      '}',
    ].join('\n'),
    'main.ts': [
      "import { StrictTypeError } from 'ts-typed';",
      "import { Model } from './model';",
      'const model = new Model();',
      'try { (model as any).node = { value: "root", next: { value: 1 } }; }',
      'catch (error) {',
      '  if (!(error instanceof StrictTypeError)) throw error;',
      '  process.stdout.write("same-runtime");',
      '}',
    ].join('\n'),
  });

  const emittedModel = readFileSync(join(project.outputRoot, 'model.js'), 'utf8');
  assert.match(emittedModel, /__metadata\("design:type", Number\)/);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'same-runtime');
});

test('unsupported protected syntax emits localized warnings and preserves executable code', () => {
  const project = emitProject({
    'main.ts': [
      'const externalValue: any = 2;',
      'let count = 1;',
      'count += externalValue;',
      'class State { static value: number = 1; }',
      'const callable: () => string = () => "ok";',
      'if (count !== 3 || State.value !== 1 || callable() !== "ok") throw new Error("semantics changed");',
    ].join('\n'),
  });

  const syntaxWarnings = project.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'TT_UNSUPPORTED_SYNTAX',
  );
  assert.equal(syntaxWarnings.length >= 2, true);
  for (const diagnostic of syntaxWarnings) {
    assert.equal(diagnostic.category, 'warning');
    assert.equal(diagnostic.status === 'partial' || diagnostic.status === 'unsupported', true);
    assert.equal(diagnostic.file.endsWith('main.ts'), true);
    assert.equal(diagnostic.line > 0, true);
    assert.equal(diagnostic.column > 0, true);
    assert.equal(typeof diagnostic.name, 'string');
    assert.equal(typeof diagnostic.kind, 'string');
  }
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
});
