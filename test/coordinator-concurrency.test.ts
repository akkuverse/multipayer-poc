// B16: hold real settlement calls at their interface; only scheduling changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareCents } from '../src/core/coordinator.ts';
import { unwrapView } from '../src/core/live-view.ts';
import type { SubmitRequest } from '../src/settlement/backend.ts';
import { keyPairFromSeed, signPayload, verifyPayload } from '../src/core/signing.ts';
import { world, lunch, approveAs, cancelAs, changeOfferAs, proposeSplitAs, refundAs, submitAs, advance, updateMandate, updateEmployeeMandate, ASSEMBLY_WINDOW, AUTO_EMPLOYEE_TERMS, EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, MERCHANT_B } from '../src/scenarios.ts';

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

// The direct-mode seat uses the test-bypass fixture: these purchases span
// providers, so the guarded 'coordinator_as_psp' mode would refuse them.
for (const initiation of ['test_bypass_psp', 'per_payer_psp'] as const) {
  for (const phase of ['before_dispatch', 'before_response'] as const) {
    test(`B16 ${initiation} submit ${phase} protects terms and benefit until its outcome arrives`, async () => {
      const w = world({}, {}, { initiation });
      const p = lunch(w);
      const approval = approveAs(w, p);
      const held = holdNext(w.backend.submit.bind(w.backend), phase);
      w.backend.submit = held.call;
      const running = submitAs(w, p, EMPLOYEE);
      await held.entered;
      try {
        const before = structuredClone(unwrapView(p));
        // Each public mutation must refuse before it can change terms, clear
        // legs/reservations, or derive a state from an incomplete operation.
        assert.throws(() => cancelAs(w, p, EMPLOYEE), /operation_in_progress/);
        assert.throws(() => changeOfferAs(w, p, { merchantId: MERCHANT_B, totalCents: 1_200, expiresAt: 100 }, MERCHANT_A), /operation_in_progress/);
        assert.throws(() => w.coordinator.refreshAuthorization(p.purchaseId), /operation_in_progress/);
        assert.throws(() => w.coordinator.approve(p.purchaseId, approval), /operation_in_progress/);
        await assert.rejects(() => submitAs(w, p, EMPLOYEE), /operation_in_progress/);
        await assert.rejects(() => w.coordinator.resubmit(p.purchaseId), /operation_in_progress/);
        await assert.rejects(() => w.coordinator.reconcile(p.purchaseId), /operation_in_progress/);
        await assert.rejects(() => w.coordinator.recover(p.purchaseId), /operation_in_progress/);
        await assert.rejects(() => refundAs(w, p, MERCHANT_A), /operation_in_progress/);
        assert.deepEqual(p, before);
        assert.deepEqual(w.coordinator.ledger.usage(w.mandate.mandateRef, 0), { cents: 500, purchases: 1 });
        const second = lunch(w, 1_300, MERCHANT_A, { purchaseId: 'purchase-2' });
        assert.equal(shareCents(second.proposal, 'employer'), 0, 'cancellation cannot free benefit for a second lunch');
        assert.equal(second.state, 'awaiting_approvals', 'the employee is not charged the missing employer share');

        // A hold belongs to one purchase: another approved payment can finish.
        const other = proposeSplitAs(
          w,
          {
            purchaseId: 'other-purchase', merchantId: MERCHANT_B, expiresAt: 100,
            amountsFrom: 'equal_split', totalCents: 100,
            shares: [{ role: 'employee', payerId: EMPLOYEE }],
          },
          EMPLOYEE,
        );
        approveAs(w, other);
        await submitAs(w, other, other.proposal.shares[0].payerId);
        assert.equal(other.state, 'completed');
      } finally {
        held.release();
        await running;
      }
      // In per-PSP assembly the first response can still be unknown after
      // the second PSP completes the group. Normal reconciliation resolves it.
      await w.coordinator.reconcile(p.purchaseId);
      assert.equal(p.state, 'completed');
      assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
      assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300);
      assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 99_500);
      await refundAs(w, p, MERCHANT_A);
      assert.equal(p.returnStatus, 'completed', 'completion releases the operation guard for later work');
    });
  }
}

