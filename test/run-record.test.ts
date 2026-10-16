import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, FIXTURE_VERSION } from '../src/scenarios.ts';
import { recordRun, traceDigest } from '../src/evidence/run-record.ts';

const byId = (id: string) => scenarios.find((s) => s.id.startsWith(id))!;

test('the same scenario gives the same trace digest on every run', async () => {
  const a = await byId('S01').run();
  const b = await byId('S01').run();
  assert.equal(traceDigest(a.w.trace.events), traceDigest(b.w.trace.events));
});

test('different scenarios give different digests', async () => {
  const a = await byId('S01').run();
  const b = await byId('S04').run();
  assert.notEqual(traceDigest(a.w.trace.events), traceDigest(b.w.trace.events));
});

test('a run record names its fixtures, backend and outcome', async () => {
  const { w, p } = await byId('S09').run();
  const r = recordRun('run-test', 'S09-timeout-unknown', w, p);
  assert.equal(r.fixtureVersion, FIXTURE_VERSION);
  assert.deepEqual(r.backend, { name: 'mock-backend', origin: 'LOCAL', specVersion: 'mock-2' });
  assert.equal(r.result.state, 'completed');
  assert.match(r.traceDigest, /^[0-9a-f]{16}$/);
  assert.equal(r.events.length, w.trace.events.length);
});

test('no local run records an ECB_API event', async () => {
  for (const s of scenarios) {
    const { w } = await s.run();
    assert.ok(w.trace.events.every((e) => e.origin === 'LOCAL'), s.id);
  }
});
