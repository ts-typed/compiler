'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { assertValue, assertValueCollecting, StrictTypeError } = require('../../dist/runtime');

const stringSchema = { kind: 'primitive', name: 'string' };
const numberSchema = { kind: 'primitive', name: 'number' };

const context = {
  contractKind: 'parameter',
  operation: 'argument',
  propertyPath: 'CreateUserDto',
};

test('assertValueCollecting returns every violation in a flat object instead of stopping at the first', () => {
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  const violations = assertValueCollecting(schema, { name: 42, age: 'old' }, context);

  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => v.propertyPath).sort(),
    ['CreateUserDto.age', 'CreateUserDto.name'],
  );
  assert.ok(violations.every((v) => v.code === 'TYPE_MISMATCH'));
});

test('assertValueCollecting returns an empty array for a fully valid value', () => {
  const schema = { kind: 'object', properties: { name: { schema: stringSchema } } };
  assert.deepEqual(assertValueCollecting(schema, { name: 'Ada' }, context), []);
});

test('assertValueCollecting walks nested objects to full depth, collecting violations at every level', () => {
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      profile: {
        schema: {
          kind: 'object',
          properties: {
            bio: { schema: stringSchema },
            age: { schema: numberSchema },
          },
        },
      },
    },
  };
  const violations = assertValueCollecting(
    schema,
    { name: 42, profile: { bio: 7, age: 'old' } },
    context,
  );

  assert.equal(violations.length, 3);
  assert.deepEqual(
    violations.map((v) => v.propertyPath).sort(),
    ['CreateUserDto.name', 'CreateUserDto.profile.age', 'CreateUserDto.profile.bio'],
  );
});

test('assertValueCollecting walks every object in an array of objects', () => {
  const schema = {
    kind: 'array',
    items: { kind: 'object', properties: { name: { schema: stringSchema } } },
  };
  const violations = assertValueCollecting(schema, [{ name: 'Ada' }, { name: 1 }, { name: 2 }], context);

  assert.deepEqual(
    violations.map((v) => v.propertyPath),
    ['CreateUserDto[1].name', 'CreateUserDto[2].name'],
  );
});

test('assertValueCollecting mixes REQUIRED_PROPERTY and EXTRA_PROPERTY with TYPE_MISMATCH in one pass', () => {
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  const violations = assertValueCollecting(schema, { age: 'old', extra: true }, context);

  assert.deepEqual(violations.map((v) => v.code).sort(), ['EXTRA_PROPERTY', 'REQUIRED_PROPERTY', 'TYPE_MISMATCH']);
});

test('assertValueCollecting does not leak a union field candidate probing into the collected list', () => {
  const schema = {
    kind: 'object',
    properties: { value: { schema: { kind: 'union', schemas: [stringSchema, numberSchema] } } },
  };
  const violations = assertValueCollecting(schema, { value: true }, context);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].expected, 'union');
});

test('assertValue (non-collecting) still throws on the very first violation, unchanged', () => {
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  assert.throws(
    () => assertValue(schema, { name: 42, age: 'old' }, context),
    (error) => error instanceof StrictTypeError && error.propertyPath === 'CreateUserDto.name',
  );
});
