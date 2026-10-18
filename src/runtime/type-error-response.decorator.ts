export interface TypeErrorResponseOptions {
  readonly message: string;
  readonly status?: number;
}

const propertyMetadata = new WeakMap<object, Map<string | symbol, TypeErrorResponseOptions>>();

export function TypeErrorResponse(message: string, status?: number): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    const options: TypeErrorResponseOptions =
      status === undefined ? { message } : { message, status };
    const entries = propertyMetadata.get(target) ?? new Map<string | symbol, TypeErrorResponseOptions>();
    entries.set(propertyKey, options);
    propertyMetadata.set(target, entries);
  };
}

export function getTypeErrorResponse(
  instance: object,
  propertyKey: string | symbol,
): TypeErrorResponseOptions | undefined {
  let current: object | null = instance;

  while (current !== null) {
    const found = propertyMetadata.get(current)?.get(propertyKey);
    if (found !== undefined) {
      return found;
    }
    current = Object.getPrototypeOf(current);
  }

  return undefined;
}
