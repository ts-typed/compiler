'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { assertValue, StrictClass, StructuralClass, StrictTypeError } = require('../../dist/runtime');

const context = { contractKind: 'variable', operation: 'assert', propertyPath: 'value' };

class PlainValueClass {
  constructor(name) {
    this.name = name;
  }
}

function schemaFor(ctor, strictClassDefault) {
  return {
    kind: 'object',
    properties: { name: { schema: { kind: 'primitive', name: 'string' } } },
    instanceOf: ctor,
    strictClassDefault,
  };
}

test('without strictClass, a structurally matching plain object is accepted even though it is not an instance', () => {
  const schema = schemaFor(PlainValueClass, false);
  assert.doesNotThrow(() => assertValue(schema, { name: 'Ada' }, context));
  assert.doesNotThrow(() => assertValue(schema, new PlainValueClass('Ada'), context));
});

test('with strictClassDefault true, a structurally matching plain object that is not an instance is rejected', () => {
  const schema = schemaFor(PlainValueClass, true);
  assert.throws(() => assertValue(schema, { name: 'Ada' }, context), StrictTypeError);
  assert.doesNotThrow(() => assertValue(schema, new PlainValueClass('Ada'), context));
});

// Decorators are applied as plain function calls here (the same shape the
// compiler's `experimentalDecorators` emit produces: `Decorator()(target)`)
// so this test does not depend on native/engine decorator syntax support.

test('StrictClass() overrides a false compiled-in default for that class', () => {
  class Decorated {
    constructor(name) {
      this.name = name;
    }
  }
  StrictClass()(Decorated);

  const schema = schemaFor(Decorated, false);
  assert.throws(() => assertValue(schema, { name: 'Ada' }, context), StrictTypeError);
  assert.doesNotThrow(() => assertValue(schema, new Decorated('Ada'), context));
});

test('StructuralClass() overrides a true compiled-in default for that class', () => {
  class Decorated {
    constructor(name) {
      this.name = name;
    }
  }
  StructuralClass()(Decorated);

  const schema = schemaFor(Decorated, true);
  assert.doesNotThrow(() => assertValue(schema, { name: 'Ada' }, context));
  assert.doesNotThrow(() => assertValue(schema, new Decorated('Ada'), context));
});

test('a per-class decorator is inherited by subclasses unless they override it themselves', () => {
  class Base {
    constructor(name) {
      this.name = name;
    }
  }
  StrictClass()(Base);
  class Derived extends Base {}
  class DerivedOverride extends Base {}
  StructuralClass()(DerivedOverride);

  assert.throws(() => assertValue(schemaFor(Derived, false), { name: 'Ada' }, context), StrictTypeError);
  assert.doesNotThrow(() => assertValue(schemaFor(DerivedOverride, true), { name: 'Ada' }, context));
});
