import type { Schema } from '../../runtime';

export type SchemaResolutionStatus = 'protected' | 'partial' | 'open' | 'unsupported';

export interface SchemaResolution {
  readonly schema?: Schema;
  readonly status: SchemaResolutionStatus;
  readonly reason?: string;
}
