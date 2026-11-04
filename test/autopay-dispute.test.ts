// Receipts, disputes and uncertain returns on automatic purchases (spec §9).
// On the first observed full completion of a mandate-authorized purchase the
// coordinator retains one receipt with the used mandate revision and a fixed
// dispute deadline; a dispute is a request for the existing full-purchase
// return — never proof a refund happened — and a lost refund response is
// reconciled through the same execution reference before any retry, because
// the mock's refund() is not idempotent after a completed return.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payerView } from '../src/core/views.ts';
import { ProviderUnavailableError } from '../src/settlement/provider.ts';
import type { World } from '../src/scenarios.ts';
import {
  world,
  lunch,
  approveAs,
  refundAs,
  submitAs,
  advance,
  AUTO_EMPLOYEE_TERMS,
  EMPLOYEE,
  EMPLOYER,
  COLLEAGUE_1,
  MERCHANT_A,
  MERCHANT_B,
} from '../src/scenarios.ts';
import type { WorldOptions } from '../src/scenarios.ts';
import {
  deGroupKey,
  payerBankCents,
  payerDeCents,
  payeeBankCents,
  settlementOf,
} from '../src/scenarios.ts';
import type { EmployerMandate } from '../src/core/types.ts';

// Auto-capable world: EUR 6 monthly cap, EUR 6 per purchase, merchant-a
// trusted; employer limits raised so the employee budget is never the
// blocker for these EUR 4 debits. Worlds start at minute 10, so a purchase
// completing immediately records receiptAt 10 and, under the default
// 1,440-minute window, disputeUntil 1,450.
const AUTO_TERMS = { ...AUTO_EMPLOYEE_TERMS, autoPayMonthlyCents: 600 };
const autoWorld = (employee: { deCents?: number; reverseWaterfall?: boolean } = {}, mandate: Partial<EmployerMandate> = {}, opts: WorldOptions = {}) =>
  world(employee, { maxPerDayCents: 10_000, maxPurchasesPerDay: 10, ...mandate }, {
    supportsMandatePayments: true,
    employeeMandate: AUTO_TERMS,
    ...opts,
  });

const events = (w: World, event: string) => w.trace.events.filter((e) => e.event === event);
// Legs with a confirmed return outcome — each under its own return key,
// whether the outcome arrived on the call or on a later status query.
const returnsApplied = (w: World, purchaseId = 'purchase-1') =>
  settlementOf(w, purchaseId)?.legs.filter((l) => l.returned?.status === 'succeeded').length ?? 0;
// A provider without return support reports the refusal conclusively.
const setRefundSupport = (w: World, supported: boolean): void => {
  for (const provider of w.providers.values()) {
    if (supported) delete provider.refund;
    else provider.refund = async (_executionRef, key, _policy) => ({ key, status: 'rejected', reason: 'unsupported' });
  }
};
// Lose the first return response: the call's effect applies at the
// provider, the answer never reaches the orchestrator.
const loseFirstRefund = (w: World): void => {
  let lose = true;
  for (const provider of w.providers.values()) {
    const refund = provider.refund.bind(provider);
    provider.refund = async (...args) => {
      const out = await refund(...args);
      if (lose) {
        lose = false;
        throw new Error('synthetic lost refund response');
      }
      return out;
    };
  }
};
// Drop the first return call before any effect — an in-flight failure.
const dropFirstRefund = (w: World): void => {
  let drop = true;
  for (const provider of w.providers.values()) {
    const refund = provider.refund.bind(provider);
    provider.refund = async (...args) => {
      if (drop) {
        drop = false;
        throw new Error('synthetic refund failure before forwarding');
      }
      return refund(...args);
    };
  }
};

// A completed mandate-authorized EUR 9 lunch: EUR 4 employee + EUR 5 employer.
const completedAutoPurchase = async (w: World) => {
  const p = lunch(w, 900);
  await submitAs(w, p, EMPLOYEE);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  return p;
};

