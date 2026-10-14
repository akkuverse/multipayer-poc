// Proposals are a list of shares; each payer whose authority is 'approval'
// approves their own shares. A payer with no approval share cannot approve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, lunch, approveAs, EMPLOYER } from '../src/scenarios.ts';
import { shareCents } from '../src/coordinator.ts';

test('a zero employee share still needs the employee\'s approval', async () => {
  const w = world();
  const p = lunch(w, 400);
  assert.equal(shareCents(p.proposal, 'employee'), 0);
  assert.equal(p.state, 'awaiting_approvals');
  await assert.rejects(() => w.coordinator.submit(p, 'atomic'), /cannot submit/);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
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
  assert.equal(p.approvals.length, 0);
});
