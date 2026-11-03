// Fresh-purchase benefit quotes: a side-effect-free projection of what a
// purchase under these terms would draw today. A quote reserves nothing,
// creates no purchase and appends nothing to the trace — but it does count
// benefit other purchases already hold, including a pending reservation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, lunch, approveAs, proposeAs, changeOfferAs, submitAs, updateMandate, advance, AUTO_EMPLOYEE_TERMS, EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_C } from '../src/scenarios.ts';
import { shareCents } from '../src/core/coordinator.ts';
import { unwrapView } from '../src/core/live-view.ts';
import type { QuoteInput } from '../src/core/coordinator.ts';
import { dayOf } from '../src/core/ledger.ts';
import { signPayload } from '../src/core/signing.ts';

// The reference lunch terms: EUR 13 at merchant-a under the standing EUR 8
// maximum, so a valid quote is EUR 8 employee + EUR 5 employer.
const INPUT: QuoteInput = {
  merchantId: MERCHANT_A,
  totalCents: 1_300,
  employeeId: EMPLOYEE,
  mandateRef: 'mandate-1',
};

const quoteInput = (over: Partial<QuoteInput> = {}): QuoteInput => ({ ...INPUT, ...over });

test('a valid quote projects the deterministic employee/employer split', () => {
  const w = world();
  const q = w.coordinator.quote(quoteInput());
  assert.equal(q.employerCents, 500);
  assert.equal(q.employeeCents, 800);
  assert.equal(q.assessment.authZone, 'Confirm');
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
    // EUR 13 alone exceeds employee-1's standing EUR 8 maximum; employee-2
    // has no standing terms at all and confirms instead.
    assert.equal(q.assessment.authZone, over.employeeId === 'employee-2' ? 'Confirm' : 'Exception', reason);
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
  // Publish verifies at acceptance, so a failing signature at use means the
  // retained record was corrupted after acceptance.
  w.authority.publishEmployerMandate(signPayload({ ...w.mandate, mandateRef: 'mandate-bad', version: 1 }, w.signers.get(EMPLOYER)!));
  w.authority.employerMandate('mandate-bad')!.payload.eligibleMerchants = ['merchant-x'];
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
  assert.equal(q.assessment.authZone, 'Exception', 'EUR 9 exceeds the EUR 8 maximum');
  assert.equal(q.ineligibleReason, undefined, 'a partial contribution is not an authority failure');
});

test('the employee fee counts against the standing maximum wherever the share comes from', () => {
  const w = world();
  // With benefit: EUR 8 share + EUR 1 fee exceeds the standing EUR 8 maximum.
  assert.equal(w.coordinator.quote(quoteInput({ feesCents: 100 })).assessment.authZone, 'Exception');
  // Without usable authority the whole total plus fee falls to the employee:
  // EUR 8 + EUR 1 under the EUR 8 maximum is over (B13, quote side).
  const unknown = quoteInput({ totalCents: 800, feesCents: 100, mandateRef: 'mandate-missing' });
  assert.equal(w.coordinator.quote(unknown).assessment.authZone, 'Exception');
  assert.equal(w.coordinator.quote(unknown).assessment.employeeDebitCents, 900);
});

test('malformed quote input is rejected before evaluation and leaves no trace', () => {
  const w = world();
  const bad: [Partial<QuoteInput>, RegExp][] = [
    [{ totalCents: 0 }, /positive integer cents/],
    [{ totalCents: -100 }, /positive integer cents/],
    [{ totalCents: 1_300.5 }, /positive integer cents/],
    [{ feesCents: -1 }, /non-negative integer cents/],
    [{ feesCents: 1.5 }, /non-negative integer cents/],
    [{ merchantId: '' }, /merchant of record/],
    [{ employeeId: '' }, /employee/],
    [{ mandateRef: '' }, /mandate/],
  ];
  // Signed setup publication legitimately logs; compare against the baseline.
  const baseline = w.trace.events.length;
  for (const [over, pattern] of bad) {
    assert.throws(() => w.coordinator.quote(quoteInput(over)), pattern, JSON.stringify(over));
  }
  assert.equal(w.trace.events.length, baseline, 'rejected quotes append nothing');
});

