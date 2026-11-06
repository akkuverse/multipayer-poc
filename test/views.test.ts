// Per-recipient projections (docs/field-map.md): a payee sees what it
// received, never who paid; the sponsor sees its own contribution, never the
// purchase total or the employee's share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, world, lunch, approveAs, proposeSplitAs, submitAs, refundAs, updateEmployeeMandate, legChildKey, openFundAs, pledgeAs, AUTO_EMPLOYEE_TERMS, EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, PLATFORM, PROJECT_1, RESIDENT_1, RESIDENT_2 } from '../src/scenarios.ts';
import { viewFor } from '../src/core/privacy.ts';
import type { CampaignTerms } from '../src/core/types.ts';

const run = (id: string) => scenarios.find((s) => s.id.startsWith(id))!.run();
const sponsorView = (p: Parameters<typeof viewFor>[0]) => viewFor(p, { partyId: EMPLOYER, facet: 'sponsor' });
// These tests only ever project ordinary purchases — a campaign profile's
// FundPayerView is a distinct result the narrowing keeps honest.
const payerView = (p: Parameters<typeof viewFor>[0], payerId: string) => {
  const v = viewFor(p, { partyId: payerId, facet: 'payer' });
  assert.ok('totalCents' in v, 'expected the ordinary payer view');
  return v;
};
const payeeView = (p: Parameters<typeof viewFor>[0], payeeId: string) => viewFor(p, { partyId: payeeId, facet: 'payee' });

test('the employer sees its own contribution and nothing else', async () => {
  const { p } = await run('S01');
  const v = sponsorView(p);
  assert.deepEqual(Object.keys(v).sort(), ['contributionCents', 'mandateRef', 'merchantId', 'purchaseId', 'status']);
  assert.equal(v.contributionCents, 500);
  assert.equal(v.status, 'settled');
});

test('the employer sees a returned contribution as returned', async () => {
  const { p } = await run('S05');
  assert.equal(sponsorView(p).status, 'returned');
});

test('the merchant sees what it received, not who paid', async () => {
  const { p } = await run('S01');
  const v = payeeView(p, MERCHANT_A);
  assert.equal(v.receivedCents, 1_300);
  assert.equal(v.contributions.length, 2);
  // An ordinary purchase has no funding phase to report — the key is
  // absent, not merely empty (conditional-fund purchases only).
  assert.equal('fundingOutcome' in v, false);
  const json = JSON.stringify(v);
  assert.equal(json.includes(EMPLOYEE), false);
  assert.equal(json.includes(EMPLOYER), false);
});

test('each payee in a multi-payee purchase sees only its own legs', async () => {
  const { p } = await run('S18');
  assert.equal(payeeView(p, PLATFORM).receivedCents, 250);
  assert.equal(payeeView(p, PLATFORM).contributions.length, 1);
  assert.equal(payeeView(p, MERCHANT_A).receivedCents, 1_250);
});

test('a split payer sees their own share and legs, the others combined in the total', async () => {
  const { p } = await run('S03');
  const v = payerView(p, COLLEAGUE_1);
  assert.equal(v.ownCents, 1_333);
  assert.equal(v.othersCents, 2_667);
  assert.equal(v.ownLegs.length, 1);
});

test('a sponsor cannot be projected through the payer view', async () => {
  const { p } = await run('S01');
  assert.throws(() => payerView(p, EMPLOYER), /recipient_not_entitled/);
});

test('the sponsor view only exists for the employer the frozen source names', async () => {
  const { p } = await run('S03');
  assert.throws(() => sponsorView(p), /recipient_not_entitled/);
});

test('a purchase with no employer share reports the sponsor not submitted', async () => {
  const { p } = await run('S10');
  const v = sponsorView(p);
  assert.equal(v.contributionCents, 0);
  assert.equal(v.status, 'not_submitted');
});

test('returned legs do not count as received', async () => {
  const { p } = await run('S05');
  const v = payeeView(p, MERCHANT_A);
  assert.equal(v.receivedCents, 0);
  assert.ok(v.contributions.some((c) => c.status === 'returned'));
});

