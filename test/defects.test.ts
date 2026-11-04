// Regression tests for the defects listed in docs/backlog.md (B1–B13).

import { test } from 'node:test';
import assert from 'node:assert/strict';import { scenarios, world, lunch, approveAs, changeOfferAs, proposeAs, proposeSplitAs, refundAs, submitAs, updateMandate, updateEmployeeMandate, advance, AUTO_EMPLOYEE_TERMS, EMPLOYEE, EMPLOYER, COLLEAGUE_1, MERCHANT_A, MERCHANT_B, MERCHANT_C, payerDeCents, payerBankCents, payeeBankCents, settlementOf, legChildKey, deGroupKey, coordinatorFor } from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';
import { operationKey } from '../src/settlement/operations.ts';
import { Coordinator, approvalCents, approvalFeeCents, shareCents } from '../src/core/coordinator.ts';
import type { CoordinatorOptions } from '../src/core/coordinator.ts';
import type { Cents } from '../src/core/types.ts';
import { MINUTES_PER_DAY, dayOf } from '../src/core/ledger.ts';
import { signPayload, sharesDigestOf } from '../src/core/signing.ts';

// Legs with a confirmed commit under the purchase's recorded intent —
// zero for a purchase that was never admitted.
const committedLegs = (w: World, purchaseId = 'purchase-1'): number => {
  try {
    return settlementOf(w, purchaseId)?.legs.filter((l) => l.committedCents !== undefined).length ?? 0;
  } catch {
    return 0;
  }
};
// A leg's snapshot evidence by role.
const legSnap = (w: World, role: string, purchaseId = 'purchase-1') =>
  settlementOf(w, purchaseId)?.legs.find((l) => l.role === role);
// Remove a provider's fee route: a fee-bearing leg must refuse before
// handoff, the way a missing collector account once refused the request.
const dropFeeRoute = (w: World, payerId: string): void => {
  (w.providers.get(payerId) as unknown as { feePseudonym?: Cents }).feePseudonym = undefined;
};
// A second coordinator over the world's SAME orchestrator — deliberately not
// coordinatorFor(), which builds a fresh orchestrator. These B10/B12 tests
// exercise the recorded-intent conflict that only a shared orchestrator can
// see: admit() refuses before any provider handoff, so its bound
// authorizeFirstHandoff — still pointing at w.coordinator — is never
// reached. Non-refusal paths through the second coordinator would call the
// FIRST coordinator's authority recheck and must not be driven here.
const coordinatorSharingSettlement = (w: World, opts: CoordinatorOptions = {}): Coordinator =>
  new Coordinator(() => w.settlement, w.trace, {
    keys: w.keys,
    authority: w.authority,
    destinationFor: w.destinationFor,
    now: w.coordinator.now,
    ...opts,
  });

// The employee leg's digital-euro group key for the default two-leg lunch.
const employeeGroupKey = (purchaseId = 'purchase-1') => deGroupKey(purchaseId, 1, ['employee']);
// The employer leg's pay-credit child key for a default two-leg lunch.
const employerPayKey = (purchaseId = 'purchase-1') =>
  legChildKey(purchaseId, 1, 'employer', 'pay', 'psp-shop-merchant-a');

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
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  assert.equal(payeeBankCents(w, MERCHANT_A), 1_300, 'the merchant receives exactly the total');
  assert.equal(w.providers.get(EMPLOYEE)!.feesCents, 20, 'the employee provider retains the charged fee');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000 - 820);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000 - 500, 'the employer never pays the employee fee');
});

