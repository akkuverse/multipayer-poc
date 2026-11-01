// Regression tests for the defects listed in docs/backlog.md (B1–B13).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, world, lunch, approveAs, updateMandate, updateEmployeeMandate, advance, ASSEMBLY_WINDOW, AUTO_EMPLOYEE_TERMS, EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_B, MERCHANT_C } from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';
import { approvalCents, approvalFeeCents, shareCents } from '../src/core/coordinator.ts';
import { FEE_COLLECTOR } from '../src/settlement/mock-backend.ts';
import { MINUTES_PER_DAY } from '../src/core/ledger.ts';
import { signPayload } from '../src/core/signing.ts';

const run = async (id: string) => {
  const s = scenarios.find((x) => x.id.startsWith(id));
  if (!s) throw new Error(`no scenario ${id}`);
  return s.run();
};

test('B1 fees default to zero and are bound in the approval', async () => {
  const { p } = await run('S01');
  assert.ok(p.proposal.shares.every((s) => s.feeCents === 0));
  assert.equal(p.authorizations[0]?.basis === 'device' ? p.authorizations[0].approval.payload.feeCents : undefined, 0);
  assert.deepEqual(p.legs.map((l) => l.feeCents), [0, 0]);
});

test('B1 a non-zero fee is paid by the employee on top of the total and counts against their instruction', async () => {
  const w = world();
  const p = lunch(w, 1_300, MERCHANT_A, { feesCents: 20 });
  // EUR 8 share + EUR 0.20 fee is above the standing EUR 8 maximum.
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.employeeAssessment?.authZone, 'Exception');
  updateEmployeeMandate(w, { maxCents: 820 });
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300, 'the merchant receives exactly the total');
  assert.equal(w.backend.account(FEE_COLLECTOR).linkedBankCents, 20);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000 - 820);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000 - 500, 'the employer never pays the employee fee');
});

test('B1 a missing fee-collector account throws before any money moves', async () => {
  const w = world();
  w.backend.accounts.delete(FEE_COLLECTOR);
  const p = lunch(w, 1_300, MERCHANT_A, { feesCents: 20 });
  updateEmployeeMandate(w, { maxCents: 820 });
  approveAs(w, p);
  await assert.rejects(() => w.coordinator.submit(p, 'atomic'), /unknown account psp-fees/);
  // The settlement failed atomically: neither leg debited, nothing credited.
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYEE).linkedBankCents, 50_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0);
  // Legs are cleared with the released benefit reservation: a resubmit cannot
  // execute them — the only way forward is submit() and its full recheck.
  await assert.rejects(() => w.coordinator.resubmit(p), /nothing to resubmit/);
});

test('B3 a mandate granted to another employee funds nothing', async () => {
  const w = world({}, { beneficiaryRef: 'employee-2' });
  const p = lunch(w);
  assert.equal(shareCents(p.proposal, 'employer'), 0);
  assert.equal(p.state, 'awaiting_approvals', 'EUR 13 alone exceeds the EUR 8 maximum');
  assert.equal(p.employeeAssessment?.authZone, 'Exception');
  const proposal = w.trace.events.find((e) => e.event === 'proposal');
  assert.equal(proposal?.detail?.ineligibleReason, 'beneficiary_mismatch');
});

test('B3 the beneficiary is rechecked at initiation', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  updateMandate(w, { beneficiaryRef: 'employee-2' });
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'failed');
  assert.equal(p.reason, 'employer_authority_invalid:beneficiary_mismatch');
  assert.equal(w.backend.executionCount(), 0);
});

test('B4 an approval cannot outlive the proposal it binds to', async () => {
  const w = world();
  const p = lunch(w);
  const q = p.proposal;
  const approval = {
    approvalRef: 'appr-long',
    purchaseId: p.purchaseId,
    payerId: EMPLOYEE,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, EMPLOYEE),
    feeCents: approvalFeeCents(q, EMPLOYEE),
    // The discriminant is present so the expiry binding — not a missing
    // basis — is what the rejection exercises.
    basis: 'device',
    expiresAt: q.expiresAt + 1_000,
  };
  assert.throws(() => w.coordinator.approve(p, signPayload(approval, w.signers.get(EMPLOYEE)!)), /does not match/);
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.authorizations.length, 0);
});

