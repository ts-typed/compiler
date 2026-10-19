'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, relative } = require('node:path');
const test = require('node:test');

const typescript = require('typescript');
const { analyzeProject } = require('../../../dist/compiler/analysis');
const { assertValue, SchemaRegistry, StrictTypeError } = require('../../../dist/runtime');

function createProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-analysis-'));
  const sourceRoot = join(projectRoot, 'src');
  const dependencyRoot = join(projectRoot, 'node_modules', 'fixture-package');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(dependencyRoot, { recursive: true });

  writeFileSync(
    join(projectRoot, 'tsconfig.base.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'CommonJS',
        skipLibCheck: true,
      },
    }),
  );
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({ extends: './tsconfig.base.json', include: ['src/**/*.ts'], exclude: ['src/excluded.ts'] }),
  );
  writeFileSync(join(sourceRoot, 'excluded.ts'), 'const excludedContract: string = "skip";\n');
  writeFileSync(join(sourceRoot, 'ambient.d.ts'), 'declare const ambientContract: string;\n');
  writeFileSync(join(dependencyRoot, 'index.ts'), 'export const dependencyContract: string = "skip";\n');
  writeFileSync(
    join(sourceRoot, 'contracts.ts'),
    [
      'interface IUser { name: string; age: number; }',
      'interface IResponse<T> { data: T; ok: true; }',
      'interface INode { value: string; next?: INode; }',
      'const external: unknown = {};',
      'export const response: IResponse<IUser> = external as IResponse<IUser>;',
      'export let count = 1;',
      'export let intentional: any = external;',
      'export const recursive: INode = { value: "root" };',
      'export function greet(input: IUser): string { return input.name; }',
      'export const asserted = external as IUser;',
      'export const optionalTuple: [string, number?] = ["one"];',
      'export const callable: () => string = () => "ok";',
      'export const promised: Promise<string> = Promise.resolve("ok");',
      'export const mapped: Map<string, number> = new Map();',
      '',
    ].join('\n'),
  );

  return { projectRoot, tsconfigPath: join(projectRoot, 'tsconfig.json') };
}

function findContract(result, name, kind) {
  return [...result.contracts.values()].find(
    (contract) => contract.name === name && contract.kind === kind,
  );
}

function createRegistry(definitions) {
  const registry = new SchemaRegistry();
  for (const [name, schema] of Object.entries(definitions)) {
    registry.define(name, schema);
  }
  return registry;
}

function replaceSource(project, lines) {
  writeFileSync(join(project.projectRoot, 'src', 'contracts.ts'), `${lines.join('\n')}\n`);
}

test('analyzes concrete contracts with consumer TypeScript and runtime-valid schemas', () => {
  const project = createProject();
  const result = analyzeProject({ tsconfigPath: relative(process.cwd(), project.tsconfigPath) });

  assert.strictEqual(result.typescript, typescript);
  assert.equal(result.program.getCompilerOptions().strict, true);
  assert.equal(result.tsDiagnostics.length, 0);

  const response = findContract(result, 'response', 'variable');
  assert.ok(response);
  assert.equal(response.resolution.status, 'partial');
  assert.equal(response.resolution.schema.kind, 'ref');
  assert.equal(response.file, join(project.projectRoot, 'src', 'contracts.ts'));
  assert.equal(response.line, 5);
  assert.equal(response.column, 14);

  const definitions = result.resolver.getDefinitions();
  const registry = createRegistry(definitions);
  const context = { contractKind: 'variable', operation: 'assign', propertyPath: 'response', registry };
  assert.doesNotThrow(() =>
    assertValue(response.resolution.schema, { data: { name: 'Ada', age: 36 }, ok: true }, context),
  );
  assert.throws(
    () => assertValue(response.resolution.schema, { data: { name: 'Ada' }, ok: true }, context),
    StrictTypeError,
  );
  assert.throws(
    () =>
      assertValue(
        response.resolution.schema,
        { data: { name: 'Ada', age: 36, extra: true }, ok: true },
        context,
      ),
    StrictTypeError,
  );

  const count = findContract(result, 'count', 'variable');
  assert.deepEqual(count.resolution, {
    status: 'protected',
    schema: { kind: 'primitive', name: 'number' },
  });

  const recursive = findContract(result, 'recursive', 'variable');
  assert.equal(recursive.resolution.status, 'partial');
  assert.doesNotThrow(() =>
    assertValue(
      recursive.resolution.schema,
      { value: 'root', next: { value: 'leaf' } },
      { ...context, propertyPath: 'recursive' },
    ),
  );
});