test('B1 a missing fee route refuses the leg before any money moves', async () => {
  // The payer's provider has no fee destination: the fee-bearing leg is
  // conclusively refused at validation — before any hold — and the refusal
  // unwinds the whole intent atomically.
  const w = world();
  dropFeeRoute(w, EMPLOYEE);
  const p = lunch(w, 1_300, MERCHANT_A, { feesCents: 20 });
  updateEmployeeMandate(w, { maxCents: 820 });
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'failed');
  assert.equal(p.legs[0].rejectReason, 'fee_route_missing');
  // The settlement failed atomically: neither leg debited, nothing credited.
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYEE), 50_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
  assert.equal(payeeBankCents(w, MERCHANT_A), 0);
  // A failed purchase cannot be replayed — only a fresh submit() rechecks.
  await assert.rejects(() => w.coordinator.resubmit(p.purchaseId), /cannot resubmit in state failed/);
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
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'failed');
  assert.equal(p.reason, 'employer_authority_invalid:beneficiary_mismatch');
  assert.equal(committedLegs(w), 0);
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
    sharesDigest: sharesDigestOf(q.shares),
    // The discriminant is present so the expiry binding — not a missing
    // basis — is what the rejection exercises.
    basis: 'device',
    expiresAt: q.expiresAt + 1_000,
  };
  assert.throws(() => w.coordinator.approve(p.purchaseId, signPayload(approval, w.signers.get(EMPLOYEE)!)), /does not match/);
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
  await submitAs(w, a, EMPLOYEE);
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(shareCents(b.proposal, 'employer'), 0);
});

test('B2 a failed purchase releases its reservation', async () => {
  const w = world();
  w.providers.get(EMPLOYER)!.setFault(employerPayKey(), 'credit', 'reject_before_effect');
  const a = lunch(w);
  approveAs(w, a);
  await submitAs(w, a, EMPLOYEE);
  assert.equal(a.state, 'failed');
  assert.equal(w.coordinator.ledger.state('purchase-1'), undefined);
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(shareCents(b.proposal, 'employer'), 500);
});

test('B2 a purchase cancelled after recovery releases its reservation', async () => {
  // The employee leg cannot fund its share; the employer leg settles alone.
  const w = world({ deCents: 300, reverseWaterfall: false });
  const a = lunch(w, 1_300, MERCHANT_A, { settlementMode: 'independent' });
  approveAs(w, a);
  await submitAs(w, a, EMPLOYEE);
  assert.equal(a.state, 'recovery_required');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
  // Returning the settled leg leaves every obligation resolved: cancelled,
  // and the day's subsidised meal is free for the next purchase.
  await w.coordinator.recover(a.purchaseId);
  assert.equal(a.state, 'cancelled');
  assert.equal(w.coordinator.ledger.state('purchase-1'), undefined);
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(shareCents(b.proposal, 'employer'), 500);
});

test('B2 a pending purchase keeps its reservation', async () => {
  const w = world();
  w.providers.get(EMPLOYER)!.setFault(employerPayKey(), 'credit', 'lose_response_after_effect');
  const a = lunch(w);
  approveAs(w, a);
  await submitAs(w, a, EMPLOYEE);
  assert.equal(a.state, 'pending');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
});

test('B2 a full refund gives the meal benefit back', async () => {
  const { w } = await run('S17');
  assert.equal(w.coordinator.ledger.state('purchase-1'), undefined);
});

test('B2 the benefit renews on the next working day', async () => {
  const w = world({}, { validUntil: 10 * MINUTES_PER_DAY });
  const a = lunch(w);
  approveAs(w, a);
  await submitAs(w, a, EMPLOYEE);
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
  await submitAs(w, a, EMPLOYEE);
  await submitAs(w, b, EMPLOYEE);
  assert.equal(a.state, 'completed');
  assert.equal(b.state, 'failed');
  assert.equal(committedLegs(w, 'purchase-2'), 0, 'the rejected purchase executed nothing');
  assert.equal(b.reason, 'employer_authority_invalid:daily_purchase_limit_reached');
  assert.equal(shareCents(b.proposal, 'employee'), 800, 'the employee share did not grow');
});

test('B5 a per-purchase cap lowered after approval stops initiation', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  updateMandate(w, { maxPerPurchaseCents: 300 });
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'failed');
  assert.equal(p.reason, 'employer_authority_invalid:cap_exceeded');
  assert.equal(shareCents(p.proposal, 'employee'), 800);
  assert.equal(committedLegs(w), 0);
});

