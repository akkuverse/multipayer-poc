// The request/outcome trace model (spec §7.2): every cross-party call that
// can move or reserve money announces itself with a '<op>_requested' event
// immediately before dispatch — carrying the operation key its outcome
// pairs with, the receiving actor, the causing request's key and the
// attempt number. These tests pin pairing (an outcome never precedes its
// request), nesting (a ledger request's parent chain reaches the
// coordinator's submit), retry (a re-dispatch under the same key is a new
// request, not a new key) and the lost reply (a request left visible with
// no outcome).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPLOYEE,
  EMPLOYER,
  MERCHANT_A,
  approveAs,
  deGroupKey,
  legChildKey,
  lunch,
  refundAs,
  scenarios,
  submitAs,
  world,
} from '../src/scenarios.ts';
import { ProviderUnavailableError } from '../src/settlement/provider.ts';
import { operationKey } from '../src/settlement/operations.ts';
import type { TraceEvent } from '../src/core/types.ts';

// Outcome events that must pair with an earlier '_requested' under the same
// key. Events that carry a key but are not call outcomes are out: lazy
// lifecycle tombstones (de_hold_expired, provider_bank_hold_expired),
// internal effects (de_transit_created, provider_fee_charged), a refusal
// decided before any dispatch (leg_authority_refused) and the
// not-yet-dispatched stall note de_group_blocked.
const OUTCOMES = new Set([
  'settlement_intent',
  'settlement_intent_rejected',
  'provider_reserve_done',
  'provider_reserve_rejected',
  'provider_commit_done',
  'provider_commit_rejected',
  'provider_release_done',
  'provider_release_rejected',
  'provider_return_done',
  'provider_return_rejected',
  'provider_bank_debited',
  'provider_bank_hold',
  'provider_bank_hold_released',
  'provider_bank_restored',
  'provider_funding_restored',
  'provider_op_rejected',
  'leg_reserve',
  'leg_commit',
  'leg_release',
  'leg_return',
  'de_hold_reserved',
  'de_hold_committed',
  'de_hold_released',
  'de_funded',
  'de_defunded',
  'de_transit_defunded',
  'de_transit_cancelled',
  'de_transferred',
  'de_group_committed',
  'de_op_rejected',
  'de_group',
  'de_group_uncertain',
  'de_group_vouched',
  'de_group_vouch_refused',
  'bank_transfer_debited',
  'bank_transfer_credited',
  'bank_transfer_rejected',
  'bank_transit_cancelled',
  'shop_bank_credited',
]);

const isRequest = (e: TraceEvent): boolean => e.event.endsWith('_requested');

const earlierRequests = (events: TraceEvent[], e: TraceEvent, key: unknown): TraceEvent[] =>
  events.filter((r) => isRequest(r) && r.detail?.key === key && r.seq < e.seq);

const outcomesFor = (events: TraceEvent[], key: string): TraceEvent[] =>
  events.filter((e) => OUTCOMES.has(e.event) && e.detail?.key === key);

test('every money-moving outcome pairs with an earlier request under the same key', async () => {
  for (const s of scenarios) {
    const { w } = await s.run();
    for (const e of w.trace.events) {
      const keyedUnavailable = e.event === 'provider_unavailable' && typeof e.detail?.key === 'string';
      if (!OUTCOMES.has(e.event) && !keyedUnavailable) continue;
      const key = e.detail?.key;
      // A rejected admission may not even carry a parseable purchaseRef.
      if (typeof key !== 'string') continue;
      assert.ok(
        earlierRequests(w.trace.events, e, key).length > 0,
        `${s.id} seq ${e.seq} ${e.event} has no earlier '_requested' under ${key}`,
      );
    }
  }
});