test('B4 an approval that has already expired is rejected', async () => {
  const w = world();
  const p = lunch(w);
  advance(w, p.proposal.expiresAt + 1);
  assert.throws(() => approveAs(w, p), /does not match/);
});

test('B2 a completed purchase uses up the day\'s subsidised meal', async () => {
  const w = world();
  const a = lunch(w);
  approveAs(w, a);
  await w.coordinator.submit(a, 'atomic');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(shareCents(b.proposal, 'employer'), 0);
});

test('B2 a failed purchase releases its reservation', async () => {
  const w = world();
  w.backend.faults.set(EMPLOYER, 'decline');
  const a = lunch(w);
  approveAs(w, a);
  await w.coordinator.submit(a, 'atomic');
  assert.equal(a.state, 'failed');
  assert.equal(w.coordinator.ledger.state('purchase-1'), undefined);
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(shareCents(b.proposal, 'employer'), 500);
});

test('B2 a purchase cancelled after recovery releases its reservation', async () => {
  // The employee leg cannot fund its share; the employer leg settles alone.
  const w = world({ deCents: 300, reverseWaterfall: false });
  const a = lunch(w);
  approveAs(w, a);
  await w.coordinator.submit(a, 'independent');
  assert.equal(a.state, 'recovery_required');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
  // Returning the settled leg leaves every obligation resolved: cancelled,
  // and the day's subsidised meal is free for the next purchase.
  await w.coordinator.recover(a);
  assert.equal(a.state, 'cancelled');
  assert.equal(w.coordinator.ledger.state('purchase-1'), undefined);
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(shareCents(b.proposal, 'employer'), 500);
});

test('B2 a pending purchase keeps its reservation', async () => {
  const w = world();
  w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
  const a = lunch(w);
  approveAs(w, a);
  await w.coordinator.submit(a, 'atomic');
  assert.equal(a.state, 'pending');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
});

test('B2 a full refund gives the meal benefit back', async () => {
  const { w } = await run('S10');
  assert.equal(w.coordinator.ledger.state('purchase-1'), undefined);
});

test('B2 the benefit renews on the next working day', async () => {
  const w = world({}, { validUntil: 10 * MINUTES_PER_DAY });
  const a = lunch(w);
  approveAs(w, a);
  await w.coordinator.submit(a, 'atomic');
  advance(w, MINUTES_PER_DAY + 10);
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(shareCents(b.proposal, 'employer'), 500);
});

test('B5 two purchases in flight cannot both draw the day\'s benefit', async () => {
  const w = world();
  const a = lunch(w);
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(shareCents(b.proposal, 'employer'), 500, 'both proposals see the benefit before either submits');
  approveAs(w, a);
  approveAs(w, b);
  await w.coordinator.submit(a, 'atomic');
  const executionsBeforeB = w.backend.executionCount();
  await w.coordinator.submit(b, 'atomic');
  assert.equal(a.state, 'completed');
  assert.equal(b.state, 'failed');
  assert.equal(w.backend.executionCount(), executionsBeforeB, 'the rejected purchase executed nothing');
  assert.equal(b.reason, 'employer_authority_invalid:daily_purchase_limit_reached');
  assert.equal(shareCents(b.proposal, 'employee'), 800, 'the employee share did not grow');
});

test('B5 a per-purchase cap lowered after approval stops initiation', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  updateMandate(w, { maxPerPurchaseCents: 300 });
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'failed');
  assert.equal(p.reason, 'employer_authority_invalid:cap_exceeded');
  assert.equal(shareCents(p.proposal, 'employee'), 800);
  assert.equal(w.backend.executionCount(), 0);
});

test('B6 reconcile on a purchase with nothing submitted refuses instead of completing', async () => {
  // Found by test/invariants.property.test.ts (seed 1): with no legs, derive's
  // every-leg-settled check was vacuously true, so a status query alone marked
  // the purchase completed without any money moving.
  const w = world();
  const p = lunch(w);
  await assert.rejects(() => w.coordinator.reconcile(p), /nothing to reconcile/);
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(w.backend.executionCount(), 0);
});

