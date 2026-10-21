export { ConfigError } from './config-error';
export { DEFAULT_CONFIG } from './config.const';
export { loadConfig } from './load-config';
export { initializeProject } from './init-project';
export { configureNestProjectScripts } from './configure-nest-project-scripts';
export { detectProjectKind } from './detect-project-kind';
export type { ProjectKind } from './detect-project-kind';
export type { NestScriptSetupResult } from './configure-nest-project-scripts';
export type {
  AssetConfig,
  CompilerConfig,
  DiagnosticsConfig,
  InitResult,
  InitializeProjectOptions,
  NccConfig,
  ProjectConfig,
} from './config.interface';
export type { ConfigOverrides, DeepPartial } from './config.type';
