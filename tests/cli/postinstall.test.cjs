'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { isEligibleConsumer } = require('../../scripts/postinstall.cjs');

test('postinstall only initializes a consumer that explicitly depends on the compiler', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-postinstall-'));
  const packageRoot = join(projectRoot, 'node_modules', '@ts-typed', 'compiler');
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ devDependencies: { '@ts-typed/compiler': '^0.0.1' } }),
  );

  assert.equal(isEligibleConsumer(projectRoot, packageRoot), true);
  assert.equal(isEligibleConsumer(packageRoot, packageRoot), false);
});
