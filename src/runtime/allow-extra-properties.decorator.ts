const classMetadata = new WeakMap<object, true>();
const propertyMetadata = new WeakMap<object, Set<string | symbol>>();

export function AllowExtraProperties(): ClassDecorator & PropertyDecorator {
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      classMetadata.set(target, true);
      return;
    }

    const keys = propertyMetadata.get(target) ?? new Set<string | symbol>();
    keys.add(propertyKey);
    propertyMetadata.set(target, keys);
  };
}

export function isExtraPropertiesAllowed(
  target: object,
  propertyKey?: string | symbol,
): boolean {
  if (propertyKey !== undefined) {
    return hasPropertyMetadata(target, propertyKey);
  }

  return hasClassMetadata(target);
}

function hasPropertyMetadata(target: object, propertyKey: string | symbol): boolean {
  let current: object | null = target;

  while (current !== null) {
    if (propertyMetadata.get(current)?.has(propertyKey) === true) {
      return true;
    }
    current = Object.getPrototypeOf(current);
  }

  return false;
}

function hasClassMetadata(target: object): boolean {
  let current: object | null = target;

  while (current !== null) {
    if (classMetadata.has(current) || classMetadata.has(current.constructor)) {
      return true;
    }
    current = Object.getPrototypeOf(current);
  }

  return false;
}
