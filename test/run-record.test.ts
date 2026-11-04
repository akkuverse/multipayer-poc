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
  // every leg of an atomic group; without per-leg reasons in the submit
  // events their traces — and digests — were identical. Under per-payer
  // The settlement snapshot carries each leg's authoritative outcome: a
  // conclusive reserve refusal names its reason, and the atomic abort keeps
  // the untouched leg free of any fabricated outcome.
  const insufficient = await byId('S06').run();
  const declined = await byId('S11').run();
  const legOutcomes = (p: typeof insufficient.p) =>
    p.settlement!.legs.map((l) => `${l.payerId}:${l.refusal ?? l.reserve?.status ?? 'unstarted'}`);
  assert.deepEqual(legOutcomes(insufficient.p), ['employee-1:rejected', 'employer-1:unstarted']);
  assert.equal(insufficient.p.settlement!.legs[0].reserve?.reason, 'insufficient_funds');
  assert.deepEqual(legOutcomes(declined.p), ['employee-1:succeeded', 'employer-1:rejected']);
  assert.equal(declined.p.settlement!.legs[1].reserve?.reason, 'hold_rejected');
  assert.notEqual(traceDigest(insufficient.w.trace.events), traceDigest(declined.w.trace.events));
  // Independent mode rejects per leg: the failed share unwinds, the
  // employer's settled leg stands until explicit recovery.
  const partial = await byId('S05').run();
  const pLeg = partial.p.settlement!.legs.find((l) => l.role === 'employee')!;
  const eLeg = partial.p.settlement!.legs.find((l) => l.role === 'employer')!;
  assert.equal(pLeg.reserve?.status, 'rejected');
  assert.equal(pLeg.reserve?.reason, 'insufficient_funds');
  assert.equal(eLeg.settled, true);
});

test('a run record names its fixtures, settlement and outcome', async () => {
  const { w, p } = await byId('S16').run();
  const r = recordRun('run-test', 'S16-timeout-unknown', w, p);
  assert.equal(r.fixtureVersion, FIXTURE_VERSION);
  // settlement-ledgers-1: provider-owned books and explicit ledger-local
  // settlement replaced the single balance-owning backend.
  assert.deepEqual(r.settlement, { name: 'settlement-orchestrator', origin: 'LOCAL', specVersion: 'settlement-ledgers-1' });
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
  assert.equal(r.settlement.specVersion, 'settlement-ledgers-1', 'coordinator-only changes are not settlement capabilities');
});

test('no local run records an ECB_API event', async () => {
  for (const s of scenarios) {
    const { w } = await s.run();
    assert.ok(w.trace.events.every((e) => e.origin === 'LOCAL'), s.id);
  }
});