for (const operation of ['resubmit', 'reconcile', 'recover', 'refund'] as const) {
  test(`B16 a held ${operation} refuses overlapping work and can finish normally`, async () => {
    const w = world();
    const p = lunch(w, 1_300, MERCHANT_A, { settlementMode: operation === 'recover' ? 'independent' : 'atomic' });
    approveAs(w, p);
    if (operation === 'resubmit' || operation === 'reconcile') w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
    if (operation === 'recover') w.backend.faults.set(EMPLOYEE, 'decline');
    await submitAs(w, p, EMPLOYEE);
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
    // The refund leg of this table needs its signed caller request, like
    // every caller-facing refund; the coordinator's own post-failure ops
    // (resubmit/reconcile/recover) take none.
    const call = () => (operation === 'refund' ? refundAs(w, p, MERCHANT_A) : w.coordinator[operation](p.purchaseId));
    const running = call();
    await held.entered;
    try {
      const before = structuredClone(unwrapView(p));
      await assert.rejects(call, /operation_in_progress/);
      if (operation !== 'reconcile') await assert.rejects(() => w.coordinator.reconcile(p.purchaseId), /operation_in_progress/);
      assert.deepEqual(p, before);
    } finally {
      held.release();
      await running;
    }
    await w.coordinator.reconcile(p.purchaseId);
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

test('B16 a leg that loses authority between route calls is refused in place, never failing the purchase', async () => {
  // Atomic per-PSP: the employee leg is mid-forward when the employer mandate
  // is revoked. The employer leg's first-handoff recheck refuses it and keeps
  // the handed-off leg's outcome; the group resolves at its original deadline.
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const p = lunch(w);
  approveAs(w, p);
  const psp = w.psps.get(EMPLOYEE)!;
  const held = holdNext(psp.submit.bind(psp), 'before_response');
  psp.submit = held.call;
  const running = submitAs(w, p, EMPLOYEE);
  await held.entered;
  try {
    updateMandate(w, { revoked: true });
  } finally {
    held.release();
    await running;
  }
  assert.equal(p.legs[0].status, 'unknown', 'the employee leg was already handed off');
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'employer_authority_invalid:mandate_revoked');
  assert.equal(w.backend.executionCount(), 1, 'the refused leg never reached the backend');
  assert.equal(p.state, 'pending', 'a handed-off leg decides the state — never a whole-purchase failure');
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});

test('B16 an independent purchase enters recovery when a later leg loses authority mid-dispatch', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const p = lunch(w, 1_300, MERCHANT_A, { settlementMode: 'independent' });
  approveAs(w, p);
  const psp = w.psps.get(EMPLOYEE)!;
  const held = holdNext(psp.submit.bind(psp), 'before_response');
  psp.submit = held.call;
  const running = submitAs(w, p, EMPLOYEE);
  await held.entered;
  try {
    updateMandate(w, { revoked: true });
  } finally {
    held.release();
    await running;
  }
  assert.equal(p.legs[0].status, 'settled', 'the employee leg already settled');
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'employer_authority_invalid:mandate_revoked');
  // One settled leg and one refused leg: recovery, and the employer's
  // refused share is never shifted onto the employee.
  assert.equal(p.state, 'recovery_required');
  await w.coordinator.recover(p.purchaseId);
  assert.equal(p.state, 'cancelled');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});

test('B16 a first handoff after the deadline replays the admission-time assembly terms', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  const seen: SubmitRequest[] = [];
  const submit = w.backend.submit.bind(w.backend);
  w.backend.submit = async (req) => {
    seen.push(req);
    return submit(req);
  };
  // Past the admission deadline: the employer leg's first handoff must replay
  // the frozen assembly descriptor — the original size and deadline — never a
  // fresh window that would keep a dead group alive.
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.deepEqual(seen.map((r) => r.assembly), [
    { size: 2, assembleBy: 10 + ASSEMBLY_WINDOW },
    { size: 2, assembleBy: 10 + ASSEMBLY_WINDOW },
  ]);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
});

