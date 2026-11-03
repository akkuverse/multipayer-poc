// Per-payer PSP initiation (docs/initiation-model.md): each payer's simulated
// PSP submits its own leg, the backend assembles atomic groups by a deadline,
// and an unavailable PSP refuses before anything is forwarded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, lunch, approveAs, advance, ASSEMBLY_WINDOW, EMPLOYEE, EMPLOYER, MERCHANT_A } from '../src/scenarios.ts';
import { PspUnavailableError, SimulatedPsp } from '../src/settlement/psp.ts';
import type { SettlementBackend } from '../src/settlement/backend.ts';

const perPsp = () => world({}, {}, { initiation: 'per_payer_psp' });

test('a PSP that comes back can complete an assembling group with the same keys', async () => {
  const w = perPsp();
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(p.state, 'pending');
  assert.equal(w.backend.executionCount(), 1);
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.executionCount(), 2, 'one execution per key');
});

test('a refused retry does not mark an in-flight leg rejected; reconcile still learns its outcome', async () => {
  const w = perPsp();
  // Employer PSP down: the employee leg is submitted and waits in the group,
  // the employer leg is refused before reaching the backend.
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(p.legs[0].status, 'unknown');
  assert.equal(p.legs[1].status, 'rejected');
  // Flip availability and retry. The employee PSP now refuses, but its
  // earlier submission still stands: the leg must stay 'unknown'. Fabricating
  // 'rejected' would orphan money the backend is about to settle.
  w.psps.get(EMPLOYER)!.available = true;
  w.psps.get(EMPLOYEE)!.available = false;
  await w.coordinator.resubmit(p.purchaseId);
  // The refused replay over a handed-off leg keeps its outcome but is not
  // silent: the error reaches the trace as evidence.
  assert.ok(w.trace.events.some((e) => e.event === 'submit_leg_error' && e.detail?.payerId === EMPLOYEE));
  assert.equal(p.legs[0].status, 'unknown', 'refused retry must not retract a submitted leg');
  assert.equal(p.legs[1].status, 'settled');
  // The unreachable PSP cannot answer, but must not abort the reconcile loop.
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.legs[0].status, 'unknown');
  assert.equal(p.state, 'pending');
  // With the PSP back, the status query recovers the leg's true outcome: the
  // group assembled on the employer's resubmission and settled the employee
  // share too — no settled money is left unaccounted for.
  w.psps.get(EMPLOYEE)!.available = true;
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.legs[0].status, 'settled');
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_200);
});

test('a leg that arrives after the assembly deadline fails the whole group', async () => {
  const w = perPsp();
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});

test('a refund through an unavailable PSP keeps what was returned and completes on retry', async () => {
  const w = perPsp();
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  w.psps.get(EMPLOYER)!.available = false;
  await assert.rejects(() => w.coordinator.refund(p.purchaseId), PspUnavailableError);
  assert.deepEqual(p.legs.map((l) => l.status), ['returned', 'settled']);
  assert.equal(p.returnStatus, 'partial');
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.refund(p.purchaseId);
  assert.equal(p.returnStatus, 'completed');
  assert.deepEqual(p.legs.map((l) => l.status), ['returned', 'returned']);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});

test('a refused retry keeps a conclusive backend rejection instead of downgrading it', async () => {
  const w = perPsp();
  w.backend.faults.set(EMPLOYEE, 'timeout_then_reject');
  w.backend.faults.set(EMPLOYER, 'decline');
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'independent');
  assert.deepEqual(p.legs.map((l) => l.status), ['unknown', 'rejected']);
  assert.equal(p.state, 'pending');
  // The employer PSP now refuses the retry, but the backend's rejection
  // already stands: 'unknown' would downgrade a conclusive outcome.
  w.psps.get(EMPLOYER)!.available = false;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'declined_by_payer_psp');
  assert.equal(p.state, 'pending');
});

test('a mid-send adapter failure leaves the leg unknown, not orphaned, and a retry resolves it', async () => {
  const w = perPsp();
  // An adapter that fails mid-forward is indistinguishable from a lost
  // response: the leg may have reached the backend, so it is 'unknown',
  // never a fabricated terminal status.
  const exploding: SettlementBackend = {
    get name() {
      return 'exploding';
    },
    get origin() {
      return 'LOCAL';
    },
    get specVersion() {
      return 'stub';
    },
    submit: () => Promise.reject(new Error('adapter exploded')),
    status: (ref: string) => w.backend.status(ref),
    refund: (ref: string) => w.backend.refund(ref),
  };
  w.psps.set(EMPLOYER, exploding);
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(p.state, 'pending');
  assert.deepEqual(p.legs.map((l) => l.status), ['unknown', 'unknown']);
  assert.equal(w.backend.executionCount(), 1, 'only the employee leg was submitted');
  assert.ok(w.trace.events.some((e) => e.event === 'submit_leg_error'));
  // A retry with the same keys completes the group once the PSP is healthy;
  // the early submitter learns the outcome through a status query.
  w.psps.set(EMPLOYER, new SimulatedPsp('psp-employer-1', w.backend, w.trace));
  await w.coordinator.resubmit(p.purchaseId);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.executionCount(), 2);
});

