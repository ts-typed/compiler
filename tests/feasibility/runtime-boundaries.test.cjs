'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

class ObservedStrictTypeError extends TypeError {
  constructor(message, code = 'INVALID_MUTATION') {
    super(message);
    this.name = 'StrictTypeError';
    this.code = code;
  }
}

function acceptsObjectThroughBoundary(value) {
  if (value === null || typeof value !== 'object') {
    throw new ObservedStrictTypeError('expected object');
  }
  // A real implementation would need a concrete schema here. This proof
  // intentionally rejects the alias when it cannot install protection on it.
  if (Object.isExtensible(value) === false) {
    throw new ObservedStrictTypeError(
      'cannot establish alias protection for a non-extensible object',
    );
  }
  return value;
}

test('a Proxy installed at a property cannot protect a pre-existing alias', () => {
  const source = { name: 'Patrick' };
  const writes = [];
  const wrapped = new Proxy(source, {
    set(target, property, value, receiver) {
      writes.push([property, value]);
      if (property === 'name' && typeof value !== 'string') {
        throw new ObservedStrictTypeError('name must be string');
      }
      return Reflect.set(target, property, value, receiver);
    },
  });

  const service = { profile: wrapped };
  assert.strictEqual(service.profile, wrapped);
  assert.notStrictEqual(service.profile, source, 'wrapping changes observable identity');

  source.name = 123;
  assert.equal(source.name, 123);
  assert.equal(service.profile.name, 123);
  assert.deepEqual(writes, [], 'the old alias bypasses the property Proxy');
});

test('an accessor installed at object origin protects aliases while preserving identity', () => {
  let current = 'Patrick';
  const source = {};
  Object.defineProperty(source, 'name', {
    configurable: false,
    enumerable: true,
    get: () => current,
    set: (value) => {
      if (typeof value !== 'string') {
        throw new ObservedStrictTypeError('name must be string');
      }
      current = value;
    },
  });
  const alias = source;

  alias.name = 'Ana';
  assert.equal(source.name, 'Ana');
  assert.strictEqual(alias, source);
  assert.throws(() => {
    source.name = 123;
  }, ObservedStrictTypeError);
});

test('a canonical managed Proxy can be shared, while unmanaged provenance is rejected', () => {
  const managed = new WeakSet();
  const backing = { name: 'Patrick' };
  const canonical = new Proxy(backing, {
    set(target, property, value, receiver) {
      if (property === 'name' && typeof value !== 'string') {
        throw new ObservedStrictTypeError('name must be string');
      }
      return Reflect.set(target, property, value, receiver);
    },
  });
  managed.add(canonical);
  const serviceAlias = canonical;
  const publicAlias = canonical;

  assert.strictEqual(serviceAlias, publicAlias);
  assert.notStrictEqual(serviceAlias, backing);
  assert.throws(() => {
    publicAlias.name = 123;
  }, ObservedStrictTypeError);

  const external = { name: 'outside' };
  assert.equal(managed.has(external), false);
  assert.throws(
    () => {
      if (!managed.has(external)) {
        throw new ObservedStrictTypeError('unmanaged alias rejected', 'INVALID_MUTATION');
      }
    },
    (error) => error.code === 'INVALID_MUTATION',
  );
});

test('Proxy identity is not interchangeable with the original object', () => {
  const original = { value: 1 };
  const proxy = new Proxy(original, {});
  class Profile {}
  const instance = new Profile();
  const instanceProxy = new Proxy(instance, {});

  assert.notStrictEqual(proxy, original);
  assert.equal(proxy.value, original.value);
  assert(instanceProxy instanceof Profile);
  assert.notStrictEqual(instanceProxy, instance);
  assert.notStrictEqual(instanceProxy, original);
});

