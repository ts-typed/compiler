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

function writeProject(source) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-generic-call-'));
  const sourceRoot = join(projectRoot, 'src');
  const declarationRoot = join(projectRoot, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarationRoot, { recursive: true });
  writeFileSync(
    join(declarationRoot, 'index.d.ts'),
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
  writeFileSync(join(sourceRoot, 'main.ts'), source);
  return { projectRoot, tsconfigPath: join(projectRoot, 'tsconfig.json') };
}

function emitAndRun(source) {
  const project = writeProject(source);
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath });
  assert.equal(
    analysis.tsDiagnostics.length,
    0,
    analysis.tsDiagnostics.map((diagnostic) => diagnostic.messageText).join('\n'),
  );
  const emitResult = analysis.program.emit(undefined, undefined, undefined, false, {
    before: [createContractTransformer({ analysis, runtimeModule, onDiagnostic: () => {} })],
  });
  assert.equal(emitResult.emitSkipped, false);
  const result = spawnSync(process.execPath, [join(project.projectRoot, 'out', 'main.js')], {
    cwd: project.projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(',');
}

const PROLOGUE = [
  "import { StrictTypeError } from 'ts-typed';",
  'interface Person { name: string; age: number }',
  'const results: string[] = [];',
  'function record(name: string, action: () => unknown): void {',
  '  try {',
  '    action();',
  '    results.push(`ok:${name}`);',
  '  } catch (error) {',
  '    if (error instanceof StrictTypeError) {',
  '      results.push(`strict:${name}:${error.contractKind}:${error.operation}`);',
  '      return;',
  '    }',
  '    throw error;',
  '  }',
  '}',
];

function runScenario(lines) {
  return emitAndRun([...PROLOGUE, ...lines, 'process.stdout.write(results.join(","));'].join('\n'));
}

test('explicit identity<Person> validates the argument before the generic body runs', () => {
  const results = runScenario([
    'let ran = false;',
    'function identity<T>(x: T): T { ran = true; return x; }',
    'const bad = { name: "Ada", age: "old" } as any;',
    'record("arg", () => { identity<Person>(bad); });',
    'results.push(`ran:${ran}`);',
  ]);
  assert.deepEqual(results, ['strict:arg:parameter:argument', 'ran:false']);
});

test('explicit identity<Person> accepts a valid argument and returns it unchanged', () => {
  const results = runScenario([
    'function identity<T>(x: T): T { return x; }',
    'const good: Person = { name: "Ada", age: 36 };',
    'results.push(identity<Person>(good) === good ? "same" : "different");',
  ]);
  assert.deepEqual(results, ['same']);
});

test('explicit wrap<number> rejects a bad argument', () => {
  const results = runScenario([
    'function wrap<T>(x: T): { value: T } { return { value: x }; }',
    'record("wrap-arg", () => { wrap<number>("not-a-number" as any); });',
  ]);
  assert.deepEqual(results, ['strict:wrap-arg:parameter:argument']);
});

test('explicit generic call checks the instantiated return type independently of the argument', () => {
  const results = runScenario([
    // The parameter is `unknown`, so the argument is never checked here; only the return is wrong.
    'function liar<T>(x: unknown): { value: T } { return { value: "oops" as unknown as T }; }',
    'record("return-only", () => { liar<number>(1); });',
    'record("valid-return", () => { liar<string>(1); });',
  ]);
  assert.deepEqual(results, ['strict:return-only:return:return', 'ok:valid-return']);
});

test('a call without explicit type arguments is not guarded at the call site', () => {
  const results = runScenario([
    'function identity<T>(x: T): T { return x; }',
    'const bad = { name: "Ada", age: "old" };',
    'record("inferred", () => { if (identity(bad) !== bad) throw new Error("changed"); });',
  ]);
  assert.deepEqual(results, ['ok:inferred']);
});

test('ordinary non-generic calls are unaffected and still validated by the callee', () => {
  const results = runScenario([
    'function add(a: number, b: number): number { return a + b; }',
    'results.push(String(add(1, 2)));',
    'record("callee-arg", () => { add("x" as any, 2); });',
  ]);
  assert.deepEqual(results, ['3', 'strict:callee-arg:parameter:argument']);
});

function runAsyncScenario(lines) {
  return emitAndRun(
    [
      ...PROLOGUE,
      'async function recordAsync(name: string, action: () => unknown): Promise<void> {',
      '  try {',
      '    await action();',
      '    results.push(`ok:${name}`);',
      '  } catch (error) {',
      '    if (error instanceof StrictTypeError) {',
      '      results.push(`strict:${name}:${error.contractKind}:${error.operation}`);',
      '      return;',
      '    }',
      '    throw error;',
      '  }',
      '}',
      'async function main(): Promise<void> {',
      ...lines,
      '}',
      'main().then(() => process.stdout.write(results.join(",")));',
    ].join('\n'),
  );
}

test('async explicit identityAsync<Person> resolves to the valid value', async () => {
  const results = runAsyncScenario([
    'async function identityAsync<T>(x: T): Promise<T> { return x; }',
    'const good: Person = { name: "Ada", age: 36 };',
    'const resolved = await identityAsync<Person>(good);',
    'results.push(resolved === good ? "same" : "different");',
  ]);
  assert.deepEqual(results, ['same']);
});

test('async explicit call validates the resolved value and rejects with a return StrictTypeError', async () => {
  const results = runAsyncScenario([
    // Argument is `unknown`, so only the resolved return value is wrong (a number, not a string).
    'async function liarAsync<T>(x: unknown): Promise<T> { return x as T; }',
    'const asyncNumber: Promise<number> = Promise.resolve(1);',
    'await recordAsync("async-return", () => liarAsync<string>(asyncNumber));',
    'await recordAsync("async-valid", () => liarAsync<number>(asyncNumber));',
  ]);
  assert.deepEqual(results, ['strict:async-return:return:return', 'ok:async-valid']);
});

test('async explicit call still returns a Promise before it is awaited', async () => {
  const results = runAsyncScenario([
    'async function identityAsync<T>(x: T): Promise<T> { return x; }',
    'const good: Person = { name: "Ada", age: 36 };',
    'const pending = identityAsync<Person>(good);',
    'results.push(pending instanceof Promise ? "promise" : "not-promise");',
    'results.push(typeof pending.then === "function" ? "has-then" : "no-then");',
    'await pending;',
  ]);
  assert.deepEqual(results, ['promise', 'has-then']);
});

test('async call without explicit type arguments is not guarded at the call site', async () => {
  const results = runAsyncScenario([
    'async function identityAsync<T>(x: T): Promise<T> { return x; }',
    'const bad = { name: "Ada", age: "old" };',
    'await recordAsync("async-inferred", async () => {',
    '  if ((await identityAsync(bad)) !== bad) throw new Error("changed");',
    '});',
  ]);
  assert.deepEqual(results, ['ok:async-inferred']);
});

test('async generator with explicit type arguments is not return-validated', async () => {
  const results = runAsyncScenario([
    // Same lying-return shape as above, but as an async generator: the yielded value is not checked.
    'async function* yielder<T>(x: unknown): AsyncGenerator<T> { yield x as T; }',
    'const iterator = yielder<string>(1);',
    'results.push(String((await iterator.next()).value));',
  ]);
  assert.deepEqual(results, ['1']);
});

test('async explicit call checks the argument synchronously and the return asynchronously', async () => {
  const results = runAsyncScenario([
    'async function pick<T>(x: Person): Promise<T> { return x as unknown as T; }',
    'const bad = { name: "Ada", age: "old" } as any;',
    'const good: Person = { name: "Ada", age: 36 };',
    // Bad argument: the argument check throws synchronously, before the call returns a Promise.
    'let threw = false;',
    'try { pick<string>(bad); } catch (error) { threw = error instanceof StrictTypeError && error.contractKind === "parameter"; }',
    'results.push(threw ? "sync-argument" : "no-sync-argument");',
    // Valid argument: the call returns a Promise and the wrong resolved value rejects it.
    'await recordAsync("async-both-return", () => pick<string>(good));',
  ]);
  assert.deepEqual(results, ['sync-argument', 'strict:async-both-return:return:return']);
});

test('explicit new Box<Person> validates the constructor argument before the constructor body runs', () => {
  const results = runScenario([
    'let ran = false;',
    'class Box<T> { public readonly value: T; public constructor(value: T) { ran = true; this.value = value; } }',
    'const bad = { name: "Ada", age: "old" } as any;',
    'record("ctor-arg", () => { new Box<Person>(bad); });',
    'results.push(`ran:${ran}`);',
  ]);
  assert.deepEqual(results, ['strict:ctor-arg:parameter:argument', 'ran:false']);
});

test('explicit new Box<Person> accepts a valid argument and keeps the instance value', () => {
  const results = runScenario([
    'class Box<T> { public readonly value: T; public constructor(value: T) { this.value = value; } }',
    'const good: Person = { name: "Ada", age: 36 };',
    'const box = new Box<Person>(good);',
    'results.push(box.value === good ? "same" : "different");',
  ]);
  assert.deepEqual(results, ['same']);
});

test('explicit new Liar<number> checks the constructed instance independently of the argument', () => {
  const results = runScenario([
    // The constructor parameter is `unknown`, so the argument is never checked; only the instance is wrong.
    'class Liar<T> { public readonly value: T; public constructor(x: unknown) { this.value = "oops" as unknown as T; } }',
    'record("ctor-return", () => { new Liar<number>(1); });',
    'record("ctor-valid-return", () => { new Liar<string>(1); });',
  ]);
  assert.deepEqual(results, ['strict:ctor-return:return:return', 'ok:ctor-valid-return']);
});

test('a generic construction without explicit type arguments is not guarded at the construction site', () => {
  const results = runScenario([
    'class Box<T> { public readonly value: T; public constructor(value: T) { this.value = value; } }',
    'const bad = { name: "Ada", age: "old" };',
    'record("ctor-inferred", () => { if (new Box(bad).value !== bad) throw new Error("changed"); });',
  ]);
  assert.deepEqual(results, ['ok:ctor-inferred']);
});

test('an ordinary non-generic class construction is unaffected', () => {
  const results = runScenario([
    'class Plain { public readonly value: unknown; public constructor(value: unknown) { this.value = value; } }',
    'const bad = { name: "Ada", age: "old" } as any;',
    'record("plain-new", () => { if (new Plain(bad).value !== bad) throw new Error("changed"); });',
  ]);
  assert.deepEqual(results, ['ok:plain-new']);
});

test('explicit collect<number> validates plain arguments landing in the rest parameter', () => {
  const results = runScenario([
    'let ran = false;',
    'function collect<T>(...items: T[]): T[] { ran = true; return items; }',
    'record("rest-plain", () => { collect<number>(1, 2, "bad" as any); });',
    'results.push(`ran:${ran}`);',
  ]);
  assert.deepEqual(results, ['strict:rest-plain:parameter:argument', 'ran:false']);
});

test('explicit collect<number> accepts valid plain rest arguments and returns them', () => {
  const results = runScenario([
    'function collect<T>(...items: T[]): T[] { return items; }',
    'results.push(collect<number>(1, 2, 3).join("|"));',
  ]);
  assert.deepEqual(results, ['1|2|3']);
});

test('a call without explicit type arguments does not validate rest arguments at the call site', () => {
  const results = runScenario([
    'function collect<T>(...items: T[]): T[] { return items; }',
    'record("rest-inferred", () => { collect(1, 2, "bad" as any); });',
  ]);
  assert.deepEqual(results, ['ok:rest-inferred']);
});

test('explicit collect<number> validates a spread array landing in the rest parameter', () => {
  const results = runScenario([
    'let ran = false;',
    'function collect<T>(...items: T[]): T[] { ran = true; return items; }',
    'const mixed: any[] = [1, 2, "bad"];',
    'const good: number[] = [1, 2, 3];',
    'record("rest-spread-bad", () => { collect<number>(...mixed); });',
    'results.push(`ran:${ran}`);',
    'results.push(collect<number>(...good).join("|"));',
  ]);
  assert.deepEqual(results, ['strict:rest-spread-bad:parameter:argument', 'ran:false', '1|2|3']);
});

test('explicit collect<number> checks a plain argument after a spread that lands in the rest parameter', () => {
  const results = runScenario([
    'function collect<T>(...items: T[]): T[] { return items; }',
    'const good: number[] = [1, 2];',
    'record("rest-spread-then-bad", () => { collect<number>(...good, "bad" as any); });',
  ]);
  assert.deepEqual(results, ['strict:rest-spread-then-bad:parameter:argument']);
});

test('explicit new Collector<number> validates plain constructor rest arguments', () => {
  const results = runScenario([
    'let ran = false;',
    'class Collector<T> { public readonly items: readonly T[]; public constructor(...items: T[]) { ran = true; this.items = items; } }',
    'record("ctor-rest-plain", () => { new Collector<number>(1, 2, "bad" as any); });',
    'results.push(`ran:${ran}`);',
  ]);
  assert.deepEqual(results, ['strict:ctor-rest-plain:parameter:argument', 'ran:false']);
});

test('explicit new Collector<number> accepts valid constructor rest arguments', () => {
  const results = runScenario([
    'class Collector<T> { public readonly items: readonly T[]; public constructor(...items: T[]) { this.items = items; } }',
    'results.push(new Collector<number>(1, 2, 3).items.join("|"));',
  ]);
  assert.deepEqual(results, ['1|2|3']);
});

test('explicit new Collector<number> validates a spread array landing in the constructor rest parameter', () => {
  const results = runScenario([
    'class Collector<T> { public readonly items: readonly T[]; public constructor(...items: T[]) { this.items = items; } }',
    'const mixed: any[] = [1, "bad"];',
    'record("ctor-rest-spread-bad", () => { new Collector<number>(...mixed); });',
  ]);
  assert.deepEqual(results, ['strict:ctor-rest-spread-bad:parameter:argument']);
});
