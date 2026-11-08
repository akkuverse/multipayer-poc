import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scenarios,
  FIXTURE_VERSION,
  world,
  lunch,
  approveAs,
  submitAs,
  legChildKey,
  settlementOf,
  EMPLOYEE,
  EMPLOYER,
  MERCHANT_A,
} from '../src/scenarios.ts';
import { recordRun, settlementOf as settlementIdentityOf, traceDigest } from '../src/evidence/run-record.ts';
import type { RunRecord } from '../src/evidence/run-record.ts';

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
  // 2026.11-7: scenario-scoped worlds — each scenario builds only its
  // declared parties — so recorded runs say which fixtures produced them.
  assert.equal(FIXTURE_VERSION, '2026.11-7');
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

test('a historical record naming only `backend` still resolves its settlement identity', () => {
  // Records written before fixture 2026.11-4 carried `backend` for the
  // retired single-balance mock; readers must keep resolving them.
  const legacy: RunRecord = {
    runId: 'run-old',
    scenarioId: 'S01-both-approve',
    fixtureVersion: '2026.11-3',
    backend: { name: 'mock-backend', origin: 'LOCAL', specVersion: 'mock-3' },
    result: { state: 'completed', returnStatus: 'none', outstandingCents: 0 },
    traceDigest: '0'.repeat(16),
    events: [],
  };
  assert.deepEqual(settlementIdentityOf(legacy), { name: 'mock-backend', origin: 'LOCAL', specVersion: 'mock-3' });
  // A record naming neither field is malformed, not silently anonymous.
  const { backend: _drop, ...nameless } = legacy;
  assert.throws(() => settlementIdentityOf(nameless as RunRecord), /names no settlement/);
});

test('digital-euro ledger events carry pseudonyms and providers, never payer identities or authority', async () => {
  const { w } = await byId('S01').run();
  const de = w.trace.events.filter((e) => e.actor === 'de-ledger');
  assert.ok(de.length > 0);
  const PAYER_KEYS = new Set(['payerId', 'payeeId', 'customerId', 'employeeId', 'approvalRef', 'mandateRef', 'authority', 'authorityRef', 'signature', 'keyId']);
  for (const e of de) {
    for (const k of Object.keys(e.detail ?? {})) assert.ok(!PAYER_KEYS.has(k), `${e.event} leaks ${k}`);
    for (const [k, v] of Object.entries(e.detail ?? {})) {
      if (k === 'pseudonym') assert.match(v as string, /^ps-/, `${e.event} pseudonym`);
      if (k === 'provider') assert.match(v as string, /^psp-/, `${e.event} provider`);
    }
  }
  // The group's own event names only its key and member hold references.
  const group = de.find((e) => e.event === 'de_group_committed')!;
  assert.deepEqual(Object.keys(group.detail!).sort(), ['key', 'members']);
});

test('orchestrator and provider emit distinct events for the same leg work', async () => {
  const { w } = await byId('S01').run();
  // The orchestrator tracks per-leg progress by role; the provider reports
  // the operation key, its reference, the payer and the rail. Neither
  // duplicates the other: the leg_reserve events checked here never name a
  // payer (other orchestrator events may — it is not a pseudonymous
  // surface), and the provider never claims the leg-level verdict.
  const orch = w.trace.events.filter((e) => e.actor === 'orchestrator' && e.event === 'leg_reserve');
  assert.ok(orch.some((e) => e.detail?.role === 'employee' && e.detail?.status === 'succeeded'));
  assert.ok(orch.every((e) => e.detail?.payerId === undefined));
  const emp = w.trace.events.find((e) => e.actor === 'psp-employee-1' && e.event === 'provider_reserve_done')!;
  assert.equal(emp.detail?.payerId, EMPLOYEE);
  assert.equal(emp.detail?.rail, 'digital_euro');
  const er = w.trace.events.find((e) => e.actor === 'psp-employer-1' && e.event === 'provider_reserve_done')!;
  assert.equal(er.detail?.payerId, EMPLOYER);
  assert.equal(er.detail?.rail, 'bank');
  assert.notEqual(emp.detail?.key, er.detail?.key);
});

test('an unresolved recovery keeps its exposure visible in the run record', async () => {
  // S05's failure shape with the return's bank credit parked: the
  // committed employer share stays exposed and the return op unresolved,
  // until the deferred credit resolves and recovery confirms it.
  const w = world({ deCents: 300, reverseWaterfall: false });
  w.providers.get(EMPLOYER)!.setFault(legChildKey('purchase-1', 1, 'employer', 'return', 'bank'), 'credit', 'defer');
  const p = lunch(w, 1_300, MERCHANT_A, { settlementMode: 'independent' });
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  await w.coordinator.recover(p.purchaseId);
  const snap = settlementOf(w, p.purchaseId)!;
  assert.equal(p.state, 'recovery_required');
  assert.equal(p.returnStatus, 'unresolved');
  assert.equal(snap.exposureCents, 500);
  assert.equal(snap.principalReturnedCents, 0);
  assert.ok(snap.unresolved.length > 0, 'the parked return must appear as unresolved');
  const r = recordRun('run-test', 'recovery-exposure', w, p);
  assert.equal(r.result.outstandingCents, 500);
  // The parked credit applies; recovery then confirms the return.
  w.providers.get(EMPLOYER)!.resolveDeferred(legChildKey('purchase-1', 1, 'employer', 'return', 'bank'), 'apply');
  await w.coordinator.recover(p.purchaseId);
  const after = settlementOf(w, p.purchaseId)!;
  assert.equal(p.state, 'cancelled');
  assert.equal(after.exposureCents, 0);
  assert.equal(after.principalReturnedCents, 500);
});

test('a conclusively refused return reports the exposure it could not resolve', async () => {
  // S07: the employer provider has no return operation — the refusal is
  // conclusive, yet the committed EUR 5 stays reported as exposure.
  const { w, p } = await byId('S07').run();
  const snap = settlementOf(w, p.purchaseId)!;
  const leg = snap.legs.find((l) => l.role === 'employer')!;
  assert.equal(leg.returned?.status, 'rejected');
  assert.equal(leg.returned?.reason, 'unsupported');
  assert.equal(snap.exposureCents, 500);
  assert.equal(w.coordinator.outstandingCents(p.purchaseId), 500);
});

test('no local run records an ECB_API event', async () => {
  for (const s of scenarios) {
    const { w } = await s.run();
    assert.ok(w.trace.events.every((e) => e.origin === 'LOCAL'), s.id);
  }
});
