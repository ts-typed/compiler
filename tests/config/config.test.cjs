const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ConfigError,
  DEFAULT_CONFIG,
  initializeProject,
  loadConfig,
} = require('../../dist/config');

test('exports the configuration API through the package subpath', () => {
  const packageConfig = require('@ts-typed/compiler/config');

  assert.strictEqual(packageConfig.ConfigError, ConfigError);
  assert.strictEqual(packageConfig.DEFAULT_CONFIG, DEFAULT_CONFIG);
  assert.strictEqual(packageConfig.initializeProject, initializeProject);
  assert.strictEqual(packageConfig.loadConfig, loadConfig);
});

const createTemporaryDirectory = (t, prefix = 'ts-typed-config-') => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

const writeJson = (directory, name, value) => {
  const file = path.join(directory, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};

test('merges defaults, inherited configuration, project configuration and overrides in order', async (t) => {
  const directory = createTemporaryDirectory(t);
  writeJson(directory, 'shared/base.json', {
    ncc: { externals: ['base'], minify: true },
    compiler: { onUnsupported: 'error' },
  });
  const projectFile = writeJson(directory, 'project/typets.config.json', {
    extends: '../shared/base.json',
    ncc: { externals: ['project'] },
    diagnostics: { format: 'json' },
  });

  const config = await loadConfig(projectFile, {
    ncc: { cache: true, externals: ['override'] },
  });

  assert.deepEqual(config.ncc.externals, ['override']);
  assert.equal(config.ncc.minify, true);
  assert.equal(config.ncc.cache, true);
  assert.equal(config.diagnostics.format, 'json');
  assert.equal(config.compiler.onUnsupported, 'error');
});

test('uses warn as the compiler unsupported contract default and accepts error overrides', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {});

  const defaults = await loadConfig(projectFile);
  const overridden = await loadConfig(projectFile, { compiler: { onUnsupported: 'error' } });

  assert.equal(defaults.compiler.onUnsupported, 'warn');
  assert.equal(overridden.compiler.onUnsupported, 'error');
});

test('rejects invalid compiler unsupported warning policies', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {
    compiler: { onUnsupported: 'ignore' },
  });

  await assert.rejects(() => loadConfig(projectFile), /compiler\.onUnsupported must be warn or error/);
});

test('uses false as the compiler strictClass default (structural) and accepts a true override', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {});

  const defaults = await loadConfig(projectFile);
  const overridden = await loadConfig(projectFile, { compiler: { strictClass: true } });

  assert.equal(defaults.compiler.strictClass, false);
  assert.equal(overridden.compiler.strictClass, true);
});

test('rejects a non-boolean compiler strictClass value', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {
    compiler: { strictClass: 'always' },
  });

  await assert.rejects(() => loadConfig(projectFile), /compiler\.strictClass must be boolean/);
});

test('enforcePrivate and enforceReadonly default to true and accept false overrides independently', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {});

  const defaults = await loadConfig(projectFile);
  assert.equal(defaults.compiler.enforcePrivate, true);
  assert.equal(defaults.compiler.enforceReadonly, true);

  const overridden = await loadConfig(projectFile, {
    compiler: { enforcePrivate: false, enforceReadonly: false },
  });
  assert.equal(overridden.compiler.enforcePrivate, false);
  assert.equal(overridden.compiler.enforceReadonly, false);
});

test('rejects non-boolean compiler enforcePrivate and enforceReadonly values', async (t) => {
  const directory = createTemporaryDirectory(t);
  const privateFile = writeJson(directory, 'private.json', { compiler: { enforcePrivate: 'yes' } });
  const readonlyFile = writeJson(directory, 'readonly.json', { compiler: { enforceReadonly: 'yes' } });

  await assert.rejects(() => loadConfig(privateFile), /compiler\.enforcePrivate must be boolean/);
  await assert.rejects(() => loadConfig(readonlyFile), /compiler\.enforceReadonly must be boolean/);
});