test('B6 a zero-amount proposal is refused instead of completing vacuously', () => {
  // Same vacuous-truth family: zero legs, all-settled check trivially true.
  const w = world();
  assert.throws(
    () =>
      w.coordinator.propose({
        purchaseId: 'purchase-1',
        employeeId: EMPLOYEE,
            mandateRef: 'mandate-1',
        merchantId: MERCHANT_A,
        totalCents: 0,
        expiresAt: 100,
      }),
    /positive integer cents/,
  );
});

test('B5 the recheck counts usage on the day of initiation, not of the proposal', async () => {
  const w = world({}, { validUntil: 10 * MINUTES_PER_DAY });
  const expiresAt = 10 * MINUTES_PER_DAY;
  // Proposed and approved on day 0, submitted on day 1.
  const late = lunch(w, 1_300, MERCHANT_A, { expiresAt });
  approveAs(w, late);
  advance(w, MINUTES_PER_DAY + 10);
  // Day 1's subsidised meal is used by another purchase first.
  const other = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2', expiresAt });
  approveAs(w, other);
  await w.coordinator.submit(other, 'atomic');
  const executionsBeforeLate = w.backend.executionCount();
  await w.coordinator.submit(late, 'atomic');
  assert.equal(other.state, 'completed');
  assert.equal(late.state, 'failed');
  assert.equal(w.backend.executionCount(), executionsBeforeLate);
  assert.equal(late.reason, 'employer_authority_invalid:daily_purchase_limit_reached');
});

test('B7 resubmit cannot reopen a failed purchase under revoked authority', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.psps.get(EMPLOYER)!.available = false;
  w.psps.get(EMPLOYEE)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.executionCount(), 0);
  // Authority revoked and PSPs back: a retry would be the legs' first
  // initiation, so resubmit must refuse — not settle under a dead mandate.
  updateMandate(w, { revoked: true });
  w.psps.get(EMPLOYER)!.available = true;
  w.psps.get(EMPLOYEE)!.available = true;
  await assert.rejects(() => w.coordinator.resubmit(p), /cannot resubmit in state failed/);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.executionCount(), 0);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});

test('B7 a refused leg re-initiates only while its mandate still holds', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  // The employer leg never reached the backend: resubmit is its first
  // initiation, so the same recheck submit() runs applies — and refuses the
  // leg again instead of sending it under a dead mandate. The refusal is
  // recorded on the leg, never as a whole-purchase failure: the employee leg
  // already handed off still decides the outcome.
  updateMandate(w, { revoked: true });
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p);
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'employer_authority_invalid:mandate_revoked');
  assert.equal(w.backend.executionCount(), 1, 'the refused leg was never handed off');
  assert.equal(p.state, 'pending');
  // The assembly deadline still resolves the purchase with nothing committed.
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});

test('B7 resubmit cannot reopen recovery or a cancelled purchase', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'independent');
  assert.equal(p.state, 'recovery_required');
  // Recovery has one exit — recover() — not a retry that could re-commit.
  await assert.rejects(() => w.coordinator.resubmit(p), /cannot resubmit in state recovery_required/);
  await w.coordinator.recover(p);
  assert.equal(p.state, 'cancelled');
  w.psps.get(EMPLOYER)!.available = true;
  await assert.rejects(() => w.coordinator.resubmit(p), /cannot resubmit in state cancelled/);
  assert.equal(p.state, 'cancelled');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
});

test('B7 a refused approval-funded leg re-initiates only before its approval expires', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.psps.get(EMPLOYEE)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  assert.equal(p.legs[0].rejectReason, 'psp_unavailable');
  // The employee leg never reached the backend; resubmit is its first
  // initiation, so the expired approval refuses it in place — recorded on the
  // leg while the already handed-off employer leg keeps its outcome.
  advance(w, 150);
  await w.coordinator.resubmit(p);
  assert.equal(p.legs[0].status, 'rejected');
  assert.equal(p.legs[0].rejectReason, 'approval_expired:employee-1');
  assert.equal(w.backend.executionCount(), 1, 'the refused leg was never handed off');
  assert.equal(p.state, 'pending');
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'failed');
});

