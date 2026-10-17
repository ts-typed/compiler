'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const integration = require('@ts-typed/compiler');
const integrationSubpath = require('@ts-typed/compiler/integration');

const projectContext = { projectRoot: __dirname };

test('exports the versioned API from the package root and subpath', () => {
  assert.equal(integration.INTEGRATION_API_VERSION, 1);
  assert.equal(typeof integration.resolveProject, 'function');
  assert.equal(typeof integration.loadIntegration, 'function');
  assert.strictEqual(integrationSubpath.resolveProject, integration.resolveProject);
});

test('resolves the built-in TypeScript integration', () => {
  const project = integration.resolveProject(projectContext, 'typescript');
  assert.deepEqual(project, {
    apiVersion: 1,
    integration: 'typescript',
    projectRoot: __dirname,
  });
});

test('loads only the explicitly selected external integration', () => {
  const project = integration.resolveProject(projectContext, './fixtures/external-adapter.cjs');
  assert.equal(project.integration, 'external-fixture');
});

test('does not execute an unselected integration module', () => {
  const project = integration.resolveProject(projectContext, 'typescript');
  assert.equal(project.integration, 'typescript');
  assert.doesNotThrow(() => integration.loadIntegration('typescript', projectContext.projectRoot));
});

test('rejects missing integration modules', () => {
  assert.throws(
    () => integration.resolveProject(projectContext, './fixtures/missing-adapter.cjs'),
    (error) => error instanceof Error && error.code === 'INTEGRATION_LOAD_FAILED',
  );
});

test('rejects an incompatible adapter version', () => {
  assert.throws(
    () => integration.resolveProject(projectContext, './fixtures/invalid-version.cjs'),
    (error) => error instanceof Error && error.code === 'INCOMPATIBLE_INTEGRATION',
  );
});

test('rejects an incompatible adapter shape', () => {
  assert.throws(
    () => integration.resolveProject(projectContext, './fixtures/invalid-shape.cjs'),
    (error) => error instanceof Error && error.code === 'INCOMPATIBLE_INTEGRATION',
  );
});

test('rejects an invalid adapter result', () => {
  assert.throws(
    () => integration.resolveProject(projectContext, './fixtures/invalid-result.cjs'),
    (error) => error instanceof Error && error.code === 'INCOMPATIBLE_INTEGRATION',
  );
});
