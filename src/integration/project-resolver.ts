import type { IntegrationContext } from './integration-context.interface';
import { isProjectResolution, loadIntegration } from './integration-loader';
import { IntegrationError } from './integration-error.class';
import type { ProjectResolution } from './project-resolution.interface';

export const resolveProject = (
  context: IntegrationContext,
  integration: string = 'typescript',
): ProjectResolution => {
  const adapter = loadIntegration(integration, context.projectRoot);
  const result: unknown = adapter.resolveProject(context);
  if (!isProjectResolution(result)) {
    throw new IntegrationError(
      'INCOMPATIBLE_INTEGRATION',
      `Integration module "${integration}" returned an invalid project resolution.`,
    );
  }
  return result;
};