test('B16 an approval-funded leg refused mid-dispatch is recorded without failing the purchase', async () => {
  // Both legs are approval-funded; the first is mid-forward when the second
  // payer's approval expires. Its first-handoff recheck refuses that leg.
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const p = proposeSplitAs(
    w,
    {
      purchaseId: 'split-1',
      merchantId: MERCHANT_A,
      amountsFrom: 'equal_split',
      totalCents: 200,
      shares: [
        { role: 'a', payerId: EMPLOYEE },
        { role: 'b', payerId: EMPLOYER },
      ],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, EMPLOYER);
  const psp = w.psps.get(EMPLOYEE)!;
  const held = holdNext(psp.submit.bind(psp), 'before_response');
  psp.submit = held.call;
  const running = submitAs(w, p, EMPLOYEE);
  await held.entered;
  try {
    advance(w, 150);
  } finally {
    held.release();
    await running;
  }
  assert.equal(p.legs[0].status, 'unknown');
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'approval_expired:employer-1');
  assert.equal(w.backend.executionCount(), 1, 'the refused leg never reached the backend');
  assert.equal(p.state, 'pending');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
});

test('B16 a refused submission releases its operation guard so a corrected request can run', async () => {
  // Deliberately the test-bypass fixture: the assertion is about the
  // whole-request conclusive refusal and its rollback — under per-payer
  // initiation the same backend refusal lands on one leg instead.
  const w = world({}, {}, { initiation: 'test_bypass_psp' });
  const p = lunch(w);
  approveAs(w, p);
  const account = w.backend.account(MERCHANT_A);
  w.backend.accounts.delete(MERCHANT_A);
  const held = holdNext(w.backend.submit.bind(w.backend), 'before_dispatch');
  w.backend.submit = held.call;
  const running = submitAs(w, p, EMPLOYEE);
  const refused = assert.rejects(running, /unknown account/);
  await held.entered;
  try {
    assert.throws(() => cancelAs(w, p, EMPLOYEE), /operation_in_progress/);
  } finally {
    held.release();
    await refused;
  }
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.equal(w.backend.executionCount(), 0);
  w.backend.addAccount(account);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300);
});

test('B16 employee-terms publication during an in-flight operation defers the purchase refresh until the guard releases', async () => {
  // The submission is held mid-flight when new standing terms arrive: the
  // purchase keeps its terms, evidence and legs through the operation, and
  // the deferred refresh applies the revision only once the guard is
  // released. The conclusive pre-dispatch refusal below leaves the purchase
  // in 'ready' — an open state — so the drained refresh is observable.
  // Deliberately the test-bypass fixture: only the whole-request refusal
  // rolls back to 'ready'; under per-payer initiation the same backend
  // refusal is a per-leg rejection that fails the purchase.
  const w = world({}, {}, { initiation: 'test_bypass_psp' });
  const p = lunch(w);
  approveAs(w, p);
  w.backend.accounts.delete(MERCHANT_A);
  const held = holdNext(w.backend.submit.bind(w.backend), 'before_dispatch');
  w.backend.submit = held.call;
  const running = submitAs(w, p, EMPLOYEE);
  const refused = assert.rejects(running, /unknown account/);
  await held.entered;
  try {
    const before = structuredClone(unwrapView(p));
    // Lowering the standing maximum below the debit is accepted as new
    // terms, but must not reach the in-flight purchase.
    updateEmployeeMandate(w, { maxCents: 700 });
    assert.deepEqual(p, before);
    assert.equal(p.state, 'ready');
  } finally {
    held.release();
    await refused;
  }
  // Drained after the guard released: the device approval no longer fits the
  // revised maximum, so the purchase waits for a signed exception.
  assert.equal(w.backend.executionCount(), 0);
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.equal(p.employeeAssessment?.authZone, 'Exception');
  assert.equal(p.authorizations.length, 0);
  assert.equal(p.state, 'awaiting_approvals');
  const invalidated = w.trace.events.filter((e) => e.event === 'approval_invalidated');
  assert.ok(invalidated.some((e) => e.detail?.basis === 'device' && e.detail?.payerId === EMPLOYEE));
  assert.ok(w.trace.events.some((e) => e.event === 'auth_zone' && e.detail?.authZone === 'Exception'));
});