test('B6 reconcile on a purchase with nothing submitted refuses instead of completing', async () => {
  // Found by test/invariants.property.test.ts (seed 1): with no legs, derive's
  // every-leg-settled check was vacuously true, so a status query alone marked
  // the purchase completed without any money moving.
  const w = world();
  const p = lunch(w);
  await assert.rejects(() => w.coordinator.reconcile(p.purchaseId), /nothing to reconcile/);
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(committedLegs(w), 0);
});

test('B6 a zero-amount proposal is refused instead of completing vacuously', () => {
  // Same vacuous-truth family: zero legs, all-settled check trivially true.
  const w = world();
  assert.throws(
    () =>
      proposeAs(w, {
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
  await submitAs(w, other, EMPLOYEE);
  await submitAs(w, late, EMPLOYEE);
  assert.equal(other.state, 'completed');
  assert.equal(late.state, 'failed');
  assert.equal(committedLegs(w, 'purchase-1'), 0, 'the rejected purchase executed nothing');
  assert.equal(late.reason, 'employer_authority_invalid:daily_purchase_limit_reached');
});

test('B7 resubmit cannot reopen a failed purchase under revoked authority', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.providers.get(EMPLOYER)!.available = false;
  w.providers.get(EMPLOYEE)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending', 'unreachable providers park the legs, never a failure');
  // Authority revoked and providers back: a retry under a dead mandate is
  // refused at the first-handoff recheck, never dispatched.
  updateMandate(w, { revoked: true });
  w.providers.get(EMPLOYER)!.available = true;
  w.providers.get(EMPLOYEE)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(committedLegs(w), 0);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('B7 a refused leg re-initiates only while its mandate still holds', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.providers.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  // The employer leg never reached a provider: resubmit is its first
  // initiation, so the same recheck submit() runs applies — and refuses the
  // leg again instead of sending it under a dead mandate. The refusal is
  // recorded on the leg, never as a whole-purchase failure: the employee leg
  // already handed off still decides the outcome.
  updateMandate(w, { revoked: true });
  w.providers.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'employer_authority_invalid:mandate_revoked');
  assert.equal(committedLegs(w), 0, 'the refused leg was never handed off');
  // The conclusive refusal unwinds the intent: the employee hold releases.
  assert.equal(p.state, 'failed');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('B7 resubmit cannot reopen recovery or a cancelled purchase', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.providers.get(EMPLOYER)!.setFault(employerPayKey(), 'credit', 'reject_before_effect');
  const p = lunch(w, 1_300, MERCHANT_A, { settlementMode: 'independent' });
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'recovery_required');
  // Recovery has one exit — recover() — not a retry that could re-commit.
  await assert.rejects(() => w.coordinator.resubmit(p.purchaseId), /cannot resubmit in state recovery_required/);
  await w.coordinator.recover(p.purchaseId);
  assert.equal(p.state, 'cancelled');
  await assert.rejects(() => w.coordinator.resubmit(p.purchaseId), /cannot resubmit in state cancelled/);
  assert.equal(p.state, 'cancelled');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
});

test('B7 a refused approval-funded leg re-initiates only before its approval expires', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.providers.get(EMPLOYEE)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  assert.equal(p.legs[0].status, 'unknown', 'an unreachable provider parks the leg, it is not a refusal');
  // The employee leg never reached a provider; resubmit is its first
  // initiation, so the expired approval refuses it in place — recorded on the
  // leg while the already handed-off employer leg keeps its outcome.
  advance(w, 150);
  w.providers.get(EMPLOYEE)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[0].status, 'rejected');
  assert.equal(p.legs[0].rejectReason, 'approval_expired:employee-1');
  assert.equal(committedLegs(w), 0, 'the refused leg was never handed off');
  // The conclusive refusal unwinds the intent.
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
    sharesDigest: sharesDigestOf(q.shares),
    expiresAt: q.expiresAt,
    basis: 'device',
  };
  w.coordinator.approve(p.purchaseId, signPayload(approval, w.signers.get(EMPLOYEE)!));
  w.providers.get(EMPLOYEE)!.available = false;
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  advance(w, 150);
  w.providers.get(EMPLOYEE)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[0].status, 'rejected');
  assert.equal(p.legs[0].rejectReason, 'approval_expired:employee-1');
});

