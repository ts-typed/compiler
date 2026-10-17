'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const runtime = require('../../dist/runtime');
const guards = require('../../dist/runtime/guards');

const numberSchema = { kind: 'primitive', name: 'number' };
const stringSchema = { kind: 'primitive', name: 'string' };
const context = {
  contractKind: 'property',
  operation: 'initialize',
  propertyPath: 'Profile.value',
};

test('protectValue returns the exact primitive or object identity after validation', () => {
  const value = { name: 'Ada' };
  const schema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };

  assert.strictEqual(guards.protectValue(stringSchema, 'Ada', context), 'Ada');
  assert.strictEqual(guards.protectValue(schema, value, context), value);
  assert.throws(
    () => guards.protectValue(schema, { name: 42 }, context),
    runtime.StrictTypeError,
  );
});

test('object guards reject writes through aliases and Object.assign without changing the field', () => {
  const value = { name: 'Ada' };
  const schema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };
  guards.protectValue(schema, value, context);

  assert.throws(() => {
    value.name = 42;
  }, runtime.StrictTypeError);
  assert.equal(value.name, 'Ada');
  assert.throws(() => Object.assign(value, { name: 42 }), runtime.StrictTypeError);
  assert.equal(value.name, 'Ada');

  value.name = 'Grace';
  assert.equal(value.name, 'Grace');
});

test('nested objects keep their original alias and reject incompatible nested writes', () => {
  const profile = { name: 'Ada' };
  const value = { profile };
  const schema = {
    kind: 'object',
    properties: {
      profile: {
        schema: {
          kind: 'object',
          properties: { name: { schema: stringSchema } },
        },
      },
    },
  };

  guards.protectValue(schema, value, context);

  assert.strictEqual(value.profile, profile);
  assert.throws(() => {
    profile.name = 7;
  }, runtime.StrictTypeError);
  assert.equal(profile.name, 'Ada');
});

test('object guards preserve configurable enumerable data-property descriptors', () => {
  const value = { count: 1 };
  const schema = {
    kind: 'object',
    properties: { count: { schema: numberSchema } },
  };

  guards.protectValue(schema, value, context);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'count');

  assert.equal(descriptor.enumerable, true);
  assert.equal(descriptor.configurable, true);
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(typeof descriptor.set, 'function');
});

test('installFieldGuard rejects an invalid initializer before installing a guard', () => {
  const instance = { count: 'one' };

  assert.throws(
    () => guards.installFieldGuard(instance, 'count', numberSchema, context, { initialized: true }),
    runtime.StrictTypeError,
  );
  assert.deepEqual(Object.getOwnPropertyDescriptor(instance, 'count'), {
    value: 'one',
    writable: true,
    enumerable: true,
    configurable: true,
  });
});

test('installFieldGuard tolerates an uninitialized field and validates its first write', () => {
  const instance = {};
  guards.installFieldGuard(instance, 'count', numberSchema, context, { initialized: false });

  assert.equal(instance.count, undefined);
  assert.throws(() => {
    instance.count = 'one';
  }, runtime.StrictTypeError);
  assert.equal(instance.count, undefined);

  instance.count = 1;
  assert.equal(instance.count, 1);
});

test('reinstalling a field guard composes contracts instead of overwriting the first guard', () => {
  const instance = { value: 1 };
  const positiveNumberSchema = {
    kind: 'union',
    schemas: [{ kind: 'literal', value: 1 }, { kind: 'literal', value: 2 }],
  };
  guards.installFieldGuard(instance, 'value', numberSchema, context, { initialized: true });
  guards.installFieldGuard(instance, 'value', positiveNumberSchema, context, { initialized: true });

  instance.value = 2;
  assert.equal(instance.value, 2);
  assert.throws(() => {
    instance.value = 3;
  }, runtime.StrictTypeError);
  assert.throws(() => {
    instance.value = '1';
  }, runtime.StrictTypeError);
  assert.equal(instance.value, 2);
});

test('a shared object reference keeps every active object contract', () => {
  const shared = { value: 1 };
  const numberObject = {
    kind: 'object',
    properties: { value: { schema: numberSchema } },
  };
  const smallNumberObject = {
    kind: 'object',
    properties: {
      value: {
        schema: {
          kind: 'union',
          schemas: [{ kind: 'literal', value: 1 }, { kind: 'literal', value: 2 }],
        },
      },
    },
  };

  guards.protectValue(numberObject, shared, {
    ...context,
    propertyPath: 'first.shared',
  });
  guards.protectValue(smallNumberObject, shared, {
    ...context,
    propertyPath: 'second.shared',
  });

  shared.value = 2;
  assert.throws(() => {
    shared.value = 3;
  }, runtime.StrictTypeError);
  assert.equal(shared.value, 2);
});

