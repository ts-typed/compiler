import type { CoverageDiagnostic, CoverageItem, SchemaResolutionStatus } from '../analysis';
import type { CoverageReport, FileCoverage, ReportedContract } from './coverage-report.interface';

const COVERAGE_SEVERITY: Readonly<Record<SchemaResolutionStatus, number>> = {
  open: 0,
  protected: 1,
  partial: 2,
  unsupported: 3,
};

function contractIdentity(item: ReportedContract): string {
  return JSON.stringify([item.file, item.line, item.column, item.name, item.kind]);
}

function locationOrder(left: ReportedContract, right: ReportedContract): number {
  return left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || left.name.localeCompare(right.name);
}

export function createCoverageReport(
  coverage: readonly CoverageItem[],
  diagnostics: readonly CoverageDiagnostic[],
): CoverageReport {
  const items = new Map<string, ReportedContract>();
  const uniqueWarnings = new Map<string, CoverageDiagnostic>();
  for (const item of coverage) {
    const serializable: ReportedContract = {
      file: item.file,
      line: item.line,
      column: item.column,
      name: item.name,
      kind: item.kind,
      status: item.status,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    };
    items.set(contractIdentity(serializable), serializable);
  }
  for (const warning of diagnostics) {
    const identity = contractIdentity(warning);
    uniqueWarnings.set(JSON.stringify([identity, warning.code, warning.message]), warning);
    const previous = items.get(identity);
    if (previous === undefined || COVERAGE_SEVERITY[warning.status] >= COVERAGE_SEVERITY[previous.status]) {
      items.set(identity, {
        file: warning.file,
        line: warning.line,
        column: warning.column,
        name: warning.name,
        kind: warning.kind,
        status: warning.status,
        reason: warning.message,
      });
    }
  }
  const orderedItems = [...items.values()].sort(locationOrder);
  const fileNames = [...new Set(orderedItems.map((item) => item.file))];
  const files: FileCoverage[] = fileNames.map((file) => {
    const fileItems = orderedItems.filter((item) => item.file === file);
    return {
      file,
      protected: fileItems.filter((item) => item.status === 'protected').length,
      partial: fileItems.filter((item) => item.status === 'partial').length,
      unsupported: fileItems.filter((item) => item.status === 'unsupported').length,
      open: fileItems.filter((item) => item.status === 'open').length,
    };
  });
  return {
    items: orderedItems,
    warnings: [...uniqueWarnings.values()].sort(locationOrder),
    files,
  };
}