test('B7 the resubmit recheck follows the share kind, not a payer-chosen approvalRef', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const p = lunch(w);
  const q = p.proposal;
  // The employee signs a valid approval but names it after the mandate: the
  // leg must still be rechecked as approval-funded, not routed to the
  // mandate check by the stored ref string.
  const approval = {
    approvalRef: 'mandate-1',
    purchaseId: p.purchaseId,
    payerId: EMPLOYEE,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, EMPLOYEE),
    feeCents: approvalFeeCents(q, EMPLOYEE),
    expiresAt: q.expiresAt,
    basis: 'device',
  };
  w.coordinator.approve(p, signPayload(approval, w.signers.get(EMPLOYEE)!));
  w.psps.get(EMPLOYEE)!.available = false;
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  advance(w, 150);
  await w.coordinator.resubmit(p);
  assert.equal(p.legs[0].status, 'rejected');
  assert.equal(p.legs[0].rejectReason, 'approval_expired:employee-1');
});

test('B7 a refused mandate-funded leg replayed past the offer expiry is refused, not sent', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  // The employer leg never reached the backend; while it waited, the offer
  // died. A mandate can outlive the proposal it funds — an approval cannot —
  // so the first-handoff recheck must refuse this leg on the expired offer
  // instead of handing it off under a dead proposal.
  advance(w, p.proposal.expiresAt + 1);
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p);
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'offer_expired');
  assert.equal(w.backend.executionCount(), 1, 'the refused leg was never handed off');
  assert.equal(p.state, 'pending');
  // The original assembly deadline resolves the group with nothing committed.
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});

test('B8 a bad account in a later leg throws before any leg settles', async () => {
  const w = world();
  w.backend.accounts.delete(FEE_COLLECTOR);
  const p = w.coordinator.proposeSplit({
    purchaseId: 'split-fee',
    merchantId: MERCHANT_A,
    shares: [
      { role: 'a', payerId: EMPLOYEE, amountCents: 100 },
      { role: 'b', payerId: EMPLOYER, amountCents: 100, feeCents: 5 },
    ],
    expiresAt: 100,
  });
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, EMPLOYER);
  // The fee on the second leg names a missing account: the request must
  // throw before the first leg's debit, not between legs.
  await assert.rejects(() => w.coordinator.submit(p, 'independent'), /unknown account psp-fees/);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0);
});

test('B8 an account deleted mid-assembly still fails the group atomically', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const p = w.coordinator.proposeSplit({
    purchaseId: 'split-assembly',
    merchantId: MERCHANT_A,
    shares: [
      { role: 'a', payerId: EMPLOYEE, amountCents: 100, feeCents: 5 },
      { role: 'b', payerId: EMPLOYER, amountCents: 100 },
    ],
    expiresAt: 100,
  });
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, EMPLOYER);
  w.psps.get(EMPLOYER)!.available = false;
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  // The fee collector vanishes between the first leg's arrival and the
  // group completing: completion throws before the first debit, and the
  // group stays alive so the deadline can still resolve it.
  w.backend.accounts.delete(FEE_COLLECTOR);
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p);
  await w.coordinator.resubmit(p);
  advance(w, 20);
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYEE).linkedBankCents, 50_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0);
});

test('B9 a refunded purchase stays completed under reconcile and resubmit', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  await w.coordinator.refund(p);
  assert.equal(p.returnStatus, 'completed');
  assert.equal(p.state, 'completed');
  // Returned legs of a completed purchase still count as settled: the return
  // is recorded separately, so no derive pass may relabel the purchase.
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'completed');
  await w.coordinator.resubmit(p);
  assert.equal(p.state, 'completed');
});