test('B16 a corrupted retained record cannot mask a refusal or starve the deferred drain', async () => {
  // Two ready purchases of one employee, both held before dispatch. New
  // standing terms arrive while both operations are in flight, so each
  // purchase's refresh is deferred; deleting the employee's key then
  // corrupts the retained record, so every later refresh — the rollback's
  // own and the drain's — throws employee_mandate_invalid. Neither may
  // replace the conclusive pre-dispatch refusal the caller is owed, and one
  // failing drain must not starve the other purchase's.
  // Deliberately the test-bypass fixture: the assertion is about the
  // whole-request conclusive refusal and its rollback, one backend call
  // per purchase — under per-payer initiation each leg is its own request.
  const w = world({}, { maxPerDayCents: 10_000, maxPurchasesPerDay: 10 }, { initiation: 'test_bypass_psp' });
  const first = lunch(w);
  const second = lunch(w, 1_300, MERCHANT_A, { purchaseId: 'purchase-2' });
  approveAs(w, first);
  approveAs(w, second);
  w.backend.accounts.delete(MERCHANT_A);
  const gate = Promise.withResolvers<void>();
  const bothHeld = Promise.withResolvers<void>();
  let heldCalls = 0;
  const realSubmit = w.backend.submit.bind(w.backend);
  w.backend.submit = async (req) => {
    if (++heldCalls === 2) bothHeld.resolve();
    await gate.promise;
    return realSubmit(req);
  };
  const running = [submitAs(w, first, EMPLOYEE), submitAs(w, second, EMPLOYEE)];
  const refused = running.map((r) => assert.rejects(r, /unknown account/));
  await bothHeld;
  try {
    // Both purchases are in flight: publication defers each refresh to the
    // drain. Only then corrupt the retained record, so every later refresh
    // of either purchase fails closed.
    updateEmployeeMandate(w, { maxCents: 700 });
    w.keys.delete(w.signers.get(EMPLOYEE)!.keyId);
  } finally {
    gate.resolve();
    await Promise.all(refused);
  }
  // The original refusal reached the caller both times; each refresh failure
  // is evidence in the trace instead — logged for BOTH purchases, so one
  // throw did not abort the other's drain.
  const failed = w.trace.events.filter((e) => e.event === 'auth_refresh_failed');
  assert.deepEqual(
    new Set(failed.map((e) => e.detail?.purchaseId)),
    new Set([first.purchaseId, second.purchaseId]),
  );
  assert.ok(failed.every((e) => e.detail?.message === 'employee_mandate_invalid'));
  assert.equal(failed.length, 2, 'one refresh failure per purchase, even across rollback and deferred retries');
  // Rollback left both purchases repairable: legs, intent and reservations
  // released, open 'ready' state kept.
  assert.equal(first.state, 'ready');
  assert.equal(second.state, 'ready');
  assert.equal(w.coordinator.ledger.state(first.purchaseId), undefined);
  assert.equal(w.coordinator.ledger.state(second.purchaseId), undefined);
  // Fail-closed stays fail-closed: the public refresh and a fresh submission
  // still surface the corruption rather than pay under stale evidence. The
  // employee's own key is gone from the registry — their request would be
  // bad_signature — so the employer (the proposal's other payer) signs it.
  assert.throws(() => w.coordinator.refreshAuthorization(first.purchaseId), /employee_mandate_invalid/);
  await assert.rejects(() => submitAs(w, first, EMPLOYER), /employee_mandate_invalid/);
  // The failed refreshes were never dropped: an unrelated purchase's
  // operation drains them again — and still cannot be masked by them.
  const other = proposeSplitAs(
    w,
    {
      purchaseId: 'other-purchase',
      merchantId: MERCHANT_B,
      amountsFrom: 'equal_split',
      totalCents: 200,
      shares: [
        { role: 'a', payerId: COLLEAGUE_1 },
        { role: 'b', payerId: COLLEAGUE_2 },
      ],
      expiresAt: 100,
    },
    COLLEAGUE_1,
  );
  approveAs(w, other, COLLEAGUE_1);
  approveAs(w, other, COLLEAGUE_2);
  const before = failed.length;
  await submitAs(w, other, other.proposal.shares[0].payerId);
  assert.equal(other.state, 'completed');
  assert.equal(w.trace.events.filter((e) => e.event === 'auth_refresh_failed').length, before,
    'unchanged refresh failures do not emit endless trace noise');
  const key = w.signers.get(EMPLOYEE)!;
  w.keys.set(key.keyId, { publicKey: key.publicKey, holder: EMPLOYEE });
  await w.coordinator.resubmit(other.purchaseId);
  for (const p of [first, second]) {
    assert.equal(p.state, 'awaiting_approvals', 'deferred refresh still heals after the key is restored');
    assert.equal(p.employeeAssessment?.authZone, 'Exception');
    assert.equal(p.authorizations.length, 0);
  }
});