test('field replacement validates closed object extras and preserves the previous value', () => {
  const previous = { name: 'Ada' };
  const instance = { profile: previous };
  const profileSchema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };
  guards.installFieldGuard(instance, 'profile', profileSchema, context, { initialized: true });

  assert.throws(() => {
    instance.profile = { name: 'Grace', extra: true };
  }, runtime.StrictTypeError);
  assert.strictEqual(instance.profile, previous);
});

test('field guards preserve registry-backed references and nested error paths', () => {
  const registry = new runtime.SchemaRegistry();
  const nodeRef = { kind: 'ref', name: 'Node' };
  registry.define('Node', {
    kind: 'object',
    properties: {
      value: { schema: numberSchema },
      next: { schema: nodeRef, optional: true },
    },
  });
  const node = { value: 1 };
  node.next = node;

  guards.protectValue(nodeRef, node, { ...context, propertyPath: 'root', registry });

  assert.throws(
    () => {
      node.value = 'one';
    },
    (error) =>
      error instanceof runtime.StrictTypeError &&
      error.propertyPath === 'root.value' &&
      error.operation === 'set',
  );
});

test('frozen and non-configurable values are accepted after validation without guard installation', () => {
  const frozen = Object.freeze({ count: 1 });
  const nonConfigurable = {};
  Object.defineProperty(nonConfigurable, 'count', {
    value: 1,
    writable: true,
    enumerable: true,
    configurable: false,
  });
  const schema = {
    kind: 'object',
    properties: { count: { schema: numberSchema } },
  };

  assert.strictEqual(guards.protectValue(schema, frozen, context), frozen);
  assert.strictEqual(guards.protectValue(schema, nonConfigurable, context), nonConfigurable);
  assert.equal(Object.getOwnPropertyDescriptor(nonConfigurable, 'count').get, undefined);

  nonConfigurable.count = 'escaped';
  assert.equal(nonConfigurable.count, 'escaped');
  assert.throws(() => runtime.assertValue(schema, nonConfigurable, context), runtime.StrictTypeError);
});

test('accessor properties are read once for validation and left untouched', () => {
  let reads = 0;
  let stored = 1;
  const value = {};
  const getter = () => {
    reads += 1;
    return stored;
  };
  const setter = (next) => {
    stored = next;
  };
  Object.defineProperty(value, 'count', {
    get: getter,
    set: setter,
    enumerable: true,
    configurable: true,
  });
  const schema = {
    kind: 'object',
    properties: { count: { schema: numberSchema } },
  };

  guards.protectValue(schema, value, context);

  assert.equal(reads, 1);
  assert.strictEqual(Object.getOwnPropertyDescriptor(value, 'count').get, getter);
  value.count = 'escaped';
  assert.equal(stored, 'escaped');
});

test('array protection stays point-in-time while recursively guarding object elements', () => {
  const item = { name: 'Ada' };
  const values = [item];
  const schema = {
    kind: 'array',
    items: {
      kind: 'object',
      properties: { name: { schema: stringSchema } },
    },
  };

  assert.strictEqual(guards.protectValue(schema, values, context), values);
  assert.equal(Object.hasOwn(values, 'push'), false);
  assert.throws(() => {
    item.name = 42;
  }, runtime.StrictTypeError);

  values.push({ name: 42 });
  assert.equal(values.length, 2);
  assert.throws(() => runtime.assertValue(schema, values, context), runtime.StrictTypeError);
});

test('property and class extra-property decorators are honored without opening known fields', () => {
  class Profile {}
  runtime.AllowExtraProperties()(Profile);
  const classDecorated = Object.assign(new Profile(), { name: 'Ada', source: 'import' });
  const profileSchema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };

  assert.strictEqual(guards.protectValue(profileSchema, classDecorated, context), classDecorated);
  assert.throws(() => {
    classDecorated.name = 42;
  }, runtime.StrictTypeError);

  class Owner {}
  runtime.AllowExtraProperties()(Owner.prototype, 'profile');
  const owner = Object.assign(new Owner(), {
    profile: { name: 'Grace', source: 'import' },
  });
  guards.installFieldGuard(owner, 'profile', profileSchema, context, { initialized: true });

  assert.throws(() => {
    owner.profile = { name: 42, source: 'import' };
  }, runtime.StrictTypeError);
  owner.profile = { name: 'Lin', source: 'import' };
  assert.equal(owner.profile.source, 'import');
});
