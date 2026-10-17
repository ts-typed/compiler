export type ClassValidationMode = 'strict' | 'structural';

const classValidationMode = new WeakMap<Function, ClassValidationMode>();

/**
 * Opts a class into nominal (`instanceof`) validation wherever its runtime
 * schema can embed a live reference to it, overriding `compiler.strictClass`
 * for this class regardless of the global default.
 */
export function StrictClass(): ClassDecorator {
  return (target: Function): void => {
    classValidationMode.set(target, 'strict');
  };
}

/**
 * Opts a class into purely structural validation (same as an equivalent
 * interface), overriding `compiler.strictClass` for this class regardless of
 * the global default.
 */
export function StructuralClass(): ClassDecorator {
  return (target: Function): void => {
    classValidationMode.set(target, 'structural');
  };
}

/**
 * Resolves the effective validation mode for a class constructor: an
 * explicit per-class decorator override if present on it or an ancestor,
 * otherwise `undefined` (meaning the caller should fall back to
 * `compiler.strictClass`'s compiled-in default).
 */
export function getClassValidationMode(target: Function): ClassValidationMode | undefined {
  let current: Function | null = target;

  while (current !== null) {
    const mode = classValidationMode.get(current);
    if (mode !== undefined) {
      return mode;
    }
    current = Object.getPrototypeOf(current) as Function | null;
  }

  return undefined;
}