test('reports open, partial and unsupported coverage without treating unsupported types as any', () => {
  const result = analyzeProject(createProject());

  const intentional = findContract(result, 'intentional', 'variable');
  assert.deepEqual(intentional.resolution, {
    status: 'open',
    schema: { kind: 'unknown' },
    reason: 'The effective contract is any.',
  });
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.name === 'intentional'), false);

  // callable is a pure function type: it is now a protected `function` leaf
  // (see type-schema-resolver.ts's _isPureFunction), not unsupported.
  const callable = findContract(result, 'callable', 'variable');
  assert.ok(callable);
  assert.deepEqual(callable.resolution, { status: 'protected', schema: { kind: 'function' } });
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.name === 'callable'), false);

  // A Map is a protected collection (map schema, alias-limited partial), not unsupported.
  const mapped = findContract(result, 'mapped', 'variable');
  assert.equal(mapped.resolution.status, 'partial');
  assert.equal(mapped.resolution.schema.kind, 'ref');
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.name === 'mapped' && diagnostic.status === 'unsupported'), false);

  for (const name of ['promised', 'optionalTuple']) {
    const contract = findContract(result, name, 'variable');
    assert.ok(contract, name);
    assert.equal(contract.resolution.status, 'unsupported', name);
    assert.equal(contract.resolution.schema, undefined, name);
    const diagnostic = result.diagnostics.find((item) => item.name === name);
    assert.ok(diagnostic, name);
    assert.equal(diagnostic.code, 'TT_UNSUPPORTED_TYPE');
    assert.equal(diagnostic.category, 'warning');
    assert.equal(diagnostic.status, 'unsupported');
    assert.equal(diagnostic.file.endsWith('contracts.ts'), true);
    assert.equal(diagnostic.line > 0, true);
    assert.equal(diagnostic.column > 0, true);
    assert.equal(diagnostic.kind, 'variable');
    assert.match(diagnostic.message, /unsupported|cannot|not represented/i);
  }

  const responseDiagnostic = result.diagnostics.find(
    (diagnostic) => diagnostic.name === 'response' && diagnostic.code === 'TT_PARTIAL_ALIAS',
  );
  assert.ok(responseDiagnostic);
  assert.equal(responseDiagnostic.status, 'partial');
});

test('discovers parameters, returns and assertions and excludes declarations and excluded sources', () => {
  const result = analyzeProject(createProject());
  const contracts = [...result.contracts.values()];

  assert.ok(findContract(result, 'input', 'parameter'));
  assert.ok(findContract(result, 'greet', 'return'));
  assert.ok(contracts.some((contract) => contract.kind === 'expression' && contract.line === 10));
  assert.equal(contracts.some((contract) => contract.name === 'ambientContract'), false);
  assert.equal(contracts.some((contract) => contract.name === 'excludedContract'), false);
  assert.equal(contracts.some((contract) => contract.file.includes('node_modules')), false);
  assert.equal(result.coverage.length, result.contracts.size);
  for (const item of result.coverage) {
    assert.equal(item.line > 0, true);
    assert.equal(item.column > 0, true);
    assert.equal(typeof item.status, 'string');
  }
});

test('resolves unions, intersections, enum literals, arrays, fixed tuples and a single index signature', () => {
  const project = createProject();
  replaceSource(project, [
    'enum Choice { Left = "left", Right = "right" }',
    'type Named = { name: string };',
    'type Aged = { age: number };',
    'export let choice: Choice = Choice.Left;',
    'export let choiceAgain: Choice = Choice.Right;',
    'export let union: string | number = "one";',
    'export const intersection: Named & Aged = { name: "Ada", age: 36 };',
    'export const list: number[] = [1, 2];',
    'export const tuple: [string, ...number[]] = ["count", 1, 2];',
    'export const dictionary: Record<string, number> = { one: 1 };',
  ]);

  const result = analyzeProject(project);
  const definitions = result.resolver.getDefinitions();
  const registry = createRegistry(definitions);
  const context = { contractKind: 'variable', operation: 'assign', propertyPath: 'value', registry };

  assert.equal(findContract(result, 'choice', 'variable').resolution.status, 'protected');
  assert.equal(findContract(result, 'choiceAgain', 'variable').resolution.status, 'protected');

  for (const [name, validValue, invalidValue] of [
    ['choice', 'right', 'other'],
    ['union', 1, false],
    ['intersection', { name: 'Ada', age: 36 }, { name: 'Ada' }],
    ['list', [1, 2], [1, '2']],
    ['tuple', ['count', 1, 2], ['count', '1']],
    ['dictionary', { one: 1 }, { one: '1' }],
  ]) {
    const contract = findContract(result, name, 'variable');
    assert.ok(contract, name);
    assert.notEqual(contract.resolution.status, 'unsupported', name);
    assert.ok(contract.resolution.schema, name);
    assert.doesNotThrow(() => assertValue(contract.resolution.schema, validValue, context), name);
    assert.throws(() => assertValue(contract.resolution.schema, invalidValue, context), StrictTypeError);
  }

  for (const name of ['intersection', 'list', 'tuple', 'dictionary']) {
    assert.equal(findContract(result, name, 'variable').resolution.status, 'partial', name);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) => diagnostic.name === name && diagnostic.code === 'TT_PARTIAL_ALIAS',
      ),
      name,
    );
  }
});