test('resolves inherited paths and relative integration modules from their declaring file', async (t) => {
  const directory = createTemporaryDirectory(t);
  const realDirectory = fs.realpathSync(directory);
  writeJson(directory, 'shared/base.json', {
    integration: './adapter.cjs',
    entry: 'src/base.ts',
    tsconfig: 'tsconfig.base.json',
    outDir: 'build',
    assets: [{ from: 'assets/**/*', to: 'public' }],
    diagnostics: { reportFile: 'reports/build.json' },
  });
  const projectFile = writeJson(directory, 'project/typets.config.json', {
    extends: '../shared/base.json',
  });

  const config = await loadConfig(projectFile);

  assert.equal(config.integration, path.join(realDirectory, 'shared/adapter.cjs'));
  assert.equal(config.entry, path.join(realDirectory, 'shared/src/base.ts'));
  assert.equal(config.tsconfig, path.join(realDirectory, 'shared/tsconfig.base.json'));
  assert.equal(config.outDir, path.join(realDirectory, 'shared/build'));
  assert.equal(config.assets[0].from, path.join(realDirectory, 'shared/assets/**/*'));
  assert.equal(config.assets[0].to, 'public');
  assert.equal(
    config.diagnostics.reportFile,
    path.join(realDirectory, 'shared/reports/build.json'),
  );
});

test('resolves override paths from the loaded project configuration directory', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'project/typets.config.json', {});

  const config = await loadConfig(projectFile, {
    integration: './override-adapter.cjs',
    entry: 'override/main.ts',
    tsconfig: 'override/tsconfig.json',
    outDir: 'override/dist',
    assets: [{ from: 'override/assets', to: 'public' }],
    diagnostics: { reportFile: 'override/report.json' },
  });

  assert.equal(config.integration, path.join(directory, 'project/override-adapter.cjs'));
  assert.equal(config.entry, path.join(directory, 'project/override/main.ts'));
  assert.equal(config.tsconfig, path.join(directory, 'project/override/tsconfig.json'));
  assert.equal(config.outDir, path.join(directory, 'project/override/dist'));
  assert.equal(config.assets[0].from, path.join(directory, 'project/override/assets'));
  assert.equal(config.assets[0].to, 'public');
  assert.equal(config.diagnostics.reportFile, path.join(directory, 'project/override/report.json'));
});

test('keeps schema URIs and package integration specifiers unchanged', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {
    $schema: './node_modules/@ts-typed/compiler/schema.json',
    integration: '@scope/ts-typed-adapter',
  });

  const config = await loadConfig(projectFile);

  assert.equal(config.$schema, './node_modules/@ts-typed/compiler/schema.json');
  assert.equal(config.integration, '@scope/ts-typed-adapter');
});

test('keeps asset destinations relative to outDir and accepts ordinary names beginning with dots', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {
    assets: [{ from: 'assets', to: '..public' }],
  });

  const config = await loadConfig(projectFile);

  assert.equal(config.assets[0].to, '..public');
});

test('rejects asset destinations that are absolute or escape outDir', async (t) => {
  const directory = createTemporaryDirectory(t);
  const absoluteFile = writeJson(directory, 'absolute.json', {
    assets: [{ from: 'assets', to: path.join(directory, 'outside') }],
  });
  const escapeFile = writeJson(directory, 'escape.json', {
    assets: [{ from: 'assets', to: '../outside' }],
  });

  await assert.rejects(() => loadConfig(absoluteFile), /assets\.to must be relative to outDir/);
  await assert.rejects(() => loadConfig(escapeFile), /assets\.to escapes outDir/);
});

test('accepts partial nested configuration objects', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {
    compiler: {},
    ncc: {},
    diagnostics: {},
  });

  const config = await loadConfig(projectFile);

  assert.equal(config.compiler.sourceMap, true);
  assert.equal(config.ncc.sourceMap, true);
  assert.equal(config.diagnostics.format, 'pretty');
});

test('rejects unknown configuration keys even when runtime extra properties are allowed', async (t) => {
  const directory = createTemporaryDirectory(t);
  const cases = [
    ['root', { unknownOption: true }, /config\.unknownOption is unknown/],
    ['compiler', { compiler: { unknownOption: true } }, /config\.compiler\.unknownOption/],
    ['ncc', { ncc: { unknownOption: true } }, /config\.ncc\.unknownOption/],
    [
      'asset',
      { assets: [{ from: 'assets', to: 'public', unknownOption: true }] },
      /config\.assets\[0\]\.unknownOption/,
    ],
    [
      'diagnostics',
      { diagnostics: { unknownOption: true } },
      /config\.diagnostics\.unknownOption/,
    ],
  ];

  for (const [name, fragment, errorPattern] of cases) {
    const projectFile = writeJson(directory, `${name}.json`, {
      allowExtraPropertiesAll: true,
      ...fragment,
    });
    await assert.rejects(() => loadConfig(projectFile), errorPattern);
  }
});

