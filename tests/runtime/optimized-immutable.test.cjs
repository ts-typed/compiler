'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const runtime = require('../../dist/runtime');

const context = {
  contractKind: 'return',
  operation: 'return',
  propertyPath: 'UsersController.list',
};

const userSchema = {
  kind: 'object',
  properties: {
    id: { schema: { kind: 'primitive', name: 'number' } },
    name: { schema: { kind: 'primitive', name: 'string' } },
    tags: { schema: { kind: 'array', items: { kind: 'primitive', name: 'string' } } },
  },
};

test('protectOptimizedImmutableValue validates then deep-freezes a plain DTO without accessors', () => {
  const dto = { id: 1, name: 'Ada', tags: ['admin'] };

  const result = runtime.protectOptimizedImmutableValue(userSchema, dto, context);

  assert.strictEqual(result, dto);
  assert.equal(Object.isFrozen(dto), true);
  assert.equal(Object.isFrozen(dto.tags), true);
  assert.equal(typeof Object.getOwnPropertyDescriptor(dto, 'name').get, 'undefined');
  assert.deepEqual(Object.keys(dto), ['id', 'name', 'tags']);
  assert.deepEqual({ ...dto }, { id: 1, name: 'Ada', tags: ['admin'] });
  assert.deepEqual(structuredClone(dto), { id: 1, name: 'Ada', tags: ['admin'] });
  assert.throws(() => { dto.name = 'Grace'; }, TypeError);
  assert.throws(() => { dto.tags.push('staff'); }, TypeError);
});

test('protectOptimizedImmutableValue leaves invalid values mutable after rejecting them', () => {
  const invalid = { id: 'one', name: 'Ada', tags: [] };

  assert.throws(
    () => runtime.protectOptimizedImmutableValue(userSchema, invalid, context),
    runtime.StrictTypeError,
  );
  assert.equal(Object.isFrozen(invalid), false);
});

test('protectOptimizedImmutableValue supports cyclic plain-object graphs', () => {
  const nodeSchema = {
    kind: 'object',
    properties: {
      name: { schema: { kind: 'primitive', name: 'string' } },
      self: { schema: { kind: 'ref', name: 'Node' }, optional: true },
    },
  };
  const registry = new runtime.SchemaRegistry();
  registry.define('Node', nodeSchema);
  const node = { name: 'root' };
  node.self = node;

  assert.strictEqual(
    runtime.protectOptimizedImmutableValue({ kind: 'ref', name: 'Node' }, node, { ...context, registry }),
    node,
  );
  assert.equal(Object.isFrozen(node), true);
});

test('protectOptimizedImmutableValue leaves an already-walked sibling mutable when a LATER sibling is rejected', () => {
  const outerSchema = {
    kind: 'object',
    properties: {
      sib: { schema: { kind: 'object', properties: { x: { schema: { kind: 'primitive', name: 'number' } } } } },
      a: { schema: { kind: 'object', properties: { m: { schema: { kind: 'map', key: { kind: 'primitive', name: 'string' }, value: { kind: 'primitive', name: 'string' } } } } } },
    },
  };
  const outer = { sib: { x: 1 }, a: { m: new Map() } };

  assert.throws(
    () => runtime.protectOptimizedImmutableValue(outerSchema, outer, context),
    /TTOptImmut only supports plain objects and arrays/,
  );
  assert.equal(Object.isFrozen(outer), false);
  assert.equal(Object.isFrozen(outer.sib), false);
  assert.equal(Object.isFrozen(outer.a), false);
});

test('protectOptimizedImmutableValue rejects class instances instead of pretending they are DTOs', () => {
  class UserEntity {
    constructor() {
      this.id = 1;
      this.name = 'Ada';
      this.tags = [];
    }
  }

  assert.throws(
    () => runtime.protectOptimizedImmutableValue(userSchema, new UserEntity(), context),
    /TTOptImmut only supports plain objects and arrays/,
  );
});
