// Regression tests for the defects listed in docs/backlog.md (B1–B5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, world, lunch, updateMandate, EMPLOYEE, EMPLOYER, MERCHANT_A } from '../src/scenarios.ts';
import { FEE_COLLECTOR } from '../src/mock-backend.ts';

const run = (id: string) => {
  const s = scenarios.find((x) => x.id.startsWith(id));
  if (!s) throw new Error(`no scenario ${id}`);
  return s.run();
};

test('B1 fees default to zero and are bound in the approval', () => {
  const { p } = run('S01');
  assert.equal(p.proposal.feesCents, 0);
  assert.equal(p.approval?.feesCents, 0);
  assert.deepEqual(p.legs.map((l) => l.feeCents), [0, 0]);
});

test('B1 a non-zero fee is paid by the employee on top of the total and counts against their instruction', () => {
  const w = world();
  const p = lunch(w, 1_300, MERCHANT_A, { feesCents: 20 });
  // EUR 8 share + EUR 0.20 fee is above the EUR 8 instruction.
  assert.equal(p.state, 'draft');
  assert.equal(p.reason, 'employee_share_exceeds_instruction');
  w.coordinator.reviseInstruction(p, 820);
  w.coordinator.approveCurrent(p);
  w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300, 'the merchant receives exactly the total');
  assert.equal(w.backend.account(FEE_COLLECTOR).linkedBankCents, 20);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000 - 820);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000 - 500, 'the employer never pays the employee fee');
});

test('B1 a missing fee-collector account throws before any money moves', () => {
  const w = world();
  w.backend.accounts.delete(FEE_COLLECTOR);
  const p = lunch(w, 1_300, MERCHANT_A, { feesCents: 20 });
  w.coordinator.reviseInstruction(p, 820);
  w.coordinator.approveCurrent(p);
  assert.throws(() => w.coordinator.submit(p, 'atomic'), /unknown account psp-fees/);
  // The settlement failed atomically: neither leg debited, nothing credited.
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYEE).linkedBankCents, 50_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0);
});

test('B3 a mandate granted to another employee funds nothing', () => {
  const w = world({}, { beneficiaryRef: 'employee-2' });
  const p = lunch(w);
  assert.equal(p.proposal.employerCents, 0);
  assert.equal(p.state, 'draft', 'EUR 13 alone exceeds the EUR 8 instruction');
  const proposal = w.trace.events.find((e) => e.event === 'proposal');
  assert.equal(proposal?.detail?.ineligibleReason, 'beneficiary_mismatch');
});

test('B3 the beneficiary is rechecked at initiation', () => {
  const w = world();
  const p = lunch(w);
  w.coordinator.approveCurrent(p);
  updateMandate(w, { beneficiaryRef: 'employee-2' });
  w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'failed');
  assert.equal(p.reason, 'employer_authority_invalid:beneficiary_mismatch');
  assert.equal(w.backend.executionCount(), 0);
});
