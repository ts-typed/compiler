import type ts from 'typescript';

import type { ContractKind } from './contract-descriptor.interface';
import type { SchemaResolutionStatus } from './schema-resolution.interface';

export type CoverageDiagnosticCode =
  | 'TT_UNSUPPORTED_TYPE'
  | 'TT_PARTIAL_ALIAS'
  | 'TT_UNSUPPORTED_SYNTAX';

export interface CoverageItem {
  readonly node: ts.Node;
  readonly name: string;
  readonly kind: ContractKind;
  readonly status: SchemaResolutionStatus;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly reason?: string;
}

export interface CoverageDiagnostic {
  readonly code: CoverageDiagnosticCode;
  readonly category: 'warning';
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly name: string;
  readonly kind: ContractKind;
  readonly status: 'partial' | 'unsupported';
  readonly message: string;
}
