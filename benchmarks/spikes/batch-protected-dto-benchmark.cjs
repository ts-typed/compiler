'use strict';

const { protectValue } = require('../../dist/runtime');
const { createBatchProtectedDtoFactory } = require('./batch-protected-dto-spike.cjs');

const USER_COUNT = 10_000;
const SAMPLE_COUNT = 9;
const WARMUP_COUNT = 2;
const context = Object.freeze({
  contractKind: 'return',
  operation: 'return',
  propertyPath: 'UserService.list',
});
const stringSchema = Object.freeze({ kind: 'primitive', name: 'string' });
const numberSchema = Object.freeze({ kind: 'primitive', name: 'number' });
const booleanSchema = Object.freeze({ kind: 'primitive', name: 'boolean' });
const userSchema = Object.freeze({
  kind: 'object',
  properties: Object.freeze({
    id: Object.freeze({ schema: numberSchema }),
    name: Object.freeze({ schema: stringSchema }),
    email: Object.freeze({ schema: stringSchema }),
    active: Object.freeze({ schema: booleanSchema }),
    department: Object.freeze({ schema: stringSchema }),
  }),
});
const userArraySchema = Object.freeze({ kind: 'array', items: userSchema });
const batchFactory = createBatchProtectedDtoFactory(userSchema, context);

function createRows() {
  return Array.from({ length: USER_COUNT }, (_, index) => ({
    id: index,
    name: `User ${index}`,
    email: `user-${index}@example.com`,
    active: index % 2 === 0,
    department: index % 3 === 0 ? 'engineering' : 'operations',
  }));
}

function benchmark(name, operation) {
  let result;
  for (let sample = 0; sample < WARMUP_COUNT; sample += 1) {
    result = operation();
  }

  const measurements = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    if (global.gc) {
      global.gc();
    }
    const startedAt = process.hrtime.bigint();
    result = operation();
    measurements.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  measurements.sort((left, right) => left - right);
  console.log(`${name}: median ${measurements[Math.floor(measurements.length / 2)].toFixed(2)}ms; range ${measurements[0].toFixed(2)}–${measurements.at(-1).toFixed(2)}ms`);
  return result;
}

console.log(`Batch size: ${USER_COUNT} flat DTOs with 5 fields`);
console.log('Run with --expose-gc for stable samples.');

const guarded = benchmark('Current protectValue', () => protectValue(userArraySchema, createRows(), context));
const materialized = benchmark('Experimental shared-prototype DTO', () => batchFactory.materializeMany(createRows()));
benchmark('Current protectValue + JSON.stringify', () => JSON.stringify(protectValue(userArraySchema, createRows(), context)));
benchmark('Experimental DTO + JSON.stringify', () => JSON.stringify(batchFactory.materializeMany(createRows())));

console.log(`Current guard remains active: ${guarded[0].email}`);
console.log(`Experimental DTO remains serializable: ${JSON.stringify(materialized[0])}`);
