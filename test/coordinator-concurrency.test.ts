// B16: hold real settlement calls at their interface; only scheduling changes.
// The orchestrator drives legs in order, so a provider seam held
// 'before_response' is exactly where authority can change between reserves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareCents } from '../src/core/coordinator.ts';
import { unwrapView } from '../src/core/live-view.ts';
import { keyPairFromSeed, signPayload, verifyPayload } from '../src/core/signing.ts';
import { world, lunch, approveAs, cancelAs, changeOfferAs, proposeSplitAs, refundAs, submitAs, advance, updateMandate, updateEmployeeMandate, deGroupKey, legChildKey, payerBankCents, payerDeCents, payeeBankCents, settlementOf, AUTO_EMPLOYEE_TERMS, COLLEAGUES_V1_GROUP, EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, MERCHANT_B } from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';

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

// Committed legs under a purchase's recorded intent.
const committedLegs = (w: World, purchaseId = 'purchase-1'): number =>
  settlementOf(w, purchaseId)?.legs.filter((l) => l.committedCents !== undefined).length ?? 0;

// Holds the orchestrator's submit at the operation seam: 'before_dispatch'
// pauses before any leg work, 'before_response' after the snapshot was
// computed — the equivalent of the old whole-request backend hold.
const holdSubmit = (w: World, phase: HoldPhase) => {
  const held = holdNext(w.settlement.submit.bind(w.settlement), phase);
  w.settlement.submit = held.call;
  return held;
};

// Holds one payer provider's reserve: the leg order in the intent is the
// proposal's share order, so the first reserve call is the first share's.
const holdReserve = (w: World, payerId: string, phase: HoldPhase) => {
  const provider = w.providers.get(payerId)!;
  const held = holdNext(provider.reserve.bind(provider), phase);
  provider.reserve = held.call;
  return held;
};

