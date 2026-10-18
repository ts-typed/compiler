'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ValueObject, StrictTypeError, protectValue, installFieldGuard } = require('../../dist/runtime');

// Throwaway concrete ValueObject: a 4-character code. Counts isValid calls so
// tests can prove whether construction (and therefore validation) happened.
let isValidCalls = 0;

class TestCode extends ValueObject {
  constructor(raw, context) {
    super(raw, context);
  }

  isValid(raw) {
    isValidCalls += 1;
    return raw.length === 4;
  }
}

class OtherCode extends ValueObject {
  constructor(raw, context) {
    super(raw, context);
  }

  isValid(raw) {
    return raw.length === 2;
  }
}

const valueObjectSchema = {
  kind: 'object',
  properties: {},
  valueObjectCtor: TestCode,
};

const plainObjectSchema = {
  kind: 'object',
  properties: {
    name: { schema: { kind: 'primitive', name: 'string' } },
  },
};

function context(overrides = {}) {
  return {
    contractKind: 'parameter',
    operation: 'argument',
    propertyPath: 'createUser.code',
    ...overrides,
  };
}

// --- protectValue ----------------------------------------------------------

test('protectValue constructs an instance from a valid raw string', () => {
  const result = protectValue(valueObjectSchema, 'abcd', context());

  assert.ok(result instanceof TestCode);
  assert.equal(String(result), 'abcd');
  assert.equal(result.toString(), 'abcd');
});

test('protectValue rejects an invalid raw string with the constructor StrictTypeError', () => {
  assert.throws(
    () => protectValue(valueObjectSchema, 'abcde', context()),
    (error) =>
      error instanceof StrictTypeError &&
      error.code === 'TYPE_MISMATCH' &&
      error.expected === 'TestCode' &&
      error.received === 'string',
  );
});

test('protectValue returns an already-constructed instance unchanged, without re-validating it', () => {
  const instance = new TestCode('abcd');
  const callsBefore = isValidCalls;

  const result = protectValue(valueObjectSchema, instance, context());

  assert.strictEqual(result, instance);
  assert.equal(isValidCalls, callsBefore);
});

test('protectValue maps the AssertionContext onto the thrown error fields', () => {
  assert.throws(
    () =>
      protectValue(
        valueObjectSchema,
        'bad',
        context({
          contractKind: 'property',
          operation: 'set',
          propertyPath: 'CreateUserDto.cpf',
          className: 'CreateUserDto',
        }),
      ),
    (error) =>
      error instanceof StrictTypeError &&
      error.propertyPath === 'CreateUserDto.cpf' &&
      error.contractKind === 'property' &&
      error.operation === 'set' &&
      error.className === 'CreateUserDto',
  );
});

test('protectValue rejects a non-string value that is not an instance', () => {
  assert.throws(
    () => protectValue(valueObjectSchema, 1234, context()),
    (error) => error instanceof StrictTypeError && error.code === 'TYPE_MISMATCH' && error.expected === 'TestCode',
  );
});

test('protectValue rejects an instance of a different ValueObject class', () => {
  assert.throws(
    () => protectValue(valueObjectSchema, new OtherCode('ab'), context()),
    (error) => error instanceof StrictTypeError && error.expected === 'TestCode',
  );
});

test('a schema without valueObjectCtor keeps the ordinary object behavior in protectValue', () => {
  const value = { name: 'Ada' };
  assert.strictEqual(protectValue(plainObjectSchema, value, context()), value);

  assert.throws(
    () => protectValue(plainObjectSchema, 'abcd', context()),
    (error) => error instanceof StrictTypeError && error.code === 'TYPE_MISMATCH' && error.expected === 'object',
  );
  assert.throws(
    () => protectValue(plainObjectSchema, { name: 42 }, context()),
    (error) => error instanceof StrictTypeError && error.propertyPath === 'createUser.code.name',
  );
});

// --- class-field setter (installFieldGuard) --------------------------------

test('writing a raw string to a guarded ValueObject field stores and reads back an instance', () => {
  const dto = {};
  installFieldGuard(dto, 'cpf', valueObjectSchema, context({ contractKind: 'property', operation: 'initialize', propertyPath: 'CreateUserDto.cpf', className: 'CreateUserDto' }), {
    initialized: false,
  });

  dto.cpf = 'abcd';

  assert.ok(dto.cpf instanceof TestCode);
  assert.equal(String(dto.cpf), 'abcd');
});

test('writing an already-constructed instance to a guarded field keeps the same instance', () => {
  const dto = {};
  installFieldGuard(dto, 'cpf', valueObjectSchema, context({ contractKind: 'property', operation: 'initialize', propertyPath: 'CreateUserDto.cpf' }), {
    initialized: false,
  });
  const instance = new TestCode('wxyz');

  dto.cpf = instance;

  assert.strictEqual(dto.cpf, instance);
});

test('writing an invalid raw string to a guarded ValueObject field throws and keeps the previous value', () => {
  const dto = {};
  installFieldGuard(dto, 'cpf', valueObjectSchema, context({ contractKind: 'property', operation: 'initialize', propertyPath: 'CreateUserDto.cpf', className: 'CreateUserDto' }), {
    initialized: false,
  });
  dto.cpf = 'abcd';
  const previous = dto.cpf;

  assert.throws(
    () => {
      dto.cpf = 'abcde';
    },
    (error) =>
      error instanceof StrictTypeError &&
      error.expected === 'TestCode' &&
      error.propertyPath === 'CreateUserDto.cpf' &&
      error.operation === 'set' &&
      error.className === 'CreateUserDto',
  );
  assert.strictEqual(dto.cpf, previous);
});

test('an already-initialized raw string on a ValueObject field is converted when the guard is installed', () => {
  const dto = { cpf: 'abcd' };
  installFieldGuard(dto, 'cpf', valueObjectSchema, context({ propertyPath: 'CreateUserDto.cpf' }), {
    initialized: true,
  });

  assert.ok(dto.cpf instanceof TestCode);
  assert.equal(String(dto.cpf), 'abcd');
});

test('a plain object field with no valueObjectCtor still rejects a raw string on write', () => {
  const holder = {};
  installFieldGuard(holder, 'profile', plainObjectSchema, context({ propertyPath: 'Holder.profile' }), {
    initialized: false,
  });

  assert.throws(
    () => {
      holder.profile = 'abcd';
    },
    (error) => error instanceof StrictTypeError && error.code === 'TYPE_MISMATCH',
  );

  const profile = { name: 'Ada' };
  holder.profile = profile;
  assert.strictEqual(holder.profile, profile);
});