test('a completed Auto purchase retains one receipt with the used revision and a fixed deadline', async () => {
  const w = autoWorld();
  const p = await completedAutoPurchase(w);
  assert.deepEqual(p.receipt, {
    purchaseId: 'purchase-1',
    proposalVersion: 1,
    merchantId: MERCHANT_A,
    employeeId: EMPLOYEE,
    receiptAt: 10,
    disputeUntil: 1_450,
    amountCents: 400,
    feeCents: 0,
    debitCents: 400,
    totalCents: 900,
    employerCents: 500,
    mandateRef: 'employee-mandate-1',
    mandateVersion: 1,
  });
  const receipts = events(w, 'autopay_receipt');
  assert.equal(receipts.length, 1);
  // Replayed observations never reissue the receipt or extend its deadline.
  advance(w, 20);
  await w.coordinator.reconcile(p.purchaseId);
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(events(w, 'autopay_receipt').length, 1);
  assert.equal(p.receipt?.receiptAt, 10);
  assert.equal(p.receipt?.disputeUntil, 1_450);
});

test('device and exception purchases complete without an Auto receipt', async () => {
  const w = autoWorld();
  // merchant-b is employer-eligible but untrusted: Confirm under a device signature.
  const device = lunch(w, 900, MERCHANT_B);
  approveAs(w, device);
  await submitAs(w, device, EMPLOYEE);
  assert.equal(device.state, 'completed');
  assert.equal(device.receipt, undefined);
  // EUR 15 personal against the EUR 10 maximum: a signed one-off exception.
  const exception = lunch(w, 2_000, MERCHANT_A, { purchaseId: 'purchase-2' });
  approveAs(w, exception, EMPLOYEE, { exception: true });
  await submitAs(w, exception, EMPLOYEE);
  assert.equal(exception.state, 'completed');
  assert.equal(exception.receipt, undefined);
  assert.equal(events(w, 'autopay_receipt').length, 0);
});

test('a dispute at the deadline minute opens a case and returns every share once', async () => {
  const w = autoWorld();
  const p = await completedAutoPurchase(w);
  // Deadline equality: a first request at disputeUntil itself is accepted.
  advance(w, p.receipt!.disputeUntil);
  const outcome = await w.coordinator.dispute(p.purchaseId, EMPLOYEE);
  assert.equal(outcome, 'returned');
  assert.equal(p.dispute?.outcome, 'returned');
  assert.equal(p.dispute?.openedAt, 1_450);
  assert.equal(p.returnStatus, 'completed');
  assert.equal(p.state, 'completed', 'a returned purchase stays completed');
  // Every settled share went back to its original payer — the dispute is not
  // a unilateral employee-only refund.
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
  assert.equal(payeeBankCents(w, MERCHANT_A), 0);
  assert.equal(returnsApplied(w), 2, 'one backend return per leg');
  // One case, one ledger release: the whole EUR 4 booking goes back.
  assert.equal(events(w, 'dispute_opened').length, 1);
  assert.deepEqual(events(w, 'dispute_updated').map((e) => e.detail?.outcome), ['returned']);
  // The update carries the case's identity and simulated time (spec §11).
  const updated = events(w, 'dispute_updated')[0];
  assert.equal(updated.detail?.now, 1_450);
  assert.equal(updated.detail?.proposalVersion, 1);
  assert.equal(updated.detail?.mandateVersion, 1);
  assert.equal(updated.detail?.employeeId, EMPLOYEE);
  const released = events(w, 'autopay_released');
  assert.equal(released.length, 1);
  assert.equal(released[0].detail?.cents, 400);
  assert.equal(released[0].detail?.retainedCents, 0);
  assert.equal(w.coordinator.ledger.state('purchase-1'), undefined, 'the meal benefit goes back');
  // Repeating the request resumes the same case: no new return call, no
  // second release, no new events.
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'returned');
  await refundAs(w, p, p.proposal.merchantId);
  assert.equal(returnsApplied(w), 2, 'no second return was requested');
  assert.equal(events(w, 'autopay_released').length, 1);
  assert.equal(events(w, 'dispute_opened').length, 1);
  assert.equal(events(w, 'dispute_updated').length, 1);
  assert.equal(events(w, 'refund_completed').length, 1, 'the confirmed return is reported once, not per repeat');
});

test('a first dispute request one minute late is rejected and opens no case', async () => {
  const w = autoWorld();
  const p = await completedAutoPurchase(w);
  advance(w, p.receipt!.disputeUntil + 1);
  await assert.rejects(() => w.coordinator.dispute(p.purchaseId, EMPLOYEE), /dispute_window_expired/);
  assert.equal(p.dispute, undefined, 'a refused request records no case');
  assert.equal(p.returnStatus, 'none', 'a rejected request ran no return');
  assert.equal(returnsApplied(w), 0);
  const rejected = events(w, 'dispute_rejected');
  assert.deepEqual(rejected.map((e) => e.detail?.reason), ['dispute_window_expired']);
  assert.equal(rejected[0].detail?.now, 1_451, 'the rejection records simulated time');
  assert.equal(rejected[0].detail?.mandateVersion, 1, 'the receipt identifies the used revision');
  assert.equal(events(w, 'autopay_released').length, 0, 'an opening dispute alone releases no budget');
});