test('B7 a refused mandate-funded leg replayed past the offer expiry is refused, not sent', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.providers.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  // The employer leg never reached a provider; while it waited, the offer
  // died. A mandate can outlive the proposal it funds — an approval cannot —
  // so the first-handoff recheck must refuse this leg on the expired offer
  // instead of handing it off under a dead proposal.
  advance(w, p.proposal.expiresAt + 1);
  w.providers.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'offer_expired');
  assert.equal(committedLegs(w), 0, 'the refused leg was never handed off');
  // The conclusive refusal resolves the group with nothing committed.
  assert.equal(p.state, 'failed');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('B8 an unroutable rail on a later leg refuses before any leg settles', async () => {
  // A split puts every share on the digital-euro rail; a payer with no
  // digital-euro pseudonym is conclusively refused at validation — before
  // any hold — so no earlier leg's money ever moves.
  const w = world();
  const p = proposeSplitAs(
    w,
    {
      purchaseId: 'split-fee',
      merchantId: MERCHANT_A,
      amountsFrom: 'equal_split',
      totalCents: 200,
      settlementMode: 'atomic',
      shares: [
        { role: 'a', payerId: EMPLOYEE },
        { role: 'b', payerId: EMPLOYER, feeCents: 5 },
      ],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, EMPLOYER);
  // The employer has no digital-euro pseudonym: its leg is conclusively
  // refused at validation, unwinding the whole intent before any debit.
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'failed');
  assert.equal(p.legs[1].rejectReason, 'rail_unavailable');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
  assert.equal(payeeBankCents(w, MERCHANT_A), 0);
});

test('B8 an account deleted mid-reserve still fails the group atomically', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const p = proposeSplitAs(
    w,
    {
      purchaseId: 'split-reserve',
      merchantId: MERCHANT_A,
      amountsFrom: 'equal_split',
      totalCents: 200,
      shares: [
        { role: 'a', payerId: EMPLOYEE, feeCents: 5 },
        { role: 'b', payerId: EMPLOYER },
      ],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, EMPLOYER);
  w.providers.get(EMPLOYER)!.available = false;
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  // The employee provider's fee route vanishes before the first handoff
  // re-checks authority: the refused leg unwinds the whole intent, and the
  // hold deadline resolves it with nothing committed.
  dropFeeRoute(w, EMPLOYEE);
  w.providers.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYEE), 50_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
  assert.equal(payeeBankCents(w, MERCHANT_A), 0);
});

test('B9 a refunded purchase stays completed under reconcile and resubmit', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  await refundAs(w, p, MERCHANT_A);
  assert.equal(p.returnStatus, 'completed');
  assert.equal(p.state, 'completed');
  // Returned legs of a completed purchase still count as settled: the return
  // is recorded separately, so no derive pass may relabel the purchase.
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
});

test('B10 a reused purchaseId cannot complete a different purchase', async () => {
  const w = world();
  const a = lunch(w, 1_300, MERCHANT_A);
  approveAs(w, a);
  await submitAs(w, a, EMPLOYEE);
  assert.equal(a.state, 'completed');
  // Within one coordinator the reused id is refused at the door; the
  // downstream defense still guards two coordinators sharing one
  // orchestrator and one benefit ledger. A wider daily allowance gives the
  // second coordinator's purchase an employer share of its own — its
  // proposal is legitimate, but its reservation reuses a's purchaseId, so
  // reserve() refuses before any colliding idempotency key is sent.
  updateMandate(w, { maxPurchasesPerDay: 2, maxPerDayCents: 10_000 });
  const w2 = {
    ...w,
    coordinator: coordinatorSharingSettlement(w, { ledger: w.coordinator.ledger }),
  };
  const b = lunch(w2, 1_300, MERCHANT_B);
  approveAs(w2, b);
  await assert.rejects(() => submitAs(w2, b, EMPLOYEE), /conflicting benefit reservation/);
  assert.equal(b.state, 'ready');
  // The refusal must not have touched a's ledger entry, and b's merchant was
  // never paid.
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  assert.equal(payeeBankCents(w, MERCHANT_B), 0);
  // The refusal added nothing to the day: usage is still exactly a's.
  assert.deepEqual(w.coordinator.ledger.usage('mandate-1', dayOf(w.coordinator.now)), { cents: 500, purchases: 1 });
});

