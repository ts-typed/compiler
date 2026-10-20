declare const ttOptImmutBrand: unique symbol;

type TTOptImmutPrimitive = string | number | boolean | bigint | symbol | null | undefined;

type DeepReadonly<T> =
  T extends TTOptImmutPrimitive | ((...args: never[]) => unknown)
    ? T
    : T extends readonly unknown[]
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

/**
 * Marks a plain response DTO as immutable and selects ts-typed's
 * validate-then-freeze runtime strategy at a typed boundary.
 *
 * Use `TTOptImmut<User[]>` for immutable batches. It deliberately rejects
 * entities, Dates, Maps, Sets and accessor-backed objects at runtime.
 */
export type TTOptImmut<T> = DeepReadonly<T> & {
  readonly [ttOptImmutBrand]?: never;
};
