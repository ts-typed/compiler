import { relative } from 'node:path';
import type { CoverageReport } from './coverage-report.interface';

export function formatCoverageReport(report: CoverageReport, projectRoot: string): string {
  const lines: string[] = report.warnings.map((warning) => {
    const file = relative(projectRoot, warning.file) || warning.file;
    return `${file}:${warning.line}:${warning.column} warning ${warning.code}: ${warning.name} — ${warning.message}`;
  });
  for (const file of report.files) {
    const name = relative(projectRoot, file.file) || file.file;
    lines.push(`${name}: ${file.protected} protected, ${file.partial} partial, ${file.unsupported} unsupported, ${file.open} open`);
  }
  return lines.join('\n');
}
