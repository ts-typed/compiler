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

function emit(source) {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-opt-immut-'));
  const sourceRoot = join(root, 'src');
  const declarations = join(root, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarations, { recursive: true });
  writeFileSync(
    join(declarations, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {}',
      'declare const ttOptImmutBrand: unique symbol;',
      'type DeepReadonly<T> = T extends readonly unknown[] ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;',
      'export type TTOptImmut<T> = DeepReadonly<T> & { readonly [ttOptImmutBrand]?: never };',
    ].join('\n'),
  );
  writeFileSync(join(sourceRoot, 'globals.d.ts'), 'declare const process: { stdout: { write(chunk: string): boolean } };\n');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS', moduleResolution: 'Node', rootDir: './src', outDir: './out', skipLibCheck: true },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(join(sourceRoot, 'main.ts'), source);
  const analysis = analyzeProject({ tsconfigPath: join(root, 'tsconfig.json') });
  assert.equal(analysis.tsDiagnostics.length, 0, analysis.tsDiagnostics.map((item) => item.messageText).join('\n'));
  const diagnostics = [];
  const emitted = analysis.program.emit(undefined, undefined, undefined, false, {
    before: [createContractTransformer({ analysis, runtimeModule, onDiagnostic: (item) => diagnostics.push(item) })],
  });
  assert.equal(emitted.emitSkipped, false);
  return { root, diagnostics, analysisDiagnostics: analysis.diagnostics };
}

test('TTOptImmut selects validate-then-freeze for an immutable DTO batch', () => {
  const project = emit([
    "import type { TTOptImmut } from 'ts-typed';",
    'interface IUserData { id: number; name: string; tags: string[]; }',
    'type Users = TTOptImmut<IUserData[]>;',
    'function list(): Users {',
    '  return [{ id: 1, name: "Ada", tags: ["admin"] }];',
    '}',
    'function receivesOne(user: TTOptImmut<IUserData>): boolean { return Object.isFrozen(user) && Object.isFrozen(user.tags); }',
    'const users = list();',
    'const dto = users[0];',
    'const parameterWasFrozen = receivesOne({ id: 2, name: "Grace", tags: ["staff"] });',
    'if (false) {',
    '  // @ts-expect-error TTOptImmut makes the list and its DTO fields readonly in TypeScript.',
    '  dto.name = "Grace";',
    '  // @ts-expect-error TTOptImmut<IUserData[]> makes the outer batch readonly too.',
    '  users.push({ id: 2, name: "Grace", tags: [] });',
    '}',
    'process.stdout.write(JSON.stringify({',
    '  root: Object.isFrozen(users), item: Object.isFrozen(dto), tags: Object.isFrozen(dto.tags),',
    '  parameterWasFrozen,',
    '  keys: Object.keys(dto), spread: { ...dto }, clone: structuredClone(dto),',
    '}));',
  ].join('\n'));
  const result = spawnSync(process.execPath, [join(project.root, 'out', 'main.js')], { cwd: project.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    root: true,
    item: true,
    tags: true,
    parameterWasFrozen: true,
    keys: ['id', 'name', 'tags'],
    spread: { id: 1, name: 'Ada', tags: ['admin'] },
    clone: { id: 1, name: 'Ada', tags: ['admin'] },
  });
});

test('TTOptImmut reports classes as unsupported instead of silently falling back to mutable guards', () => {
  const project = emit([
    "import type { TTOptImmut } from 'ts-typed';",
    'class UserEntity { id = 1; name = "Ada"; }',
    'const user: TTOptImmut<UserEntity> = { id: 1, name: "Ada" };',
    'void user;',
  ].join('\n'));

  const diagnostic = project.analysisDiagnostics.find((item) => item.code === 'TT_UNSUPPORTED_TYPE');
  assert.equal(diagnostic?.status, 'unsupported');
  assert.match(diagnostic?.message ?? '', /class instances require normal typed protection/);
});