test('a case opened at the deadline may finish after it without moving its deadline', async () => {
  const w = autoWorld({}, {}, { initiation: 'per_payer_psp' });
  const p = await completedAutoPurchase(w);
  // At the last allowed minute the employer's PSP is unreachable: the
  // employee share returns conclusively while the employer's leg meets a
  // conclusive pre-forward refusal, which surfaces to the caller — a
  // partial return keeps the case open and releases nothing.
  advance(w, p.receipt!.disputeUntil);
  w.providers.get(EMPLOYER)!.available = false;
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'unresolved');
  assert.equal(p.dispute?.outcome, 'unresolved', 'the accepted case reflects partial progress before the refusal');
  assert.equal(p.legs[0].status, 'returned');
  assert.equal(p.legs[1].status, 'settled');
  assert.equal(events(w, 'autopay_released').length, 0, 'no confirmed outcome yet — the hold stays');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  // One minute past the deadline the accepted case still resumes — the
  // window gates only new cases.
  advance(w, 1_451);
  w.providers.get(EMPLOYER)!.available = true;
  const second = await w.coordinator.dispute(p.purchaseId, EMPLOYEE);
  assert.equal(second, 'returned');
  assert.equal(p.receipt?.disputeUntil, 1_450, 'the fixed deadline never moves');
  assert.equal(events(w, 'dispute_opened').length, 1);
  assert.deepEqual(events(w, 'dispute_updated').map((e) => e.detail?.outcome), ['unresolved', 'returned']);
  assert.equal(returnsApplied(w), 2, 'each leg returned exactly once');
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
  assert.equal(events(w, 'autopay_released').length, 1);
});

test('a request naming another employee is rejected as wrong_employee', async () => {
  const w = autoWorld();
  const p = await completedAutoPurchase(w);
  await assert.rejects(() => w.coordinator.dispute(p.purchaseId, COLLEAGUE_1), /wrong_employee/);
  assert.equal(p.dispute, undefined);
  assert.equal(p.returnStatus, 'none');
  assert.deepEqual(events(w, 'dispute_rejected').map((e) => e.detail?.reason), ['wrong_employee']);
});

test('a purchase without an Auto receipt has no dispute route', async () => {
  const w = autoWorld();
  // A pending automatic purchase: no completion observation, no receipt.
  w.digitalEuro.setFault(deGroupKey('purchase-1', 1, ['employee']), 'commit', 'lose_response_after_effect');
  const pending = lunch(w, 900);
  await submitAs(w, pending, EMPLOYEE);
  assert.equal(pending.state, 'pending');
  await assert.rejects(() => w.coordinator.dispute(pending.purchaseId, EMPLOYEE), /no_receipt/);
  // A completed device purchase keeps the existing refund route only.
  const device = lunch(w, 900, MERCHANT_B, { purchaseId: 'purchase-2' });
  approveAs(w, device);
  await submitAs(w, device, EMPLOYEE);
  assert.equal(device.state, 'completed');
  await assert.rejects(() => w.coordinator.dispute(device.purchaseId, EMPLOYEE), /no_receipt/);
  await refundAs(w, device, device.proposal.merchantId);
  assert.equal(device.returnStatus, 'completed');
  assert.deepEqual(
    events(w, 'dispute_rejected').map((e) => e.detail?.reason),
    ['no_receipt', 'no_receipt'],
  );
  assert.equal(events(w, 'dispute_opened').length, 0);
});

test('an unsupported return stays visible and releases no budget', async () => {
  const w = autoWorld();
  const p = await completedAutoPurchase(w);
  setRefundSupport(w, false);
  const outcome = await w.coordinator.dispute(p.purchaseId, EMPLOYEE);
  assert.equal(outcome, 'unsupported');
  assert.equal(p.dispute?.outcome, 'unsupported');
  assert.equal(p.returnStatus, 'unsupported');
  assert.equal(p.state, 'completed', 'an unresolved return never un-completes the purchase');
  assert.equal(events(w, 'autopay_released').length, 0, 'no confirmed outcome, no release');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  const v = payerView(p, EMPLOYEE);
  assert.equal(v.returnStatus, 'unsupported');
  assert.equal(v.dispute?.outcome, 'unsupported');
});