test('marks unresolved generics and class-specific member syntax unsupported with localized diagnostics', () => {
  const project = createProject();
  replaceSource(project, [
    'declare function fieldDecorator(_decoratedValue: undefined, context: ClassFieldDecoratorContext): void;',
    'export function identity<T>(value: T): T { return value; }',
    'class Example {',
    '  private hidden: string = "hidden";',
    '  protected guarded: number = 1;',
    '  static shared: boolean = true;',
    '  @fieldDecorator decorated: string = "decorated";',
    '  #secret: number = 1;',
    '}',
    'export const instance: Example = new Example();',
    'export function discard(): void { return; }',
  ]);

  const result = analyzeProject(project);
  for (const [name, kind] of [
    ['value', 'parameter'],
    ['identity', 'return'],
    ['hidden', 'property'],
    ['guarded', 'property'],
    ['#secret', 'property'],
    ['instance', 'variable'],
    ['discard', 'return'],
  ]) {
    const contract = findContract(result, name, kind);
    assert.ok(contract, `${kind}:${name}`);
    assert.equal(contract.resolution.status, 'unsupported', `${kind}:${name}`);
    assert.equal(contract.resolution.schema, undefined, `${kind}:${name}`);
    const diagnostic = result.diagnostics.find(
      (item) => item.name === name && item.kind === kind,
    );
    assert.ok(diagnostic, `${kind}:${name}`);
    assert.equal(diagnostic.status, 'unsupported');
    assert.equal(diagnostic.file.endsWith('contracts.ts'), true);
    assert.equal(diagnostic.line > 0, true);
    assert.equal(diagnostic.column > 0, true);
  }
  // A plain `static` field (no private/protected) is now a supported
  // contract, guarded through a static initializer block.
  const shared = findContract(result, 'shared', 'property');
  assert.ok(shared, 'property:shared');
  assert.notEqual(shared.resolution.status, 'unsupported', 'property:shared');
  assert.notEqual(shared.resolution.schema, undefined, 'property:shared');
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.name === 'shared'), false);
  assert.equal(
    result.diagnostics.find((diagnostic) => diagnostic.name === 'hidden').code,
    'TT_UNSUPPORTED_SYNTAX',
  );
  assert.equal(
    result.diagnostics.find((diagnostic) => diagnostic.name === 'value').code,
    'TT_UNSUPPORTED_TYPE',
  );
});

test('a decorated field is resolved from its type like an undecorated one, not blocked by its decorator', () => {
  // Behavior change: decorators (legacy or TC39) no longer make a member
  // unsupported. The field's own type decides the resolution, so a plain
  // `string` decorated field resolves to a schema the same way it would
  // without the decorator.
  const project = createProject();
  replaceSource(project, [
    'declare function fieldDecorator(_decoratedValue: undefined, context: ClassFieldDecoratorContext): void;',
    'class Example {',
    '  @fieldDecorator decorated: string = "decorated";',
    '  plain: string = "plain";',
    '}',
    'export const instance: Example = new Example();',
  ]);

  const result = analyzeProject(project);
  const decorated = findContract(result, 'decorated', 'property');
  const plain = findContract(result, 'plain', 'property');
  assert.ok(decorated, 'property:decorated');
  assert.notEqual(decorated.resolution.schema, undefined);
  assert.equal(decorated.resolution.status, plain.resolution.status);
  assert.deepEqual(decorated.resolution.schema, plain.resolution.schema);
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.name === 'decorated'),
    false,
  );
});

test('exposes static TypeScript diagnostics and applies compiler option overrides', () => {
  const project = createProject();
  replaceSource(project, ['export const broken: string = 123;']);

  const result = analyzeProject({
    tsconfigPath: project.tsconfigPath,
    compilerOptions: { declaration: false, sourceMap: true },
  });

  assert.equal(result.program.getCompilerOptions().declaration, false);
  assert.equal(result.program.getCompilerOptions().sourceMap, true);
  assert.ok(
    result.tsDiagnostics.some(
      (diagnostic) => diagnostic.code === 2322 && diagnostic.category === typescript.DiagnosticCategory.Error,
    ),
  );
});