test('repeated quotes reserve nothing, consume no benefit and append no trace', () => {
  const w = world();
  const baseline = w.trace.events.length;
  const first = w.coordinator.quote(quoteInput());
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(w.coordinator.quote(quoteInput()), first);
  }
  assert.equal(w.trace.events.length, baseline);
  assert.deepEqual(w.coordinator.ledger.usage('mandate-1', dayOf(w.coordinator.now)), { cents: 0, purchases: 0 });
  // Nothing was held by the quotes: a real purchase still draws the benefit.
  const p = lunch(w);
  assert.equal(shareCents(p.proposal, 'employer'), 500);
});

test('unsafe amounts and fee-inclusive sums are rejected before quoting or replacing a proposal', () => {
  for (const employeeMandate of [null, AUTO_EMPLOYEE_TERMS]) {
    const w = world({}, {}, { employeeMandate });
    const p = lunch(w, 900);
    const before = structuredClone(unwrapView(p));
    const baseline = w.trace.events.length;
    const invalid = [
      { totalCents: Number.MAX_SAFE_INTEGER + 1, feesCents: 0 },
      { totalCents: 900, feesCents: Number.MAX_SAFE_INTEGER + 1 },
      // Both inputs are safe, but the employee's principal plus fee is not.
      { totalCents: Number.MAX_SAFE_INTEGER, feesCents: 502 },
    ];
    for (const amounts of invalid) {
      assert.throws(() => w.coordinator.quote(quoteInput(amounts)), /safe/);
      assert.throws(() => proposeAs(w, { ...INPUT, ...amounts, purchaseId: 'invalid', expiresAt: 100 }), /safe/);
    }
    assert.throws(() => changeOfferAs(w, p, { merchantId: MERCHANT_A, totalCents: Number.MAX_SAFE_INTEGER + 1, expiresAt: 100 }, MERCHANT_A), /safe/);
    assert.deepEqual(p, before);
    assert.equal(w.trace.events.length, baseline, 'invalid arithmetic publishes no assessment or proposal');
    const edge = w.coordinator.quote(quoteInput({ totalCents: Number.MAX_SAFE_INTEGER, feesCents: 500 }));
    assert.equal(edge.assessment.employeeDebitCents, Number.MAX_SAFE_INTEGER, 'exactly safe sums remain usable');
  }
});

test('a pending purchase counts against a fresh quote: quoting cannot spend held benefit', async () => {
  const w = world();
  w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
  const p = lunch(w);
  assert.equal(w.coordinator.quote(quoteInput()).employerCents, 500, 'the benefit is free before submission');
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
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
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(w.coordinator.quote(quoteInput()).employerCents, 0);
});

test('a quote reflects pending automatic reservations but is never authority', async () => {
  // Auto-eligible terms, EUR 6 monthly cap: a EUR 9 lunch carries a EUR 4
  // automatic debit.
  const terms = { ...AUTO_EMPLOYEE_TERMS, autoPayMonthlyCents: 600 };
  const w = world({}, { maxPerDayCents: 10_000, maxPurchasesPerDay: 10 }, { employeeMandate: terms, supportsMandatePayments: true });
  const quote = () => w.coordinator.quote(quoteInput({ totalCents: 900 }));
  assert.equal(quote().assessment.authZone, 'Auto');
  const p = lunch(w, 900);
  // A prior favorable quote authorises nothing: the real proposal still
  // evaluates under current usage.
  assert.equal(p.employeeAssessment?.authZone, 'Auto');
  w.backend.faults.set(EMPLOYEE, 'timeout_then_settle');
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  // 400 of 600 held: the quote answers honestly — and reserves nothing,
  // since repeating it changes no answer.
  const held = quote();
  assert.equal(held.assessment.authZone, 'Confirm');
  assert.equal(held.assessment.autoPayBlockedReason, 'monthly_cap');
  assert.deepEqual(quote(), held);
});
