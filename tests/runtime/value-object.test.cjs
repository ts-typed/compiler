'use strict';

const assert = require('node:assert/strict');
const { inspect } = require('node:util');
const test = require('node:test');

const { ValueObject, StrictTypeError } = require('../../dist/runtime');

// Minimal concrete subclass: a 4-character code.
class TestCode extends ValueObject {
  constructor(raw, context) {
    super(raw, context);
  }

  isValid(raw) {
    return raw.length === 4;
  }

  masked() {
    return '*'.repeat(this.length - 1) + this.slice(-1);
  }
}

test('a valid raw value constructs and behaves as its string in templates, concatenation and toString', () => {
  const instance = new TestCode('1234');

  assert.equal(`value: ${instance}`, 'value: 1234');
  assert.equal('value: ' + instance, 'value: 1234');
  assert.equal(instance.toString(), '1234');
  assert.equal(String(instance), '1234');
  assert.equal(instance.masked(), '***4');
});

test('an invalid raw value throws StrictTypeError with TYPE_MISMATCH', () => {
  assert.throws(
    () => new TestCode('12345'),
    (error) =>
      error instanceof StrictTypeError &&
      error.code === 'TYPE_MISMATCH' &&
      error.expected === 'TestCode' &&
      error.received === 'string',
  );
});

test('a valid instance inherits native String.prototype methods', () => {
  const instance = new TestCode('ab12');

  assert.equal(instance.toUpperCase(), 'AB12');
  assert.equal(instance.includes('b1'), true);
  assert.equal(instance.startsWith('ab'), true);
  assert.equal(instance.trim(), 'ab12');
});

test('JSON.stringify emits the raw string, not an object shape', () => {
  const instance = new TestCode('1234');

  assert.equal(JSON.stringify(instance), '"1234"');
  assert.equal(JSON.stringify({ code: instance }), '{"code":"1234"}');
  assert.equal(JSON.stringify([instance]), '["1234"]');
});

test('util.inspect shows the bare raw value instead of the boxed [String: ...] form', () => {
  const instance = new TestCode('1234');

  // Without the util.inspect.custom hook Node would print "[String: '1234']".
  assert.equal(inspect(instance), '1234');
  assert.notEqual(inspect(instance), "[String: '1234']");
});

test('context passed to the constructor is copied onto the thrown StrictTypeError', () => {
  assert.throws(
    () =>
      new TestCode('bad!!', {
        propertyPath: 'user.code',
        contractKind: 'parameter',
        operation: 'argument',
        className: 'Checkout',
      }),
    (error) =>
      error instanceof StrictTypeError &&
      error.propertyPath === 'user.code' &&
      error.contractKind === 'parameter' &&
      error.operation === 'argument' &&
      error.className === 'Checkout',
  );
});

test('omitting the context still produces a sensible default StrictTypeError', () => {
  assert.throws(
    () => new TestCode('x'),
    (error) =>
      error instanceof StrictTypeError &&
      error.propertyPath === 'TestCode' &&
      error.contractKind === 'construction' &&
      error.operation === 'initialize' &&
      error.className === undefined,
  );
});

test('typeof a value object instance is "object", not "string" (intentional JS limitation)', () => {
  // A primitive cannot carry extra methods, so value objects must be boxed objects.
  const instance = new TestCode('1234');

  assert.equal(typeof instance, 'object');
  assert.equal(instance instanceof String, true);
});