test('B10 the settlement layer still refuses a reused key with different terms', async () => {
  const w = world();
  const a = lunch(w);
  approveAs(w, a);
  await submitAs(w, a, EMPLOYEE);
  assert.equal(a.state, 'completed');
  // Within one coordinator the reused id is refused at the door. A split in
  // a second coordinator sharing the orchestrator and ledger holds no
  // benefit reservation of its own, so reserve() is not in the way and the
  // colliding key reaches the shared intent store — which refuses the
  // mismatched terms rather than deduping into a purchase that never paid
  // its merchant.
  const w2 = {
    ...w,
    coordinator: coordinatorSharingSettlement(w, { ledger: w.coordinator.ledger }),
  };
  const b = proposeSplitAs(
    w2,
    {
      purchaseId: 'purchase-1',
      merchantId: MERCHANT_B,
      amountsFrom: 'equal_split',
      totalCents: 1_300,
      shares: [{ role: 'employee', payerId: EMPLOYEE, payeeId: MERCHANT_B }],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  approveAs(w2, b);
  await assert.rejects(() => submitAs(w2, b, EMPLOYEE), /settlement_intent_conflict/);
  // A split holds no reservation of its own; the throw must not release
  // the consumed benefit a still owns under the shared purchaseId.
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  assert.equal(b.state, 'ready');
  assert.equal(payeeBankCents(w, MERCHANT_B), 0);
});

test('B12 a colliding purchase cannot release a live reservation', async () => {
  const w = world();
  w.providers.get(EMPLOYER)!.setFault(employerPayKey(), 'credit', 'lose_response_after_effect');
  const a = lunch(w);
  approveAs(w, a);
  await submitAs(w, a, EMPLOYEE);
  assert.equal(a.state, 'pending');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
  // A split in a second coordinator sharing the orchestrator and ledger
  // holds no reservation of its own, so its submission reaches the shared
  // intent store and is refused there. The thrown submit must not release
  // the live reservation a still holds under the reused purchaseId.
  const w2 = {
    ...w,
    coordinator: coordinatorSharingSettlement(w, { ledger: w.coordinator.ledger }),
  };
  const b = proposeSplitAs(
    w2,
    {
      purchaseId: 'purchase-1',
      merchantId: MERCHANT_B,
      amountsFrom: 'equal_split',
      totalCents: 1_300,
      shares: [{ role: 'employee', payerId: EMPLOYEE, payeeId: MERCHANT_B }],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  approveAs(w2, b);
  await assert.rejects(() => submitAs(w2, b, EMPLOYEE), /settlement_intent_conflict/);
  assert.equal(b.state, 'ready');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
});

test('B12 a refused leg under per-PSP initiation is rejected, not lost', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  // a submits at proposal v2 (the reprice bumps the version) so that b —
  // whose revised proposal also lands on v2 — mints the same idempotency
  // key carrying different terms.
  const a = lunch(w);
  changeOfferAs(w, a, { merchantId: MERCHANT_A, totalCents: 1_300, expiresAt: 100 }, MERCHANT_A);
  approveAs(w, a);
  await submitAs(w, a, EMPLOYEE);
  await w.coordinator.reconcile(a.purchaseId);
  assert.equal(a.state, 'completed');
  updateMandate(w, { revoked: true });
  // The second coordinator shares the orchestrator and routes through the
  // same providers — one coordinator would refuse the reused id at the
  // door, but across coordinators the shared intent's idempotency defense
  // still fires.
  const w2 = {
    ...w,
    coordinator: coordinatorSharingSettlement(w),
  };
  // Employee-only proposal: EUR 13 alone exceeds the EUR 8 maximum, so the
  // purchase waits in Exception until the employee raises their maximum.
  const b = lunch(w2, 1_300, MERCHANT_B);
  assert.equal(b.state, 'awaiting_approvals');
  // Bump b's proposal to v2 (a mandate-only refresh never bumps) so it mints
  // the same idempotency key as a's v2 under different terms.
  changeOfferAs(w2, b, { merchantId: MERCHANT_B, totalCents: 1_300, expiresAt: 100 }, EMPLOYEE);
  updateEmployeeMandate(w, { maxCents: 1_300 });
  approveAs(w2, b);
  // The shared orchestrator conclusively refuses the differing intent under
  // a recorded purchaseRef: a thrown refusal, never a dedupe into terms that
  // never paid the merchant — and never a 'pending' that waits forever.
  await assert.rejects(() => submitAs(w2, b, EMPLOYEE), /settlement_intent_conflict/);
  assert.equal(b.state, 'ready');
  assert.equal(payeeBankCents(w, MERCHANT_B), 0, 'the colliding purchase never paid its merchant');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
});

test('B12 a partially colliding purchase cannot exist to entangle another purchase\'s execution', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const a = lunch(w);
  approveAs(w, a);
  await submitAs(w, a, EMPLOYEE);
  await w.coordinator.reconcile(a.purchaseId);
  assert.equal(a.state, 'completed');
  // A split reusing the purchaseId would mint one key that dedupes into
  // a's execution and one the settlement layer refuses — the collision
  // that used to surface as a foreign executionRef is now refused at the
  // door: the store rejects the reused id before any such proposal exists.
  assert.throws(
    () =>
      proposeSplitAs(
        w,
        {
          purchaseId: 'purchase-1',
          merchantId: MERCHANT_A,
          amountsFrom: 'proposer',
          shares: [
            { role: 'employee', payerId: EMPLOYEE, payeeId: MERCHANT_A, amountCents: 800 },
            { role: 'employer', payerId: EMPLOYER, payeeId: MERCHANT_A, amountCents: 600 },
          ],
          expiresAt: 100,
        },
        EMPLOYEE,
      ),
    /duplicate_purchase/,
  );
  assert.equal(committedLegs(w), 2, 'nothing new was sent');
  assert.equal(a.state, 'completed');
  assert.equal(a.legs[0].status, 'settled', "a's payment is untouched");
});

test('a changed offer still needs a merchant of record', () => {
  const w = world();
  const p = lunch(w);
  assert.equal(p.state, 'awaiting_approvals');
  assert.throws(() => changeOfferAs(w, p, { merchantId: '', totalCents: 1_200, expiresAt: 100 }, EMPLOYEE), /merchant of record/);
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
        w.authority.publishEmployerMandate(signPayload({ ...w.mandate, mandateRef: 'mandate-bad', version: 1 }, w.signers.get(EMPLOYER)!));
        w.authority.employerMandate('mandate-bad')!.payload.maxPerPurchaseCents = 9_999;
        return 'mandate-bad';
      },
    },
  ];
  for (const { ineligibleReason, mandateRef } of cases) {
    const w = world();
    const p = proposeAs(w, {
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
  // The employee leg's group commit parks deferred; the employer leg's pay
  // credit resolves deferred to a conclusive rejection — one conclusive
  // rejection unwinds the intent.
  w.digitalEuro.setFault(employeeGroupKey(), 'commit', 'defer');
  w.providers.get(EMPLOYER)!.setFault(employerPayKey(), 'credit', 'defer');
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  w.providers.get(EMPLOYER)!.resolveDeferred(employerPayKey(), 'reject');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('a lost submission response keeps the purchase pending and the replay dedupes', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  // The employee leg's group commit applies, but its response never
  // arrives. The coordinator cannot tell this from a mid-forward failure,
  // so the purchase must keep its intent: legs, keys and benefit
  // reservation stay live, and a same-key replay discovers the outcome
  // instead of paying again.
  w.digitalEuro.setFault(employeeGroupKey(), 'commit', 'lose_response_after_effect');
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  // The employer leg's own response did arrive; only the leg whose group
  // outcome was lost stays 'unknown' — which is what keeps it pending.
  assert.equal(p.legs[1].status, 'settled');
  const keys = p.legs.map((l) => l.idempotencyKey);
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved', 'a lost response cannot release a live reservation');
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.deepEqual(p.legs.map((l) => l.idempotencyKey), keys, 'the replay used the same keys');
  assert.equal(committedLegs(w), 2, 'the replay deduplicated — no second payment');
  assert.equal(payeeBankCents(w, MERCHANT_A), 1_300);
});

test('a submission error before a conclusive result still retains the intent', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  // A response lost before its effect lands is not proof that nothing
  // moved: the submission intent stays and a same-key replay learns the
  // real outcome — which here means actually committing, since nothing
  // had been recorded.
  w.providers.get(EMPLOYER)!.setFault(
    legChildKey('purchase-1', 1, 'employer', 'hold', 'bank'),
    'hold',
    'lose_response_after_effect',
  );
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  assert.equal(p.legs[0].status, 'unknown');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
  // The lost call applied nothing the snapshot can prove: no leg commits.
  assert.equal(committedLegs(w), 0, 'the thrown path left nothing confirmed');
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(committedLegs(w), 2, 'the replay resolved for real — nothing had been confirmed');
});

test('a lost refund response is reconciled through the same execution reference before any retry', async () => {
  const w = world(
    {},
    { maxPerDayCents: 10_000, maxPurchasesPerDay: 10 },
    { supportsMandatePayments: true, employeeMandate: { ...AUTO_EMPLOYEE_TERMS, autoPayMonthlyCents: 600 } },
  );
  const p = lunch(w, 900);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  // The provider really returns the employee leg's principal, but the
  // response never arrives — indistinguishable from a mid-call failure.
  const employeeProvider = w.providers.get(EMPLOYEE)!;
  const refund = employeeProvider.refund.bind(employeeProvider);
  let loseResponse = true;
  employeeProvider.refund = async (...args) => {
    const response = await refund(...args);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('synthetic lost refund response');
    }
    return response;
  };
  await refundAs(w, p, MERCHANT_A);
  // The uncertain attempt is preserved as return knowledge, never as a lost
  // settlement: the purchase stays completed and the hold stays held.
  assert.equal(p.state, 'completed');
  assert.equal(p.returnStatus, 'partial', 'the employer leg returned while the employee leg stays unresolved');
  assert.equal(p.legs[0].status, 'settled');
  assert.equal(p.legs[1].status, 'returned', 'the employer leg returned conclusively');
  assert.equal(w.trace.events.filter((e) => e.event === 'autopay_released').length, 0);
  // Resuming through the public path queries the same execution reference
  // first: status() reports the recorded return, so no second refund call
  // runs — the provider's once-returned guard would refuse a blind retry.
  await refundAs(w, p, MERCHANT_A);
  assert.equal(p.returnStatus, 'completed');
  const returnedLegs = settlementOf(w, 'purchase-1')!.legs.filter((l) => l.returned?.status === 'succeeded');
  assert.equal(returnedLegs.length, 2, 'exactly one confirmed return per leg — no extra refund debit');
  assert.equal(payeeBankCents(w, MERCHANT_A), 0, 'the merchant was debited once per leg');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000, 'principal back to the original payer');
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
  const released = w.trace.events.filter((e) => e.event === 'autopay_released');
  assert.equal(released.length, 1, 'exactly one ledger release');
  assert.equal(released[0].detail?.cents, 400);
});
