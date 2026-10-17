import type { PrimitiveName, Schema } from './schema.type';

export interface PrimitiveSchema {
  readonly kind: 'primitive';
  readonly name: PrimitiveName;
}

export interface LiteralSchema {
  readonly kind: 'literal';
  readonly value: string | number | boolean | bigint | null | undefined;
}

export interface UnionSchema {
  readonly kind: 'union';
  readonly schemas: readonly Schema[];
}

export interface IntersectionSchema {
  readonly kind: 'intersection';
  readonly schemas: readonly Schema[];
}

export interface ArraySchema {
  readonly kind: 'array';
  readonly items: Schema;
}

export interface TupleSchema {
  readonly kind: 'tuple';
  readonly items: readonly Schema[];
  readonly rest?: Schema | false;
}

export interface ObjectPropertySchema {
  readonly schema: Schema;
  readonly optional?: boolean;
  /**
   * The property comes from a definite assignment assertion (`field!: T`,
   * e.g. Angular-style `@Input() value!: T`): TypeScript itself does not
   * guarantee it is set by the time the instance is first observed. Unlike
   * an ordinary optional (`field?: T`) property — where an explicit
   * `undefined` is deliberately treated as invalid, distinct from absence —
   * a present-but-still-`undefined` value here is tolerated, matching the
   * "trust me, it is assigned later" contract `!` makes with the compiler.
   */
  readonly deferredAssignment?: boolean;
}

export interface SchemaProperties {
  readonly [key: string]: ObjectPropertySchema;
  readonly [key: symbol]: ObjectPropertySchema;
}

export interface ObjectSchema {
  readonly kind: 'object';
  readonly properties: SchemaProperties;
  readonly allowExtraProperties?: boolean;
  readonly index?: Schema;
  /**
   * The originating class constructor, embedded by the compiler only when
   * the class is declared in the same file as the validation point (a live
   * reference is required for `instanceof`; there is no cross-file lookup).
   * Whether it is actually enforced is decided at validation time by
   * {@link getClassValidationMode} (a per-class decorator override) or,
   * absent one, by {@link strictClassDefault}.
   */
  readonly instanceOf?: Function;
  readonly strictClassDefault?: boolean;
}

export interface RefSchema {
  readonly kind: 'ref';
  readonly name: string;
}

export interface UnknownSchema {
  readonly kind: 'unknown';
}

export interface NeverSchema {
  readonly kind: 'never';
}
