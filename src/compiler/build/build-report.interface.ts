import type { CoverageReport } from '../report';
import type { BuildStageMetrics } from './build-metrics';

export interface BuildAssetReport {
  readonly from: string;
  readonly to: string;
}

export interface BuildReport {
  readonly success: boolean;
  readonly outDir: string;
  readonly bundled: boolean;
  readonly coverage?: CoverageReport;
  readonly assets: readonly BuildAssetReport[];
  readonly externals: readonly string[];
  readonly errors: readonly string[];
  /**
   * Per-stage build timing. Undocumented and unsupported: only present when
   * the internal `TS_TYPED_BUILD_METRICS=1` environment variable is set
   * (used by this project's own tests/development, never by a consumer's
   * normal build).
   */
  readonly metrics?: BuildStageMetrics;
}