test('descriptor changes leave unprotected mutation paths and invariants', () => {
  const object = {};
  Object.defineProperty(object, 'name', {
    value: 'Patrick',
    configurable: true,
    enumerable: true,
    writable: true,
  });

  Object.defineProperty(object, 'name', { value: 123 });
  assert.equal(object.name, 123, 'a configurable descriptor can be redefined directly');

  Object.defineProperty(object, 'name', { configurable: false });
  assert.throws(
    () => Object.defineProperty(object, 'name', { configurable: true }),
    TypeError,
  );
  object.name = 456;
  assert.equal(object.name, 456, 'non-configurable does not mean non-writable');

  const frozen = Object.freeze({ name: 'Patrick' });
  assert.equal(Reflect.set(frozen, 'name', 123), false);
  assert.equal(frozen.name, 'Patrick');

  const proxy = new Proxy(frozen, {
    set() {
      return true;
    },
  });
  assert.throws(() => Reflect.set(proxy, 'name', 123), TypeError);

  const extensible = { name: 'Patrick', extra: true };
  assert.equal(Reflect.deleteProperty(extensible, 'name'), true);
  assert.equal('name' in extensible, false, 'delete is an independent mutation path');
  const prototype = { inherited: 123 };
  assert.equal(Reflect.setPrototypeOf(extensible, prototype), true);
  assert.equal(extensible.inherited, 123, 'prototype mutation changes observable behavior');

  const fixed = {};
  Object.defineProperty(fixed, 'name', {
    configurable: false,
    value: 'Patrick',
    writable: false,
  });
  assert.equal(Reflect.defineProperty(fixed, 'name', { value: 123 }), false);
  assert.throws(
    () => Object.defineProperty(fixed, 'name', { value: 123 }),
    TypeError,
  );
});

test('an aliased array bypasses a Proxy around the field', () => {
  const source = [];
  const events = [];
  const watched = new Proxy(source, {
    set(target, property, value, receiver) {
      events.push([property, value]);
      if (property !== 'length' && typeof value !== 'string') {
        throw new ObservedStrictTypeError('roles element must be string');
      }
      return Reflect.set(target, property, value, receiver);
    },
  });
  const service = { roles: watched };

  source.push(123);
  assert.deepEqual(service.roles, [123]);
  assert.deepEqual(events, [], 'push through the old array alias never reaches the Proxy');
  assert.notStrictEqual(service.roles, source);
});

test('cycles are traversable, but freezing does not repair invalid state', () => {
  const node = { name: 'ok' };
  node.self = node;
  const seen = new WeakSet();
  let visits = 0;
  function visit(value) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    visits += 1;
    for (const child of Object.values(value)) visit(child);
  }
  visit(node);
  assert.equal(visits, 1, 'cycle-aware validation must terminate');

  const invalid = Object.freeze({ name: 123 });
  assert.equal(invalid.name, 123);
  assert.throws(() => {
    invalid.name = 'still invalid';
  }, TypeError);
});

test('wrapping a function validates calls only through the wrapper and changes identity', () => {
  function thirdParty(value) {
    return value;
  }
  const retainedAlias = thirdParty;
  const guarded = function guarded(value) {
    if (typeof value !== 'string') {
      throw new ObservedStrictTypeError('argument must be string');
    }
    const result = thirdParty.call(this, value);
    if (typeof result !== 'string') {
      throw new ObservedStrictTypeError('return must be string');
    }
    return result;
  };

  assert.notStrictEqual(guarded, thirdParty);
  assert.equal(guarded('ok'), 'ok');
  assert.throws(() => guarded(123), ObservedStrictTypeError);
  assert.equal(retainedAlias(123), 123, 'a third party alias remains outside the wrapper');
});

test('generic type arguments are erased and cannot be recovered from identity at runtime', () => {
  function identity(value) {
    return value;
  }
  const numberResult = identity(42); // identity<number>(42) in TypeScript
  const stringResult = identity('not a number'); // identity<number>(...) after cast

  assert.equal(numberResult, 42);
  assert.equal(stringResult, 'not a number');
  assert.strictEqual(identity, identity);
  assert.equal(identity.length, 1);
  assert.equal(Object.getOwnPropertyNames(identity).includes('typeParameters'), false);
});

test('a viable strategy can reject an unprotectable alias before exposing it', () => {
  const frozen = Object.freeze({ name: 'Patrick' });
  assert.throws(
    () => acceptsObjectThroughBoundary(frozen),
    (error) => error instanceof ObservedStrictTypeError && error.code === 'INVALID_MUTATION',
  );
  assert.equal(frozen.name, 'Patrick');
});
