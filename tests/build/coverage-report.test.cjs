'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoverageReport, formatCoverageReport } = require('../../dist/compiler/report');

test('reports warnings with source location and downgrades instrumented coverage without serializing AST', () => {
  const node = {}; node.self = node;
  const items = [{ node, file: '/project/src/a.ts', line: 3, column: 2, name: 'response', kind: 'variable', status: 'protected' }];
  const warning = { file: '/project/src/a.ts', line: 3, column: 2, name: 'response', kind: 'variable', status: 'partial', code: 'TT_PARTIAL_ALIAS', category: 'warning', message: 'External aliases may bypass guards.' };
  const report = createCoverageReport(items, [warning, warning]);
  assert.equal(report.items[0].status, 'partial');
  assert.equal(report.warnings.length, 1);
  assert.equal(report.files[0].partial, 1);
  assert.equal(report.files[0].protected, 0);
  assert.doesNotThrow(() => JSON.stringify(report));
  const pretty = formatCoverageReport(report, '/project');
  assert.match(pretty, /src\/a.ts:3:2 warning TT_PARTIAL_ALIAS: response/);
  assert.match(pretty, /0 protected, 1 partial, 0 unsupported, 0 open/);
});

test('keeps intentionally open contracts separate and includes warnings outside initial analysis', () => {
  const items = [{ node: {}, file: '/project/a.ts', line: 1, column: 1, name: 'payload', kind: 'variable', status: 'open' }];
  const warning = { file: '/project/a.ts', line: 2, column: 1, name: 'compound', kind: 'expression', status: 'unsupported', code: 'TT_UNSUPPORTED_SYNTAX', category: 'warning', message: 'Compound assignment not instrumented.' };
  const report = createCoverageReport(items, [warning]);
  assert.equal(report.items.length, 2);
  assert.equal(report.files[0].open, 1);
  assert.equal(report.files[0].unsupported, 1);
  assert.equal(report.warnings.length, 1);
});
