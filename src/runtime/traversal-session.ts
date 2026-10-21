import type { AssertionContext } from './assertion-context.interface';
import { SchemaMetadataCache } from './schema-metadata-cache.class';
import { SchemaRegistry } from './schema-registry.class';
import type { Schema } from './schema.type';

/**
 * A reference value/schema pair that was already visited by validation.
 * Protection replays this plan after validation succeeds, so invalid input
 * can never leave a partially protected graph behind.
 */
export interface ProtectionPlanEntry {
  readonly schema: Schema;
  readonly value: object;
  readonly context: AssertionContext;
}

/** Per-boundary state shared by validation and protection. */
export interface TraversalSession {
  readonly registry: SchemaRegistry;
  readonly metadataCache: SchemaMetadataCache;
  readonly protectionPlan: ProtectionPlanEntry[];
}

export function createTraversalSession(context: AssertionContext): TraversalSession {
  return {
    registry: context.registry ?? new SchemaRegistry(),
    metadataCache: new SchemaMetadataCache(),
    protectionPlan: [],
  };
}
