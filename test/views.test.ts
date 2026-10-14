import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, PLATFORM } from '../src/scenarios.ts';
import { payerView, payeeView, sponsorView } from '../src/views.ts';

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
  assert.throws(() => payerView(p, EMPLOYER), /no approval share/);
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
