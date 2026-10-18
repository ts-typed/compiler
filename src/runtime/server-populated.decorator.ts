const classMetadata = new WeakMap<object, true>();

export function ServerPopulated(): ClassDecorator {
  return (target: object): void => {
    classMetadata.set(target, true);
  };
}

export function isServerPopulated(target: object): boolean {
  let current: object | null = target;

  while (current !== null) {
    if (classMetadata.has(current) || classMetadata.has(current.constructor)) {
      return true;
    }
    current = Object.getPrototypeOf(current);
  }

  return false;
}
