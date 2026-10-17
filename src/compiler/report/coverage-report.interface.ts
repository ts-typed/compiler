import type { ContractKind, CoverageDiagnostic, SchemaResolutionStatus } from '../analysis';

export interface ReportedContract {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly name: string;
  readonly kind: ContractKind;
  readonly status: SchemaResolutionStatus;
  readonly reason?: string;
}

export interface FileCoverage {
  readonly file: string;
  readonly protected: number;
  readonly partial: number;
  readonly unsupported: number;
  readonly open: number;
}

export interface CoverageReport {
  readonly items: readonly ReportedContract[];
  readonly warnings: readonly CoverageDiagnostic[];
  readonly files: readonly FileCoverage[];
}