test('B10 a reused purchaseId cannot complete a different purchase', async () => {
  const w = world();
  const a = lunch(w, 1_300, MERCHANT_A);
  approveAs(w, a);
  await w.coordinator.submit(a, 'atomic');
  assert.equal(a.state, 'completed');
  // A second purchase reusing the id never reaches the backend: its employer
  // share needs a reservation, and the entry under that purchaseId is a's,
  // so reserve() refuses before any colliding idempotency key is sent.
  const b = lunch(w, 1_300, MERCHANT_B);
  approveAs(w, b);
  await assert.rejects(() => w.coordinator.submit(b, 'atomic'), /conflicting benefit reservation/);
  assert.equal(b.state, 'ready');
  // The refusal must not have touched a's ledger entry, and b's merchant was
  // never paid.
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  assert.equal(w.backend.account(MERCHANT_B).linkedBankCents, 0);
  // The day's benefit stays used: a third purchase draws nothing.
  const c = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(shareCents(c.proposal, 'employer'), 0);
});

test('B10 the backend still refuses a reused key with different terms', async () => {
  const w = world();
  const a = lunch(w);
  approveAs(w, a);
  await w.coordinator.submit(a, 'atomic');
  assert.equal(a.state, 'completed');
  // A split purchase holds no benefit reservation, so reserve() is not in
  // the way and the colliding key reaches the backend — which refuses the
  // mismatched terms rather than deduping into a purchase that never paid
  // its merchant.
  const b = w.coordinator.proposeSplit({
    purchaseId: 'purchase-1',
    merchantId: MERCHANT_B,
    shares: [{ role: 'employee', payerId: EMPLOYEE, payeeId: MERCHANT_B, amountCents: 1_300 }],
    expiresAt: 100,
  });
  approveAs(w, b);
  await assert.rejects(() => w.coordinator.submit(b, 'atomic'), /idempotency key reused/);
  // A split holds no reservation of its own; the throw must not release
  // the consumed benefit a still owns under the shared purchaseId.
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  assert.equal(b.state, 'ready');
  assert.equal(w.backend.account(MERCHANT_B).linkedBankCents, 0);
});

test('B12 a colliding purchase cannot release a live reservation', async () => {
  const w = world();
  w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
  const a = lunch(w);
  approveAs(w, a);
  await w.coordinator.submit(a, 'atomic');
  assert.equal(a.state, 'pending');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
  // A split purchase holds no reservation, so its submission reaches the
  // backend and is refused there. The thrown submit must not release the
  // live reservation a still holds under the reused purchaseId.
  const b = w.coordinator.proposeSplit({
    purchaseId: 'purchase-1',
    merchantId: MERCHANT_B,
    shares: [{ role: 'employee', payerId: EMPLOYEE, payeeId: MERCHANT_B, amountCents: 1_300 }],
    expiresAt: 100,
  });
  approveAs(w, b);
  await assert.rejects(() => w.coordinator.submit(b, 'atomic'), /idempotency key reused/);
  assert.equal(b.state, 'ready');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
});

test('B12 a refused leg under per-PSP initiation is rejected, not lost', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  // a submits at proposal v2 (the reprice bumps the version) so that b —
  // whose revised proposal also lands on v2 — mints the same idempotency
  // key carrying different terms.
  const a = lunch(w);
  w.coordinator.changeOffer(a, { merchantId: MERCHANT_A, totalCents: 1_300, expiresAt: 100 });
  approveAs(w, a);
  await w.coordinator.submit(a, 'atomic');
  await w.coordinator.reconcile(a);
  assert.equal(a.state, 'completed');
  updateMandate(w, { revoked: true });
  // Employee-only proposal: EUR 13 alone exceeds the EUR 8 maximum, so the
  // purchase waits in Exception until the employee raises their maximum.
  const b = lunch(w, 1_300, MERCHANT_B);
  assert.equal(b.state, 'awaiting_approvals');
  // Bump b's proposal to v2 (a mandate-only refresh never bumps) so it mints
  // the same idempotency key as a's v2 under different terms.
  w.coordinator.changeOffer(b, { merchantId: MERCHANT_B, totalCents: 1_300, expiresAt: 100 });
  updateEmployeeMandate(w, { maxCents: 1_300 });
  approveAs(w, b);
  await w.coordinator.submit(b, 'atomic');
  // The backend conclusively refused the reused key: 'rejected' resolves the
  // purchase, where 'unknown' would have left it pending forever.
  assert.equal(b.legs[0].status, 'rejected');
  assert.equal(b.legs[0].rejectReason, 'idempotency key reused with different terms');
  assert.equal(b.state, 'failed');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
});

