import type {
  ArraySchema,
  IntersectionSchema,
  LiteralSchema,
  NeverSchema,
  ObjectSchema,
  PrimitiveSchema,
  RefSchema,
  TupleSchema,
  UnionSchema,
  UnknownSchema,
} from './schema.interface';

export type PrimitiveName =
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | 'symbol'
  | 'object'
  | 'function'
  | 'null'
  | 'undefined';

export type Schema =
  | PrimitiveSchema
  | LiteralSchema
  | UnionSchema
  | IntersectionSchema
  | ArraySchema
  | TupleSchema
  | ObjectSchema
  | RefSchema
  | UnknownSchema
  | NeverSchema;
