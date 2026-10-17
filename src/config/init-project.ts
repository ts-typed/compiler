import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG } from './config.const';
import type {
  InitResult,
  InitializeProjectOptions,
  ProjectConfig,
} from './config.interface';
import { loadConfig } from './load-config';

const CONFIG_FILE_NAME = 'typets.config.json';
const BUILD_TSCONFIG_FILE_NAME = 'tsconfig.build.json';
const DEFAULT_TSCONFIG_FILE_NAME = 'tsconfig.json';

const SUGGESTED_SCRIPTS: readonly string[] = [
  'build: ts-typed build',
  'build:debug: ts-typed build --no-bundle --sourcemap',
  'start:prod: node dist/index.js',
];

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const isExistingFileError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'EEXIST';

const selectTsconfig = async (root: string): Promise<string> => {
  const buildTsconfig = join(root, BUILD_TSCONFIG_FILE_NAME);
  return await fileExists(buildTsconfig)
    ? BUILD_TSCONFIG_FILE_NAME
    : DEFAULT_TSCONFIG_FILE_NAME;
};

const createConfiguration = async (
  configPath: string,
  template: ProjectConfig,
): Promise<boolean> => {
  let handle: FileHandle;
  try {
    handle = await open(configPath, 'wx');
  } catch (error: unknown) {
    if (isExistingFileError(error)) {
      return false;
    }
    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify(template, null, 2)}\n`);
  } finally {
    await handle.close();
  }

  return true;
};

export const initializeProject = async (
  root: string,
  options: InitializeProjectOptions = {},
): Promise<InitResult> => {
  const absoluteRoot = resolve(root);
  const configPath = join(absoluteRoot, CONFIG_FILE_NAME);
  const tsconfig = await selectTsconfig(absoluteRoot);
  const template: ProjectConfig = {
    ...DEFAULT_CONFIG,
    ...(options.integration === undefined ? {} : { integration: options.integration }),
    tsconfig,
  };
  const created = await createConfiguration(configPath, template);
  const config = await loadConfig(configPath);

  return {
    created,
    configPath,
    config,
    suggestedScripts: SUGGESTED_SCRIPTS,
  };
};