test('parent links walk ledger hold → provider reserve → coordinator submit', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  const events = w.trace.events;
  const reserveKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'reserve']);
  const commitKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit']);

  const hold = events.find((e) => e.event === 'de_hold_requested')!;
  assert.equal(hold.actor, 'psp-employee-1');
  assert.equal(hold.detail?.to, 'de-ledger');
  assert.equal(hold.detail?.parent, reserveKey);
  const reserve = events.find((e) => e.event === 'reserve_requested' && e.detail?.key === reserveKey)!;
  assert.equal(reserve.actor, 'orchestrator');
  assert.equal(reserve.detail?.to, 'psp-employee-1');
  assert.equal(reserve.detail?.parent, 'purchase-1');
  const submit = events.find((e) => e.event === 'submit_requested' && e.detail?.key === 'purchase-1')!;
  assert.equal(submit.actor, 'coordinator');
  assert.equal(submit.detail?.to, 'orchestrator');
  assert.equal(submit.detail?.parent, null);

  // A forwarded hop keeps the caller's key: the shop's ledger request
  // parents on the same key, resolving to the immediately preceding
  // confirm_credit request.
  const destKey = legChildKey('purchase-1', 1, 'employee', 'commit', 'destination');
  const confirm = events.find((e) => e.event === 'confirm_credit_requested')!;
  assert.equal(confirm.detail?.key, destKey);
  assert.equal(confirm.detail?.to, 'psp-shop-merchant-a');
  assert.equal(confirm.detail?.parent, commitKey);
  const defund = events.find((e) => e.event === 'de_defund_requested' && e.actor === 'psp-shop-merchant-a')!;
  assert.equal(defund.detail?.key, destKey);
  assert.equal(defund.detail?.parent, destKey);
  const parent = earlierRequests(events, defund, defund.detail?.parent).at(-1);
  assert.equal(parent?.event, 'confirm_credit_requested');
});

test('resubmit logs a new request under the same key with a higher attempt; the outcome stays deduped', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  await w.coordinator.resubmit(p.purchaseId);
  const submits = w.trace.events.filter((e) => e.event === 'submit_requested' && e.detail?.key === 'purchase-1');
  assert.deepEqual(
    submits.map((e) => e.detail?.attempt),
    [1, 2],
  );
  assert.equal(w.trace.events.filter((e) => e.event === 'settlement_intent').length, 1);
});

test('a call refused before acting stays an open request; a retry under the same key pairs it', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  const employer = w.providers.get(EMPLOYER)!;
  const realReserve = employer.reserve.bind(employer);
  // Refuse before the provider records anything: the dispatch leaves a
  // request with no outcome at all — visible as open, never silent.
  employer.reserve = () => Promise.reject(new ProviderUnavailableError(employer.provider));
  await submitAs(w, p, EMPLOYEE);
  const reserveKey = operationKey(['leg', 'purchase-1', 1, 'employer', 'reserve']);
  const first = w.trace.events.filter((e) => e.event === 'reserve_requested' && e.detail?.key === reserveKey);
  assert.deepEqual(first.map((e) => e.detail?.attempt), [1]);
  assert.equal(outcomesFor(w.trace.events, reserveKey).length, 0, 'the refused request must have no outcome yet');

  employer.reserve = realReserve;
  await w.coordinator.reconcile(p.purchaseId);
  const all = w.trace.events.filter((e) => e.event === 'reserve_requested' && e.detail?.key === reserveKey);
  assert.deepEqual(
    all.map((e) => e.detail?.attempt),
    [1, 2],
  );
  assert.ok(
    w.trace.events.some((e) => e.event === 'provider_reserve_done' && e.detail?.key === reserveKey),
    'the retried reserve reports its outcome',
  );
});