for (const [label, change, reason] of [
  ['a lowered standing maximum', { maxCents: 700 }, 'exceeds_mandate'],
  ['a newly blocked merchant', { blockedMerchants: [MERCHANT_A] }, 'blocked_merchant'],
] as const) {
  test(`B16 ${label} refuses a still-unsent payer leg at its deferred first handoff`, async () => {
    // The employee leg was conclusively refused before forwarding (PSP
    // unavailable), so its replay is a first handoff: it revalidates under
    // the standing terms now in force, and the refusal lands on that leg
    // alone while the already forwarded employer leg keeps its outcome.
    const w = world({}, {}, { initiation: 'per_payer_psp' });
    w.psps.get(EMPLOYEE)!.available = false;
    const p = lunch(w);
    approveAs(w, p);
    await submitAs(w, p, EMPLOYEE);
    assert.equal(p.state, 'pending');
    assert.equal(p.legs[0].rejectReason, 'psp_unavailable');
    // Publication cannot mutate the pending purchase, but the deferred
    // handoff re-evaluates the current terms.
    updateEmployeeMandate(w, change);
    w.psps.get(EMPLOYEE)!.available = true;
    await w.coordinator.resubmit(p.purchaseId);
    assert.equal(p.legs[0].status, 'rejected');
    assert.equal(p.legs[0].rejectReason, reason);
    assert.equal(p.legs[1].status, 'unknown', 'the forwarded employer leg kept its outcome');
    assert.equal(w.backend.executionCount(), 1, 'the refused leg never reached the backend');
    assert.equal(p.state, 'pending');
    // The original assembly deadline resolves the group with nothing committed.
    advance(w, 10 + ASSEMBLY_WINDOW + 1);
    await w.coordinator.reconcile(p.purchaseId);
    assert.equal(p.state, 'failed');
    assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
    assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  });
}

// Auto-capable fixture for the automatic-admission races: employer limits
// are raised so the EUR 6 monthly employee budget is the limiting resource.
const AUTO_TERMS = { ...AUTO_EMPLOYEE_TERMS, autoPayMonthlyCents: 600 };
const autoOpts = { supportsMandatePayments: true, employeeMandate: AUTO_TERMS } as const;

const autopayEvents = (w: ReturnType<typeof world>, event: string) => w.trace.events.filter((e) => e.event === event);

