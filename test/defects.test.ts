// Regression tests for the defects listed in docs/backlog.md (B1–B6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, world, lunch, approveAs, updateMandate, EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_C } from '../src/scenarios.ts';
import { approvalCents, approvalFeeCents, shareCents } from '../src/coordinator.ts';
import { FEE_COLLECTOR } from '../src/mock-backend.ts';
import { MINUTES_PER_DAY } from '../src/ledger.ts';
import { signPayload } from '../src/signing.ts';

const run = async (id: string) => {
  const s = scenarios.find((x) => x.id.startsWith(id));
  if (!s) throw new Error(`no scenario ${id}`);
  return s.run();
};

test('B1 fees default to zero and are bound in the approval', async () => {
  const { p } = await run('S01');
  assert.ok(p.proposal.shares.every((s) => s.feeCents === 0));
  assert.equal(p.approvals[0]?.payload.feeCents, 0);
  assert.deepEqual(p.legs.map((l) => l.feeCents), [0, 0]);
});

test('B1 a non-zero fee is paid by the employee on top of the total and counts against their instruction', async () => {
  const w = world();
  const p = lunch(w, 1_300, MERCHANT_A, { feesCents: 20 });
  // EUR 8 share + EUR 0.20 fee is above the EUR 8 instruction.
  assert.equal(p.state, 'draft');
  assert.equal(p.reason, 'employee_share_exceeds_instruction');
  w.coordinator.reviseInstruction(p, 820);
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
  w.coordinator.reviseInstruction(p, 820);
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
  assert.equal(p.state, 'draft', 'EUR 13 alone exceeds the EUR 8 instruction');
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
    expiresAt: q.expiresAt + 1_000,
  };
  assert.throws(() => w.coordinator.approve(p, signPayload(approval, w.signers.get(EMPLOYEE)!)), /does not match/);
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.approvals.length, 0);
});

test('B4 an approval that has already expired is rejected', async () => {
  const w = world();
  const p = lunch(w);
  w.coordinator.now = p.proposal.expiresAt + 1;
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
  w.coordinator.now = MINUTES_PER_DAY + 10;
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
        employeeMaxCents: 800,
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
  w.coordinator.now = MINUTES_PER_DAY + 10;
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
