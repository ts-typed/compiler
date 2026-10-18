import { inspect } from 'node:util';
import { StrictTypeError } from './strict-type-error.class';
import type { StrictTypeErrorInfo } from './strict-type-error-info.interface';

export interface ValueObjectErrorContext {
  readonly propertyPath?: string;
  readonly contractKind?: StrictTypeErrorInfo['contractKind'];
  readonly operation?: StrictTypeErrorInfo['operation'];
  readonly className?: string;
}

/**
 * Base class for "value object" types that behave like a string but carry
 * extra validation and extra methods.
 *
 * Subclasses extend the boxed `String` object (not the primitive), so they
 * inherit every `String.prototype` method (`.toUpperCase()`, `.trim()`,
 * `.includes()`, ...) and can add their own methods on top.
 *
 * Trade-offs inherent to JavaScript (not fixable here):
 * - `typeof instance` is `'object'`, not `'string'`. A primitive can never
 *   carry extra methods, so the instance has to be a real object.
 * - Strict equality against a primitive fails (`instance === 'abc'` is
 *   `false`). Compare with `String(instance)` or `instance.toString()`.
 *
 * Behavior fixed by this class:
 * - `JSON.stringify` emits the raw string via `toJSON()`.
 * - `util.inspect` / `console.log` print the raw value instead of the default
 *   `[String: 'raw']` boxed form, via the `util.inspect.custom` hook.
 *
 * Construction order: `super(raw)` runs first, because `this` does not exist
 * until `super()` returns. This means a failing `new X(raw)` briefly builds a
 * boxed instance before the constructor throws. That instance is discarded
 * because the `new` expression throws, so nothing can hold a reference to it.
 */
export abstract class ValueObject extends String {
  protected constructor(raw: string, context?: ValueObjectErrorContext) {
    super(raw);
    if (!this.isValid(raw)) {
      throw new StrictTypeError({
        code: 'TYPE_MISMATCH',
        contractKind: context?.contractKind ?? 'construction',
        propertyPath: context?.propertyPath ?? this.constructor.name,
        expected: this.constructor.name,
        received: receivedName(raw),
        operation: context?.operation ?? 'initialize',
        ...(context?.className === undefined ? {} : { className: context.className }),
      });
    }
  }

  /**
   * Return `true` when `raw` is an acceptable value for this type.
   * Called from the constructor, so it must be stateless: subclass fields are
   * not yet initialized when it runs.
   */
  protected abstract isValid(raw: string): boolean;

  public toJSON(): string {
    return this.toString();
  }

  public [inspect.custom](): string {
    return this.toString();
  }
}

// Mirrors `receivedName` in assert-value.ts so errors from both paths report
// `received` the same way. For a string input this is always `'string'`.
function receivedName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}
