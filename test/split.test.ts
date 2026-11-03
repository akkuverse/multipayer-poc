// Split purchases: every payer approves their own share, no benefit policy
// applies, and a share that fails is never re-split across the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, approveAs, EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, MERCHANT_B, PLATFORM } from '../src/scenarios.ts';
import { equalShares } from '../src/core/policy.ts';

const split = (w: ReturnType<typeof world>, shares: { role: string; payerId: string; payeeId?: string; amountCents: number; feeCents?: number }[]) =>
  w.coordinator.view(w.coordinator.proposeSplit({ purchaseId: 'purchase-1', merchantId: MERCHANT_B, expiresAt: 100, shares }));

test('equal shares are integer cents, sum exactly, and give the remainder to the first payers', () => {
  assert.deepEqual(equalShares(4_000, 3), [1_334, 1_333, 1_333]);
  assert.deepEqual(equalShares(1_000, 4), [250, 250, 250, 250]);
  assert.deepEqual(equalShares(2, 3), [1, 1, 0]);
});

test('malformed split input is refused before any approval exists', () => {
  const w = world();
  assert.throws(() => split(w, []), /distinct roles/);
  assert.throws(() => split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: 500 }, { role: 'a', payerId: COLLEAGUE_1, amountCents: 500 }]), /distinct roles/);
  assert.throws(() => split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: 0 }]), /positive integer/);
  assert.throws(() => split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: -100 }]), /positive integer/);
  assert.throws(() => split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: 10.5 }]), /positive integer/);
  assert.throws(() => split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: 500, feeCents: -1 }]), /fees must be/);
  assert.throws(() => split(w, [{ role: '', payerId: EMPLOYEE, amountCents: 500 }]), /non-empty/);
  assert.throws(() => split(w, [{ role: 'a', payerId: '', amountCents: 500 }]), /non-empty/);
  assert.throws(
    () => w.coordinator.view(w.coordinator.proposeSplit({ purchaseId: 'purchase-1', merchantId: '', expiresAt: 100, shares: [{ role: 'a', payerId: EMPLOYEE, amountCents: 500 }] })),
    /merchant of record/,
  );
  assert.throws(() => equalShares(4_000, 0), /positive integer/);
  assert.throws(() => equalShares(4_000.5, 3), /integer cents/);
});

test('a split is never repriced; changing it means proposing again', () => {
  const w = world();
  const p = split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: 500 }, { role: 'b', payerId: COLLEAGUE_1, amountCents: 500 }]);
  assert.throws(() => w.coordinator.changeOffer(p.purchaseId, { merchantId: MERCHANT_B, totalCents: 1_200, expiresAt: 100 }), /cannot be repriced/);
});

test('a split stays awaiting approvals until every payer approved', async () => {
  const w = world();
  const p = split(w, [
    { role: 'a', payerId: EMPLOYEE, amountCents: 500 },
    { role: 'b', payerId: COLLEAGUE_1, amountCents: 500 },
    { role: 'c', payerId: COLLEAGUE_2, amountCents: 500 },
  ]);
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, COLLEAGUE_1);
  assert.equal(p.state, 'awaiting_approvals');
  await assert.rejects(() => w.coordinator.submit(p.purchaseId, 'atomic'), /cannot submit/);
  approveAs(w, p, COLLEAGUE_2);
  assert.equal(p.state, 'ready');
});

test('one payer with two legs in an atomic group is funded for their total', async () => {
  const w = world({ deCents: 1_000, reverseWaterfall: false });
  const p = w.coordinator.view(w.coordinator.proposeSplit({
    purchaseId: 'purchase-1',
    merchantId: MERCHANT_A,
    expiresAt: 100,
    shares: [
      { role: 'restaurant', payerId: EMPLOYEE, payeeId: MERCHANT_A, amountCents: 800 },
      { role: 'delivery', payerId: EMPLOYEE, payeeId: PLATFORM, amountCents: 400 },
    ],
  }));
  approveAs(w, p, EMPLOYEE);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_000);
});
