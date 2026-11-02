// One synchronous decision verifies each signed record once. The decision
// scope (src/core/verified-authority.ts) memoizes reads and verdicts by
// signed content inside one uninterrupted stretch, so helpers that compose
// share verified authority instead of re-verifying it. These tests count
// verifyPayload calls through the key registry — one keys.get per call —
// and check the scope boundary: corruption between two operations is still
// caught at the next decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  world,
  lunch,
  approveAs,
  AUTO_EMPLOYEE_TERMS,
  EMPLOYEE,
  COLLEAGUE_1,
  COLLEAGUE_2,
  MERCHANT_A,
} from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';

// Count verifyPayload invocations: each one reads the key registry exactly
// once, so a get() spy is an exact counter. Setup publishes happen before
// the spy installs, so the count is the measured operation's alone.
const verifyCount = (w: World): (() => number) => {
  let calls = 0;
  const get = w.keys.get.bind(w.keys);
  w.keys.get = ((keyId: string) => {
    calls++;
    return get(keyId);
  }) as typeof w.keys.get;
  return () => calls;
};

const AUTO_WORLD = { employeeMandate: AUTO_EMPLOYEE_TERMS, supportsMandatePayments: true };

test('propose with auto-pay verifies the employer allowance and the standing terms once each', () => {
  const w = world({}, {}, AUTO_WORLD);
  const count = verifyCount(w);
  const p = lunch(w, 900);
  assert.equal(p.state, 'ready');
  // resolveBenefit and the share naming share the scope's employer
  // resolution; assessment, expiry noting and mandate evidence share the
  // one verified standing record.
  assert.equal(count(), 2);
});

test('an offer change verifies each authority record once across the whole decision', () => {
  const w = world({}, {}, AUTO_WORLD);
  const p = lunch(w, 900);
  const count = verifyCount(w);
  const change = w.coordinator.changeOffer(p, { merchantId: MERCHANT_A, totalCents: 1_000, expiresAt: 100 });
  assert.equal(change.outcome, 'replaced');
  // The old-offer employer pre-check and reprice's own resolution share the
  // scope's employer read; the standing terms are read once for reprice.
  assert.equal(count(), 2);
});

test('a quote verifies the allowance and the standing terms once each', () => {
  const w = world({}, {}, AUTO_WORLD);
  const count = verifyCount(w);
  w.coordinator.quote({ merchantId: MERCHANT_A, totalCents: 900, employeeId: EMPLOYEE, mandateRef: w.mandate.mandateRef });
  assert.equal(count(), 2);
});

test('each approve call verifies only the incoming signature in a split', () => {
  const w = world();
  const p = w.coordinator.proposeSplit({
    purchaseId: 'split-1',
    merchantId: MERCHANT_A,
    shares: [
      { role: 'a', payerId: EMPLOYEE, amountCents: 400 },
      { role: 'b', payerId: COLLEAGUE_1, amountCents: 400 },
      { role: 'c', payerId: COLLEAGUE_2, amountCents: 400 },
    ],
    expiresAt: 100,
  });
  // A split has no standing terms to refresh, so each call's one
  // verification is the new evidence itself — a fresh decision each time.
  for (const id of [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2]) {
    const count = verifyCount(w);
    approveAs(w, p, id);
    assert.equal(count(), 1, `approve by ${id}`);
  }
});

test('submit with auto-pay verifies the standing terms and the allowance once each', async () => {
  const w = world({}, {}, AUTO_WORLD);
  const p = lunch(w, 900);
  const count = verifyCount(w);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
  // The admission refresh verifies the standing record; the mandate
  // evidence carries identical signed bytes, so its re-checks consult the
  // scope's verdict. The employer recheck and the frozen evidence share one
  // resolution.
  assert.equal(count(), 2);
});

test('submit with a device approval verifies the terms, the approval and the allowance once each', async () => {
  const w = world();
  const p = lunch(w, 900);
  approveAs(w, p);
  const count = verifyCount(w);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
  // The admission-time approval re-check reuses the verdict the refresh
  // computed in the same decision.
  assert.equal(count(), 3);
});

test('a validity projection shares the verified standing read its caller passes', () => {
  const w = world({}, {}, AUTO_WORLD);
  const p = lunch(w, 900);
  const count = verifyCount(w);
  // The caller reads the record once for the whole list; each entry's own
  // signature still verifies — the mandate snapshot's bytes equal the
  // record's only when they are the same revision, which is one record.
  const record = w.coordinator.employeeMandate(EMPLOYEE);
  const reads = count();
  for (const a of p.authorizations) {
    assert.equal(w.coordinator.authorizationCurrentlyValid(p, a, record), true);
  }
  assert.equal(reads, 1, 'one verified read served the whole list');
  assert.equal(count() - reads, p.authorizations.length, 'each entry still verifies its own signature');
});

test('a stored record corrupted between two operations fails closed at the next decision', async () => {
  const w = world({}, {}, AUTO_WORLD);
  const p = lunch(w, 900);
  // Corrupt the retained standing record in place (the registry's
  // fault-injection seam). The next decision must not reuse the earlier
  // scope's verdicts: it verifies the mutated content and refuses.
  w.authority.storedEmployeeMandate(EMPLOYEE)!.payload.maxCents = 1;
  assert.throws(() => w.coordinator.refreshAuthorization(p), /employee_mandate_invalid/);
  await assert.rejects(() => w.coordinator.submit(p, 'atomic'), /employee_mandate_invalid/);
});

test('an employer record corrupted between two operations fails closed at the next decision', async () => {
  const w = world();
  const p = lunch(w, 900);
  approveAs(w, p);
  // Corrupt the retained allowance in place: the admission recheck verifies
  // the mutated bytes, never a verdict from the proposal's scope.
  w.authority.employerMandate(w.mandate.mandateRef)!.payload.beneficiaryRef = COLLEAGUE_1;
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'failed');
  assert.match(p.reason ?? '', /^employer_authority_invalid:/);
});
