'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { analyzeProject } = require('../../../dist/compiler/analysis');
const { createContractTransformer } = require('../../../dist/compiler/transform');

// The package root, linked into each fixture as `@ts-typed/core` so the
// emitted runtime import resolves exactly as it would in a consumer project.
const packageRoot = resolve(__dirname, '../../..');

function writeProject({ module, moduleResolution, files, packageType }) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-esm-output-'));
  const sourceRoot = join(projectRoot, 'src');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(join(projectRoot, 'node_modules', '@ts-typed'), { recursive: true });
  symlinkSync(packageRoot, join(projectRoot, 'node_modules', '@ts-typed', 'core'), 'dir');
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module,
        moduleResolution,
        rootDir: './src',
        outDir: './out',
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  if (packageType !== undefined) {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ type: packageType }));
  }
  for (const [relativePath, source] of Object.entries(files)) {
    writeFileSync(join(sourceRoot, relativePath), source);
  }
  return { projectRoot, outputRoot: join(projectRoot, 'out') };
}

function emitProject(project) {
  const analysis = analyzeProject({ tsconfigPath: join(project.projectRoot, 'tsconfig.json') });
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
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ],
  });
  assert.equal(emitResult.emitSkipped, false);
  assert.deepEqual(diagnostics, []);
  return project;
}

function runEntry(project, relativePath = 'main.js') {
  return spawnSync(process.execPath, [join(project.outputRoot, relativePath)], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
}

test('ESNext output injects a real import for the runtime and still validates contracts', () => {
  const project = emitProject(
    writeProject({
      module: 'ESNext',
      moduleResolution: 'Bundler',
      packageType: 'module',
      files: {
        'main.ts': [
          "import { StrictTypeError } from '@ts-typed/core';",
          'export interface IUser { name: string; age: number; }',
          'const failures: string[] = [];',
          'function expectTypeError(name: string, action: () => void): void {',
          '  try { action(); } catch (error) {',
          '    if (error instanceof StrictTypeError) { failures.push(name); return; }',
          '    throw error;',
          '  }',
          '  throw new Error(`missing error: ${name}`);',
          '}',
          'let user: IUser = { name: "Ada", age: 36 };',
          'expectTypeError("write", () => { user = { name: "Ada", age: "bad" } as any; });',
          'if (user.age !== 36) throw new Error("failed assignment changed the variable");',
          'function parameter(value: IUser): string { return value.name; }',
          'expectTypeError("parameter", () => parameter({ name: "Ada" } as any));',
          'const valid: IUser = { name: "Grace", age: 85 };',
          'console.log(JSON.stringify({ failures, valid }));',
        ].join('\n'),
      },
    }),
  );

  const emitted = readFileSync(join(project.outputRoot, 'main.js'), 'utf8');
  assert.match(emitted, /^import \* as __tsTypedRuntime\w* from ['"]@ts-typed\/core['"];?$/m);
  assert.doesNotMatch(emitted, /\brequire\(/);

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /require is not defined/);
  assert.deepEqual(JSON.parse(result.stdout), {
    failures: ['write', 'parameter'],
    valid: { name: 'Grace', age: 85 },
  });
});

test('CommonJS output keeps the require-based runtime binding for script files', () => {
  const project = emitProject(
    writeProject({
      module: 'CommonJS',
      moduleResolution: 'Node',
      files: {
        // A script (no import/export) is the case the require binding protects.
        'main.ts': [
          'interface IUser { name: string; age: number; }',
          'let user: IUser = { name: "Ada", age: 36 };',
          'let failed = false;',
          'try { user = { name: "Ada", age: "bad" } as any; } catch (error) {',
          '  failed = error instanceof Error && error.name === "StrictTypeError";',
          '}',
          'console.log(JSON.stringify({ failed, age: user.age }));',
        ].join('\n'),
      },
    }),
  );

  const emitted = readFileSync(join(project.outputRoot, 'main.js'), 'utf8');
  assert.match(emitted, /const __tsTypedRuntime\w* = require\(["']@ts-typed\/core["']\);/);
  assert.doesNotMatch(emitted, /^import \* as /m);

  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { failed: true, age: 36 });
});
