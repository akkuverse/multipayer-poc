import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../src/scenarios.ts';
import { findingsTable } from '../src/findings.ts';

test('every scenario shows its expected observation locally', async () => {
  for (const s of scenarios) assert.equal(s.check(await s.run()), undefined, s.id);
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
