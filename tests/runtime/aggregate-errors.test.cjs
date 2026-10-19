'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { AggregateErrors, isAggregateErrorsEnabled } = require('../../dist/runtime');

test('a class without the decorator is not aggregate-enabled', () => {
  class PlainDto {}
  assert.equal(isAggregateErrorsEnabled(new PlainDto()), false);
});

test('AggregateErrors() marks every instance of the decorated class, found by walking the instance\'s own prototype chain', () => {
  // This is the mechanism that makes it work regardless of which file the
  // DTO class is declared in — no schema.instanceOf reference is involved.
  class CreateUserDto {}
  AggregateErrors()(CreateUserDto);

  assert.equal(isAggregateErrorsEnabled(new CreateUserDto()), true);
});

test('the decorator is inherited by subclasses', () => {
  class BaseDto {}
  AggregateErrors()(BaseDto);
  class DerivedDto extends BaseDto {}

  assert.equal(isAggregateErrorsEnabled(new DerivedDto()), true);
});
