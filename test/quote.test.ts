// Fresh-purchase benefit quotes: a side-effect-free projection of what a
// purchase under these terms would draw today. A quote reserves nothing,
// creates no purchase and appends nothing to the trace — but it does count
// benefit other purchases already hold, including a pending reservation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, lunch, approveAs, updateMandate, advance, EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_C } from '../src/scenarios.ts';
import { shareCents } from '../src/core/coordinator.ts';
import type { QuoteInput } from '../src/core/coordinator.ts';
import { dayOf } from '../src/core/ledger.ts';
import { signPayload } from '../src/core/signing.ts';

// The reference lunch terms: EUR 13 at merchant-a under an EUR 8 instruction,
// so a valid quote is EUR 8 employee + EUR 5 employer.
const INPUT: QuoteInput = {
  merchantId: MERCHANT_A,
  totalCents: 1_300,
  employeeId: EMPLOYEE,
  employeeMaxCents: 800,
  mandateRef: 'mandate-1',
};

const quoteInput = (over: Partial<QuoteInput> = {}): QuoteInput => ({ ...INPUT, ...over });

test('a valid quote projects the deterministic employee/employer split', () => {
  const w = world();
  const q = w.coordinator.quote(quoteInput());
  assert.equal(q.employerCents, 500);
  assert.equal(q.employeeCents, 800);
  assert.equal(q.withinInstruction, true);
  assert.equal(q.ineligibleReason, undefined);
});

test('a quote agrees with the proposal a real purchase would get', () => {
  const w = world();
  const q = w.coordinator.quote(quoteInput());
  const p = lunch(w);
  assert.equal(shareCents(p.proposal, 'employer'), q.employerCents);
  assert.equal(shareCents(p.proposal, 'employee'), q.employeeCents);
  assert.equal(p.state, 'awaiting_approvals');
});

test('a quote names why the employer contributes nothing and prices the full total on the employee', () => {
  const w = world();
  const cases: [Partial<QuoteInput>, string][] = [
    [{ merchantId: 'merchant-x' }, 'merchant_not_eligible'],
    [{ employeeId: 'employee-2' }, 'beneficiary_mismatch'],
    [{ mandateRef: 'mandate-missing' }, 'mandate_unknown'],
  ];
  for (const [over, reason] of cases) {
    const q = w.coordinator.quote(quoteInput(over));
    assert.equal(q.employerCents, 0, reason);
    assert.equal(q.employeeCents, 1_300, reason);
    assert.equal(q.ineligibleReason, reason);
    // EUR 13 alone exceeds the EUR 8 instruction.
    assert.equal(q.withinInstruction, false, reason);
  }
});

test('a quote reflects mandate validity and revocation at the coordinator clock', () => {
  const w = world();
  assert.equal(w.coordinator.quote(quoteInput()).employerCents, 500);
  // A re-published revocation denies even inside the validity window.
  updateMandate(w, { revoked: true });
  let q = w.coordinator.quote(quoteInput());
  assert.equal(q.employerCents, 0);
  assert.equal(q.ineligibleReason, 'mandate_revoked');
  // Past the validity window (validUntil 1_000) it funds nothing either.
  updateMandate(w, { revoked: false });
  advance(w, 2_000);
  q = w.coordinator.quote(quoteInput());
  assert.equal(q.employerCents, 0);
  assert.equal(q.ineligibleReason, 'mandate_expired');
});

test('a mandate that fails signature verification funds nothing', () => {
  const w = world();
  // Published under the employee's key: the registry stores it, but the
  // signature does not verify against the employer the payload names.
  w.mandates.publish(signPayload({ ...w.mandate, mandateRef: 'mandate-bad' }, w.signers.get(EMPLOYEE)!));
  const q = w.coordinator.quote(quoteInput({ mandateRef: 'mandate-bad' }));
  assert.equal(q.employerCents, 0);
  assert.equal(q.employeeCents, 1_300);
  assert.equal(q.ineligibleReason, 'mandate_signature_invalid');
});

