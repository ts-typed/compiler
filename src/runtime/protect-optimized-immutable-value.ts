import { assertValue } from './assert-value';
import type { AssertionContext } from './assertion-context.interface';
import type { Schema } from './schema.type';

/**
 * Validates an output DTO, then freezes its complete plain-object graph.
 *
 * This is intentionally separate from `protectValue`: it trades mutable
 * assignment guards for native immutable data properties. That keeps DTOs
 * compatible with `Object.keys`, object spread and `structuredClone`, while
 * avoiding one getter/setter pair for every protected field.
 */
export function protectOptimizedImmutableValue(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
): unknown {
  assertValue(schema, value, context);
  // Verified, then frozen, as two separate passes: freezing while still
  // walking the graph for the unsupported-shape check would freeze a
  // sibling visited before the node that gets rejected, leaving the input
  // partially (and unpredictably, depending on key order) frozen on a call
  // that throws and returns nothing to the caller.
  assertPlainGraphSupported(value, new WeakSet<object>());
  freezePlainGraph(value, new WeakSet<object>());
  return value;
}

function assertPlainGraphSupported(value: unknown, visited: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (visited.has(value)) {
    return;
  }
  visited.add(value);

  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError(
      'TTOptImmut only supports plain objects and arrays. Use the normal typed contract for class instances and built-in objects.',
    );
  }

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }
    if (!('value' in descriptor)) {
      throw new TypeError(
        'TTOptImmut only supports plain data properties; accessor properties require the normal typed contract.',
      );
    }
    assertPlainGraphSupported(descriptor.value, visited);
  }
}

function freezePlainGraph(value: unknown, visited: WeakSet<object>): void {
  if (value === null || typeof value !== 'object' || visited.has(value)) {
    return;
  }
  visited.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      freezePlainGraph(descriptor.value, visited);
    }
  }
  Object.freeze(value);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
