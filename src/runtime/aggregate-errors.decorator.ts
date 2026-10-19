const classMetadata = new WeakMap<object, true>();

/**
 * Opts a class into aggregated validation at the parameter boundary: when an
 * instance of this class (or a subclass) is the value crossing a typed
 * function/method parameter, `protectValue` (guards.ts) collects every
 * violation found anywhere in it — at any depth — into one
 * `AggregateStrictTypeError`, instead of throwing `StrictTypeError` on the
 * first one. Every other boundary (construction, field mutation after
 * construction, variables, returns) stays fail-fast regardless of this
 * decorator — see the design doc for why.
 */
export function AggregateErrors(): ClassDecorator {
  return (target: object): void => {
    classMetadata.set(target, true);
  };
}

/**
 * Walks `target`'s own prototype chain (an instance, not a class/schema
 * reference) looking for `AggregateErrors()` on its constructor or an
 * ancestor's. Keyed off the actual runtime value on purpose: unlike
 * `schema.instanceOf`, which the compiler only embeds when the class is
 * declared in the same file as the validation point, this works no matter
 * which file the class was imported from — the same mechanism
 * `isServerPopulated`/`isExtraPropertiesAllowed` already rely on.
 */
export function isAggregateErrorsEnabled(target: object): boolean {
  let current: object | null = target;

  while (current !== null) {
    if (classMetadata.has(current) || classMetadata.has(current.constructor)) {
      return true;
    }
    current = Object.getPrototypeOf(current);
  }

  return false;
}