for (const operation of ['dispute', 'refund'] as const) {
  test(`B26 ${operation} reports an uncertain return before a later PSP refusal`, async () => {
    const w = autoWorld({}, {}, { initiation: 'per_payer_psp' });
    const p = await completedAutoPurchase(w);
    if (operation === 'refund') {
      // Open the case without return progress; the plain refund must also
      // keep this already accepted case's outcome current when it throws.
      w.providers.get(EMPLOYEE)!.available = false;
      assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'unresolved');
      assert.equal(p.dispute?.outcome, 'unresolved');
      w.providers.get(EMPLOYEE)!.available = true;
    }
    loseFirstRefund(w);
    w.providers.get(EMPLOYER)!.available = false;
    if (operation === 'dispute') assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'unresolved');
    else await refundAs(w, p, p.proposal.merchantId);
    assert.equal(p.legs[0].returnForwarded, true);
    const view = payerView(p, EMPLOYEE);
    // The employer leg's return already confirmed in the refund-variant
    // pre-step: partial is the honest report there; the dispute-variant
    // leg stays pending behind the unreachable provider.
    assert.equal(view.returnStatus, operation === 'refund' ? 'partial' : 'unresolved');
    assert.equal(view.dispute?.outcome, 'unresolved');
    assert.equal(view.returnedCents, 0, 'an uncertain response cannot confirm returned principal');
    assert.deepEqual(
      events(w, 'dispute_updated').map((e) => e.detail?.outcome),
      operation === 'refund' ? ['unresolved', 'unresolved'] : ['unresolved'],
    );
    assert.equal(p.state, 'completed');
    assert.equal(events(w, 'autopay_released').length, 0);
    assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');

    w.providers.get(EMPLOYER)!.available = true;
    assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'returned');
    assert.equal(returnsApplied(w), 2, 'resuming queries the lost response instead of returning it twice');
    assert.equal(events(w, 'autopay_released').length, 1);
  });
}

test('B26 an unsupported dispute becomes unresolved when a later return loses its responses', async () => {
  const w = autoWorld();
  const p = await completedAutoPurchase(w);
  setRefundSupport(w, false);
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'unsupported');
  setRefundSupport(w, true);
  loseFirstRefund(w);
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'unresolved');
  // The employer leg returned while the employee leg's outcome is
  // uncertain: partial for the payer, unresolved for the case.
  assert.equal(payerView(p, EMPLOYEE).returnStatus, 'partial');
  assert.equal(payerView(p, EMPLOYEE).dispute?.outcome, 'unresolved');
  assert.ok(p.legs.every((l) => l.returnForwarded));
  assert.deepEqual(events(w, 'dispute_updated').map((e) => e.detail?.outcome), ['unsupported', 'unresolved']);
  assert.equal(events(w, 'autopay_released').length, 0);
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'returned');
  assert.equal(returnsApplied(w), 2, 'status confirms both returns without a second refund');
  assert.equal(events(w, 'autopay_released').length, 1);
});

test('a lost refund response is reconciled through the same execution reference', async () => {
  const w = autoWorld();
  const p = await completedAutoPurchase(w);
  // The employee leg's return really executes at the backend, but its
  // response never arrives — indistinguishable from a mid-call failure.
  loseFirstRefund(w);
  const first = await w.coordinator.dispute(p.purchaseId, EMPLOYEE);
  assert.equal(first, 'unresolved');
  assert.equal(p.state, 'completed', 'a lost return response never un-completes the purchase');
  assert.equal(p.legs[0].status, 'settled');
  assert.equal(p.legs[0].returnForwarded, true, 'the uncertain attempt is preserved');
  assert.equal(p.legs[1].status, 'returned', 'the employer leg returned conclusively');
  assert.equal(p.returnStatus, 'partial', 'one leg returned, the other still outstanding');
  assert.equal(events(w, 'autopay_released').length, 0, 'the hold stays while the outcome is unknown');
  const uncertain = events(w, 'provider_call_uncertain');
  assert.equal(uncertain.length, 1);
  // Resuming must query the same execution reference through status() — a
  // second blind refund() would throw on the already-returned leg, because
  // the mock's refund is not idempotent after a completed return.
  const second = await w.coordinator.dispute(p.purchaseId, EMPLOYEE);
  assert.equal(second, 'returned');
  assert.equal(p.returnStatus, 'completed');
  assert.equal(returnsApplied(w), 2, 'exactly one actual return per leg — no extra refund debit');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
  assert.equal(payeeBankCents(w, MERCHANT_A), 0);
  assert.equal(events(w, 'autopay_released').length, 1);
  assert.deepEqual(events(w, 'dispute_updated').map((e) => e.detail?.outcome), ['unresolved', 'returned']);
});