test('a payer with no PSP fails loudly before any leg is forwarded', async () => {
  const w = perPsp();
  w.psps.delete(EMPLOYER);
  const p = lunch(w);
  approveAs(w, p);
  await assert.rejects(() => w.coordinator.submit(p.purchaseId, 'atomic'), /no PSP for payer/);
  assert.equal(w.backend.executionCount(), 0);
  assert.equal(p.state, 'ready');
});

test('a backend that returns no outcome for a leg leaves it unknown, not planned', async () => {
  const w = perPsp();
  const silent: SettlementBackend = {
    get name() {
      return 'silent';
    },
    get origin() {
      return 'LOCAL';
    },
    get specVersion() {
      return 'stub';
    },
    submit: () => Promise.resolve([]),
    status: (ref: string) => w.backend.status(ref),
    refund: (ref: string) => w.backend.refund(ref),
  };
  w.psps.set(EMPLOYER, silent);
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  // The leg may have been processed without a reported outcome: 'unknown'
  // keeps it pending, never 'planned' where derive() would ignore it.
  assert.equal(p.legs[1].status, 'unknown');
  assert.equal(p.state, 'pending');
});

test('a lost response through the PSP route keeps the purchase pending and the replay dedupes', async () => {
  const w = perPsp();
  const p = lunch(w);
  approveAs(w, p);
  // The employee leg reaches the backend and waits in the assembling group,
  // but its response never arrives at the PSP: the leg is 'unknown' with no
  // execution reference — handed off, yet unresolvable by a status query.
  const submit = w.backend.submit.bind(w.backend);
  let loseResponse = true;
  w.backend.submit = async (request) => {
    const response = await submit(request);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('synthetic lost submission response');
    }
    return response;
  };
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(p.state, 'pending');
  assert.equal(p.legs[0].status, 'unknown');
  assert.equal(p.legs[0].executionRef, undefined, 'the response was lost before the reference arrived');
  assert.equal(p.legs[1].status, 'settled');
  assert.equal(w.backend.executionCount(), 2);
  // The same-key replay is deduplicated: it discovers the original execution
  // instead of creating a second payment.
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.executionCount(), 2, 'no extra executions');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300);
});

test('a replay of a handed-off leg uses its frozen authorization, not the current one', async () => {
  const w = perPsp();
  const p = lunch(w);
  approveAs(w, p);
  const submit = w.backend.submit.bind(w.backend);
  let loseResponse = true;
  w.backend.submit = async (request) => {
    const response = await submit(request);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('synthetic lost submission response');
    }
    return response;
  };
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(p.state, 'pending');
  // The employee approval has expired since dispatch — but the leg was
  // already handed off: absence of an executionRef is not absence of
  // dispatch, so the replay is not a new initiation needing live authority.
  advance(w, p.proposal.expiresAt + 1);
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.executionCount(), 2);
});

test('a refused replay never overwrites a settled leg', async () => {
  const w = perPsp();
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  // Both PSPs refuse the retry, but the legs were already handed off and
  // settled: the refused replay must not downgrade their recorded outcomes.
  w.psps.get(EMPLOYEE)!.available = false;
  w.psps.get(EMPLOYER)!.available = false;
  await w.coordinator.resubmit(p.purchaseId);
  assert.deepEqual(p.legs.map((l) => l.status), ['settled', 'settled']);
  assert.equal(p.state, 'completed');
});

test('a re-sent refused leg whose response omits its outcome is unknown, not stranded rejected', async () => {
  const w = perPsp();
  // Employer PSP down: the employer leg is refused before reaching the
  // backend — recorded 'rejected', never handed off.
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(p.legs[1].status, 'rejected');
  // The leg's first handoff now reaches the backend — the group completes and
  // settles — but the route response drops its outcome. Leaving the leg at
  // 'rejected' would strand committed money where reconcile() never queries
  // and recover() never returns: it is 'unknown' instead.
  const key = p.legs[1].idempotencyKey;
  const lossy: SettlementBackend = {
    get name() {
      return 'lossy';
    },
    get origin() {
      return 'LOCAL';
    },
    get specVersion() {
      return 'stub';
    },
    submit: (req) => w.backend.submit(req).then((rs) => rs.filter((r) => r.idempotencyKey !== key)),
    status: (ref: string) => w.backend.status(ref),
    refund: (ref: string) => w.backend.refund(ref),
  };
  w.psps.set(EMPLOYER, lossy);
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[1].status, 'unknown', 'a handed-off leg with no reported outcome is not conclusively rejected');
  assert.equal(w.backend.executionCount(), 2, 'the leg really was processed');
  // The next replay through a healthy route dedupes on the same key and
  // discovers the outcome the earlier response dropped.
  w.psps.set(EMPLOYER, new SimulatedPsp('psp-employer-1', w.backend, w.trace));
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.executionCount(), 2, 'no extra executions');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300);
});

test('a deferred atomic group resolves every leg on the first status query', async () => {
  const w = perPsp();
  w.backend.faults.set(EMPLOYEE, 'timeout_then_settle');
  w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.deepEqual(p.legs.map((l) => l.status), ['unknown', 'unknown']);
  // One status query resolves the whole group atomically: the employer's
  // leg settles before its own PSP ever asks.
  await w.psps.get(EMPLOYEE)!.status(p.legs[0].executionRef!);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000 - 500);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000 - 800);
});
