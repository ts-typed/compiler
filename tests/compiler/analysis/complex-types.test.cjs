'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');

const { analyzeProject } = require('../../../dist/compiler/analysis');

function writeProject(source) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-complex-analysis-'));
  const sourceRoot = join(projectRoot, 'src');
  mkdirSync(sourceRoot, { recursive: true });
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
  const absolutePath = join(sourceRoot, 'main.ts');
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
  return { tsconfigPath: join(projectRoot, 'tsconfig.json') };
}

function analyze(source) {
  const project = writeProject(source);
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath });
  assert.equal(
    analysis.tsDiagnostics.length,
    0,
    analysis.tsDiagnostics.map((diagnostic) => diagnostic.messageText).join('\n'),
  );
  return analysis;
}

function variableContract(analysis, name) {
  for (const contract of analysis.contracts.values()) {
    if (contract.kind === 'variable' && contract.name === name) {
      return contract;
    }
  }
  throw new Error(`no variable contract named "${name}"`);
}

test('a generic discriminated union over an interface resolves every branch, including a nested homomorphic mapped type', () => {
  const analysis = analyze(
    [
      'class FormControl<T> { value!: T; }',
      'interface IValue<T extends object> { value: { [K in keyof T]: FormControl<T[K]>; }; }',
      'interface IValor<T> { valor: T; }',
      'interface IValorDesc<T> { valor: T; desc: string; }',
      'type ValueType<T extends object> = IValue<T> | IValor<T> | IValorDesc<T>;',
      'interface IValueClass { name: string; age: number; }',
      'const value: ValueType<IValueClass> = { valor: { name: "a", age: 1 } };',
    ].join('\n'),
  );

  const contract = variableContract(analysis, 'value');
  assert.equal(contract.resolution.status, 'partial');
  assert.equal(contract.resolution.schema.kind, 'ref');

  const definitions = analysis.resolver.getDefinitions();
  const union = definitions[contract.resolution.schema.name];
  assert.equal(union.kind, 'union');
  assert.equal(union.schemas.length, 3);

  const valueBranch = definitions[union.schemas[0].name];
  assert.equal(valueBranch.properties.value.schema.kind, 'object');
  assert.equal(
    definitions[valueBranch.properties.value.schema.properties.name.schema.name].properties.value.schema.kind,
    'primitive',
  );
  assert.equal(
    definitions[valueBranch.properties.value.schema.properties.age.schema.name].properties.value.schema.name,
    'number',
  );

  const valorBranch = definitions[union.schemas[1].name];
  assert.equal(definitions[valorBranch.properties.valor.schema.name].properties.name.schema.name, 'string');

  const valorDescBranch = definitions[union.schemas[2].name];
  assert.equal(valorDescBranch.properties.desc.schema.name, 'string');
});

test('a plain data class used directly as a generic argument resolves structurally, like an equivalent interface', () => {
  const analysis = analyze(
    [
      'class FormControl<T> { value!: T; }',
      'interface IValue<T extends object> { value: { [K in keyof T]: FormControl<T[K]>; }; }',
      'interface IValor<T> { valor: T; }',
      'interface IValorDesc<T> { valor: T; desc: string; }',
      'type ValueType<T extends object> = IValue<T> | IValor<T> | IValorDesc<T>;',
      // Old-style `private`/`protected` TypeScript members have no runtime
      // effect and are reflectively identical to public ones, so they do not
      // block structural resolution either.
      'class ValueClass { name!: string; age!: number; private internal = 0; }',
      'const value: ValueType<ValueClass> = { valor: new ValueClass() };',
    ].join('\n'),
  );

  const contract = variableContract(analysis, 'value');
  assert.equal(contract.resolution.status, 'partial');
  assert.equal(contract.resolution.schema.kind, 'ref');
  const definitions = analysis.resolver.getDefinitions();
  const union = definitions[contract.resolution.schema.name];
  const valorBranch = definitions[union.schemas[1].name];
  const valueClassSchema = definitions[valorBranch.properties.valor.schema.name];
  assert.equal(valueClassSchema.properties.name.schema.name, 'string');
  assert.equal(valueClassSchema.properties.age.schema.name, 'number');
  // Old-style `private` has no runtime effect, so it is validated just like
  // a public field rather than being hidden from the schema.
  assert.equal(valueClassSchema.properties.internal.schema.name, 'number');
});