test('preserves dangerous property names and does not claim distinct index or symbol coverage', () => {
  const project = createProject();
  replaceSource(project, [
    'declare const token: unique symbol;',
    'interface Dangerous { "__proto__": string; constructor: number; }',
    'interface MixedIndex { [key: string]: string | number; [key: number]: number; }',
    'interface Symbolic { [token]: string; }',
    'export const dangerous = {} as Dangerous;',
    'export const mixed = {} as MixedIndex;',
    'export const symbolic = {} as Symbolic;',
  ]);

  const result = analyzeProject(project);
  const dangerous = findContract(result, 'dangerous', 'variable');
  assert.equal(dangerous.resolution.status, 'partial');
  assert.equal(dangerous.resolution.schema.kind, 'ref');
  const definition = result.resolver.getDefinitions()[dangerous.resolution.schema.name];
  assert.equal(definition.kind, 'object');
  assert.equal(Object.hasOwn(definition.properties, '__proto__'), true);
  assert.equal(Object.hasOwn(definition.properties, 'constructor'), true);

  const valid = {};
  Object.defineProperty(valid, '__proto__', { value: 'safe', enumerable: true });
  Object.defineProperty(valid, 'constructor', { value: 1, enumerable: true });
  const registry = createRegistry(result.resolver.getDefinitions());
  assert.doesNotThrow(() =>
    assertValue(dangerous.resolution.schema, valid, {
      contractKind: 'variable',
      operation: 'assign',
      propertyPath: 'dangerous',
      registry,
    }),
  );

  for (const name of ['mixed', 'symbolic']) {
    const contract = findContract(result, name, 'variable');
    assert.equal(contract.resolution.status, 'unsupported', name);
    assert.equal(contract.resolution.schema, undefined, name);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) => diagnostic.name === name && diagnostic.code === 'TT_UNSUPPORTED_TYPE',
      ),
      name,
    );
  }
});

test('rejects an incompatible consumer TypeScript with a clear version diagnostic', () => {
  const project = createProject();
  const typescriptRoot = join(project.projectRoot, 'node_modules', 'typescript');
  mkdirSync(typescriptRoot, { recursive: true });
  writeFileSync(join(typescriptRoot, 'package.json'), JSON.stringify({ main: 'index.js' }));
  writeFileSync(
    join(typescriptRoot, 'index.js'),
    `const compiler = require(${JSON.stringify(require.resolve('typescript'))});\nmodule.exports = { ...compiler, version: '7.0.0', versionMajorMinor: '7.0' };\n`,
  );

  assert.throws(
    () => analyzeProject(project),
    /Unsupported TypeScript 7\.0\.0; ts-typed requires TypeScript >=5\.4 and <7\./,
  );
});

test('rejects a project configured with strictNullChecks: false (B9)', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-analysis-strict-null-'));
  const sourceRoot = join(projectRoot, 'src');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        strictNullChecks: false,
        target: 'ES2022',
        module: 'CommonJS',
        skipLibCheck: true,
        rootDir: './src',
        outDir: './out',
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(join(sourceRoot, 'main.ts'), 'const value: string = "ok";\n');

  assert.throws(
    () => analyzeProject({ tsconfigPath: join(projectRoot, 'tsconfig.json') }),
    /requires "strictNullChecks": true/,
  );
});

test('rejects a project with no strict/strictNullChecks configured at all (B9)', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-analysis-no-strict-'));
  const sourceRoot = join(projectRoot, 'src');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        skipLibCheck: true,
        rootDir: './src',
        outDir: './out',
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(join(sourceRoot, 'main.ts'), 'const value: string = "ok";\n');

  assert.throws(
    () => analyzeProject({ tsconfigPath: join(projectRoot, 'tsconfig.json') }),
    /requires "strictNullChecks": true/,
  );
});

test('accepts a project with only "strict": true (no explicit strictNullChecks)', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-analysis-strict-implies-'));
  const sourceRoot = join(projectRoot, 'src');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'CommonJS',
        skipLibCheck: true,
        rootDir: './src',
        outDir: './out',
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(join(sourceRoot, 'main.ts'), 'const value: string = "ok";\n');

  assert.doesNotThrow(() => analyzeProject({ tsconfigPath: join(projectRoot, 'tsconfig.json') }));
});