test('an employee leg never charged releases its whole hold once recovery resolves', async () => {
  // EUR 3 in holdings and no reverse waterfall: the employee leg is refused
  // before any debit while the employer leg settles — recovery must return
  // the employer's money and release the full EUR 4 booking.
  const w = autoWorld({ deCents: 300, reverseWaterfall: false });
  const p = lunch(w, 900, MERCHANT_A, { settlementMode: 'independent' });
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'recovery_required');
  // Lose the employer leg's refund response: the return executes at the
  // backend, and the preserved attempt is reconciled by status() before any
  // second refund call.
  loseFirstRefund(w);
  const realStatus = w.providers.get(EMPLOYER)!.status.bind(w.providers.get(EMPLOYER)!);
  w.providers.get(EMPLOYER)!.status = async () => {
    throw new ProviderUnavailableError('psp-employer-1');
  };
  await w.coordinator.recover(p.purchaseId);
  assert.equal(p.state, 'recovery_required', 'an uncertain return keeps the purchase in recovery');
  assert.equal(p.legs[1].returnForwarded, true);
  assert.equal(payerView(p, EMPLOYEE).returnStatus, 'unresolved', 'uncertain recovery is visible without a dispute');
  assert.equal(events(w, 'autopay_released').length, 0);
  w.providers.get(EMPLOYER)!.status = realStatus;
  await w.coordinator.recover(p.purchaseId);
  assert.equal(p.state, 'cancelled');
  assert.equal(returnsApplied(w), 1, 'the settled leg returned exactly once');
  const released = events(w, 'autopay_released');
  assert.equal(released.length, 1);
  assert.equal(released[0].detail?.cents, 400);
  assert.equal(released[0].detail?.retainedCents, 0, 'the employee was never charged');
});

test('a fee-bearing return retains the charged fee and the payer view separates it', async () => {
  const w = autoWorld();
  const p = lunch(w, 900, MERCHANT_A, { feesCents: 20 });
  await submitAs(w, p, EMPLOYEE);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'returned');
  const released = events(w, 'autopay_released');
  assert.equal(released.length, 1);
  assert.equal(released[0].detail?.cents, 400);
  assert.equal(released[0].detail?.retainedCents, 20, 'returns cover principal, not fees');
  // "principal returned; fee retained" is visible to the employee — not
  // folded into the refunded principal.
  const v = payerView(p, EMPLOYEE);
  assert.equal(v.returnedCents, 400);
  assert.equal(v.unreturnedFeeCents, 20);
  assert.equal(v.returnStatus, 'completed');
  assert.equal(v.dispute?.outcome, 'returned');
  assert.equal(v.receipt?.disputeUntil, 1_450);
  assert.equal(v.receipt?.mandateVersion, 1);
  assert.ok(!JSON.stringify(v).includes('employee-mandate-1'), 'the mandate reference stays out of the payer column');
});

test("a 'settled' status lets the preserved return attempt retry the same reference", async () => {
  const w = autoWorld();
  const p = await completedAutoPurchase(w);
  // The employee leg's refund call fails before the request can reach the
  // backend — indistinguishable from a mid-call failure, so the attempt is
  // preserved as returnForwarded even though nothing was forwarded.
  dropFirstRefund(w);
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'unresolved');
  assert.equal(p.legs[0].status, 'settled');
  assert.equal(p.legs[0].returnForwarded, true);
  assert.equal(returnsApplied(w), 1, 'only the employer leg reached the backend');
  // Resuming queries the same execution reference first: status() reports
  // 'settled', conclusively not returned, so a fresh refund() call is safe.
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'returned');
  assert.equal(p.returnStatus, 'completed');
  assert.deepEqual(p.legs.map((l) => l.status), ['returned', 'returned']);
  assert.equal(returnsApplied(w), 2, 'the preserved leg was retried exactly once');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
  assert.equal(events(w, 'autopay_released').length, 1);
  assert.equal(events(w, 'refund_completed').length, 1);
});

