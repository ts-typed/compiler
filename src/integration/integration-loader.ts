import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { INTEGRATION_API_VERSION } from './integration-version.const';
import type { IntegrationAdapterV1 } from './integration-adapter.interface';
import { IntegrationError } from './integration-error.class';
import type { ProjectResolution } from './project-resolution.interface';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const isAdapter = (value: unknown): value is IntegrationAdapterV1 => {
  if (!isRecord(value)) {
    return false;
  }

  return value.apiVersion === INTEGRATION_API_VERSION
    && typeof value.name === 'string'
    && typeof value.resolveProject === 'function'
    && (value.installGlobalStrictTypeErrorFilter === undefined
      || typeof value.installGlobalStrictTypeErrorFilter === 'function');
};

export const isProjectResolution = (value: unknown): value is ProjectResolution => {
  if (!isRecord(value)) {
    return false;
  }

  return value.apiVersion === INTEGRATION_API_VERSION
    && typeof value.integration === 'string'
    && typeof value.projectRoot === 'string'
    && (value.configPath === undefined || typeof value.configPath === 'string');
};

const unwrapModule = (value: unknown): unknown => {
  if (!isRecord(value) || !('default' in value)) {
    return value;
  }
  return value.default;
};

export const loadIntegration = (
  specifier: string,
  projectRoot: string,
): IntegrationAdapterV1 => {
  if (specifier === 'typescript') {
    return {
      apiVersion: INTEGRATION_API_VERSION,
      name: 'typescript',
      resolveProject: (context) => ({
        apiVersion: INTEGRATION_API_VERSION,
        integration: 'typescript',
        projectRoot: context.projectRoot,
        ...(context.configPath === undefined ? {} : { configPath: context.configPath }),
      }),
    };
  }

  try {
    const requireFromProject = createRequire(resolve(projectRoot, '__ts_typed_integration__.cjs'));
    const loaded: unknown = requireFromProject(specifier);
    const adapter = unwrapModule(loaded);
    if (!isAdapter(adapter)) {
      throw new IntegrationError(
        'INCOMPATIBLE_INTEGRATION',
        `Integration module "${specifier}" does not implement API version ${INTEGRATION_API_VERSION}.`,
      );
    }
    return adapter;
  } catch (error: unknown) {
    if (error instanceof IntegrationError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : 'unknown module loading error';
    throw new IntegrationError(
      'INTEGRATION_LOAD_FAILED',
      `Unable to load integration module "${specifier}": ${detail}`,
    );
  }
};