test('rejects prototype-sensitive own keys in execution overrides', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {});
  const prototypeOverride = JSON.parse('{"__proto__":{"polluted":true}}');
  const constructorOverride = JSON.parse('{"constructor":{"polluted":true}}');

  await assert.rejects(
    () => loadConfig(projectFile, prototypeOverride),
    /config\.__proto__ is unknown/,
  );
  await assert.rejects(
    () => loadConfig(projectFile, constructorOverride),
    /config\.constructor is unknown/,
  );
  assert.equal({}.polluted, undefined);
});

test('rejects empty paths, module names and bundler targets', async (t) => {
  const directory = createTemporaryDirectory(t);
  const cases = [
    ['entry', { entry: '' }],
    ['integration', { integration: '' }],
    ['assets.from', { assets: [{ from: '', to: 'public' }] }],
    ['assets.to', { assets: [{ from: 'assets', to: '' }] }],
    ['ncc.target', { ncc: { target: '' } }],
    ['ncc.externals', { ncc: { externals: [''] } }],
    ['diagnostics.reportFile', { diagnostics: { reportFile: '' } }],
  ];

  for (const [label, fragment] of cases) {
    const file = writeJson(directory, `${label}.json`, fragment);
    await assert.rejects(() => loadConfig(file), new RegExp(label.replace('.', '\\.')));
  }
});

test('rejects bundle source maps when compiler source maps are disabled', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {
    compiler: { sourceMap: false },
    ncc: { sourceMap: true },
  });

  await assert.rejects(
    () => loadConfig(projectFile),
    /ncc\.sourceMap requires compiler\.sourceMap/,
  );
});

test('reports malformed JSON as a typed configuration error', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = path.join(directory, 'typets.config.json');
  fs.writeFileSync(projectFile, '{ invalid json');

  await assert.rejects(
    () => loadConfig(projectFile),
    (error) => error instanceof ConfigError && error.code === 'INVALID_CONFIG',
  );
});

test('detects extends cycles through symbolic links', async (t) => {
  const directory = createTemporaryDirectory(t);
  writeJson(directory, 'config.json', { extends: 'alias.json' });
  fs.symlinkSync('config.json', path.join(directory, 'alias.json'));

  await assert.rejects(() => loadConfig(path.join(directory, 'config.json')), /cycle/i);
});

test('schema keys and defaults match the documented generated configuration', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../schema.json'), 'utf8'),
  );
  const expectedDefaults = {
    $schema: './node_modules/@ts-typed/compiler/schema.json',
    integration: 'typescript',
    extends: null,
    entry: 'src/main.ts',
    tsconfig: 'tsconfig.json',
    outDir: 'dist',
    allowExtraPropertiesAll: false,
    compiler: {
      sourceMap: true,
      onUnsupported: 'warn',
      strictClass: false,
      enforcePrivate: true,
      enforceReadonly: true,
      enforceClosedInstances: false,
      enforceMutationGuards: false,
    },
    ncc: {
      enabled: true,
      minify: false,
      sourceMap: true,
      sourceMapRegister: false,
      target: 'es2020',
      externals: [],
      cache: false,
      license: null,
      quiet: false,
      debugLog: false,
    },
    assets: [],
    diagnostics: { format: 'pretty', coverage: 'summary', reportFile: null },
  };

  assert.deepEqual(DEFAULT_CONFIG, expectedDefaults);
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(expectedDefaults).sort());
  assert.deepEqual(
    Object.keys(schema.properties.ncc.properties).sort(),
    Object.keys(expectedDefaults.ncc).sort(),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.compiler.additionalProperties, false);
  assert.equal(schema.properties.ncc.additionalProperties, false);
  assert.equal(schema.properties.assets.items.additionalProperties, false);
  assert.equal(schema.properties.diagnostics.additionalProperties, false);

  for (const [key, value] of Object.entries(expectedDefaults)) {
    if (key === 'compiler' || key === 'ncc' || key === 'diagnostics') {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        assert.deepEqual(schema.properties[key].properties[nestedKey].default, nestedValue);
      }
      continue;
    }
    assert.deepEqual(schema.properties[key].default, value);
  }
});

