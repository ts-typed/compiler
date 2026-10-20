'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { StrictTypeError } = require('../../dist/runtime');
const { createBatchProtectedDtoFactory } = require('./batch-protected-dto-spike.cjs');

const numberSchema = { kind: 'primitive', name: 'number' };
const stringSchema = { kind: 'primitive', name: 'string' };
const userSchema = {
  kind: 'object',
  properties: {
    id: { schema: numberSchema },
    name: { schema: stringSchema },
    email: { schema: stringSchema },
  },
};
const context = { contractKind: 'return', operation: 'return', propertyPath: 'UserService.list' };

test('materializes a batch into independently protected DTOs', () => {
  const factory = createBatchProtectedDtoFactory(userSchema, context);
  const source = [{ id: 1, name: 'Ada', email: 'ada@example.com' }];

  const [result] = factory.materializeMany(source);

  assert.notStrictEqual(result, source[0]);
  assert.equal(result.email, 'ada@example.com');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), source[0]);
});

test('rejects an invalid field mutation without replacing the stored value', () => {
  const factory = createBatchProtectedDtoFactory(userSchema, context);
  const [result] = factory.materializeMany([{ id: 1, name: 'Ada', email: 'ada@example.com' }]);

  assert.throws(
    () => {
      result.email = 123;
    },
    StrictTypeError,
  );
  assert.equal(result.email, 'ada@example.com');
});

test('does not let an alias to the source object bypass the protected DTO', () => {
  const factory = createBatchProtectedDtoFactory(userSchema, context);
  const source = { id: 1, name: 'Ada', email: 'ada@example.com' };
  const [result] = factory.materializeMany([source]);

  source.email = 'other@example.com';

  assert.equal(result.email, 'ada@example.com');
});

test('rejects an invalid DTO before it is materialized', () => {
  const factory = createBatchProtectedDtoFactory(userSchema, context);

  assert.throws(
    () => factory.materializeMany([{ id: '1', name: 'Ada', email: 'ada@example.com' }]),
    StrictTypeError,
  );
});
