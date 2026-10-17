'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { installFieldGuard, lockReadonlyField, StrictTypeError } = require('../../dist/runtime');

const numberSchema = { kind: 'primitive', name: 'number' };

function context(overrides = {}) {
  return { contractKind: 'property', operation: 'initialize', propertyPath: 'value', ...overrides };
}

test('a readonly field accepts multiple writes before it is locked, matching writes allowed during construction', () => {
  const instance = {};
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: false, readonlyField: true });
  instance.value = 1;
  instance.value = 2;
  assert.equal(instance.value, 2);
});

test('lockReadonlyField makes every further write throw StrictTypeError with code READONLY_PROPERTY', () => {
  const instance = {};
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: false, readonlyField: true });
  instance.value = 1;
  lockReadonlyField(instance, 'value');

  assert.throws(() => {
    instance.value = 2;
  }, (error) => error instanceof StrictTypeError && error.code === 'READONLY_PROPERTY');
  assert.equal(instance.value, 1);
});

test('a readonly field initialized at install time locks immediately, treating the initializer as the only write', () => {
  const instance = { value: 1 };
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: true, readonlyField: true });
  lockReadonlyField(instance, 'value');

  assert.throws(() => {
    instance.value = 2;
  }, (error) => error instanceof StrictTypeError && error.code === 'READONLY_PROPERTY');
});

test('a non-readonly field is unaffected by lockReadonlyField being called on an unrelated key', () => {
  const instance = {};
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: false, readonlyField: false });
  instance.value = 1;
  lockReadonlyField(instance, 'other-key-never-installed');
  instance.value = 2;
  assert.equal(instance.value, 2);
});

test('type validation still runs normally before the readonly lock is applied', () => {
  const instance = {};
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: false, readonlyField: true });

  assert.throws(() => {
    instance.value = 'not-a-number';
  }, (error) => error instanceof StrictTypeError && error.code === 'TYPE_MISMATCH');
});