test('B16 two automatic purchases cannot both spend the last automatic budget', async () => {
  // Two distinct purchase objects race for the EUR 6 month with EUR 4
  // debits: the reservation is admitted synchronously before the first
  // await, so the second's stale Auto decision falls to Confirm at its own
  // refresh — never both spending the same budget.
  const w = world({}, { maxPerDayCents: 10_000, maxPurchasesPerDay: 10 }, autoOpts);
  const first = lunch(w, 900);
  const second = lunch(w, 900, MERCHANT_A, { purchaseId: 'purchase-2' });
  assert.equal(first.state, 'ready');
  assert.equal(second.state, 'ready');
  const held = holdNext(w.backend.submit.bind(w.backend), 'before_dispatch');
  w.backend.submit = held.call;
  const running = submitAs(w, first, EMPLOYEE);
  await held.entered;
  try {
    // first's 400 is already reserved; second's refresh sees monthly_cap.
    await assert.rejects(() => submitAs(w, second, EMPLOYEE), /cannot submit/);
    assert.equal(second.state, 'awaiting_approvals');
    assert.equal(second.employeeAssessment?.autoPayBlockedReason, 'monthly_cap');
    assert.equal(second.authorizations.length, 0);
    assert.equal(w.backend.executionCount(), 0, 'the second purchase sent nothing');
  } finally {
    held.release();
    await running;
  }
  assert.equal(first.state, 'completed');
  assert.equal(autopayEvents(w, 'autopay_consumed').length, 1);
  // The second purchase still has no automatic path; a device signature
  // settles it without touching the automatic budget.
  approveAs(w, second);
  await submitAs(w, second, EMPLOYEE);
  assert.equal(second.state, 'completed');
  assert.equal(autopayEvents(w, 'autopay_reserved').length, 1);
  const third = lunch(w, 900, MERCHANT_A, { purchaseId: 'purchase-3' });
  assert.equal(third.employeeAssessment?.autoPayBlockedReason, 'monthly_cap');
});

test('B16 employer authority lost mid-dispatch releases the automatic reservation', async () => {
  // The mandate-funded employee leg is mid-forward when the employer mandate
  // is revoked: the employer leg's first-handoff recheck refuses it, the
  // group expires at its original deadline, and the EUR 4 hold goes back.
  const w = world({}, {}, { initiation: 'per_payer_psp', ...autoOpts });
  const p = lunch(w, 900);
  assert.equal(p.authorizations[0]?.basis, 'mandate');
  const psp = w.psps.get(EMPLOYEE)!;
  const held = holdNext(psp.submit.bind(psp), 'before_response');
  psp.submit = held.call;
  const running = submitAs(w, p, EMPLOYEE);
  await held.entered;
  try {
    updateMandate(w, { revoked: true });
  } finally {
    held.release();
    await running;
  }
  assert.equal(p.legs[0].status, 'unknown', 'the employee leg was already handed off');
  assert.equal(p.legs[0].authorityRef, 'employee-mandate-1', 'mandate evidence funded it');
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'employer_authority_invalid:mandate_revoked');
  assert.equal(p.state, 'pending');
  assert.equal(autopayEvents(w, 'autopay_released').length, 0, 'pending holds the reservation');
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  const released = autopayEvents(w, 'autopay_released');
  assert.equal(released.length, 1);
  assert.equal(released[0].detail?.cents, 400);
  assert.equal(released[0].detail?.retainedCents, 0);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
});

test('B16 employee revocation before the first send stops the unsent leg', async () => {
  // The mandate-funded employee leg was conclusively refused before
  // forwarding (PSP unavailable), so its replay is a first handoff under
  // current terms: revocation stops it in place — never a dispatch.
  const w = world({}, {}, { initiation: 'per_payer_psp', ...autoOpts });
  w.psps.get(EMPLOYEE)!.available = false;
  const p = lunch(w, 900);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  assert.equal(p.legs[0].rejectReason, 'psp_unavailable');
  updateEmployeeMandate(w, { revoked: true });
  w.psps.get(EMPLOYEE)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[0].status, 'rejected');
  assert.equal(p.legs[0].rejectReason, 'not_auto_zone');
  assert.equal(w.backend.executionCount(), 1, 'the refused leg never reached the backend');
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(autopayEvents(w, 'autopay_released').length, 1);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
});

test('a superseded automatic grant cannot fund a deferred first handoff even when Auto is restored', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp', ...autoOpts });
  w.psps.get(EMPLOYEE)!.available = false;
  const p = lunch(w, 900);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  updateEmployeeMandate(w, { revoked: true });
  updateEmployeeMandate(w, { revoked: false });
  assert.equal(w.coordinator.assess(p.purchaseId).authZone, 'Auto', 'eligibility alone still permits this debit');
  w.psps.get(EMPLOYEE)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[0].rejectReason, 'employee_mandate_superseded');
  assert.equal(p.submission!.legs[0].dispatch, 'refused');
  assert.equal(w.backend.executionCount(), 1, 'only the original employer leg reached the backend');
  assert.equal(p.receipt, undefined);
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(autopayEvents(w, 'autopay_released').length, 1);
});

