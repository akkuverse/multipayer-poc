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

test('an automatic-payment scenario gives the same trace digest on every run', async () => {
  const a = await byId('S19').run();
  const b = await byId('S19').run();
  assert.equal(traceDigest(a.w.trace.events), traceDigest(b.w.trace.events));
});

test('different scenarios give different digests', async () => {
  const a = await byId('S01').run();
  const b = await byId('S06').run();
  assert.notEqual(traceDigest(a.w.trace.events), traceDigest(b.w.trace.events));
});

test('different rejection causes give different digests: the submit event carries per-leg reasons', async () => {
  // S06 (employee cannot fund) and S11 (employer PSP declines) both reject
  // every leg of an atomic group; without per-leg reasons in the submit event
  // their traces — and digests — were identical.
  const insufficient = await byId('S06').run();
  const declined = await byId('S11').run();
  const submitEvent = (events: typeof insufficient.w.trace.events) =>
    events.find((e) => e.actor === 'backend' && e.event === 'submit');
  assert.deepEqual(submitEvent(insufficient.w.trace.events)?.detail?.results, [
    'employee-1:rejected:group_rejected:insufficient_funds',
    'employer-1:rejected:group_rejected:insufficient_funds',
  ]);
  assert.deepEqual(submitEvent(declined.w.trace.events)?.detail?.results, [
    'employee-1:rejected:group_rejected:declined_by_payer_psp',
    'employer-1:rejected:group_rejected:declined_by_payer_psp',
  ]);
  assert.notEqual(traceDigest(insufficient.w.trace.events), traceDigest(declined.w.trace.events));
  // Independent mode rejects per leg, without the group_rejected prefix.
  const partial = await byId('S05').run();
  assert.deepEqual(submitEvent(partial.w.trace.events)?.detail?.results, [
    'employee-1:rejected:insufficient_funds',
    'employer-1:settled',
  ]);
});

test('a run record names its fixtures, backend and outcome', async () => {
  const { w, p } = await byId('S16').run();
  const r = recordRun('run-test', 'S16-timeout-unknown', w, p);
  assert.equal(r.fixtureVersion, FIXTURE_VERSION);
  // mock-3: pre-dispatch account validation now refuses with
  // RequestRefusedError instead of a generic Error — observable semantics
  // changed, so the run record's assumption label moved.
  assert.deepEqual(r.backend, { name: 'mock-backend', origin: 'LOCAL', specVersion: 'mock-3' });
  assert.equal(r.result.state, 'completed');
  assert.match(r.traceDigest, /^[0-9a-f]{16}$/);
  assert.equal(r.events.length, w.trace.events.length);
});

test('a run record carries the calendar/window fixture settings that make the run reproducible', async () => {
  const { w, p } = await byId('S19').run();
  const r = recordRun('run-test', 'S19-autopay-within', w, p);
  // Booking months and dispute deadlines derive from these settings: they
  // must travel with the record, or a replay cannot reproduce them.
  assert.deepEqual(r.fixtureSettings, { calendarEpoch: '2026-01-01T00:00:00Z', disputeWindowMinutes: 1_440 });
  assert.equal(r.backend.specVersion, 'mock-3', 'coordinator-only changes are not backend capabilities');
});

test('no local run records an ECB_API event', async () => {
  for (const s of scenarios) {
    const { w } = await s.run();
    assert.ok(w.trace.events.every((e) => e.origin === 'LOCAL'), s.id);
  }
});
