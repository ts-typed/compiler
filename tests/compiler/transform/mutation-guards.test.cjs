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

/**
 * Builds a snippet that crosses a `Map<string, number>` boundary (and a
 * `Set<number>` boundary), then runs `body` against the typed `map` / `set`.
 */
function collectionSnippet(body) {
  return [
    'const mapValue: any = new Map([["a", 1]]);',
    'const map: Map<string, number> = mapValue;',
    'const setValue: any = new Set([1]);',
    'const set: Set<number> = setValue;',
    body,
  ].join('\n');
}

test('compiler.enforceMutationGuards defaults off: map.set and set.add of wrong types still succeed', () => {
  const body = collectionSnippet([
    'const looseMap: any = map;',
    'const looseSet: any = set;',
    'map.set("b", "wrong" as any);',
    'if (looseMap.get("b") !== "wrong") throw new Error("map.set was rejected");',
    'set.add("wrong" as any);',
    'if (!looseSet.has("wrong")) throw new Error("set.add was rejected");',
    'process.stdout.write("OK");',
  ].join('\n'));

  assert.equal(runSnippet(body), 'OK');
  assert.equal(runSnippet(body, { enforceMutationGuards: false }), 'OK');
});

test('compiler.enforceMutationGuards rejects map.set with a wrong-typed value and leaves the map unchanged', () => {
  const stdout = runSnippet(
    collectionSnippet([
      'let caught: any;',
      'try { map.set("b", "wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined) throw new Error("map.set was accepted");',
      'if (caught.name !== "StrictTypeError") throw new Error("expected StrictTypeError, got " + caught.name);',
      'if (caught.propertyPath !== "map<mutate>.value") throw new Error("unexpected path " + caught.propertyPath);',
      'if (caught.operation !== "mutate") throw new Error("unexpected operation " + caught.operation);',
      'if (map.size !== 1 || map.has("b")) throw new Error("bad entry was stored");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards rejects map.set with a wrong-typed key', () => {
  const stdout = runSnippet(
    collectionSnippet([
      'const looseMap: any = map;',
      'let caught: any;',
      'try { map.set(7 as any, 2); } catch (error) { caught = error; }',
      'if (caught === undefined || caught.name !== "StrictTypeError") throw new Error("wrong key was accepted");',
      'if (caught.propertyPath !== "map<mutate>.key") throw new Error("unexpected path " + caught.propertyPath);',
      'if (map.size !== 1 || looseMap.has(7)) throw new Error("bad key was stored");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards rejects set.add of a wrong-typed item and leaves the set unchanged', () => {
  const stdout = runSnippet(
    collectionSnippet([
      'const looseSet: any = set;',
      'let caught: any;',
      'try { set.add("wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined || caught.name !== "StrictTypeError") throw new Error("set.add was accepted");',
      'if (caught.propertyPath !== "set<mutate>") throw new Error("unexpected path " + caught.propertyPath);',
      'if (set.size !== 1 || looseSet.has("wrong")) throw new Error("bad item was stored");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards still allows valid map.set, chained set calls and set.add', () => {
  const stdout = runSnippet(
    collectionSnippet([
      'map.set("b", 2).set("c", 3);',
      'if (map.size !== 3 || map.get("b") !== 2 || map.get("c") !== 3) throw new Error("valid chained map.set failed");',
      'set.add(2).add(3);',
      'if (set.size !== 3 || !set.has(2) || !set.has(3)) throw new Error("valid chained set.add failed");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards forwards delete and clear without validation', () => {
  const stdout = runSnippet(
    collectionSnippet([
      'map.set("b", 2);',
      'if (map.delete("b") !== true || map.has("b")) throw new Error("map.delete failed");',
      'if (map.delete("missing") !== false) throw new Error("map.delete return value wrong");',
      'map.clear();',
      'if (map.size !== 0) throw new Error("map.clear failed");',
      'set.add(5);',
      'if (set.delete(5) !== true || set.has(5)) throw new Error("set.delete failed");',
      'set.clear();',
      'if (set.size !== 0) throw new Error("set.clear failed");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards keeps get, has, size and iteration working on the wrapped collections', () => {
  const stdout = runSnippet(
    collectionSnippet([
      'if (map.get("a") !== 1 || map.has("a") !== true || map.size !== 1) throw new Error("map reads broke");',
      'if (JSON.stringify([...map.keys()]) !== "[\\"a\\"]") throw new Error("map.keys broke");',
      'if (JSON.stringify([...map.values()]) !== "[1]") throw new Error("map.values broke");',
      'if (JSON.stringify([...map.entries()]) !== "[[\\"a\\",1]]") throw new Error("map.entries broke");',
      'const seenEntries = []; for (const [k, v] of map) seenEntries.push(k + "=" + v);',
      'if (seenEntries.join(",") !== "a=1") throw new Error("map for...of broke");',
      'if (set.has(1) !== true || set.size !== 1) throw new Error("set reads broke");',
      'if (JSON.stringify([...set.values()]) !== "[1]") throw new Error("set.values broke");',
      'const seenItems = []; for (const item of set) seenItems.push(item);',
      'if (seenItems.join(",") !== "1") throw new Error("set for...of broke");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards keeps instanceof Map and instanceof Set true for the wrapped collections', () => {
  const stdout = runSnippet(
    collectionSnippet([
      'if (!(map instanceof Map)) throw new Error("wrapped map is not instanceof Map");',
      'if (!(set instanceof Set)) throw new Error("wrapped set is not instanceof Set");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('protectValue wraps Map and Set only when enforceMutationGuards is set, and reuses the same proxy', () => {
  const mapSchema = {
    kind: 'map',
    key: { kind: 'primitive', name: 'string' },
    value: { kind: 'primitive', name: 'number' },
  };
  const setSchema = { kind: 'set', item: { kind: 'primitive', name: 'number' } };
  const baseContext = { contractKind: 'variable', propertyPath: 'lookup', operation: 'set' };
  const guardedContext = { ...baseContext, enforceMutationGuards: true };

  const plainMap = new Map([['a', 1]]);
  assert.strictEqual(guards.protectValue(mapSchema, plainMap, baseContext), plainMap);

  const rawMap = new Map([['a', 1]]);
  const mapProxy = guards.protectValue(mapSchema, rawMap, guardedContext);
  assert.notStrictEqual(mapProxy, rawMap);
  assert.strictEqual(guards.protectValue(mapSchema, rawMap, guardedContext), mapProxy);
  assert.strictEqual(guards.protectValue(mapSchema, mapProxy, guardedContext), mapProxy);
  assert.throws(() => mapProxy.set('b', 'wrong'), runtime.StrictTypeError);
  assert.equal(rawMap.has('b'), false);

  const plainSet = new Set([1]);
  assert.strictEqual(guards.protectValue(setSchema, plainSet, baseContext), plainSet);

  const rawSet = new Set([1]);
  const setProxy = guards.protectValue(setSchema, rawSet, guardedContext);
  assert.notStrictEqual(setProxy, rawSet);
  assert.strictEqual(guards.protectValue(setSchema, rawSet, guardedContext), setProxy);
  assert.throws(() => setProxy.add('wrong'), runtime.StrictTypeError);
  assert.equal(rawSet.has('wrong'), false);
});

/**
 * Builds a snippet that crosses a `Profile` interface boundary. `required`
 * keys are `name` and `age`; `nickname` is optional. `valueExpression` is the
 * runtime value handed to the boundary, and `body` runs against `profile`.
 */
function profileSnippet(valueExpression, body) {
  return [
    'interface Profile { name: string; age: number; nickname?: string; }',
    `const value: any = ${valueExpression};`,
    'const profile: Profile = value;',
    body,
  ].join('\n');
}

const plainProfile = '{ name: "Ada", age: 36, nickname: "A" }';
const sealedProfile = 'Object.seal({ name: "Ada", age: 36 })';

test('compiler.enforceMutationGuards defaults off: a wrong-typed write to a sealed object still succeeds', () => {
  const body = profileSnippet(sealedProfile, [
    'const loose: any = profile;',
    'if (Reflect.set(profile, "age", "wrong") !== true) throw new Error("sealed write was rejected");',
    'if (loose.age !== "wrong") throw new Error("sealed write was not applied");',
    'process.stdout.write("OK");',
  ].join('\n'));

  assert.equal(runSnippet(body), 'OK');
  assert.equal(runSnippet(body, { enforceMutationGuards: false }), 'OK');
});

test('compiler.enforceMutationGuards rejects a wrong-typed write to a sealed object and leaves the value unchanged', () => {
  const stdout = runSnippet(
    profileSnippet(sealedProfile, [
      'const loose: any = profile;',
      'let caught: any;',
      'try { Reflect.set(profile, "age", "wrong"); } catch (error) { caught = error; }',
      'if (caught === undefined) throw new Error("sealed wrong write was accepted");',
      'if (caught.name !== "StrictTypeError") throw new Error("expected StrictTypeError, got " + caught.name);',
      'if (caught.operation !== "mutate") throw new Error("unexpected operation " + caught.operation);',
      'if (loose.age !== 36) throw new Error("sealed value changed");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards still allows a valid write to a sealed object', () => {
  const stdout = runSnippet(
    profileSnippet(sealedProfile, [
      'const loose: any = profile;',
      'Reflect.set(profile, "age", 37);',
      'if (loose.age !== 37) throw new Error("valid sealed write failed");',
      'profile.name = "Grace";',
      'if (profile.name !== "Grace") throw new Error("valid direct sealed write failed");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards refuses to delete a required key from a plain object without throwing', () => {
  const stdout = runSnippet(
    profileSnippet(plainProfile, [
      'const loose: any = profile;',
      'if (Reflect.deleteProperty(profile, "age") !== false) throw new Error("required delete was not refused");',
      'if (loose.age !== 36) throw new Error("required key was removed");',
      'let strictDelete = "none";',
      'try { delete (profile as any).age; } catch (error) { strictDelete = (error as any).name; }',
      'if (strictDelete !== "TypeError") throw new Error("strict delete did not throw TypeError: " + strictDelete);',
      'if (Reflect.deleteProperty(profile, "nickname") !== true || loose.nickname !== undefined) throw new Error("optional delete failed");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards refuses a wrong-typed defineProperty with a native TypeError and keeps the value', () => {
  const stdout = runSnippet(
    profileSnippet(plainProfile, [
      'const loose: any = profile;',
      'let caught: any;',
      'try { Object.defineProperty(profile, "age", { value: "wrong" }); } catch (error) { caught = error; }',
      'if (caught === undefined) throw new Error("wrong defineProperty was accepted");',
      'if (caught.name !== "TypeError") throw new Error("expected native TypeError, got " + caught.name);',
      'if (loose.age !== 36) throw new Error("value changed after refused defineProperty");',
      'Object.defineProperty(profile, "age", { value: 37 });',
      'if (loose.age !== 37) throw new Error("valid defineProperty failed");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards keeps JSON.stringify, Object.keys, spread and reads working on the wrapped object', () => {
  const stdout = runSnippet(
    profileSnippet(plainProfile, [
      'if (JSON.stringify(profile) !== JSON.stringify({ name: "Ada", age: 36, nickname: "A" })) throw new Error("JSON.stringify changed");',
      'if (Object.keys(profile).join(",") !== "name,age,nickname") throw new Error("Object.keys changed");',
      'const copy = { ...profile };',
      'if (copy.name !== "Ada" || copy.age !== 36 || copy.nickname !== "A") throw new Error("spread changed");',
      'if (profile.name !== "Ada" || profile.age !== 36) throw new Error("reads broke");',
      'process.stdout.write("OK");',
    ].join('\n')),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards leaves class instances unwrapped, so private members still work', () => {
  const stdout = runSnippet(
    [
      'class Named { name = "Ada"; #secret = 7; reveal(): number { return this.#secret; } }',
      'const instance = new Named();',
      'const typed: Named = instance;',
      'if (typed !== instance) throw new Error("class instance was wrapped");',
      'if (typed.reveal() !== 7) throw new Error("private member access broke");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('protectValue wraps plain objects only when enforceMutationGuards is set, and reuses the same proxy', () => {
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: { kind: 'primitive', name: 'string' } },
      age: { schema: { kind: 'primitive', name: 'number' } },
      nickname: { schema: { kind: 'primitive', name: 'string' }, optional: true },
    },
  };
  const baseContext = { contractKind: 'variable', propertyPath: 'profile', operation: 'set' };

  const plain = { name: 'Ada', age: 36 };
  assert.strictEqual(guards.protectValue(schema, plain, baseContext), plain);

  const guardedContext = { ...baseContext, enforceMutationGuards: true };
  const raw = { name: 'Ada', age: 36 };
  const proxy = guards.protectValue(schema, raw, guardedContext);
  assert.notStrictEqual(proxy, raw);
  assert.strictEqual(guards.protectValue(schema, raw, guardedContext), proxy);
  assert.strictEqual(guards.protectValue(schema, proxy, guardedContext), proxy);
  assert.throws(() => Reflect.set(proxy, 'age', 'wrong'), runtime.StrictTypeError);
  assert.equal(raw.age, 36);

  class Holder { value = 1; }
  const instance = new Holder();
  assert.strictEqual(guards.protectValue({ kind: 'object', properties: {}, allowExtraProperties: true }, instance, guardedContext), instance);
});

/**
 * Nested mutation guards: the Proxy wrapping recurses into arrays, Maps, Sets
 * and plain objects found inside a guarded value, both when the value first
 * crosses a typed boundary and when a new value is written into it.
 */
test('compiler.enforceMutationGuards guards a nested array inside a typed object: push of a wrong-typed item throws', () => {
  const stdout = runSnippet(
    [
      'const value: any = { items: [1, 2] };',
      'const config: { items: number[] } = value;',
      'let caught: any;',
      'try { config.items.push("wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined) throw new Error("push was accepted");',
      'if (caught.name !== "StrictTypeError") throw new Error("expected StrictTypeError, got " + caught.name);',
      'if (config.items.join(",") !== "1,2") throw new Error("push partially applied");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards still allows a valid push into a nested array', () => {
  const stdout = runSnippet(
    [
      'const value: any = { items: [1, 2] };',
      'const config: { items: number[] } = value;',
      'config.items.push(3);',
      'if (config.items.length !== 3 || config.items.join(",") !== "1,2,3") throw new Error("valid push failed");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards guards a nested object inside an array', () => {
  const stdout = runSnippet(
    [
      'const value: any = [{ value: 1 }];',
      'const list: { value: number }[] = value;',
      'let caught: any;',
      'try { list[0].value = "wrong" as any; } catch (error) { caught = error; }',
      'if (caught === undefined || caught.name !== "StrictTypeError") throw new Error("write was not rejected");',
      'if (list[0].value !== 1) throw new Error("value changed");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards guards an array nested in an object nested in an array', () => {
  const stdout = runSnippet(
    [
      'const value: any = [{ tags: [1] }];',
      'const list: { tags: number[] }[] = value;',
      'let caught: any;',
      'try { list[0].tags.push("wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined || caught.name !== "StrictTypeError") throw new Error("push was accepted");',
      'if (list[0].tags.join(",") !== "1") throw new Error("push partially applied");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards guards a nested array inside a Map value', () => {
  const stdout = runSnippet(
    [
      'const value: any = new Map([["a", [1, 2]]]);',
      'const m: Map<string, number[]> = value;',
      'let caught: any;',
      'try { m.get("a")!.push("wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined || caught.name !== "StrictTypeError") throw new Error("push was accepted");',
      'if (m.get("a")!.join(",") !== "1,2") throw new Error("push partially applied");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards guards a nested array of a replaced slot, and a value written later', () => {
  const stdout = runSnippet(
    [
      'const value: any = { items: [1] };',
      'const config: { items: number[] } = value;',
      'config.items = [1, 2];',
      'let caught: any;',
      'try { config.items.push("wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined || caught.name !== "StrictTypeError") throw new Error("replaced slot is unguarded");',
      'if (config.items.join(",") !== "1,2") throw new Error("push partially applied");',
      'const bag: any = { entries: new Map() };',
      'const typed: { entries: Map<string, { nums: number[] }> } = bag;',
      'typed.entries.set("k", { nums: [1] });',
      'let mapCaught: any;',
      'try { typed.entries.get("k")!.nums.push("wrong" as any); } catch (error) { mapCaught = error; }',
      'if (mapCaught === undefined || mapCaught.name !== "StrictTypeError") throw new Error("Map.set value is unguarded");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards guards a nested array of an item added with set.add', () => {
  const stdout = runSnippet(
    [
      'const value: any = new Set();',
      'const bag: Set<{ items: number[] }> = value;',
      'bag.add({ items: [1] });',
      'let caught: any;',
      'try { [...bag][0].items.push("wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined || caught.name !== "StrictTypeError") throw new Error("added item is unguarded");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards guards nested arrays of items already in a Set (set items are walked, not replaced)', () => {
  const stdout = runSnippet(
    [
      'const value: any = new Set([{ items: [1] }]);',
      'const bag: Set<{ items: number[] }> = value;',
      'let caught: any;',
      'try { [...bag][0].items.push("wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined || caught.name !== "StrictTypeError") throw new Error("pre-existing set item is unguarded");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards terminates on a self-referencing object and on a parent/child cycle', () => {
  const stdout = runSnippet(
    [
      'interface Loop { name: string; next?: Loop }',
      'const value: any = { name: "a" };',
      'value.next = value;',
      'const loop: Loop = value;',
      'if (loop.next !== loop) throw new Error("self reference lost");',
      'interface Holder { name: string; children: Member[] }',
      'interface Member { parent: Holder; tags: number[] }',
      'const parentValue: any = { name: "p", children: [] };',
      'const childValue: any = { parent: parentValue, tags: [1] };',
      'parentValue.children.push(childValue);',
      'const holder: Holder = parentValue;',
      'if (holder.children[0].parent !== holder) throw new Error("parent/child cycle lost");',
      'let caught: any;',
      'try { holder.children[0].tags.push("wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined || caught.name !== "StrictTypeError") throw new Error("cyclic child array is unguarded");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});

test('compiler.enforceMutationGuards defaults off: writes into nested arrays, Maps and Sets still succeed', () => {
  const body = [
    'const value: any = { items: [1, 2] };',
    'const config: { items: number[] } = value;',
    'config.items.push("wrong" as any);',
    'if (config.items.length !== 3) throw new Error("push was rejected");',
    'config.items = [1, 2];',
    'config.items.push("wrong" as any);',
    'if (config.items.length !== 3) throw new Error("replaced slot push was rejected");',
    'const mapValue: any = new Map([["a", [1, 2]]]);',
    'const m: Map<string, number[]> = mapValue;',
    'm.get("a")!.push("wrong" as any);',
    'if (m.get("a")!.length !== 3) throw new Error("map nested push was rejected");',
    'const setValue: any = new Set();',
    'const bag: Set<{ items: number[] }> = setValue;',
    'bag.add({ items: [1] });',
    '[...bag][0].items.push("wrong" as any);',
    'if ([...bag][0].items.length !== 2) throw new Error("set nested push was rejected");',
    'const deep: any = [{ tags: [1] }];',
    'const list: { tags: number[] }[] = deep;',
    'list[0].tags.push("wrong" as any);',
    'if (list[0].tags.length !== 2) throw new Error("deep push was rejected");',
    'process.stdout.write("OK");',
  ].join('\n');

  assert.equal(runSnippet(body), 'OK');
  assert.equal(runSnippet(body, { enforceMutationGuards: false }), 'OK');
});

test('compiler.enforceMutationGuards guards an optional nested array (declared as a union with undefined)', () => {
  const stdout = runSnippet(
    [
      'const value: any = { items: [1, 2] };',
      'const config: { items?: number[] } = value;',
      'let caught: any;',
      'try { config.items!.push("wrong" as any); } catch (error) { caught = error; }',
      'if (caught === undefined || caught.name !== "StrictTypeError") throw new Error("optional nested array is unguarded");',
      'if (config.items!.join(",") !== "1,2") throw new Error("push partially applied");',
      'const empty: any = {};',
      'const sparse: { items?: number[] } = empty;',
      'if (sparse.items !== undefined) throw new Error("absent optional gained a value");',
      'process.stdout.write("OK");',
    ].join('\n'),
    { enforceMutationGuards: true },
  );
  assert.equal(stdout, 'OK');
});