test('the payer view separates present eligibility from the authority that funded the payment', async () => {
  const terms = { ...AUTO_EMPLOYEE_TERMS, autoPayMonthlyCents: 600 };
  const w = world({}, {}, { employeeMandate: terms, supportsMandatePayments: true });
  const p = lunch(w, 900);
  await submitAs(w, p, EMPLOYEE);
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

test('a compensated purchase reports no unreturned fees: compensation restores principal and fee', async () => {
  // diner-2's bank leg carries a fee and commits; diner-3's pay credit is
  // conclusively refused, so the atomic intent compensates the committed leg
  // under 'principal_and_fee'. The snapshot records fee charged and fee
  // returned — a 'returned' leg here keeps no fee, and the view must not
  // report one retained.
  const w = world();
  const p = proposeSplitAs(
    w,
    {
      purchaseId: 'split-fee-comp',
      merchantId: MERCHANT_A,
      amountsFrom: 'proposer',
      totalCents: 1_300,
      shares: [
        { role: 'diner-1', payerId: EMPLOYEE, amountCents: 800, rail: 'digital_euro' },
        { role: 'diner-2', payerId: COLLEAGUE_1, amountCents: 300, feeCents: 5, rail: 'bank' },
        { role: 'diner-3', payerId: COLLEAGUE_2, amountCents: 200, rail: 'bank' },
      ],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  for (const id of [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2]) approveAs(w, p, id);
  w.providers.get(COLLEAGUE_2)!.setFault(legChildKey('split-fee-comp', 1, 'diner-3', 'pay', 'psp-shop-merchant-a'), 'credit', 'reject_before_effect');
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'compensated');
  assert.equal(w.providers.get(COLLEAGUE_1)!.feesCents, 0, 'the charged fee was returned too');
  const v = payerView(p, COLLEAGUE_1);
  assert.equal(v.returnedCents, 300, 'the committed principal came back');
  assert.equal(v.unreturnedFeeCents, 0, 'compensation returned the fee — nothing is retained');
});

// --- Conditional-fund projections (public_good_pledge_v1) -------------------

const FUND_TERMS = (over: Partial<CampaignTerms> = {}): CampaignTerms => ({
  purchaseId: 'fund-views',
  payeeId: PROJECT_1,
  condition: { minPayers: 2, minTotalCents: 1_000 },
  fundingEndsAt: 20,
  settleBy: 30,
  acceptPledgesUntil: 'condition_met',
  submitPolicy: 'on_request',
  settlementMode: 'atomic',
  privacyProfile: 'public_good_pledge_v1',
  ...over,
});

const fundPayerView = (p: Parameters<typeof viewFor>[0], payerId: string) => {
  const v = viewFor(p, { partyId: payerId, facet: 'payer' });
  assert.ok('pledge' in v, 'expected the fund payer view');
  return v;
};

test('a settled fund reports each contributor only its own leg outcome', async () => {
  const w = world();
  const id = openFundAs(w, FUND_TERMS());
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30, { feeCents: 7, rail: 'bank' });
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  await submitAs(w, w.coordinator.view(id), RESIDENT_1);
  const p = w.coordinator.view(id);
  assert.equal(p.state, 'completed');
  const v = fundPayerView(p, RESIDENT_2);
  // The complete allowlist — no ordinary total-bearing field is present.
  assert.deepEqual(Object.keys(v).sort(), [
    'acceptance',
    'campaign',
    'merchantId',
    'outcome',
    'ownLegs',
    'pledge',
    'privacyProfile',
    'progress',
    'purchaseId',
    'returnedCents',
    'state',
    'unreturnedFeeCents',
  ]);
  assert.equal(v.ownLegs.length, 1);
  assert.equal(v.ownLegs[0].status, 'settled');
  assert.equal(v.ownLegs[0].amountCents, 700);
  assert.equal(v.ownLegs[0].payeeId, PROJECT_1);
  assert.equal(v.returnedCents, 0);
  assert.equal(v.unreturnedFeeCents, 0);
  assert.deepEqual(v.progress, { contributors: 2, pledgedCents: 1_000, met: true });
  assert.equal(JSON.stringify(v).includes(RESIDENT_1), false);
});

test('a returned fund leg reports returned principal and the retained fee on that contributor only', async () => {
  const w = world();
  const id = openFundAs(w, FUND_TERMS());
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30, { feeCents: 7, rail: 'bank' });
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30, { feeCents: 3 });
  await submitAs(w, w.coordinator.view(id), RESIDENT_1);
  await refundAs(w, w.coordinator.view(id), PROJECT_1);
  const p = w.coordinator.view(id);
  const v = fundPayerView(p, RESIDENT_2);
  assert.equal(v.ownLegs[0].status, 'returned');
  assert.equal(v.returnedCents, 700, 'own principal confirmed returned');
  assert.equal(v.unreturnedFeeCents, 3, 'the charged fee is never given back');
  const json = JSON.stringify(v);
  assert.equal(json.includes(RESIDENT_1), false);
  assert.equal(json.includes('r1'), false);
});