test('an uncertain or unreachable status keeps the preserved attempt and sends no retry', async () => {
  const w = autoWorld();
  const p = await completedAutoPurchase(w);
  // The employee leg's return really executes at the backend but its
  // response is lost: the attempt stays preserved on the leg.
  loseFirstRefund(w);
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'unresolved');
  assert.equal(returnsApplied(w), 1, 'the employee leg applied but its outcome is still uncertain');
  // status() reporting 'unknown' proves nothing: the request stays
  // unresolved and no second refund call may be sent — the mock's refund
  // is not idempotent after a completed return.
  const status = w.providers.get(EMPLOYEE)!.status.bind(w.providers.get(EMPLOYEE)!);
  w.providers.get(EMPLOYEE)!.status = async (key) =>
    key.includes('"return"') ? ({ key, status: 'unknown' } as never) : status(key);
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'unresolved');
  // The same when the status route cannot even be reached.
  w.providers.get(EMPLOYEE)!.status = async () => {
    throw new ProviderUnavailableError('psp-employee-1');
  };
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'unresolved');
  assert.equal(p.legs[0].status, 'settled');
  assert.equal(p.legs[0].returnForwarded, true, 'the attempt stays preserved');
  assert.equal(p.returnStatus, 'partial');
  assert.equal(returnsApplied(w), 1, 'no retry while the outcome stayed uncertain');
  assert.equal(events(w, 'autopay_released').length, 0, 'the hold stays while the outcome is unknown');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  assert.deepEqual(
    events(w, 'dispute_updated').map((e) => e.detail?.outcome),
    ['unresolved', 'unresolved', 'unresolved'],
    'each request that stays unresolved is logged',
  );
  // With the authoritative query back, it confirms the hidden return with
  // no further refund call.
  w.providers.get(EMPLOYEE)!.status = status;
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'returned');
  assert.equal(p.returnStatus, 'completed');
  assert.equal(returnsApplied(w), 2, 'still exactly one return per leg');
  assert.equal(events(w, 'autopay_released').length, 1);
});

test('a refund outside the dispute updates the open case outcome', async () => {
  const w = autoWorld();
  const p = await completedAutoPurchase(w);
  loseFirstRefund(w);
  assert.equal(await w.coordinator.dispute(p.purchaseId, EMPLOYEE), 'unresolved');
  assert.equal(p.dispute?.outcome, 'unresolved');
  // Completing the return through the plain refund route is a later change
  // to the same case: the recorded outcome follows it and is logged.
  await refundAs(w, p, p.proposal.merchantId);
  assert.equal(p.returnStatus, 'completed');
  assert.equal(p.dispute?.outcome, 'returned');
  const updated = events(w, 'dispute_updated');
  assert.deepEqual(updated.map((e) => e.detail?.outcome), ['unresolved', 'returned']);
  assert.equal(updated[1].detail?.mandateVersion, 1);
  assert.equal(returnsApplied(w), 2, 'the forwarded attempt was confirmed, not retried');
  assert.equal(events(w, 'refund_completed').length, 1);
});

test('a partially returned purchase reports partial and keeps its holds', async () => {
  const w = autoWorld({}, {}, { initiation: 'per_payer_psp' });
  const p = await completedAutoPurchase(w);
  // The employer's PSP is unreachable for the return: the employee leg
  // confirms while the employer leg stays settled.
  w.providers.get(EMPLOYER)!.available = false;
  await refundAs(w, p, p.proposal.merchantId);
  assert.deepEqual(p.legs.map((l) => l.status), ['returned', 'settled']);
  assert.equal(p.returnStatus, 'partial');
  // The payer view reports the partial return and the returned principal
  // without claiming the request is done.
  const v = payerView(p, EMPLOYEE);
  assert.equal(v.returnStatus, 'partial');
  assert.equal(v.returnedCents, 400, 'the employee leg came back');
  assert.equal(v.unreturnedFeeCents, 0);
  // 'partial' is not 'completed': the benefit and the automatic booking
  // stay held.
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  assert.equal(events(w, 'autopay_released').length, 0);
  assert.equal(events(w, 'refund_completed').length, 0);
});
