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
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-class-methods-'));
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

function emitProject(files) {
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

function runEntry(project) {
  return spawnSync(process.execPath, [join(project.outputRoot, 'main.js')], {
    cwd: project.projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
}

const HELPERS = [
  "import { StrictTypeError } from 'ts-typed';",
  'function expectTypeError(action: () => unknown): void {',
  '  try { action(); } catch (caught) { if (caught instanceof StrictTypeError) return; throw caught; }',
  '  throw new Error("missing StrictTypeError");',
  '}',
];

function assertOk(source) {
  const project = emitProject({ "main.ts": [...HELPERS, source, "process.stdout.write(\"OK\");"].join("\n") });
  assert.equal(project.emitSkipped, false);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "OK");
}

test("instance method parameter is validated; valid calls return the expected value", () => {
  assertOk(`
    class Greeter {
      greet(name: string): string { return \`hi \${name}\`; }
    }
    const g = new Greeter();
    if (g.greet("ana") !== "hi ana") throw new Error("wrong result");
    expectTypeError(() => { g.greet(123 as any); });
  `);
});

test("method return value is validated when the method returns", () => {
  assertOk(`
    class Parser {
      compute(): number { return JSON.parse('"not a number"'); }
    }
    expectTypeError(() => { new Parser().compute(); });
  `);
});

test("constructor parameter is validated", () => {
  assertOk(`
    const sink: { v?: unknown } = {};
    class Foo {
      constructor(label: string) { sink.v = label; }
    }
    new Foo("ok");
    if (sink.v !== "ok") throw new Error("wrong label");
    expectTypeError(() => { new Foo(123 as any); });
  `);
});

test("getter return and setter parameter are validated", () => {
  assertOk(`
    const seen: { v?: unknown } = {};
    class Holder {
      get valor(): number { return Number(seen.v); }
      set valor(v: number) { seen.v = v; }
    }
    const h = new Holder();
    h.valor = 7;
    if (h.valor !== 7) throw new Error("wrong getter/setter value");
    expectTypeError(() => { h.valor = "nope" as any; });
    class Bad {
      get broken(): number { return JSON.parse('"x"'); }
    }
    expectTypeError(() => { void new Bad().broken; });
  `);
});

test("static method is instrumented like an instance method", () => {
  assertOk(`
    class MathBox {
      static double(n: number): number { return n * 2; }
    }
    if (MathBox.double(4) !== 8) throw new Error("wrong static result");
    expectTypeError(() => { MathBox.double("4" as any); });
  `);
});

test("method decorator is still applied and the parameter is still validated", () => {
  assertOk(`
    const calls: string[] = [];
    function logged(target: any, key: string, descriptor: PropertyDescriptor) {
      calls.push(key);
      return descriptor;
    }
    class Controller {
      @logged
      createUser(dto: { name: string }): string { return dto.name; }
    }
    if (calls.length !== 1 || calls[0] !== "createUser") throw new Error("decorator not applied");
    if (new Controller().createUser({ name: "ana" }) !== "ana") throw new Error("wrong result");
    expectTypeError(() => { new Controller().createUser(42 as any); });
  `);
});

test("method body can read this.field and the instrumentation does not break it", () => {
  assertOk(`
    class Counter {
      step: number = 2;
      bump(n: number): number { return this.step + n; }
    }
    const counter = new Counter();
    if (counter.bump(3) !== 5) throw new Error("wrong bump result");
    expectTypeError(() => { counter.bump("3" as any); });
  `);
});

test("subclass method calling super.method keeps working and is validated", () => {
  assertOk(`
    class Base {
      greet(name: string): string { return "hi " + name; }
    }
    class Child extends Base {
      greet(name: string): string { return super.greet(name) + "!"; }
    }
    if (new Child().greet("ana") !== "hi ana!") throw new Error("super call broken");
    expectTypeError(() => { new Child().greet(1 as any); });
  `);
});

test("abstract and body-less members are left alone", () => {
  assertOk(`
    abstract class Shape {
      abstract area(): number;
    }
    class Square extends Shape {
      side: number = 2;
      area(): number { return this.side * this.side; }
    }
    if (new Square().area() !== 4) throw new Error("wrong area");
  `);
});