test('B17 a throwing authority recheck stays refused on every retry', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp', ...autoOpts });
  w.psps.get(EMPLOYEE)!.available = false;
  const p = lunch(w, 900);
  await submitAs(w, p, EMPLOYEE);
  // The retained v1 key remains valid, but verification of the current v2
  // record throws after its replacement key is removed from the registry.
  const key = keyPairFromSeed('replacement-employee-key', 'synthetic-recheck-key');
  w.keys.set(key.keyId, { publicKey: key.publicKey, holder: EMPLOYEE });
  w.authority.publishEmployeeMandate(signPayload({ ...AUTO_EMPLOYEE_TERMS, version: 2 }, key));
  w.keys.delete(key.keyId);
  w.psps.get(EMPLOYEE)!.available = true;
  for (let i = 0; i < 2; i++) {
    await w.coordinator.resubmit(p.purchaseId);
    assert.equal(p.submission!.legs[0].dispatch, 'refused');
    assert.equal(p.legs[0].rejectReason, 'auth_recheck_failed');
    assert.equal(w.backend.executionCount(), 1, 'a pre-route error must never authorize a later replay');
  }
  assert.ok(w.trace.events.some((e) => e.event === 'auth_recheck_failed' && e.detail?.message === 'employee_mandate_invalid'));
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
});

// Same test-bypass seat as the loop above: the purchase spans providers.
for (const initiation of ['test_bypass_psp', 'per_payer_psp'] as const) {
  test(`${initiation} retains the signed employer terms used at its first handoff`, async () => {
    const w = world({}, {}, { initiation, ...autoOpts });
    const p = lunch(w, 900);
    let expected = structuredClone(w.authority.employerMandate(w.mandate.mandateRef)!);
    if (initiation === 'per_payer_psp') {
      // The employer's first handoff happens later than admission. Capture
      // the terms at that handoff, not a stale admission-time snapshot.
      w.psps.get(EMPLOYER)!.available = false;
      await submitAs(w, p, EMPLOYEE);
      updateMandate(w, { maxPerPurchaseCents: 600 });
      expected = structuredClone(w.authority.employerMandate(w.mandate.mandateRef)!);
      w.psps.get(EMPLOYER)!.available = true;
      await w.coordinator.resubmit(p.purchaseId);
      await w.coordinator.reconcile(p.purchaseId);
    } else {
      await submitAs(w, p, EMPLOYEE);
    }
    assert.equal(p.state, 'completed');
    const employerLeg = p.submission!.legs.find((l) => l.payerId === EMPLOYER)!;
    assert.deepEqual(employerLeg.employerMandate, expected);
    // Registry replacement and caller mutation must not rewrite evidence
    // retained for the completed debit; replay keeps the original record.
    w.authority.employerMandate(w.mandate.mandateRef)!.payload.maxPerPurchaseCents = 1;
    updateMandate(w, { revoked: true });
    await w.coordinator.resubmit(p.purchaseId);
    assert.deepEqual(employerLeg.employerMandate, expected);
    assert.ok(verifyPayload(employerLeg.employerMandate!, w.keys, EMPLOYER));
  });
}

