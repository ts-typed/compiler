'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { analyzeProject } = require('../../../dist/compiler/analysis');
const { createContractTransformer } = require('../../../dist/compiler/transform');
const runtime = require('../../../dist/runtime');
const guards = require('../../../dist/runtime/guards');

const runtimeModule = join(__dirname, '../../../dist/runtime');

function writeProject(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-mutation-'));
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

function runSnippet(source, transformerOptions) {
  const project = emitProject({ 'main.ts': source }, transformerOptions);
  assert.equal(project.emitSkipped, false);
  const result = spawnSync(process.execPath, [join(project.outputRoot, 'main.js')], {
    cwd: project.projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/**
 * Builds a snippet that crosses a `number[]` boundary, then runs `body`
 * against the typed `scores` array. `body` must call
 * `process.stdout.write("OK")` only if every expectation holds.
 */
function numberArraySnippet(body) {
  return [
    'const value: any = [1, 2, 3];',
    'const scores: number[] = value;',
    body,
  ].join('\n');
}

test('compiler.enforceMutationGuards defaults off: push, splice and index writes of a wrong type still succeed', () => {
  const body = numberArraySnippet([
    'const loose: any = scores;',
    'scores.push("wrong" as any);',
    'if (loose.length !== 4 || loose[3] !== "wrong") throw new Error("push was rejected");',
    'scores.splice(0, 1, "wrong" as any);',
    'if (loose[0] !== "wrong") throw new Error("splice was rejected");',
    'scores[5] = "wrong" as any;',
    'if (loose[5] !== "wrong") throw new Error("index write was rejected");',
    'process.stdout.write("OK");',
  ].join('\n'));

  assert.equal(runSnippet(body), 'OK');
  assert.equal(runSnippet(body, { enforceMutationGuards: false }), 'OK');
});

test('compiler.enforceMutationGuards rejects push of a wrong-typed item with StrictTypeError and leaves the array unchanged', () => {
  const stdout = runSnippet(
    numberArraySnippet([
      'let caught: any;',
      'try { scores.push("wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined) throw new Error("push was accepted");',
      'if (caught.name !== "StrictTypeError") throw new Error("expected StrictTypeError, got " + caught.name);',
      'if (caught.propertyPath !== "scores[3]") throw new Error("unexpected path " + caught.propertyPath);',
      'if (caught.operation !== "mutate") throw new Error("unexpected operation " + caught.operation);',
      'if (scores.length !== 3 || scores.join(",") !== "1,2,3") throw new Error("push partially applied");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards rejects wrong-typed direct index writes and splice replacements', () => {
  const stdout = runSnippet(
    numberArraySnippet([
      'let indexError: any;',
      'try { scores[5] = "wrong" as any; } catch (error) { indexError = error; }',
      'if (indexError === undefined || indexError.name !== "StrictTypeError") throw new Error("index write was accepted");',
      'if (indexError.propertyPath !== "scores[5]") throw new Error("unexpected index path " + indexError.propertyPath);',
      'if (scores.length !== 3 || 5 in scores) throw new Error("index write changed the array");',
      'let spliceError: any;',
      'try { scores.splice(0, 1, "wrong" as any); } catch (error) { spliceError = error; }',
      'if (spliceError === undefined || spliceError.name !== "StrictTypeError") throw new Error("splice was accepted");',
      'if (scores.join(",") !== "1,2,3") throw new Error("splice changed the array");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards still allows valid push, splice and index writes', () => {
  const stdout = runSnippet(
    numberArraySnippet([
      'scores.push(4);',
      'if (scores.join(",") !== "1,2,3,4") throw new Error("valid push failed");',
      'scores.splice(0, 1, 9);',
      'if (scores.join(",") !== "9,2,3,4") throw new Error("valid splice failed");',
      'scores[1] = 8;',
      'if (scores[1] !== 8) throw new Error("valid index write failed");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards does not false-positive on length truncation or growth', () => {
  const stdout = runSnippet(
    numberArraySnippet([
      'scores.length = 10;',
      'if (scores.length !== 10 || scores[9] !== undefined) throw new Error("length growth failed");',
      'scores[9] = 7;',
      'if (scores[9] !== 7) throw new Error("valid write into grown slot failed");',
      'scores.length = 0;',
      'if (scores.length !== 0) throw new Error("length truncation failed");',
      'scores.push(1);',
      'if (scores.join(",") !== "1") throw new Error("push after truncation failed");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards keeps Array.isArray and JSON.stringify working on the wrapped array', () => {
  const stdout = runSnippet(
    numberArraySnippet([
      'if (!Array.isArray(scores)) throw new Error("wrapped array is not an array");',
      'if (JSON.stringify(scores) !== "[1,2,3]") throw new Error("JSON.stringify changed: " + JSON.stringify(scores));',
      'if (scores.map((item) => item * 2).join(",") !== "2,4,6") throw new Error("array methods broke");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('protectValue wraps only when enforceMutationGuards is set, and reuses the same proxy', () => {
  const schema = { kind: 'array', items: { kind: 'primitive', name: 'number' } };
  const baseContext = { contractKind: 'variable', propertyPath: 'scores', operation: 'set' };

  const plain = [1, 2];
  assert.strictEqual(guards.protectValue(schema, plain, baseContext), plain);

  const guardedContext = { ...baseContext, enforceMutationGuards: true };
  const raw = [1, 2];
  const proxy = guards.protectValue(schema, raw, guardedContext);
  assert.notStrictEqual(proxy, raw);
  assert.strictEqual(guards.protectValue(schema, raw, guardedContext), proxy);
  assert.strictEqual(guards.protectValue(schema, proxy, guardedContext), proxy);
  assert.throws(() => proxy.push('wrong'), runtime.StrictTypeError);
  assert.equal(raw.length, 2);
});

test('protectValue leaves tuple schemas unwrapped even with enforceMutationGuards set', () => {
  const schema = {
    kind: 'tuple',
    items: [{ kind: 'primitive', name: 'number' }],
  };
  const value = [1];
  const context = {
    contractKind: 'variable',
    propertyPath: 'pair',
    operation: 'set',
    enforceMutationGuards: true,
  };
  assert.strictEqual(guards.protectValue(schema, value, context), value);
});
