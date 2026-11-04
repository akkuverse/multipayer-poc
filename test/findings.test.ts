import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, FIXTURE_VERSION } from '../src/scenarios.ts';
import { findingsTable } from '../src/evidence/findings.ts';

test('every scenario shows its expected observation locally', async () => {
  for (const s of scenarios) assert.equal(s.check(await s.run()), undefined, s.id);
});

test('the findings table names the fixture and settlement versions of its runs', async () => {
  const table = await findingsTable('run-test');
  assert.ok(table.startsWith(`Findings run-test, fixtures ${FIXTURE_VERSION}`));
  // Every row's local result names the settlement implementation and spec
  // version that produced it — the orchestrator and settlement-ledgers-1,
  // not the retired single-backend mock.
  const rows = table.split('\n').filter((l) => /^\| S\d/.test(l));
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    assert.match(cells[3], /settlement-orchestrator settlement-ledgers-1$/, cells[1]);
  }
});

test('the findings table never claims an ECB result from a local run', async () => {
  const table = await findingsTable('run-test');
  // '| S' plus a digit: excludes the header row '| Scenario | ...'.
  const rows = table.split('\n').filter((l) => /^\| S\d/.test(l));
  assert.equal(rows.length, scenarios.length);
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    assert.match(cells[3], /^observed\/pass/, cells[1]);
    assert.equal(cells[4], 'not tested', cells[1]);
  }
});
