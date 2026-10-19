'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AggregateErrors,
  beginAggregateWindow,
  collectIfAggregating,
  takeAggregateWindowViolations,
} = require('../../dist/runtime');

function violation(propertyPath) {
  return {
    code: 'TYPE_MISMATCH',
    contractKind: 'property',
    propertyPath,
    expected: 'string',
    received: 'number',
    operation: 'set',
  };
}

test('beginAggregateWindow is a no-op for an instance of an undecorated class — collectIfAggregating returns false', () => {
  class PlainDto {}
  const instance = new PlainDto();

  beginAggregateWindow(instance);

  assert.equal(collectIfAggregating(instance, violation('x')), false);
  assert.equal(takeAggregateWindowViolations(instance), undefined);
});

test('beginAggregateWindow opens a window for an instance of an @AggregateErrors() class — collectIfAggregating collects instead of signaling "not open"', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();

  beginAggregateWindow(instance);

  assert.equal(collectIfAggregating(instance, violation('name')), true);
  assert.equal(collectIfAggregating(instance, violation('age')), true);
});

test('takeAggregateWindowViolations closes the window and returns everything collected, in order', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();
  beginAggregateWindow(instance);
  collectIfAggregating(instance, violation('name'));
  collectIfAggregating(instance, violation('age'));

  const violations = takeAggregateWindowViolations(instance);

  assert.deepEqual(violations.map((v) => v.propertyPath), ['name', 'age']);
  // Closed: a later write attempt is no longer collected.
  assert.equal(collectIfAggregating(instance, violation('email')), false);
});

test('takeAggregateWindowViolations on an instance whose window was never opened returns undefined (distinct from "opened but empty")', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();
  // beginAggregateWindow was never called for this instance.

  assert.equal(takeAggregateWindowViolations(instance), undefined);
});

test('takeAggregateWindowViolations on a window opened but nothing collected returns an empty array, not undefined', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();
  beginAggregateWindow(instance);

  assert.deepEqual(takeAggregateWindowViolations(instance), []);
});

test('two instances of the same decorated class have independent windows', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const first = new Dto();
  const second = new Dto();
  beginAggregateWindow(first);
  beginAggregateWindow(second);

  collectIfAggregating(first, violation('name'));

  assert.deepEqual(takeAggregateWindowViolations(first).map((v) => v.propertyPath), ['name']);
  assert.deepEqual(takeAggregateWindowViolations(second), []);
});
