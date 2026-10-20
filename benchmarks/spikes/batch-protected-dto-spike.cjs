'use strict';

const { assertValue } = require('../../dist/runtime');

/**
 * Experimental fast path for a homogeneous batch of flat response DTOs.
 *
 * The generated accessors live once on the prototype. Each instance keeps a
 * private snapshot in a WeakMap, so mutating the source object through an
 * alias cannot bypass the response DTO's guards.
 */
function createBatchProtectedDtoFactory(schema, context) {
  if (schema.kind !== 'object') {
    throw new TypeError('The batch DTO spike supports object schemas only.');
  }

  const keys = Reflect.ownKeys(schema.properties);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('The batch DTO spike supports string property keys only.');
  }

  const arraySchema = { kind: 'array', items: schema };
  const stateByInstance = new WeakMap();
  const materialized = Symbol('materialized');

  class BatchProtectedDto {
    constructor(input, token) {
      if (token !== materialized) {
        assertValue(schema, input, context);
      }

      const snapshot = {};
      for (const key of keys) {
        snapshot[key] = input[key];
      }
      stateByInstance.set(this, snapshot);
    }

    toJSON() {
      const snapshot = stateByInstance.get(this);
      const serialized = {};
      for (const key of keys) {
        serialized[key] = snapshot[key];
      }
      return serialized;
    }
  }

  for (const key of keys) {
    const propertySchema = schema.properties[key].schema;
    Object.defineProperty(BatchProtectedDto.prototype, key, {
      enumerable: true,
      configurable: false,
      get() {
        return stateByInstance.get(this)[key];
      },
      set(value) {
        assertValue(propertySchema, value, {
          ...context,
          operation: 'set',
          propertyPath: `${context.propertyPath}.${key}`,
        });
        stateByInstance.get(this)[key] = value;
      },
    });
  }

  return Object.freeze({
    materializeMany(inputs) {
      assertValue(arraySchema, inputs, context);
      return inputs.map((input) => new BatchProtectedDto(input, materialized));
    },
  });
}

module.exports = { createBatchProtectedDtoFactory };