test('a class with a method cannot be represented structurally and is reported unsupported rather than silently open', () => {
  const analysis = analyze(
    [
      'interface IValor<T> { valor: T; }',
      'class ValueClass { name = "Ada"; greet(): string { return `hi ${this.name}`; } }',
      'const value: IValor<ValueClass> = { valor: new ValueClass() };',
    ].join('\n'),
  );

  const contract = variableContract(analysis, 'value');
  assert.equal(contract.resolution.status, 'unsupported');
  assert.equal(contract.resolution.schema, undefined);
  assert.match(contract.resolution.reason, /Callable and constructable contracts/);
});

test('a class with a true #private field cannot be represented structurally and is reported unsupported rather than silently open', () => {
  const analysis = analyze(
    [
      'interface IValor<T> { valor: T; }',
      'class ValueClass { #secret = "x"; name = "Ada"; }',
      'const value: IValor<ValueClass> = { valor: new ValueClass() };',
    ].join('\n'),
  );

  const contract = variableContract(analysis, 'value');
  assert.equal(contract.resolution.status, 'unsupported');
  assert.equal(contract.resolution.schema, undefined);
  assert.match(contract.resolution.reason, /#private/);
});

test('Pick, Omit, Partial, Required and Record resolve to concrete object schemas', () => {
  const analysis = analyze(
    [
      'interface IUser { id: number; name: string; email?: string; }',
      'const a: Pick<IUser, "id" | "name"> = { id: 1, name: "a" };',
      'const b: Omit<IUser, "email"> = { id: 1, name: "a" };',
      'const c: Partial<IUser> = {};',
      'const d: Required<IUser> = { id: 1, name: "a", email: "x" };',
      'const e: Record<"a" | "b", number> = { a: 1, b: 2 };',
    ].join('\n'),
  );

  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    const contract = variableContract(analysis, name);
    assert.equal(contract.resolution.status, 'partial');
    assert.equal(contract.resolution.schema.kind, 'ref');
    const definition = analysis.resolver.getDefinitions()[contract.resolution.schema.name];
    assert.equal(definition.kind, 'object');
  }

  const partialDefinition = analysis.resolver.getDefinitions()[variableContract(analysis, 'c').resolution.schema.name];
  assert.equal(partialDefinition.properties.id.optional, true);
  assert.equal(partialDefinition.properties.name.optional, true);

  const requiredDefinition = analysis.resolver.getDefinitions()[variableContract(analysis, 'd').resolution.schema.name];
  assert.equal(requiredDefinition.properties.email.optional, undefined);
});

test('a conditional type instantiated with a concrete argument resolves to its selected branch', () => {
  const analysis = analyze(
    [
      'type Cond<T> = T extends string ? { kind: "s"; value: string } : { kind: "n"; value: number };',
      'const c: Cond<string> = { kind: "s", value: "ok" };',
    ].join('\n'),
  );

  const contract = variableContract(analysis, 'c');
  assert.equal(contract.resolution.status, 'partial');
  assert.equal(contract.resolution.schema.kind, 'object');
  assert.equal(contract.resolution.schema.properties.kind.schema.value, 's');
});

test('a literal-tagged discriminated union keeps each literal tag distinguishable', () => {
  const analysis = analyze(
    [
      'interface ICircle { kind: "circle"; radius: number; }',
      'interface ISquare { kind: "square"; side: number; }',
      'type Shape = ICircle | ISquare;',
      'const s: Shape = { kind: "circle", radius: 2 };',
    ].join('\n'),
  );

  const contract = variableContract(analysis, 's');
  const definitions = analysis.resolver.getDefinitions();
  const shape = definitions[contract.resolution.schema.name];
  assert.equal(shape.kind, 'union');
  const tags = shape.schemas.map((branch) => definitions[branch.name].properties.kind.schema.value).sort();
  assert.deepEqual(tags, ['circle', 'square']);
});