test('schema constrains every path, module name and target to non-empty strings', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../schema.json'), 'utf8'),
  );

  assert.equal(schema.properties.$schema.minLength, 1);
  assert.equal(schema.properties.integration.minLength, 1);
  assert.equal(schema.properties.extends.anyOf[0].minLength, 1);
  assert.equal(schema.properties.entry.minLength, 1);
  assert.equal(schema.properties.tsconfig.minLength, 1);
  assert.equal(schema.properties.outDir.minLength, 1);
  assert.equal(schema.properties.ncc.properties.target.minLength, 1);
  assert.equal(schema.properties.ncc.properties.externals.items.minLength, 1);
  assert.equal(schema.properties.ncc.properties.license.anyOf[0].minLength, 1);
  assert.equal(schema.properties.assets.items.properties.from.minLength, 1);
  assert.equal(schema.properties.assets.items.properties.to.minLength, 1);
  assert.equal(schema.properties.diagnostics.properties.reportFile.anyOf[0].minLength, 1);
});

test('initializes once with an absolute root, explicit script suggestions and matching defaults', async (t) => {
  const directory = createTemporaryDirectory(t, 'ts-typed-init-');
  const realDirectory = fs.realpathSync(directory);
  fs.writeFileSync(path.join(directory, 'tsconfig.build.json'), '{}');
  const packageFile = path.join(directory, 'package.json');
  const packageContents = '{"scripts":{"build":"existing-command"}}\n';
  fs.writeFileSync(packageFile, packageContents);
  const relativeRoot = path.relative(process.cwd(), directory);

  const first = await initializeProject(relativeRoot);
  const before = fs.readFileSync(first.configPath, 'utf8');
  const second = await initializeProject(relativeRoot);
  const generated = JSON.parse(before);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(path.isAbsolute(first.configPath), true);
  assert.equal(first.config.tsconfig, path.join(realDirectory, 'tsconfig.build.json'));
  assert.equal(fs.readFileSync(first.configPath, 'utf8'), before);
  assert.equal(fs.readFileSync(packageFile, 'utf8'), packageContents);
  assert.deepEqual(generated, {
    ...DEFAULT_CONFIG,
    tsconfig: 'tsconfig.build.json',
  });
  assert.deepEqual(first.suggestedScripts, [
    'build: ts-typed build',
    'build:debug: ts-typed build --no-bundle --sourcemap',
    'start:prod: node dist/index.js',
  ]);
});

test('enforceClosedInstances defaults to false, accepts a true override, and rejects non-boolean values', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {});

  const defaults = await loadConfig(projectFile);
  assert.equal(defaults.compiler.enforceClosedInstances, false);

  const overridden = await loadConfig(projectFile, { compiler: { enforceClosedInstances: true } });
  assert.equal(overridden.compiler.enforceClosedInstances, true);

  const invalidFile = writeJson(directory, 'invalid.json', { compiler: { enforceClosedInstances: 'yes' } });
  await assert.rejects(() => loadConfig(invalidFile), /compiler\.enforceClosedInstances must be boolean/);
});

test('enforceMutationGuards defaults to false, accepts a true override, and rejects non-boolean values', async (t) => {
  const directory = createTemporaryDirectory(t);
  const projectFile = writeJson(directory, 'typets.config.json', {});

  const defaults = await loadConfig(projectFile);
  assert.equal(defaults.compiler.enforceMutationGuards, false);

  const overridden = await loadConfig(projectFile, { compiler: { enforceMutationGuards: true } });
  assert.equal(overridden.compiler.enforceMutationGuards, true);

  const invalidFile = writeJson(directory, 'invalid.json', { compiler: { enforceMutationGuards: 'yes' } });
  await assert.rejects(() => loadConfig(invalidFile), /compiler\.enforceMutationGuards must be boolean/);
});
