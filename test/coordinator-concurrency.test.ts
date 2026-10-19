// B16: hold real settlement calls at their interface; only scheduling changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareCents } from '../src/core/coordinator.ts';
import { world, lunch, approveAs, EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_B } from '../src/scenarios.ts';

type HoldPhase = 'before_dispatch' | 'before_response';

function holdNext<A extends unknown[], R>(call: (...args: A) => Promise<R>, phase: HoldPhase) {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let first = true;
  return {
    entered: entered.promise,
    release: () => resume.resolve(),
    call: async (...args: A): Promise<R> => {
      if (!first) return call(...args);
      first = false;
      if (phase === 'before_dispatch') {
        entered.resolve();
        await resume.promise;
      }
      const response = await call(...args);
      if (phase === 'before_response') {
        entered.resolve();
        await resume.promise;
      }
      return response;
    },
  };
}

for (const initiation of ['coordinator', 'per_payer_psp'] as const) {
  for (const phase of ['before_dispatch', 'before_response'] as const) {
    test(`B16 ${initiation} submit ${phase} protects terms and benefit until its outcome arrives`, async () => {
      const w = world({}, {}, { initiation });
      const p = lunch(w);
      const approval = approveAs(w, p);
      const held = holdNext(w.backend.submit.bind(w.backend), phase);
      w.backend.submit = held.call;
      const running = w.coordinator.submit(p, 'atomic');
      await held.entered;
      try {
        const before = structuredClone(p);
        // Each public mutation must refuse before it can change terms, clear
        // legs/reservations, or derive a state from an incomplete operation.
        assert.throws(() => w.coordinator.cancel(p), /operation_in_progress/);
        assert.throws(() => w.coordinator.changeOffer(p, { merchantId: MERCHANT_B, totalCents: 1_200, expiresAt: 100 }), /operation_in_progress/);
        assert.throws(() => w.coordinator.reviseInstruction(p, 1_300), /operation_in_progress/);
        assert.throws(() => w.coordinator.approve(p, approval), /operation_in_progress/);
        await assert.rejects(() => w.coordinator.submit(p, 'atomic'), /operation_in_progress/);
        await assert.rejects(() => w.coordinator.resubmit(p), /operation_in_progress/);
        await assert.rejects(() => w.coordinator.reconcile(p), /operation_in_progress/);
        await assert.rejects(() => w.coordinator.recover(p), /operation_in_progress/);
        await assert.rejects(() => w.coordinator.refund(p), /operation_in_progress/);
        assert.deepEqual(p, before);
        assert.deepEqual(w.coordinator.ledger.usage(w.mandate.mandateRef, 0), { cents: 500, purchases: 1 });
        const second = lunch(w, 1_300, MERCHANT_A, { purchaseId: 'purchase-2' });
        assert.equal(shareCents(second.proposal, 'employer'), 0, 'cancellation cannot free benefit for a second lunch');
        assert.equal(second.state, 'draft', 'the employee is not charged the missing employer share');

        // A hold belongs to one purchase: another approved payment can finish.
        const other = w.coordinator.proposeSplit({
          purchaseId: 'other-purchase', merchantId: MERCHANT_B, expiresAt: 100,
          shares: [{ role: 'employee', payerId: EMPLOYEE, amountCents: 100 }],
        });
        approveAs(w, other);
        await w.coordinator.submit(other, 'atomic');
        assert.equal(other.state, 'completed');
      } finally {
        held.release();
        await running;
      }
      // In per-PSP assembly the first response can still be unknown after
      // the second PSP completes the group. Normal reconciliation resolves it.
      await w.coordinator.reconcile(p);
      assert.equal(p.state, 'completed');
      assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
      assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300);
      assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 99_500);
      await w.coordinator.refund(p);
      assert.equal(p.returnStatus, 'completed', 'completion releases the operation guard for later work');
    });
  }
}

for (const operation of ['resubmit', 'reconcile', 'recover', 'refund'] as const) {
  test(`B16 a held ${operation} refuses overlapping work and can finish normally`, async () => {
    const w = world();
    const p = lunch(w);
    approveAs(w, p);
    if (operation === 'resubmit' || operation === 'reconcile') w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
    if (operation === 'recover') w.backend.faults.set(EMPLOYEE, 'decline');
    await w.coordinator.submit(p, operation === 'recover' ? 'independent' : 'atomic');
    const held = (() => {
      if (operation === 'resubmit') {
        const hold = holdNext(w.backend.submit.bind(w.backend), 'before_response');
        w.backend.submit = hold.call;
        return hold;
      }
      if (operation === 'reconcile') {
        const hold = holdNext(w.backend.status.bind(w.backend), 'before_response');
        w.backend.status = hold.call;
        return hold;
      }
      const hold = holdNext(w.backend.refund.bind(w.backend), 'before_response');
      w.backend.refund = hold.call;
      return hold;
    })();
    const running = w.coordinator[operation](p);
    await held.entered;
    try {
      const before = structuredClone(p);
      await assert.rejects(() => w.coordinator[operation](p), /operation_in_progress/);
      if (operation !== 'reconcile') await assert.rejects(() => w.coordinator.reconcile(p), /operation_in_progress/);
      assert.deepEqual(p, before);
    } finally {
      held.release();
      await running;
    }
    await w.coordinator.reconcile(p);
    assert.equal(p.state, operation === 'recover' ? 'cancelled' : 'completed');
    if (operation === 'recover' || operation === 'refund') {
      assert.equal(p.returnStatus, 'completed');
      assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0);
      assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
    } else {
      assert.equal(w.backend.executionCount(), 2);
      assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300);
    }
  });
}

test('B16 a refused submission releases its operation guard so a corrected request can run', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  const account = w.backend.account(MERCHANT_A);
  w.backend.accounts.delete(MERCHANT_A);
  const held = holdNext(w.backend.submit.bind(w.backend), 'before_dispatch');
  w.backend.submit = held.call;
  const running = w.coordinator.submit(p, 'atomic');
  const refused = assert.rejects(running, /unknown account/);
  await held.entered;
  try {
    assert.throws(() => w.coordinator.cancel(p), /operation_in_progress/);
  } finally {
    held.release();
    await refused;
  }
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.equal(w.backend.executionCount(), 0);
  w.backend.addAccount(account);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300);
});
