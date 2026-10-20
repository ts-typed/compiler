import type { Schema } from '../../runtime';

export type SchemaResolutionStatus = 'protected' | 'partial' | 'open' | 'unsupported';

/** Runtime handling selected at a contract boundary. */
export type SchemaProtectionStrategy = 'guarded' | 'optimizedImmutable';

export interface SchemaResolution {
  readonly schema?: Schema;
  readonly status: SchemaResolutionStatus;
  readonly reason?: string;
  /**
   * `TTOptImmut<T>` keeps its wrapper out of the schema, but records this
   * boundary-only strategy so the transformer can emit validate-then-freeze.
   */
  readonly protectionStrategy?: SchemaProtectionStrategy;
}
