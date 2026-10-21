'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const PACKAGE_NAME = '@ts-typed/core';

function hasOwnDependency(packageJson) {
  const groups = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.peerDependencies,
    packageJson.optionalDependencies,
  ];
  return groups.some((group) =>
    typeof group === 'object' && group !== null && Object.hasOwn(group, PACKAGE_NAME),
  );
}

function isEligibleConsumer(projectRoot, packageRoot) {
  if (projectRoot === packageRoot) {
    return false;
  }
  const packageFile = resolve(projectRoot, 'package.json');
  if (!existsSync(packageFile)) {
    return false;
  }
  try {
    const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
    return typeof packageJson === 'object' && packageJson !== null && hasOwnDependency(packageJson);
  } catch {
    return false;
  }
}

async function initializeConsumerConfig() {
  const packageRoot = resolve(__dirname, '..');
  const projectRoot = resolve(process.env.INIT_CWD ?? process.cwd());
  if (!isEligibleConsumer(projectRoot, packageRoot)) {
    return;
  }
  const { initializeProject } = require('../dist/config');
  await initializeProject(projectRoot);
}

if (require.main === module) {
  initializeConsumerConfig().catch(() => undefined);
}

module.exports = { isEligibleConsumer };