test('a lost reply leaves the request open while the receiver already answered downstream', async () => {
  const w = world();
  // The employer leg's transfer credit lands, but the provider's reply to
  // the orchestrator is lost: commit stays 'unknown', never a failure.
  w.providers
    .get(EMPLOYER)!
    .setFault(legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a'), 'credit', 'lose_response_after_effect');
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  const events = w.trace.events;
  const commitKey = operationKey(['leg', 'purchase-1', 1, 'employer', 'commit']);
  const payKey = legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a');
  assert.ok(events.some((e) => e.event === 'commit_requested' && e.detail?.key === commitKey));
  // The only outcome evidence is an open 'unknown' — no terminal answer,
  // never a fabricated failure.
  const commitOutcomes = outcomesFor(events, commitKey);
  assert.ok(commitOutcomes.length > 0);
  assert.ok(commitOutcomes.every((e) => e.detail?.status === 'unknown'), 'the lost reply leaves the commit unresolved');
  assert.ok(!events.some((e) => (e.event === 'provider_commit_done' || e.event === 'provider_commit_rejected') && e.detail?.key === commitKey));
  // The downstream request was fully answered — the loss is between
  // provider and orchestrator, and the trace shows exactly that.
  const payRequests = events.filter((e) => e.event === 'bank_transfer_requested' && e.detail?.key === payKey);
  assert.equal(payRequests.length, 1);
  assert.ok(events.some((e) => e.event === 'bank_transfer_credited' && e.detail?.key === payKey));

  // Reconciliation re-asks the provider under the original keys; the open
  // request is then answered by authoritative status — never a new key.
  await w.coordinator.reconcile(p.purchaseId);
  assert.ok(
    w.trace.events.some((e) => e.event === 'provider_commit_done' && e.detail?.key === commitKey),
    'reconcile answers the open commit request',
  );
});

test('no request has the orchestrator as sender and the digital-euro ledger as receiver', async () => {
  // The DE group commit is provider-mediated: the orchestrator addresses
  // the owning providers, and only the providers dispatch to the ledger.
  for (const s of scenarios) {
    const { w } = await s.run();
    assert.ok(
      !w.trace.events.some((e) => isRequest(e) && e.actor === 'orchestrator' && e.detail?.to === 'de-ledger'),
      s.id,
    );
  }
});

test('the digital-euro group commit trace walks orchestrator → providers → ledger', async () => {
  // S03: three diners on three distinct providers join one same-ledger
  // group — one vouch request per member, each answered by its own
  // provider, then the providers' single ledger commit.
  const { w } = await scenarios.find((s) => s.id.startsWith('S03'))!.run();
  const events = w.trace.events;
  const groupKey = deGroupKey('purchase-1', 1, ['diner-1', 'diner-2', 'diner-3']);

  const groupReq = events.find((e) => e.event === 'de_group_commit_requested' && e.detail?.key === groupKey)!;
  assert.equal(groupReq.actor, 'orchestrator');
  assert.equal(groupReq.detail?.to, 'de-providers');
  assert.equal(groupReq.detail?.parent, 'purchase-1');
  assert.deepEqual(
    (groupReq.detail?.members as { provider: string }[]).map((m) => m.provider),
    ['psp-employee-1', 'psp-colleague-1', 'psp-colleague-2'],
  );

  const vouchReqs = events.filter((e) => e.event === 'de_group_vouch_requested' && e.detail?.parent === groupKey);
  assert.deepEqual(
    vouchReqs.map((e) => e.detail?.to),
    ['psp-employee-1', 'psp-colleague-1', 'psp-colleague-2'],
  );
  const ledgerReq = events.find((e) => e.event === 'de_group_ledger_commit_requested' && e.detail?.key === groupKey)!;
  assert.equal(ledgerReq.actor, 'de-providers');
  assert.equal(ledgerReq.detail?.to, 'de-ledger');
  assert.equal(ledgerReq.detail?.parent, groupKey);
  assert.equal((ledgerReq.detail?.members as unknown[]).length, 3);
  // Every member's vouch is answered by its own provider before the
  // providers dispatch the single ledger commit.
  for (const r of vouchReqs) {
    const vouched = events.find((e) => e.event === 'de_group_vouched' && e.detail?.key === r.detail?.key)!;
    assert.equal(vouched.actor, r.detail?.to);
    assert.equal(vouched.detail?.holdRef, r.detail?.key);
    assert.ok(r.seq < vouched.seq);
    assert.ok(vouched.seq < ledgerReq.seq);
  }
  const committed = events.find((e) => e.event === 'de_group_committed' && e.detail?.key === groupKey)!;
  assert.ok(ledgerReq.seq < committed.seq);
});

test('a provider validation refusal records its rejected outcome under the operation key', async () => {
  const w = world();
  const employer = w.providers.get(EMPLOYER)!;
  const leg = {
    purchaseId: 'purchase-x',
    proposalVersion: 1,
    role: 'employer',
    payerId: 'not-a-customer',
    payeeId: MERCHANT_A,
    rail: 'bank' as const,
    principalCents: 100,
    feeCents: 0,
    authority: 'employer_mandate' as const,
    destination: { bankProvider: 'psp-shop-merchant-a' },
  };
  const evidence = {
    purchaseId: 'purchase-x',
    proposalVersion: 1,
    role: 'employer',
    payerId: 'not-a-customer',
    rail: 'bank' as const,
    principalCents: 100,
    feeCents: 0,
    authority: 'employer_mandate' as const,
  };
  const out = await employer.reserve(leg, evidence);
  assert.equal(out.status, 'rejected');
  assert.equal(out.reason, 'not_customer');
  const key = operationKey(['leg', 'purchase-x', 1, 'employer', 'reserve']);
  assert.ok(w.trace.events.some((e) => e.event === 'provider_reserve_rejected' && e.detail?.key === key));
});

test('a full refund keeps the request/outcome chain: return → shop debit → bank transfer → restore', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  const realReturn = w.settlement.returnSettled.bind(w.settlement);
  w.settlement.returnSettled = async () => { throw new Error('return_dispatch_unanswered'); };
  await assert.rejects(refundAs(w, p, MERCHANT_A), /return_dispatch_unanswered/);
  const first = w.trace.events.filter((e) => e.event === 'return_settled_requested');
  assert.equal(first.length, 1, 'an unanswered coordinator return stays visible');
  assert.equal(first[0].detail?.key, 'purchase-1');
  assert.equal(first[0].detail?.to, 'orchestrator');
  assert.equal(first[0].detail?.parent, null);
  assert.equal(first[0].detail?.attempt, 2, 'submit was the first dispatch under the purchase key');
  assert.equal(w.trace.events.filter((e) => e.event === 'return_requested').length, 0);
  w.settlement.returnSettled = realReturn;
  await refundAs(w, p, MERCHANT_A);
  const events = w.trace.events;
  const returnKey = operationKey(['return', 'purchase-1', 1, 'employer', 'refund']);
  const payKey = legChildKey('purchase-1', 1, 'employer', 'return', 'bank');
  const restoreKey = legChildKey('purchase-1', 1, 'employer', 'return', 'restore');
  const ret = events.find((e) => e.event === 'return_requested' && e.detail?.key === returnKey)!;
  assert.equal(ret.detail?.parent, 'purchase-1');
  const root = earlierRequests(events, ret, ret.detail?.parent).at(-1)!;
  assert.equal(root.event, 'return_settled_requested');
  assert.equal(root.detail?.reason, 'refund');
  assert.deepEqual(root.detail?.legs, ['employee', 'employer']);
  assert.equal(root.detail?.attempt, 3);
  const debit = events.find((e) => e.event === 'debit_for_refund_requested' && e.detail?.key === payKey)!;
  assert.equal(debit.detail?.parent, returnKey);
  const transfer = events.find((e) => e.event === 'bank_transfer_requested' && e.detail?.key === payKey && e.actor === 'psp-shop-merchant-a')!;
  assert.equal(transfer.detail?.parent, payKey);
  const parent = earlierRequests(events, transfer, transfer.detail?.parent).at(-1);
  assert.equal(parent?.event, 'debit_for_refund_requested');
  assert.ok(events.some((e) => e.event === 'bank_restore_requested' && e.detail?.key === restoreKey));
  assert.ok(events.some((e) => e.event === 'provider_bank_restored' && e.detail?.key === restoreKey));
});