test('B12 a partially colliding purchase cannot entangle another purchase\'s execution', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const a = lunch(w);
  approveAs(w, a);
  await w.coordinator.submit(a, 'atomic');
  await w.coordinator.reconcile(a);
  assert.equal(a.state, 'completed');
  // A split reusing the purchaseId: its employee leg carries a's exact terms
  // and dedupes into a's execution, while its employer leg differs and the
  // backend refuses it. Recording a's executionRef on b's leg would let
  // recover() refund money that belongs to a — the leg must be rejected
  // without the reference instead.
  const b = w.coordinator.proposeSplit({
    purchaseId: 'purchase-1',
    merchantId: MERCHANT_A,
    shares: [
      { role: 'employee', payerId: EMPLOYEE, payeeId: MERCHANT_A, amountCents: 800 },
      { role: 'employer', payerId: EMPLOYER, payeeId: MERCHANT_A, amountCents: 600 },
    ],
    expiresAt: 100,
  });
  approveAs(w, b, EMPLOYEE);
  approveAs(w, b, EMPLOYER);
  await w.coordinator.submit(b, 'atomic');
  assert.equal(b.legs[0].status, 'rejected');
  assert.equal(b.legs[0].rejectReason, 'execution_owned_by_another_purchase');
  assert.equal(b.legs[0].executionRef, undefined, 'a foreign reference is never recorded');
  assert.equal(b.state, 'failed');
  assert.equal(a.state, 'completed');
  assert.equal(await w.backend.status(a.legs[0].executionRef!), 'settled', "a's payment is untouched");
});

test('a changed offer still needs a merchant of record', () => {
  const w = world();
  const p = lunch(w);
  assert.equal(p.state, 'awaiting_approvals');
  assert.throws(() => w.coordinator.changeOffer(p, { merchantId: '', totalCents: 1_200, expiresAt: 100 }), /merchant of record/);
});

test('B13 an unusable mandate counts the employee fee against the instruction', () => {
  // EUR 8 total + EUR 1 fee under an EUR 8 instruction: the employee would
  // pay EUR 9, so the purchase must stay in draft. Both kinds of unusable
  // authority are covered — a mandate the registry never heard of, and one
  // whose signature does not verify against the employer it names.
  const cases: { ineligibleReason: string; mandateRef: (w: World) => string }[] = [
    { ineligibleReason: 'mandate_unknown', mandateRef: () => 'mandate-missing' },
    {
      ineligibleReason: 'mandate_signature_invalid',
      mandateRef: (w) => {
        // Publish verifies at acceptance, so a record that cannot verify as
        // the employer's authority is only reachable by corrupting the
        // retained record afterwards.
        w.coordinator.publishEmployerMandate(signPayload({ ...w.mandate, mandateRef: 'mandate-bad', version: 1 }, w.signers.get(EMPLOYER)!));
        w.mandates.current('mandate-bad')!.payload.maxPerPurchaseCents = 9_999;
        return 'mandate-bad';
      },
    },
  ];
  for (const { ineligibleReason, mandateRef } of cases) {
    const w = world();
    const p = w.coordinator.propose({
      purchaseId: 'purchase-1',
      employeeId: EMPLOYEE,
        merchantId: MERCHANT_A,
      totalCents: 800,
      feesCents: 100,
      mandateRef: mandateRef(w),
      expiresAt: 100,
    });
    assert.equal(p.state, 'awaiting_approvals', `${ineligibleReason}: EUR 8 share + EUR 1 fee exceeds the EUR 8 maximum`);
    assert.equal(p.employeeAssessment?.authZone, 'Exception');
    const proposal = w.trace.events.find((e) => e.event === 'proposal');
    assert.equal(proposal?.detail?.ineligibleReason, ineligibleReason);
    // Covering the fee is the employee's decision: a signed revision of
    // their standing maximum permits an approval on the same terms.
    updateEmployeeMandate(w, { maxCents: 900 });
    assert.equal(p.state, 'awaiting_approvals');
    approveAs(w, p);
    assert.equal(p.state, 'ready');
  }
});

