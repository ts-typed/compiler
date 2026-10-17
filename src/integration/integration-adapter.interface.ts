import type { IntegrationContext } from './integration-context.interface';
import type { ProjectResolution } from './project-resolution.interface';

export interface GlobalErrorFilterSetupResult {
  readonly changed: boolean;
  readonly message: string;
}

export interface IntegrationAdapterV1 {
  readonly apiVersion: 1;
  readonly name: string;
  readonly resolveProject: (context: IntegrationContext) => ProjectResolution;
  /**
   * Optional, framework-owned setup hook used by `ts-typed init`. The core
   * deliberately has no framework dependency; an adapter may safely install
   * its own global error boundary when the user opts in.
   */
  readonly installGlobalStrictTypeErrorFilter?: (
    context: IntegrationContext,
  ) => GlobalErrorFilterSetupResult;
}