test('B16 a still-unsent automatic leg rechecks the budget in its admission month', async () => {
  // Admitted in January with the employee leg refused pre-forward; the
  // retry lands in February when February's budget is already half spent.
  // The leg's eligibility recheck counts usage in the booking month — the
  // retry's own month never decides a month-crossing reservation.
  const terms = { ...AUTO_TERMS, validUntil: 50_000 };
  const w = world(
    {},
    { validUntil: 50_000, maxPerDayCents: 10_000, maxPurchasesPerDay: 10 },
    { initiation: 'per_payer_psp', supportsMandatePayments: true, employeeMandate: terms },
  );
  w.psps.get(EMPLOYEE)!.available = false;
  const first = lunch(w, 900, MERCHANT_A, { expiresAt: 50_000 });
  await submitAs(w, first, EMPLOYEE);
  assert.equal(first.state, 'pending');
  assert.equal(first.legs[0].rejectReason, 'psp_unavailable');
  // February: a fresh purchase books and consumes 400 of the new month.
  advance(w, 44_650);
  w.psps.get(EMPLOYEE)!.available = true;
  const second = lunch(w, 900, MERCHANT_A, { purchaseId: 'purchase-2', expiresAt: 50_000 });
  await submitAs(w, second, EMPLOYEE);
  await w.coordinator.reconcile(second.purchaseId);
  assert.equal(second.state, 'completed');
  // Resubmitting the first purchase rechecks the unsent leg against January
  // usage (only its own booking, excluded): it forwards and is refused by
  // the dead group — 'group_incomplete', never a budget refusal.
  await w.coordinator.resubmit(first.purchaseId);
  assert.equal(first.legs[0].status, 'rejected');
  assert.equal(first.legs[0].rejectReason, 'group_incomplete');
  assert.equal(w.backend.executionCount(), 4, 'the leg reached the backend');
  await w.coordinator.reconcile(first.purchaseId);
  assert.equal(first.state, 'failed');
});

test('B16 publication and cancel wait during a held refund; a busy dispute leaves no case', async () => {
  // The refund is in flight when new standing terms arrive and other
  // operations are attempted: publication is allowed while an operation
  // awaits a response but cannot mutate the completed purchase; every other
  // mutator refuses behind the operation guard, and a refused concurrent
  // dispute records no case.
  const w = world({}, { maxPerDayCents: 10_000, maxPurchasesPerDay: 10 }, autoOpts);
  const p = lunch(w, 900);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  assert.ok(p.receipt, 'the Auto receipt exists before the refund');
  const held = holdNext(w.backend.refund.bind(w.backend), 'before_response');
  w.backend.refund = held.call;
  const running = refundAs(w, p, MERCHANT_A);
  await held.entered;
  try {
    const before = structuredClone(unwrapView(p));
    assert.throws(() => cancelAs(w, p, EMPLOYEE), /operation_in_progress/);
    await assert.rejects(() => w.coordinator.dispute(p.purchaseId, EMPLOYEE), /operation_in_progress/);
    assert.equal(p.dispute, undefined, 'a refused concurrent request has not opened a case');
    // Allowed while the operation is in flight: it changes standing terms
    // but defers nothing — the purchase left the open states at completion.
    updateEmployeeMandate(w, { maxCents: 700 });
    assert.deepEqual(p, before);
  } finally {
    held.release();
    await running;
  }
  assert.equal(p.returnStatus, 'completed');
  assert.equal(autopayEvents(w, 'autopay_released').length, 1);
  // With the return confirmed the purchase is closed: cancellation stays
  // refused, now because money already moved, not because of the guard.
  assert.throws(() => cancelAs(w, p, EMPLOYEE), /cannot cancel in state completed/);
  // And the refund that completed under the old terms still stands.
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
});

test('B16 a mandate revision refuses a still-unsent exception-approved leg as exception_superseded', async () => {
  // Same deferred first handoff: the employee leg was refused before
  // forwarding, and a revision of the standing terms — any revision, even
  // one whose new maximum would permit the debit — invalidates the signed
  // acknowledgment bound to the earlier revision.
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.psps.get(EMPLOYEE)!.available = false;
  const p = lunch(w, 1_400); // EUR 9 personal: Exception zone
  approveAs(w, p, EMPLOYEE, { exception: true });
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  assert.equal(p.legs[0].rejectReason, 'psp_unavailable');
  updateEmployeeMandate(w, { maxCents: 900 });
  w.psps.get(EMPLOYEE)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[0].status, 'rejected');
  assert.equal(p.legs[0].rejectReason, 'exception_superseded');
  assert.equal(p.legs[1].status, 'unknown', 'the forwarded employer leg kept its outcome');
  assert.equal(w.backend.executionCount(), 1, 'the refused leg never reached the backend');
  assert.equal(p.state, 'pending');
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});