test('B11 one reject-timeout leg rejects the whole deferred group', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.backend.faults.set(EMPLOYEE, 'timeout_then_settle');
  w.backend.faults.set(EMPLOYER, 'timeout_then_reject');
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});

test('a lost submission response keeps the purchase pending and the replay dedupes', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  // The backend accepts the submission, but the response never arrives. The
  // coordinator cannot tell this from a mid-forward failure, so the purchase
  // must keep its intent: legs, keys and benefit reservation stay live, and a
  // same-key replay discovers the outcome instead of paying again.
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
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  assert.deepEqual(p.legs.map((l) => l.status), ['unknown', 'unknown']);
  const keys = p.legs.map((l) => l.idempotencyKey);
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved', 'a lost response cannot release a live reservation');
  await w.coordinator.resubmit(p);
  assert.equal(p.state, 'completed');
  assert.deepEqual(p.legs.map((l) => l.idempotencyKey), keys, 'the replay used the same keys');
  assert.equal(w.backend.executionCount(), 2, 'the replay deduplicated — no second payment');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300);
});

test('a submission error before a conclusive result still retains the intent', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  // A generic failure before the backend answers is not proof that nothing
  // moved: the submission intent stays and a same-key replay learns the real
  // outcome — which here means actually dispatching, since nothing arrived.
  const submit = w.backend.submit.bind(w.backend);
  let failFirst = true;
  w.backend.submit = async (request) => {
    if (failFirst) {
      failFirst = false;
      throw new Error('synthetic transport failure');
    }
    return submit(request);
  };
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  assert.deepEqual(p.legs.map((l) => l.status), ['unknown', 'unknown']);
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
  assert.equal(w.backend.executionCount(), 0, 'this failure really was before dispatch');
  await w.coordinator.resubmit(p);
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.executionCount(), 2, 'the replay dispatched for real — nothing had arrived');
});

test('a lost refund response is reconciled through the same execution reference before any retry', async () => {
  const w = world(
    {},
    { maxPerDayCents: 10_000, maxPurchasesPerDay: 10 },
    { supportsMandatePayments: true, employeeMandate: { ...AUTO_EMPLOYEE_TERMS, autoPayMonthlyCents: 600 } },
  );
  const p = lunch(w, 900);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
  // The backend really returns the employee leg's principal, but the
  // response never arrives — indistinguishable from a mid-call failure.
  const refund = w.backend.refund.bind(w.backend);
  let loseResponse = true;
  w.backend.refund = async (ref) => {
    const response = await refund(ref);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('synthetic lost refund response');
    }
    return response;
  };
  await w.coordinator.refund(p);
  // The uncertain attempt is preserved as return knowledge, never as a lost
  // settlement: the purchase stays completed and the hold stays held.
  assert.equal(p.state, 'completed');
  assert.equal(p.returnStatus, 'partial', 'the employer leg returned while the employee leg stays unresolved');
  assert.equal(p.legs[0].status, 'settled');
  assert.equal(p.legs[1].status, 'returned', 'the employer leg returned conclusively');
  assert.equal(w.trace.events.filter((e) => e.event === 'autopay_released').length, 0);
  // Resuming through the public path queries the same execution reference
  // first: status() reports 'returned', so no second refund call runs — the
  // mock's refund is not idempotent and would throw 'cannot refund' on a
  // blind retry.
  await w.coordinator.refund(p);
  assert.equal(p.returnStatus, 'completed');
  const returns = w.trace.events.filter((e) => e.actor === 'backend' && e.event === 'refund');
  assert.equal(returns.length, 2, 'exactly one actual return per leg — no extra refund debit');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0, 'the merchant was debited once per leg');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000, 'principal back to the original payer');
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  const released = w.trace.events.filter((e) => e.event === 'autopay_released');
  assert.equal(released.length, 1, 'exactly one ledger release');
  assert.equal(released[0].detail?.cents, 400);
});