// The direct-mode seat uses the test-bypass fixture: these purchases span
// providers, so the guarded 'coordinator_as_psp' mode would refuse them.
for (const initiation of ['test_bypass_psp', 'per_payer_psp'] as const) {
  for (const phase of ['before_dispatch', 'before_response'] as const) {
    test(`B16 ${initiation} submit ${phase} protects terms and benefit until its outcome arrives`, async () => {
      const w = world({}, {}, { initiation });
      const p = lunch(w);
      const approval = approveAs(w, p);
      const held = holdSubmit(w, phase);
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
      await w.coordinator.reconcile(p.purchaseId);
      assert.equal(p.state, 'completed');
      assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
      assert.equal(payeeBankCents(w, MERCHANT_A), 1_300);
      assert.equal(payerBankCents(w, EMPLOYER), 99_500);
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
    if (operation === 'resubmit' || operation === 'reconcile') {
      // The employer leg's transfer credit is lost after its effect: the
      // commit is 'unknown' until an authoritative status query resolves it.
      w.providers.get(EMPLOYER)!.setFault(legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a'), 'credit', 'lose_response_after_effect');
    }
    if (operation === 'recover') {
      // The employee leg's digital-euro hold is conclusively refused.
      w.digitalEuro.setFault(legChildKey('purchase-1', 1, 'employee', 'hold', w.pseudonyms.get(MERCHANT_A)!), 'hold', 'reject_before_effect');
    }
    await submitAs(w, p, EMPLOYEE);
    const held = (() => {
      if (operation === 'resubmit') return holdSubmit(w, 'before_response');
      if (operation === 'reconcile') {
        const hold = holdNext(w.settlement.reconcile.bind(w.settlement), 'before_response');
        w.settlement.reconcile = hold.call;
        return hold;
      }
      const hold = holdNext(w.settlement.returnSettled.bind(w.settlement), 'before_response');
      w.settlement.returnSettled = hold.call;
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
      assert.equal(payeeBankCents(w, MERCHANT_A), 0);
      assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
    } else {
      assert.equal(committedLegs(w), 2);
      assert.equal(payeeBankCents(w, MERCHANT_A), 1_300);
    }
  });
}

test('B16 a leg that loses authority between reserves is refused; the accepted hold is released', async () => {
  // Atomic: the employee leg's reserve response is mid-flight when the
  // employer mandate is revoked. The employer leg's first-handoff recheck
  // refuses it, the abort releases the employee's accepted hold, and the
  // purchase fails with nothing committed.
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const p = lunch(w);
  approveAs(w, p);
  const held = holdReserve(w, EMPLOYEE, 'before_response');
  const running = submitAs(w, p, EMPLOYEE);
  await held.entered;
  try {
    updateMandate(w, { revoked: true });
  } finally {
    held.release();
    await running;
  }
  assert.equal(p.state, 'failed', 'a conclusive refusal aborts the intent — no group deadline to wait out');
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'employer_authority_invalid:mandate_revoked');
  // The employee leg's accepted hold was released on the unwind: it reads
  // rejected, never settled, and no merchant money moved.
  assert.equal(p.legs[0].status, 'rejected');
  assert.equal(committedLegs(w, p.purchaseId), 0, 'the refused leg never reached a ledger');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('B16 an accepted digital-euro hold survives a later mandate revocation until its expiry', async () => {
  // The employee's hold was accepted under valid authority; revocation after
  // acceptance must not invalidate that hold — authority binds to the
  // acceptance, not to a moving registry. With the employer leg deferred,
  // the employee hold stands until its half-minute expiry; releasing it
  // then is cleanup, not a refund.
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const p = lunch(w);
  approveAs(w, p);
  // Park the employer leg's transfer debit after both reserves accepted:
  // the employee hold is accepted, the bank leg can never reach the group.
  w.providers.get(EMPLOYER)!.setFault(legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a'), 'debit', 'defer');
  const running = submitAs(w, p, EMPLOYEE);
  await running;
  assert.equal(p.state, 'pending');
  // Revoking employer authority now must not invalidate the accepted hold:
  // the hold outlives the decision that admitted it, until its own expiry.
  updateMandate(w, { revoked: true });
  const holdRef = settlementOf(w, p.purchaseId)!.legs.find((l) => l.role === 'employee')!.hold!.holdRef;
  assert.equal(w.digitalEuro.holdAudit(holdRef).status, 'active', 'the accepted hold survives revocation');
  // Past the hold deadline the same unwind is cleanup: resolve the parked
  // debit to a conclusive rejection, reconcile, and the purchase fails
  // without a merchant commit — the expired hold is released, not charged.
  advance(w, 11);
  w.providers.get(EMPLOYER)!.resolveDeferred(legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a'), 'reject');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('B16 unresolved cleanup retains the benefit and Auto bookings; release happens once', async () => {
  // The employee leg's reserve is conclusively refused while the employer
  // leg's unwind stays unresolved: the purchase cannot reach 'failed' until
  // cleanup is confirmed, so benefit and monthly budget stay owned — never
  // released merely because a refusal was recorded.
  const w = world({}, {}, { supportsMandatePayments: true, employeeMandate: AUTO_EMPLOYEE_TERMS });
  const p = lunch(w, 900);
  // The employer reserve is refused after the employee's digital-euro hold
  // was accepted; the hold's release is deferred so cleanup cannot confirm.
  w.providers.get(EMPLOYER)!.setFault(legChildKey('purchase-1', 1, 'employer', 'hold', 'bank'), 'hold', 'reject_before_effect');
  w.digitalEuro.setFault(legChildKey('purchase-1', 1, 'employee', 'release', 'hold', w.pseudonyms.get(MERCHANT_A)!), 'release', 'defer');
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending', 'cleanup unresolved: no terminal outcome yet');
  assert.deepEqual(w.coordinator.ledger.usage(w.mandate.mandateRef, 0), { cents: 500, purchases: 1 }, 'benefit still held');
  const released = w.trace.events.filter((e) => e.event === 'autopay_released');
  assert.equal(released.length, 0, 'nothing released while cleanup is open');
  // Confirming cleanup moves the purchase to failed exactly once: a later
  // reconcile must not release again.
  w.digitalEuro.resolveDeferred(legChildKey('purchase-1', 1, 'employee', 'release', 'hold', w.pseudonyms.get(MERCHANT_A)!), 'succeed');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  await w.coordinator.reconcile(p.purchaseId);
  const released2 = w.trace.events.filter((e) => e.event === 'autopay_released');
  assert.equal(released2.length, 1, 'the booking resolved exactly once');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
});

test('B16 recovery_required derives pending once exposure clears with cleanup still unresolved', async () => {
  // Spec §7.1's 'recovery_required → pending' pair: the employee leg funds
  // EUR 5 through the reverse waterfall, then the digital-euro group is
  // conclusively refused — its funded money stays stranded when the bank
  // restore is refused, so cleanup can never confirm. The employer's bank
  // leg committed; with returns unsupported the compensation attempt ends
  // conclusively and committed exposure keeps the purchase in recovery.
  const w = world({ deCents: 300 });
  w.digitalEuro.setFault(deGroupKey('purchase-1', 1, ['employee']), 'commit', 'reject_before_effect');
  w.providers.get(EMPLOYEE)!.setFault(legChildKey('purchase-1', 1, 'employee', 'release', 'bank'), 'bank_restore', 'reject_before_effect');
  w.providers.get(EMPLOYER)!.returnsSupported = false;
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'recovery_required');
  assert.equal(w.coordinator.outstandingCents(p.purchaseId), 500, 'the committed bank share is still out');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'reserved');
  // The ordinary recovery return now succeeds: confirmed exposure drops to
  // zero while the failed leg's stranded funding keeps cleanup unconfirmed —
  // the snapshot reports 'compensating', so the purchase derives 'pending'
  // with its reservations retained, never 'cancelled' and never stuck in
  // recovery once nothing is owed back.
  w.providers.get(EMPLOYER)!.returnsSupported = true;
  await w.coordinator.recover(p.purchaseId);
  assert.equal(settlementOf(w, p.purchaseId)?.phase, 'compensating');
  assert.equal(settlementOf(w, p.purchaseId)?.exposureCents, 0);
  assert.equal(settlementOf(w, p.purchaseId)?.cleanupConfirmed, false);
  assert.equal(p.state, 'pending');
  assert.equal(p.returnStatus, 'completed');
  assert.equal(w.coordinator.outstandingCents(p.purchaseId), 0);
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'reserved', 'budgets stay owned while cleanup is unresolved');
  assert.equal(payerBankCents(w, EMPLOYER), 100_000, 'the committed bank share came back');
  assert.equal(payeeBankCents(w, MERCHANT_A), 0);
});

test('B16 an independent purchase enters recovery when a later leg loses authority mid-dispatch', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  const p = lunch(w, 1_300, MERCHANT_A, { settlementMode: 'independent' });
  approveAs(w, p);
  const held = holdReserve(w, EMPLOYEE, 'before_response');
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
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('B16 a first handoff after hold expiry replays the frozen intent terms', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.providers.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  const seen: unknown[] = [];
  const submit = w.settlement.submit.bind(w.settlement);
  w.settlement.submit = async (intent) => {
    seen.push(structuredClone(intent));
    return submit(intent);
  };
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  // Past the hold deadline: the employer leg's first handoff must replay the
  // frozen intent — never fresh terms — and the employee's expired hold
  // refuses the group, so the committed bank share is compensated.
  advance(w, 11);
  w.providers.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.deepEqual(seen[0], seen[1], 'the replay used the frozen intent, not fresh terms');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'compensated', 'the bank leg committed before the expired hold refused the group');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('B16 an approval-funded leg refused mid-dispatch is recorded without failing the purchase', async () => {
  // Both legs are approval-funded; the first is mid-reserve when the second
  // payer's approval expires. Its first-handoff recheck refuses that leg.
  const w = world({}, {}, {
    initiation: 'per_payer_psp',
    // A technical agreement covering this employee/employer split; the
    // colleagues group is unchanged.
    knownSplitGroups: [COLLEAGUES_V1_GROUP, { groupRef: 'employee-employer-fixture', privacyProfile: 'split_bill_v1', memberIds: [EMPLOYEE, EMPLOYER] }],
  });
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
      disclosureGroupRef: 'employee-employer-fixture',
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, EMPLOYER);
  const held = holdReserve(w, EMPLOYEE, 'before_response');
  const running = submitAs(w, p, EMPLOYEE);
  await held.entered;
  try {
    advance(w, 150);
  } finally {
    held.release();
    await running;
  }
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'approval_expired:employer-1');
  assert.equal(committedLegs(w, 'split-1'), 0, 'the refused leg never reached a ledger');
  assert.equal(p.state, 'failed');
});

test('B16 a refused submission releases its operation guard so a corrected request can run', async () => {
  // A conclusive pre-handoff refusal from the settlement layer (an
  // unroutable payee at admission) rolls back the attempt: other mutations
  // refuse while the operation is in flight, then the guard releases.
  const w = world({}, {}, { initiation: 'test_bypass_psp' });
  const p = lunch(w);
  approveAs(w, p);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const real = w.settlement.submit.bind(w.settlement);
  w.settlement.submit = async (intent) => {
    if (intent.purchaseId === 'other-purchase') return real(intent);
    entered.resolve();
    await gate.promise;
    throw new Error('unknown payee merchant-a');
  };
  const running = submitAs(w, p, EMPLOYEE);
  const refused = assert.rejects(running, /unknown payee/);
  await entered.promise;
  try {
    assert.throws(() => cancelAs(w, p, EMPLOYEE), /operation_in_progress/);
  } finally {
    gate.resolve();
    await refused;
  }
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.equal(payeeBankCents(w, MERCHANT_A), 0);
  w.settlement.submit = real;
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  assert.equal(payeeBankCents(w, MERCHANT_A), 1_300);
});

test('B16 employee-terms publication during an in-flight operation defers the purchase refresh until the guard releases', async () => {
  // The submission is held mid-flight when new standing terms arrive: the
  // purchase keeps its terms, evidence and legs through the operation, and
  // the deferred refresh applies the revision only once the guard is
  // released. The conclusive pre-handoff refusal below leaves the purchase
  // in 'ready' — an open state — so the drained refresh is observable.
  const w = world({}, {}, { initiation: 'test_bypass_psp' });
  const p = lunch(w);
  approveAs(w, p);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  w.settlement.submit = async () => {
    entered.resolve();
    await gate.promise;
    throw new Error('unknown payee merchant-a');
  };
  const running = submitAs(w, p, EMPLOYEE);
  const refused = assert.rejects(running, /unknown payee/);
  await entered.promise;
  try {
    const before = structuredClone(unwrapView(p));
    // Lowering the standing maximum below the debit is accepted as new
    // terms, but must not reach the in-flight purchase.
    updateEmployeeMandate(w, { maxCents: 700 });
    assert.deepEqual(p, before);
    assert.equal(p.state, 'ready');
  } finally {
    gate.resolve();
    await refused;
  }
  // Drained after the guard released: the device approval no longer fits the
  // revised maximum, so the purchase waits for a signed exception.
  assert.equal(payeeBankCents(w, MERCHANT_A), 0);
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
  const w = world({}, { maxPerDayCents: 10_000, maxPurchasesPerDay: 10 }, { initiation: 'test_bypass_psp' });
  const first = lunch(w);
  const second = lunch(w, 1_300, MERCHANT_A, { purchaseId: 'purchase-2' });
  approveAs(w, first);
  approveAs(w, second);
  const gate = Promise.withResolvers<void>();
  const bothHeld = Promise.withResolvers<void>();
  let heldCalls = 0;
  const realSubmit = w.settlement.submit.bind(w.settlement);
  w.settlement.submit = async (intent) => {
    if (intent.purchaseId === 'other-purchase') return realSubmit(intent);
    if (++heldCalls === 2) bothHeld.resolve();
    await gate.promise;
    throw new Error('unknown payee merchant-a');
  };
  const running = [submitAs(w, first, EMPLOYEE), submitAs(w, second, EMPLOYEE)];
  const refused = running.map((r) => assert.rejects(r, /unknown payee/));
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
    // The employee leg's reserve was conclusively unstarted (provider
    // unavailable), so its replay is a first handoff: it revalidates under
    // the standing terms now in force. The refusal lands on that leg alone;
    // the committed employer share is compensated, never shifted onto the
    // employee.
    const w = world({}, {}, { initiation: 'per_payer_psp' });
    w.providers.get(EMPLOYEE)!.available = false;
    const p = lunch(w);
    approveAs(w, p);
    await submitAs(w, p, EMPLOYEE);
    assert.equal(p.state, 'pending');
    assert.equal(settlementOf(w, p.purchaseId)!.legs[0].reserve?.reason, 'provider_unavailable');
    // Publication cannot mutate the pending purchase, but the deferred
    // handoff re-evaluates the current terms.
    updateEmployeeMandate(w, change);
    w.providers.get(EMPLOYEE)!.available = true;
    await w.coordinator.resubmit(p.purchaseId);
    assert.equal(p.legs[0].status, 'rejected');
    assert.equal(p.legs[0].rejectReason, reason);
    assert.equal(p.legs[1].status, 'rejected', 'the employer leg’s accepted hold was released, never charged');
    assert.equal(p.state, 'failed');
    assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
    assert.equal(payerBankCents(w, EMPLOYER), 100_000);
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
  const held = holdSubmit(w, 'before_dispatch');
  const running = submitAs(w, first, EMPLOYEE);
  await held.entered;
  try {
    // first's 400 is already reserved; second's refresh sees monthly_cap.
    await assert.rejects(() => submitAs(w, second, EMPLOYEE), /cannot submit/);
    assert.equal(second.state, 'awaiting_approvals');
    assert.equal(second.employeeAssessment?.autoPayBlockedReason, 'monthly_cap');
    assert.equal(second.authorizations.length, 0);
    assert.equal(second.settlement, undefined, 'the second purchase sent nothing');
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

test('B16 employer authority lost mid-dispatch retains the automatic reservation until the unwind confirms', async () => {
  // The mandate-funded employee leg is mid-reserve when the employer
  // mandate is revoked: the employer leg's first-handoff recheck refuses
  // it, the unwind releases the accepted hold, and the EUR 4 hold goes
  // back — once, when cleanup is confirmed.
  const w = world({}, {}, { initiation: 'per_payer_psp', ...autoOpts });
  const p = lunch(w, 900);
  assert.equal(p.authorizations[0]?.basis, 'mandate');
  const held = holdReserve(w, EMPLOYEE, 'before_response');
  const running = submitAs(w, p, EMPLOYEE);
  await held.entered;
  try {
    updateMandate(w, { revoked: true });
  } finally {
    held.release();
    await running;
  }
  assert.equal(p.legs[0].authorityRef, 'employee-mandate-1', 'mandate evidence funded it');
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'employer_authority_invalid:mandate_revoked');
  assert.equal(p.state, 'failed');
  const released = autopayEvents(w, 'autopay_released');
  assert.equal(released.length, 1);
  assert.equal(released[0].detail?.cents, 400);
  assert.equal(released[0].detail?.retainedCents, 0);
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
});

test('B16 employee revocation before the first handoff stops the unstarted leg', async () => {
  // The mandate-funded employee leg was conclusively unstarted (provider
  // unavailable), so its replay is a first handoff under current terms:
  // revocation stops it in place — never a handoff.
  const w = world({}, {}, { initiation: 'per_payer_psp', ...autoOpts });
  w.providers.get(EMPLOYEE)!.available = false;
  const p = lunch(w, 900);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  assert.equal(settlementOf(w, p.purchaseId)!.legs[0].reserve?.reason, 'provider_unavailable');
  updateEmployeeMandate(w, { revoked: true });
  w.providers.get(EMPLOYEE)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[0].status, 'rejected');
  assert.equal(p.legs[0].rejectReason, 'not_auto_zone');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed', 'the employer hold is released, never shifted onto the employee');
  assert.equal(autopayEvents(w, 'autopay_released').length, 1);
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('a superseded automatic grant cannot fund a deferred first handoff even when Auto is restored', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp', ...autoOpts });
  w.providers.get(EMPLOYEE)!.available = false;
  const p = lunch(w, 900);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  updateEmployeeMandate(w, { revoked: true });
  updateEmployeeMandate(w, { revoked: false });
  assert.equal(w.coordinator.assess(p.purchaseId).authZone, 'Auto', 'eligibility alone still permits this debit');
  w.providers.get(EMPLOYEE)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[0].rejectReason, 'employee_mandate_superseded');
  assert.equal(p.submission!.legs[0].dispatch, 'refused');
  assert.equal(p.receipt, undefined);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(autopayEvents(w, 'autopay_released').length, 1);
});

test('B17 a throwing authority recheck stays refused on every retry', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp', ...autoOpts });
  w.providers.get(EMPLOYEE)!.available = false;
  const p = lunch(w, 900);
  await submitAs(w, p, EMPLOYEE);
  // The retained v1 key remains valid, but verification of the current v2
  // record throws after its replacement key is removed from the registry.
  const key = keyPairFromSeed('replacement-employee-key', 'synthetic-recheck-key');
  w.keys.set(key.keyId, { publicKey: key.publicKey, holder: EMPLOYEE });
  w.authority.publishEmployeeMandate(signPayload({ ...AUTO_EMPLOYEE_TERMS, version: 2 }, key));
  w.keys.delete(key.keyId);
  w.providers.get(EMPLOYEE)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.submission!.legs[0].dispatch, 'refused');
  assert.match(p.legs[0].rejectReason ?? '', /^authority_recheck_failed:employee_mandate_invalid/);
  assert.equal(payeeBankCents(w, MERCHANT_A), 0, 'a pre-route error must never authorize a later replay');
  assert.ok(w.trace.events.some((e) => e.event === 'leg_authority_refused' && String(e.detail?.reason).includes('employee_mandate_invalid')));
  // The conclusive refusal aborts the intent: the employer hold releases
  // and the purchase fails — no second retry can resurrect it.
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  await assert.rejects(() => w.coordinator.resubmit(p.purchaseId), /cannot resubmit in state failed/);
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
      w.providers.get(EMPLOYER)!.available = false;
      await submitAs(w, p, EMPLOYEE);
      updateMandate(w, { maxPerPurchaseCents: 600 });
      expected = structuredClone(w.authority.employerMandate(w.mandate.mandateRef)!);
      w.providers.get(EMPLOYER)!.available = true;
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
  // Admitted in January with the employee leg unstarted; the retry lands in
  // February when February's budget is already half spent. The leg's
  // eligibility recheck counts usage in the booking month — the retry's
  // own month never decides a month-crossing reservation.
  const terms = { ...AUTO_TERMS, validUntil: 50_000 };
  const w = world(
    {},
    { validUntil: 50_000, maxPerDayCents: 10_000, maxPurchasesPerDay: 10 },
    { initiation: 'per_payer_psp', supportsMandatePayments: true, employeeMandate: terms },
  );
  w.providers.get(EMPLOYEE)!.available = false;
  const first = lunch(w, 900, MERCHANT_A, { expiresAt: 50_000 });
  await submitAs(w, first, EMPLOYEE);
  assert.equal(first.state, 'pending');
  assert.equal(settlementOf(w, first.purchaseId)!.legs[0].reserve?.reason, 'provider_unavailable');
  // February: a fresh purchase books and consumes 400 of the new month.
  advance(w, 44_650);
  w.providers.get(EMPLOYEE)!.available = true;
  const second = lunch(w, 900, MERCHANT_A, { purchaseId: 'purchase-2', expiresAt: 50_000 });
  await submitAs(w, second, EMPLOYEE);
  await w.coordinator.reconcile(second.purchaseId);
  assert.equal(second.state, 'completed');
  // Resubmitting the first purchase rechecks the unstarted leg against
  // January usage (only its own booking, excluded): it forwards under its
  // original terms — never a budget refusal — while the employer's January
  // bank hold has long expired, so the intent unwinds to failed.
  await w.coordinator.resubmit(first.purchaseId);
  assert.equal(first.legs[0].rejectReason, undefined, 'the leg reached its provider under the January recheck');
  assert.equal(first.settlement!.legs[0].reserve?.status, 'succeeded');
  await w.coordinator.reconcile(first.purchaseId);
  assert.equal(first.state, 'failed');
  assert.equal(payerDeCents(w, EMPLOYEE), 1_600, 'only the completed February purchase debited');
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
  const held = holdNext(w.settlement.returnSettled.bind(w.settlement), 'before_response');
  w.settlement.returnSettled = held.call;
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
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
});

test('B16 a mandate revision refuses a still-unsent exception-approved leg as exception_superseded', async () => {
  // Same deferred first handoff: the employee leg was unstarted, and a
  // revision of the standing terms — any revision, even one whose new
  // maximum would permit the debit — invalidates the signed acknowledgment
  // bound to the earlier revision.
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.providers.get(EMPLOYEE)!.available = false;
  const p = lunch(w, 1_400); // EUR 9 personal: Exception zone
  approveAs(w, p, EMPLOYEE, { exception: true });
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  assert.equal(settlementOf(w, p.purchaseId)!.legs[0].reserve?.reason, 'provider_unavailable');
  updateEmployeeMandate(w, { maxCents: 900 });
  w.providers.get(EMPLOYEE)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[0].status, 'rejected');
  assert.equal(p.legs[0].rejectReason, 'exception_superseded');
  assert.equal(p.state, 'failed', 'the employer hold is released, never shifted onto the employee');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});