test('a finite template literal type resolves to the exact literal union it denotes', () => {
  const analysis = analyze(
    [
      'type EventName = `on${"Click" | "Hover"}`;',
      'interface IHandler { event: EventName; }',
      'const h: IHandler = { event: "onClick" };',
    ].join('\n'),
  );

  const contract = variableContract(analysis, 'h');
  const definitions = analysis.resolver.getDefinitions();
  const handler = definitions[contract.resolution.schema.name];
  const eventSchema = handler.properties.event.schema;
  assert.equal(eventSchema.kind, 'union');
  const values = eventSchema.schemas.map((literal) => literal.value).sort();
  assert.deepEqual(values, ['onClick', 'onHover']);
});

test('an infinite template literal type is represented as a regex-backed templateLiteral schema', () => {
  const analysis = analyze(
    ['type UserId = `user-${number}`;', 'interface IRef { id: UserId; }', 'const r: IRef = { id: "user-1" };'].join(
      '\n',
    ),
  );

  const contract = variableContract(analysis, 'r');
  assert.notEqual(contract.resolution.status, 'unsupported');
  const definitions = analysis.resolver.getDefinitions();
  const reference = definitions[contract.resolution.schema.name];
  assert.deepEqual(reference.properties.id.schema, { kind: 'templateLiteral', pattern: '^user--?\\d+(?:\\.\\d+)?$' });
});

test('keyof resolves to the exact union of property-name literals', () => {
  const analysis = analyze(
    ['interface IUser { id: number; name: string; }', 'const k: keyof IUser = "id";'].join('\n'),
  );

  const contract = variableContract(analysis, 'k');
  assert.equal(contract.resolution.status, 'protected');
  assert.equal(contract.resolution.schema.kind, 'union');
  const values = contract.resolution.schema.schemas.map((literal) => literal.value).sort();
  assert.deepEqual(values, ['id', 'name']);
});

test('an indexed access type resolves to the concrete member type it denotes', () => {
  const analysis = analyze(
    [
      'interface IUser { id: number; name: string; }',
      'type NameType = IUser["name"];',
      'const n: NameType = "a";',
    ].join('\n'),
  );

  const contract = variableContract(analysis, 'n');
  assert.equal(contract.resolution.status, 'protected');
  assert.deepEqual(contract.resolution.schema, { kind: 'primitive', name: 'string' });
});

test('a self-referential generic type resolves through a ref instead of unfolding forever', () => {
  const analysis = analyze(
    ['interface INode<T> { value: T; next?: INode<T>; }', 'const n: INode<number> = { value: 1, next: { value: 2 } };'].join(
      '\n',
    ),
  );

  const contract = variableContract(analysis, 'n');
  assert.equal(contract.resolution.schema.kind, 'ref');
  const definitions = analysis.resolver.getDefinitions();
  const node = definitions[contract.resolution.schema.name];
  assert.equal(node.properties.next.optional, true);
  const nextUnion = node.properties.next.schema;
  assert.equal(nextUnion.kind, 'union');
  const selfRef = nextUnion.schemas.find((branch) => branch.kind === 'ref');
  assert.equal(selfRef.name, contract.resolution.schema.name);
});

test('an array of a generic union resolves its item schema instead of degrading to unknown', () => {
  const analysis = analyze(
    [
      'interface IValor<T> { valor: T; }',
      'interface IValorDesc<T> { valor: T; desc: string; }',
      'type V<T> = IValor<T> | IValorDesc<T>;',
      'const list: V<number>[] = [{ valor: 1 }, { valor: 2, desc: "d" }];',
    ].join('\n'),
  );

  const contract = variableContract(analysis, 'list');
  assert.equal(contract.resolution.schema.kind, 'ref');
  const definitions = analysis.resolver.getDefinitions();
  const arraySchema = definitions[contract.resolution.schema.name];
  assert.equal(arraySchema.kind, 'array');
  assert.equal(arraySchema.items.kind, 'ref');
  const union = definitions[arraySchema.items.name];
  assert.equal(union.kind, 'union');
  assert.equal(union.schemas.length, 2);
});

test('an intersection of two generic interfaces merges both sets of properties', () => {
  const analysis = analyze(
    [
      'interface IA<T> { a: T; }',
      'interface IB<T> { b: T; }',
      'const x: IA<number> & IB<string> = { a: 1, b: "s" };',
    ].join('\n'),
  );

  const contract = variableContract(analysis, 'x');
  assert.equal(contract.resolution.schema.kind, 'intersection');
  assert.equal(contract.resolution.schema.schemas.length, 2);
});
