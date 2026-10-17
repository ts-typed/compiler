/**
 * Per-stage build timing, used to spot bottlenecks during our own
 * development and testing. Not a documented or supported feature: there is
 * no config option for it, and {@link buildProject} only collects and
 * prints it when `TS_TYPED_BUILD_METRICS=1` is set in the environment, so
 * a real consumer's build never pays for or sees it.
 */
export interface BuildStageMetrics {
  readonly projectLoad: number;
  readonly typeAnalysis: number;
  readonly astTransform: number;
  readonly jsEmission: number;
  readonly bundling: number;
  readonly total: number;
}

const ENV_FLAG = 'TS_TYPED_BUILD_METRICS';

export function isBuildMetricsEnabled(): boolean {
  return process.env[ENV_FLAG] === '1';
}

export function now(): number {
  return performance.now();
}

export function formatBuildMetrics(metrics: BuildStageMetrics): string {
  const rows: ReadonlyArray<readonly [string, number]> = [
    ['Carregamento do projeto', metrics.projectLoad],
    ['Análise de tipos', metrics.typeAnalysis],
    ['Transformação AST', metrics.astTransform],
    ['Emissão JavaScript', metrics.jsEmission],
    ['Bundling ncc', metrics.bundling],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const lines = rows
    .filter(([, duration]) => duration > 0)
    .map(([label, duration]) => `${label.padEnd(labelWidth)}: ${formatMs(duration).padStart(8)}`);
  const separator = '─'.repeat(labelWidth + 11);
  return [
    'TypeSafe Build Performance',
    separator,
    ...lines,
    separator,
    `${'Total'.padEnd(labelWidth)}: ${formatMs(metrics.total).padStart(8)}`,
  ].join('\n');
}

function formatMs(duration: number): string {
  return `${Math.round(duration)}ms`;
}
