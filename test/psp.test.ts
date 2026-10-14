// Per-payer PSP initiation (docs/initiation-model.md): each payer's simulated
// PSP submits its own leg, the backend assembles atomic groups by a deadline,
// and an unavailable PSP refuses before anything is forwarded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, lunch, approveAs, advance, ASSEMBLY_WINDOW, EMPLOYEE, EMPLOYER } from '../src/scenarios.ts';
import { PspUnavailableError, SimulatedPsp } from '../src/psp.ts';
import type { SettlementBackend } from '../src/backend.ts';

const perPsp = () => world({}, {}, { initiation: 'per_payer_psp' });

test('a PSP that comes back can complete an assembling group with the same keys', async () => {
  const w = perPsp();
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  assert.equal(w.backend.executionCount(), 1);
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p);
  await w.coordinator.reconcile(p);
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
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.legs[0].status, 'unknown');
  assert.equal(p.legs[1].status, 'rejected');
  // Flip availability and retry. The employee PSP now refuses, but its
  // earlier submission still stands: the leg must stay 'unknown'. Fabricating
  // 'rejected' would orphan money the backend is about to settle.
  w.psps.get(EMPLOYER)!.available = true;
  w.psps.get(EMPLOYEE)!.available = false;
  await w.coordinator.resubmit(p);
  assert.equal(p.legs[0].status, 'unknown', 'refused retry must not retract a submitted leg');
  assert.equal(p.legs[1].status, 'settled');
  // The unreachable PSP cannot answer, but must not abort the reconcile loop.
  await w.coordinator.reconcile(p);
  assert.equal(p.legs[0].status, 'unknown');
  assert.equal(p.state, 'pending');
  // With the PSP back, the status query recovers the leg's true outcome: the
  // group assembled on the employer's resubmission and settled the employee
  // share too — no settled money is left unaccounted for.
  w.psps.get(EMPLOYEE)!.available = true;
  await w.coordinator.reconcile(p);
  assert.equal(p.legs[0].status, 'settled');
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_200);
});

test('a leg that arrives after the assembly deadline fails the whole group', async () => {
  const w = perPsp();
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p);
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});

test('a refund through an unavailable PSP keeps what was returned and completes on retry', async () => {
  const w = perPsp();
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'completed');
  w.psps.get(EMPLOYER)!.available = false;
  await assert.rejects(() => w.coordinator.refund(p), PspUnavailableError);
  assert.deepEqual(p.legs.map((l) => l.status), ['returned', 'settled']);
  assert.equal(p.returnStatus, 'none');
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.refund(p);
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
  await w.coordinator.submit(p, 'independent');
  assert.deepEqual(p.legs.map((l) => l.status), ['unknown', 'rejected']);
  assert.equal(p.state, 'pending');
  // The employer PSP now refuses the retry, but the backend's rejection
  // already stands: 'unknown' would downgrade a conclusive outcome.
  w.psps.get(EMPLOYER)!.available = false;
  await w.coordinator.resubmit(p);
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
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  assert.deepEqual(p.legs.map((l) => l.status), ['unknown', 'unknown']);
  assert.equal(w.backend.executionCount(), 1, 'only the employee leg was submitted');
  assert.ok(w.trace.events.some((e) => e.event === 'submit_leg_error'));
  // A retry with the same keys completes the group once the PSP is healthy;
  // the early submitter learns the outcome through a status query.
  w.psps.set(EMPLOYER, new SimulatedPsp('psp-employer-1', w.backend, w.trace));
  await w.coordinator.resubmit(p);
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.executionCount(), 2);
});
