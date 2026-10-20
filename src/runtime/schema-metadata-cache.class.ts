import type { ObjectSchema } from './schema.interface';

export interface ObjectSchemaMetadata {
  readonly declaredKeys: readonly PropertyKey[];
  readonly declaredKeySet: ReadonlySet<PropertyKey>;
}

/**
 * Caches static object-schema metadata for a single runtime traversal.
 *
 * A cache belongs to one validation/protection operation rather than the
 * registry, so metadata cannot survive into a later boundary crossing after
 * application code has replaced a schema definition. The WeakMap also does
 * not retain schema objects after the traversal completes.
 */
export class SchemaMetadataCache {
  private readonly _objectMetadata = new WeakMap<object, ObjectSchemaMetadata>();

  public getObjectMetadata(schema: ObjectSchema): ObjectSchemaMetadata {
    const existing = this._objectMetadata.get(schema);
    if (existing !== undefined) {
      return existing;
    }

    const declaredKeys = Reflect.ownKeys(schema.properties);
    const metadata: ObjectSchemaMetadata = {
      declaredKeys,
      declaredKeySet: new Set<PropertyKey>(declaredKeys),
    };
    this._objectMetadata.set(schema, metadata);
    return metadata;
  }
}
