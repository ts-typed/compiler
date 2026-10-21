'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SchemaMetadataCache } = require('../../dist/runtime/schema-metadata-cache.class');

test('compiles one object protection installer per schema and prototype', () => {
  const cache = new SchemaMetadataCache();
  const schema = {
    kind: 'object',
    properties: { name: { schema: { kind: 'primitive', name: 'string' } } },
  };
  const first = { name: 'Ada' };
  const second = { name: 'Grace' };

  const firstInstaller = cache.getObjectProtectionInstaller(schema, first);
  const secondInstaller = cache.getObjectProtectionInstaller(schema, second);

  assert.strictEqual(firstInstaller, secondInstaller);
  assert.equal(firstInstaller.properties.length, 1);
  assert.equal(firstInstaller.properties[0].key, 'name');
});
