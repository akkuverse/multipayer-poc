// Per-recipient projections (docs/field-map.md): a payee sees what it
// received, never who paid; the sponsor sees its own contribution, never the
// purchase total or the employee's share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, world, lunch, updateEmployeeMandate, AUTO_EMPLOYEE_TERMS, EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, PLATFORM } from '../src/scenarios.ts';
import { payerView, payeeView, sponsorView } from '../src/core/views.ts';

const run = (id: string) => scenarios.find((s) => s.id.startsWith(id))!.run();

test('the employer sees its own contribution and nothing else', async () => {
  const { p } = await run('S01');
  const v = sponsorView(p);
  assert.deepEqual(Object.keys(v).sort(), ['contributionCents', 'mandateRef', 'merchantId', 'purchaseId', 'status']);
  assert.equal(v.contributionCents, 500);
  assert.equal(v.status, 'settled');
});

test('the employer sees a returned contribution as returned', async () => {
  const { p } = await run('S03');
  assert.equal(sponsorView(p).status, 'returned');
});

test('the merchant sees what it received, not who paid', async () => {
  const { p } = await run('S01');
  const v = payeeView(p, MERCHANT_A);
  assert.equal(v.receivedCents, 1_300);
  assert.equal(v.contributions.length, 2);
  const json = JSON.stringify(v);
  assert.equal(json.includes(EMPLOYEE), false);
  assert.equal(json.includes(EMPLOYER), false);
});

test('each payee in a multi-payee purchase sees only its own legs', async () => {
  const { p } = await run('S15');
  assert.equal(payeeView(p, PLATFORM).receivedCents, 250);
  assert.equal(payeeView(p, PLATFORM).contributions.length, 1);
  assert.equal(payeeView(p, MERCHANT_A).receivedCents, 1_250);
});

test('a payer sees their own share and the others only combined', async () => {
  const { p } = await run('S13');
  const v = payerView(p, COLLEAGUE_1);
  assert.equal(v.ownCents, 1_333);
  assert.equal(v.othersCents, 2_667);
  assert.equal(v.ownLegs.length, 1);
  const json = JSON.stringify(v);
  assert.equal(json.includes(EMPLOYEE), false, 'no other payer identity');
  assert.equal(json.includes(COLLEAGUE_2), false);
});

test('a sponsor cannot be projected through the payer view', async () => {
  const { p } = await run('S01');
  assert.throws(() => payerView(p, EMPLOYER), /no payer share/);
});

test('the sponsor view only exists on benefit purchases', async () => {
  const { p } = await run('S13');
  assert.throws(() => sponsorView(p), /only benefit/);
});

test('a purchase with no employer share reports the sponsor not submitted', async () => {
  const { p } = await run('S11');
  const v = sponsorView(p);
  assert.equal(v.contributionCents, 0);
  assert.equal(v.status, 'not_submitted');
});

test('returned legs do not count as received', async () => {
  const { p } = await run('S03');
  const v = payeeView(p, MERCHANT_A);
  assert.equal(v.receivedCents, 0);
  assert.ok(v.contributions.some((c) => c.status === 'returned'));
});

test('the payer view separates present eligibility from the authority that funded the payment', async () => {
  const terms = { ...AUTO_EMPLOYEE_TERMS, autoPayMonthlyCents: 600 };
  const w = world({}, {}, { employeeMandate: terms, supportsMandatePayments: true });
  const p = lunch(w, 900);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(p.state, 'completed');
  // Standing terms moved on afterwards: the frozen authority that funded the
  // purchase stays 'mandate', while the current assessment answers what the
  // debit would need now.
  updateEmployeeMandate(w, { revoked: true });
  const v = payerView(p, EMPLOYEE);
  assert.equal(v.authorizationBasis, 'mandate');
  // The mandate reference itself stays out of the payer column (field map).
  assert.equal(v.authorizationRef, undefined);
  assert.ok(!JSON.stringify(v).includes('employee-mandate-1'));
  assert.equal(v.assessment?.authZone, 'Auto', 'the recorded assessment funded the submission');
  assert.equal(w.coordinator.assess(p.purchaseId).authZone, 'Confirm', 'present eligibility moved on');
  assert.equal(w.coordinator.assess(p.purchaseId).autoPayBlockedReason, 'mandate_revoked');
});

test('a device-funded payment reports its device basis and no mandate fields', async () => {
  const { p } = await run('S01');
  const v = payerView(p, EMPLOYEE);
  assert.equal(v.authorizationBasis, 'device');
  assert.equal(v.assessment?.authZone, 'Confirm');
});