test('a cap shrinks the employer share; the employee still answers for the rest', () => {
  const w = world({}, { maxPerPurchaseCents: 400 });
  const q = w.coordinator.quote(quoteInput());
  assert.equal(q.employerCents, 400);
  assert.equal(q.employeeCents, 900);
  assert.equal(q.withinInstruction, false, 'EUR 9 exceeds the EUR 8 instruction');
  assert.equal(q.ineligibleReason, undefined, 'a partial contribution is not an authority failure');
});

test('the employee fee counts against the instruction wherever the share comes from', () => {
  const w = world();
  // With benefit: EUR 8 share + EUR 1 fee needs an EUR 9 instruction.
  assert.equal(w.coordinator.quote(quoteInput({ feesCents: 100 })).withinInstruction, false);
  assert.equal(w.coordinator.quote(quoteInput({ feesCents: 100, employeeMaxCents: 900 })).withinInstruction, true);
  // Without usable authority the whole total plus fee falls to the employee:
  // EUR 8 + EUR 1 under an EUR 8 instruction is over (B13, quote side).
  const unknown = quoteInput({ totalCents: 800, feesCents: 100, mandateRef: 'mandate-missing' });
  assert.equal(w.coordinator.quote(unknown).withinInstruction, false);
  assert.equal(w.coordinator.quote({ ...unknown, employeeMaxCents: 900 }).withinInstruction, true);
});

test('malformed quote input is rejected before evaluation and leaves no trace', () => {
  const w = world();
  const bad: [Partial<QuoteInput>, RegExp][] = [
    [{ totalCents: 0 }, /positive integer cents/],
    [{ totalCents: -100 }, /positive integer cents/],
    [{ totalCents: 1_300.5 }, /positive integer cents/],
    [{ feesCents: -1 }, /non-negative integer cents/],
    [{ feesCents: 1.5 }, /non-negative integer cents/],
    [{ employeeMaxCents: -1 }, /non-negative integer cents/],
    [{ employeeMaxCents: 800.5 }, /non-negative integer cents/],
    [{ merchantId: '' }, /merchant of record/],
    [{ employeeId: '' }, /employee/],
    [{ mandateRef: '' }, /mandate/],
  ];
  for (const [over, pattern] of bad) {
    assert.throws(() => w.coordinator.quote(quoteInput(over)), pattern, JSON.stringify(over));
  }
  assert.equal(w.trace.events.length, 0, 'rejected quotes append nothing');
});

test('repeated quotes reserve nothing, consume no benefit and append no trace', () => {
  const w = world();
  const first = w.coordinator.quote(quoteInput());
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(w.coordinator.quote(quoteInput()), first);
  }
  assert.equal(w.trace.events.length, 0);
  assert.deepEqual(w.coordinator.ledger.usage('mandate-1', dayOf(w.coordinator.now)), { cents: 0, purchases: 0 });
  // Nothing was held by the quotes: a real purchase still draws the benefit.
  const p = lunch(w);
  assert.equal(shareCents(p.proposal, 'employer'), 500);
});

test('a pending purchase counts against a fresh quote: quoting cannot spend held benefit', async () => {
  const w = world();
  w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
  const p = lunch(w);
  assert.equal(w.coordinator.quote(quoteInput()).employerCents, 500, 'the benefit is free before submission');
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  // The pending purchase holds the day's one subsidised meal: a fresh quote
  // sees it as used even though nothing has settled.
  const q = w.coordinator.quote(quoteInput());
  assert.equal(q.employerCents, 0);
  assert.equal(q.employeeCents, 1_300);
  assert.equal(q.ineligibleReason, 'daily_purchase_limit_reached');
  // The same resolution drives real proposals: a fresh purchase agrees.
  const fresh = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(shareCents(fresh.proposal, 'employer'), 0);
  // Once the pending leg settles the benefit is consumed — still used.
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'completed');
  assert.equal(w.coordinator.quote(quoteInput()).employerCents, 0);
});
