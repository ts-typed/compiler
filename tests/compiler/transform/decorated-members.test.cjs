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

// Decorated members used to be blocked outright ("Decorated members require
// framework-compatible instrumentation."). These tests pin the new behavior:
// the field/parameter is instrumented from its type, and the decorator keeps
// running with its observable effect intact.

function writeProject(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-decorated-'));
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
  const analysis = analyzeProject({
    tsconfigPath: project.tsconfigPath,
    enforcePrivate: transformerOptions.enforcePrivate === true,
  });
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

const HELPERS = [
  "import { StrictTypeError } from 'ts-typed';",
  'function expectTypeError(action: () => void): void {',
  '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
  '  throw new Error("missing StrictTypeError");',
  '}',
  'const calls: string[] = [];',
  'function logged() {',
  '  return function (_target: object, key: string | symbol): void { calls.push(String(key)); };',
  '}',
  'function injected() {',
  '  return function (_target: object, key: string | symbol | undefined, index: number): void {',
  '    calls.push("param" + index + ":" + String(key));',
  '  };',
  '}',
];

function assertOk(body, transformerOptions) {
  const project = emitProject(
    { 'main.ts': [...HELPERS, body, 'process.stdout.write("OK");'].join('\n') },
    transformerOptions,
  );
  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
}

test('a decorated field with an initializer is guarded and the decorator still runs', () => {
  assertOk(`
    class Person {
      @logged() name: string = "Ada";
    }
    const person = new Person();
    if (calls.length !== 1 || calls[0] !== "name") throw new Error("decorator not applied: " + calls.join(","));
    if (person.name !== "Ada") throw new Error("wrong initial value: " + person.name);
    expectTypeError(() => { (person as any).name = 123; });
    if (person.name !== "Ada") throw new Error("guard let an invalid write through");
  `);
});

test('a decorated field without an initializer is guarded once a value is assigned, and the decorator still runs', () => {
  assertOk(`
    class Dto {
      @logged() name!: string;
    }
    const dto = new Dto();
    if (calls.length !== 1 || calls[0] !== "name") throw new Error("decorator not applied: " + calls.join(","));
    Object.assign(dto, { name: "Ada" });
    if (dto.name !== "Ada") throw new Error("assignment lost: " + dto.name);
    expectTypeError(() => { (dto as any).name = 123; });
    if (dto.name !== "Ada") throw new Error("guard let an invalid write through");
  `);
});

test('a decorated field with no inline initializer, assigned inside the constructor body (not via Object.assign), is still guarded', () => {
  // Regression: a decorated field with no inline initializer keeps its
  // PropertyDeclaration in the output (to preserve decorator emission),
  // which native class fields (target >= ES2022) pre-define as `undefined`
  // before the constructor body runs. installFieldGuard used to treat that
  // pre-defined descriptor as "already handled by someone else" and give up
  // silently, leaving the field completely unguarded for the rest of its
  // life — this is exactly the common DTO shape of
  // `class Dto { @IsString() name: string; constructor(data: Data) { this.name = data.name; } }`.
  assertOk(`
    class Dto {
      @logged() name: string;
      constructor(value: string) {
        this.name = value;
      }
    }
    const dto = new Dto("Ada");
    if (calls.length !== 1 || calls[0] !== "name") throw new Error("decorator not applied: " + calls.join(","));
    if (dto.name !== "Ada") throw new Error("constructor assignment lost: " + dto.name);
    expectTypeError(() => { (dto as any).name = 123; });
    if (dto.name !== "Ada") throw new Error("guard let an invalid write through");
    dto.name = "Grace";
    if (dto.name !== "Grace") throw new Error("valid write was not stored");
  `);
});

test('a decorated parameter is validated and its decorator still runs', () => {
  assertOk(`
    class Service {
      greet(@injected() value: string): string { return value; }
    }
    const service = new Service();
    if (!calls.includes("param0:greet")) throw new Error("parameter decorator not applied: " + calls.join(","));
    if (service.greet("hi") !== "hi") throw new Error("wrong result");
    expectTypeError(() => { service.greet(42 as any); });
  `);
});

test('a decorated field that is never assigned reads as undefined without throwing, while invalid writes still fail', () => {
  assertOk(`
    class Lazy {
      @logged() name!: string;
    }
    const lazy = new Lazy();
    if (lazy.name !== undefined) throw new Error("expected undefined, got " + String(lazy.name));
    expectTypeError(() => { (lazy as any).name = 7; });
  `);
});

// Known boundary, reported rather than silently fixed: under enforcePrivate a
// private field is rewritten into a `#name` accessor pair, which drops its
// decorator. A decorated private field is therefore reported unsupported (the
// user is told the decorator is not instrumented) and the program still runs.
// Keeping the decorator would need the private-hiding schema to tolerate an
// own property, which is a runtime change outside this scope.
test('a decorated private field under enforcePrivate is reported unsupported and the program still runs', () => {
  const project = emitProject(
    {
      'main.ts': [
        ...HELPERS,
        'class Vault {',
        '  @logged() private _v: string = "x";',
        '  get value(): string { return this._v; }',
        '}',
        'const vault = new Vault();',
        'if (vault.value !== "x") throw new Error("wrong value: " + vault.value);',
        'process.stdout.write("OK");',
      ].join('\n'),
    },
    { enforcePrivate: true },
  );

  assert.equal(project.emitSkipped, false);
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath, enforcePrivate: true });
  const unsupported = analysis.diagnostics.find((diagnostic) => diagnostic.name === '_v');
  assert.notEqual(unsupported, undefined, JSON.stringify(analysis.diagnostics.map((d) => d.name)));
  assert.equal(unsupported.status, 'unsupported');
  assert.match(unsupported.message, /Decorated private members cannot keep their decorators under enforcePrivate\./);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'OK');
});
