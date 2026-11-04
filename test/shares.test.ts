// Proposals are a list of shares; each payer whose authority is 'approval'
// approves their own shares. A payer with no approval share cannot approve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, lunch, approveAs, submitAs, refundAs, EMPLOYEE, EMPLOYER } from '../src/scenarios.ts';
import { shareCents } from '../src/core/coordinator.ts';

test('a zero employee share still needs the employee\'s approval', async () => {
  const w = world();
  const p = lunch(w, 400);
  assert.equal(shareCents(p.proposal, 'employee'), 0);
  assert.equal(p.state, 'awaiting_approvals');
  await assert.rejects(() => submitAs(w, p, EMPLOYEE), /cannot submit/);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  assert.deepEqual(p.legs.map((l) => [l.leg, l.amountCents]), [['employer', 400]]);
});

test('an approval from a payer with no approval share is rejected', () => {
  const w = world();
  const p = lunch(w);
  // The employer pays under its mandate, not by approving; a stranger has no share.
  assert.throws(() => approveAs(w, p, EMPLOYER), /does not match/);
  assert.throws(() => approveAs(w, p, 'stranger-1'), /does not match/);
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.authorizations.length, 0);
});

test('a fee-only employee share settles once and ordinary refund retains its fee', async () => {
  const w = world();
  const p = lunch(w, 400, undefined, { feesCents: 20 });
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  assert.deepEqual(p.legs.map(l => [l.leg, l.amountCents]), [['employee', 0], ['employer', 400]]);
  assert.equal(w.providers.get(EMPLOYEE)!.feesCents, 20);
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(w.providers.get(EMPLOYEE)!.feesCents, 20);
  await refundAs(w, p, p.proposal.merchantId);
  assert.equal(p.returnStatus, 'completed');
  assert.equal(w.providers.get(EMPLOYEE)!.feesCents, 20);
});
