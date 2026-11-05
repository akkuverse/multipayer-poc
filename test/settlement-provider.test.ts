// Provider-owned settlement books (spec §4.1, §4.2, §6.1, §7): a payer
// provider holds its customers' bank entitlements and maps their
// digital-euro pseudonyms, funds DE holds through a reverse waterfall whose
// bank debit and ledger credit are separately tracked child operations,
// restores only the intent's own funding when the payment hold fails,
// waits for a zero-limit destination's paired bank credit before calling a
// leg settled, charges its own fee only on confirmed settlement, and
// returns principal — plus the fee under 'principal_and_fee' — through
// keyed, once-only returns. Owning layer: the provider modules; the ledger
// tests already prove per-ledger hold/group semantics.
//
// All balances are asserted directly — payer entitlements, provider fee
// accounts, payee bank balances, ledger holdings and transit — never via
// production totals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Trace, RequestLog } from '../src/evidence/trace.ts';
import { operationKey } from '../src/settlement/operations.ts';
import { DigitalEuroLedger } from '../src/settlement/digital-euro-ledger.ts';
import { InterbankTransfer } from '../src/settlement/interbank-transfer.ts';
import {
  PayerProvider,
  ProviderOwners,
  ShopProvider,
  commitAcceptedDigitalEuroGroup,
} from '../src/settlement/provider.ts';
import type { AcceptedAuthority, AcceptedHold, SettlementLeg } from '../src/settlement/types.ts';

// A small provider world on the shared simulated-minute clock: the
// employee's provider owns a bank entitlement of EUR 1000 and pseudonym
// 'ps-emp', the shop provider is receive-only behind pseudonym 'ps-shop'
// (holding limit 0, so every DE credit defunds to its bank account), and
// the employer's provider owns a bank-only customer for bank-rail legs.
function providerWorld(opts?: { employeeDeCents?: number; employeeDeLimitCents?: number; shopPseudonym?: string; feePseudonym?: string }) {
  const trace = new Trace();
  let t = 10;
  const de = new DigitalEuroLedger(() => t, trace);
  const bank = new InterbankTransfer(() => t, trace);
  const owners = new ProviderOwners();
  de.registerHolding({
    pseudonym: 'ps-emp',
    provider: 'psp-alice',
    holdingLimitCents: opts?.employeeDeLimitCents ?? 300_000,
    deCents: opts?.employeeDeCents ?? 0,
  });
  de.registerHolding({ pseudonym: opts?.feePseudonym ?? 'ps-fee-alice', provider: 'psp-alice', holdingLimitCents: 0 });
  de.registerHolding({ pseudonym: 'ps-bob', provider: 'psp-bob', holdingLimitCents: 300_000, deCents: 1_000 });
  de.registerHolding({ pseudonym: 'ps-fee-bob', provider: 'psp-bob', holdingLimitCents: 0 });
  de.registerHolding({ pseudonym: opts?.shopPseudonym ?? 'ps-shop', provider: 'psp-shop', holdingLimitCents: 0 });
  const shop = new ShopProvider({
    provider: 'psp-shop',
    payeeId: 'merchant-1',
    dePseudonym: opts?.shopPseudonym ?? 'ps-shop',
    bankCents: 0,
    now: () => t,
    trace,
    digitalEuro: de,
    interbank: bank,
  });
  const shops = new Map([['psp-shop', shop]]);
  const alice = new PayerProvider({
    provider: 'psp-alice',
    customers: { 'employee-1': { bankCents: 100_000, dePseudonym: 'ps-emp' } },
    feePseudonym: opts?.feePseudonym ?? 'ps-fee-alice',
    now: () => t,
    trace,
    digitalEuro: de,
    interbank: bank,
    shops,
    owners,
  });
  const bob = new PayerProvider({
    provider: 'psp-bob',
    customers: { 'diner-1': { bankCents: 10_000, dePseudonym: 'ps-bob' } },
    feePseudonym: 'ps-fee-bob',
    now: () => t,
    trace,
    digitalEuro: de,
    interbank: bank,
    shops,
    owners,
  });
  const biz = new PayerProvider({
    provider: 'psp-biz',
    customers: { 'employer-1': { bankCents: 50_000 } },
    now: () => t,
    trace,
    digitalEuro: de,
    interbank: bank,
    shops,
    owners,
  });
  return {
    trace,
    de,
    bank,
    shop,
    alice,
    bob,
    biz,
    owners,
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
}

// Independent money-location sum: customer entitlements and fee revenue
// live inside provider pools, so count pools once rather than twice.
function totalMoney(w: ReturnType<typeof providerWorld>): number {
  return w.alice.poolCents + w.bob.poolCents + w.biz.poolCents + w.shop.account().bankCents
    + w.de.holdings().reduce((sum, h) => sum + h.deCents, 0)
    + w.de.transit().filter((t) => t.status === 'in_transit').reduce((sum, t) => sum + t.amountCents, 0)
    + w.bank.transit().reduce((sum, t) => sum + t.amountCents, 0)
    + w.alice.fundingTransitCents() + w.bob.fundingTransitCents() + w.biz.fundingTransitCents();
}

// EUR 8 principal + EUR 0.25 fee on the employee's digital-euro rail.
function deLeg(extra?: Partial<SettlementLeg>): SettlementLeg {
  return {
    purchaseId: 'purchase-1',
    proposalVersion: 1,
    role: 'employee',
    payerId: 'employee-1',
    payeeId: 'merchant-1',
    rail: 'digital_euro',
    principalCents: 800,
    feeCents: 25,
    authority: 'payer',
    destination: { dePseudonym: 'ps-shop' },
    ...extra,
  };
}

function deEvidence(leg: SettlementLeg, authorityRef = 'approval-1'): AcceptedAuthority {
  return {
    purchaseId: leg.purchaseId,
    proposalVersion: leg.proposalVersion,
    role: leg.role,
    payerId: leg.payerId,
    rail: leg.rail,
    principalCents: leg.principalCents,
    feeCents: leg.feeCents,
    authority: leg.authority,
    authorityRef,
  };
}

function bankLeg(): SettlementLeg {
  return {
    purchaseId: 'purchase-1',
    proposalVersion: 1,
    role: 'employer',
    payerId: 'employer-1',
    payeeId: 'merchant-1',
    rail: 'bank',
    principalCents: 800,
    feeCents: 25,
    authority: 'employer_mandate',
    destination: { bankProvider: 'psp-shop' },
  };
}

test('funding_response_loss_debits_bank_once', async () => {
  const w = providerWorld(); // employee DE is empty: the whole 825 funds from bank
  const leg = deLeg();
  const debitKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'fund', 'bank']);
  w.alice.setFault(debitKey, 'bank_debit', 'lose_response_after_effect');

  // The bank debit applied but its response was lost: the caller sees
  // 'unknown', the money sits in explicit funding transit, no DE exists yet.
  const first = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(first.status, 'unknown');
  assert.equal(w.alice.account('employee-1').spendableCents, 99_175);
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
  assert.equal(w.alice.fundingTransitCents(), 825);
  assert.equal(w.de.holding('ps-emp').deCents, 0);
  assert.equal(w.de.holds().length, 0);
  assert.equal(w.alice.poolCents, 99_175);
  // The authoritative status under the original key reports the true
  // outcome — the debit succeeded even though its response was lost.
  assert.equal((await w.alice.status(debitKey)).status, 'succeeded');

  // The replay reconciles the recorded debit and proceeds — it never
  // repeats the debit because funding timed out (spec §6.1).
  const resumed = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.expiresAt, 10.5);
  assert.equal(typeof resumed.holdRef, 'string');
  assert.equal(w.alice.account('employee-1').spendableCents, 99_175);
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
  assert.equal(w.alice.fundingTransitCents(), 0);
  // The funded 825 is now held: principal 800 to the payee, fee 25 to the
  // provider's fee pseudonym.
  assert.equal(w.de.holding('ps-emp').deCents, 825);
  assert.equal(w.de.holding('ps-emp').heldCents, 825);
  assert.equal(w.alice.poolCents, 99_175);

  // A third replay is stable — same hold, still exactly one bank debit.
  const again = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(again.status, 'succeeded');
  assert.equal(again.holdRef, resumed.holdRef);
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
  assert.equal(w.de.holding('ps-emp').deCents, 825);
});

test('hold_failure_restores_only_its_funding', async () => {
  // 200 cents of pre-existing digital euro; the reserve must fund 625 more.
  const w = providerWorld({ employeeDeCents: 200 });
  const leg = deLeg();
  const holdKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'hold', 'ps-shop']);
  w.alice.setFault(holdKey, 'hold', 'reject_before_effect');

  const res = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(res.status, 'rejected');
  // Funding succeeded but the payment hold failed: only the amount funded
  // for this intent is defunded back to bank — the pre-existing 200 stays.
  assert.equal(w.de.holding('ps-emp').deCents, 200);
  assert.equal(w.de.holds().length, 0);
  assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
  assert.equal(w.alice.fundingTransitCents(), 0);
  assert.equal(w.alice.poolCents, 100_000);
  assert.equal(res.cleanupConfirmed, true);

  // The rejection is terminal: a replay changes nothing and moves nothing.
  const again = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(again.status, 'rejected');
  assert.equal(w.de.holding('ps-emp').deCents, 200);
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
});

test('zero_limit_credit_waits_for_bank', async () => {
  const w = providerWorld({ employeeDeCents: 2_000 });
  const leg = deLeg();
  const res = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(res.status, 'succeeded');

  // Defer the paired bank credit for the shop's excess credit: the commit
  // cannot report confirmed settlement while the destination's bank credit
  // is unresolved (decision 10; spec §6 — a leg requiring waterfall is
  // settled only after the destination bank credit is confirmed).
  const destKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit', 'destination']);
  w.alice.setFault(destKey, 'defund', 'defer');
  const commit = await w.alice.commit(res.holdRef!);
  assert.equal(commit.status, 'pending');
  assert.equal(commit.committedCents, 800);
  assert.equal(commit.destinationCreditConfirmed, false);
  // Principal left the holding and sits in tracked defunding transit;
  // the shop holds no spendable digital euro and no bank credit yet.
  assert.equal(w.de.holdAudit(res.holdRef!).status, 'committed');
  assert.equal(w.de.holding('ps-shop').deCents, 0);
  assert.equal(w.de.transit().length, 1);
  assert.equal(w.de.transit()[0].status, 'in_transit');
  assert.equal(w.shop.account().bankCents, 0);
  // The fee is not yet charged — settlement is not confirmed.
  assert.equal(w.alice.feesCents, 0);
  assert.equal(commit.unresolved.some((op) => op.key === destKey), true);

  // The explicit simulation resolution progresses the deferred confirm;
  // a commit replay reconciles it, credits the shop's bank once and then
  // charges the fee.
  w.alice.resolveDeferred(destKey, 'succeed');
  const done = await w.alice.commit(res.holdRef!);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.destinationCreditConfirmed, true);
  assert.equal(done.committedCents, 800);
  assert.equal(done.feeChargedCents, 25);
  assert.equal(w.shop.account().bankCents, 800);
  assert.equal(w.de.holding('ps-shop').deCents, 0);
  // Both transit entries — destination excess and fee defund — are
  // confirmed defunded; nothing remains in flight.
  assert.equal(w.de.transit().filter((x) => x.status === 'in_transit').length, 0);
  assert.equal(w.de.holding('ps-emp').deCents, 1_175);
  // The fee landed in the provider's own fee account via the paired
  // defund — never a shared collector account.
  assert.equal(w.alice.feesCents, 25);
  assert.equal(w.alice.poolCents, 100_025);
});

test('ordinary_return_retains_fee', async () => {
  // Bank rail: the employer pays 800 + 25 fee; an ordinary refund returns
  // principal only and the provider keeps its confirmed fee (decision 9).
  const w = providerWorld();
  const leg = bankLeg();
  const res = await w.biz.reserve(leg, deEvidence(leg, 'mandate-1'));
  assert.equal(res.status, 'succeeded');
  const commit = await w.biz.commit(res.holdRef!);
  assert.equal(commit.status, 'succeeded');
  assert.equal(commit.destinationCreditConfirmed, true);
  assert.equal(commit.committedCents, 800);
  assert.equal(commit.feeChargedCents, 25);
  assert.equal(w.biz.account('employer-1').spendableCents, 49_175);
  assert.equal(w.shop.account().bankCents, 800);
  assert.equal(w.biz.feesCents, 25);

  const returnKey = operationKey(['return', 'purchase-1', 1, 'employer', 'refund-1']);
  const ret = await w.biz.refund(commit.reference!, returnKey, 'principal_only');
  assert.equal(ret.status, 'succeeded');
  assert.equal(ret.principalReturnedCents, 800);
  assert.equal(ret.feeReturnedCents ?? 0, 0);
  // Money went back the way it came: the shop's bank account is debited,
  // the interbank transfer credits the provider's book and the customer's
  // entitlement is restored — while the charged fee stays retained.
  assert.equal(w.shop.account().bankCents, 0);
  assert.equal(w.biz.account('employer-1').spendableCents, 49_975);
  assert.equal(w.biz.feesCents, 25);
  assert.equal(w.bank.transit().length, 0);
});

for (const mode of ['normal', 'refused', 'deferred', 'lost', 'deferred-restoration'])
for (const policy of ['principal_only', 'principal_and_fee'] as const) test(`return_restores_original_money_once:${policy}:${mode}`, async () => {
  const feeBack = policy === 'principal_and_fee';
  const excess = mode !== 'normal';
  // Digital-euro rail: the selected policy restores principal and any
  // refundable fee exactly once; the same execution can never be
  // returned twice under another return key (decision 9).
  const w = providerWorld({ employeeDeCents: 2_000, employeeDeLimitCents: 2_000 });
  const leg = deLeg();
  const res = await w.alice.reserve(leg, deEvidence(leg));
  const commit = await w.alice.commit(res.holdRef!);
  assert.equal(commit.status, 'succeeded');
  assert.equal(w.de.holding('ps-emp').deCents, 1_175);
  assert.equal(w.alice.feesCents, 25);
  assert.equal(w.shop.account().bankCents, 800);

  const returnKey = operationKey(['return', 'purchase-1', 1, 'employee', 'comp-1']);
  // A separate incoming credit fills the holding after payment; the
  // return must waterfall to bank without exceeding the original limit.
  if (excess) w.de.fund({ key: 'independent-credit', provider: 'psp-alice', pseudonym: 'ps-emp', amountCents: 825 });
  const excessKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'return', 'defund']);
  const restoreKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'restore', 'return-excess']);
  if (['refused', 'deferred-restoration'].includes(mode)) w.alice.setFault(excessKey, 'defund', 'reject_before_effect');
  if (mode === 'deferred') w.alice.setFault(excessKey, 'defund', 'defer');
  if (mode === 'lost') w.alice.setFault(excessKey, 'defund', 'lose_response_after_effect');
  if (mode === 'deferred-restoration') w.alice.setFault(restoreKey, 'bank_restore', 'defer');
  let ret = await w.alice.refund(commit.reference!, returnKey, policy);
  if (['deferred', 'lost', 'deferred-restoration'].includes(mode)) {
    assert.equal(ret.status, mode === 'lost' ? 'unknown' : 'pending');
    assert.equal(ret.cleanupConfirmed, false);
    assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
    assert.equal(w.shop.account().bankCents, 0);
    if (mode === 'deferred') {
      assert.equal((await w.alice.status(returnKey)).status, 'pending');
      w.de.resolveDeferred(excessKey, 'reject', 'defund_rejected');
    }
    if (mode === 'deferred-restoration') {
      assert.equal(w.bank.transit().length, 0);
      assert.equal(totalMoney(w), 163_825, 'cancelled return excess remains accounted for before customer restoration');
      assert.equal((await w.alice.status(returnKey)).status, 'pending');
      w.alice.resolveDeferred(restoreKey, 'succeed');
    }
    ret = await w.alice.status(returnKey);
  }
  assert.equal(ret.status, 'succeeded');
  assert.equal(ret.principalReturnedCents, 800);
  assert.equal(ret.feeReturnedCents, feeBack ? 25 : 0);
  assert.equal(ret.cleanupConfirmed, true);
  // The shop's bank debit funds the interbank return to the provider's
  // book, which converts the refundable amount back to DE or bank.
  assert.equal(w.shop.account().bankCents, 0);
  assert.equal(w.de.holding('ps-emp').deCents, excess || feeBack ? 2_000 : 1_975);
  assert.equal(w.alice.feesCents, feeBack ? 0 : 25);
  assert.equal(w.alice.poolCents, excess ? 100_825 : feeBack ? 100_000 : 100_025);
  assert.equal(w.alice.account('employee-1').spendableCents, excess ? (feeBack ? 100_825 : 100_800) : 100_000);
  assert.equal(w.de.holding('ps-emp').holdingLimitCents, 2_000);
  assert.equal(w.bank.transit().length, 0);
  assert.equal(w.de.transit().filter((x) => x.status === 'in_transit').length, 0);

  // Idempotent replay under the same return key: same outcome, no second
  // movement.
  const original = w.de.status(excessKey);
  const again = await w.alice.refund(commit.reference!, returnKey, policy);
  assert.deepEqual(again, ret);
  assert.deepEqual(await w.alice.status(returnKey), ret);
  if (excess) assert.equal(w.de.status(excessKey)?.status, ['refused', 'deferred', 'deferred-restoration'].includes(mode) ? 'rejected' : 'succeeded');
  assert.deepEqual(w.de.status(excessKey), original);
  assert.equal(w.alice.account('employee-1').spendableCents, excess ? (feeBack ? 100_825 : 100_800) : 100_000);
  assert.equal(w.alice.poolCents, excess ? 100_825 : feeBack ? 100_000 : 100_025);
  assert.equal(again.principalReturnedCents, 800);
  assert.equal(w.de.holding('ps-emp').deCents, excess || feeBack ? 2_000 : 1_975);
  assert.equal(w.shop.account().bankCents, 0);

  // A different return key on the same execution is refused — a second
  // return under a new key, reason or scope is never a fresh payment.
  const twice = await w.alice.refund(
    commit.reference!,
    operationKey(['return', 'purchase-1', 1, 'employee', 'comp-2']),
    policy,
  );
  assert.equal(twice.status, 'rejected');
  assert.equal(twice.reason, 'already_returned');
  assert.equal(w.de.holding('ps-emp').deCents, excess || feeBack ? 2_000 : 1_975);
  assert.equal(w.shop.account().bankCents, 0);
  assert.equal(w.alice.feesCents, feeBack ? 0 : 25);
});

test('de_group_commit_runs_member_bookkeeping_once', async () => {
  // Two payers on different providers join one frozen DE group (decision
  // 11): the module-level helper commits both holds atomically, then each
  // owning provider finishes only its fee/waterfall bookkeeping through
  // commit(holdRef) — it never debits the member again.
  const w = providerWorld({ employeeDeCents: 2_000 });
  const groupKey = operationKey(['de-group', 'purchase-1', 1, 'commit', 'employee', 'diner']);
  const member = (self: string) => ({ key: groupKey, self, members: ['employee', 'diner'] });
  const legA = deLeg({ deGroup: member('employee') });
  const legB = deLeg({ role: 'diner', payerId: 'diner-1', principalCents: 700, feeCents: 0, deGroup: member('diner') });
  const ra = await w.alice.reserve(legA, deEvidence(legA));
  const rb = await w.bob.reserve(legB, deEvidence(legB));
  assert.equal(ra.status, 'succeeded');
  assert.equal(rb.status, 'succeeded');
  const holdA = ra.acceptedHold as AcceptedHold;
  const holdB = rb.acceptedHold as AcceptedHold;
  assert.equal(holdA.provider, 'psp-alice');
  assert.equal(holdB.provider, 'psp-bob');
  assert.equal(holdA.groupKey, groupKey);

  const requests = new RequestLog(w.trace, 'orchestrator');
  const group = await commitAcceptedDigitalEuroGroup([holdA, holdB], w.owners, requests);
  assert.equal(group.status, 'succeeded');
  assert.equal(group.key, groupKey);
  assert.equal(group.members.length, 2);
  // Both members committed in one step; credits sit in defunding transit
  // awaiting each destination's paired bank credit.
  assert.equal(w.de.holdAudit(ra.holdRef!).status, 'committed');
  assert.equal(w.de.holdAudit(rb.holdRef!).status, 'committed');
  assert.equal(w.de.transit().length, 2);
  assert.equal(w.shop.account().bankCents, 0);

  // Each owning provider finishes bookkeeping by committing its own hold:
  // it recognizes the already-committed hold rather than debiting again.
  const ca = await w.alice.commit(ra.holdRef!);
  const cb = await w.bob.commit(rb.holdRef!);
  assert.equal(ca.status, 'succeeded');
  assert.equal(cb.status, 'succeeded');
  assert.equal(ca.committedCents, 800);
  assert.equal(cb.committedCents, 700);
  assert.equal(w.shop.account().bankCents, 1_500);
  assert.equal(w.de.transit().filter((x) => x.status === 'in_transit').length, 0);
  assert.equal(w.de.holding('ps-emp').deCents, 1_175);
  assert.equal(w.de.holding('ps-bob').deCents, 300);
  assert.equal(w.alice.feesCents, 25);
  assert.equal(w.bob.feesCents, 0);

  // A replay of the group commit under its original key resolves to the
  // same group outcome — never a second settlement.
  const again = await commitAcceptedDigitalEuroGroup([holdA, holdB], w.owners, requests);
  assert.equal(again.status, 'succeeded');
  assert.equal(w.shop.account().bankCents, 1_500);
  assert.equal(w.de.holding('ps-emp').deCents, 1_175);
});

test('group_commit_replays_after_acceptance_expiry', async () => {
  // Once the group operation is recorded under its key, acceptance expiry
  // must not make it unrecoverable: a replay after the deadline resolves
  // the recorded outcome (spec §7).
  const w = providerWorld({ employeeDeCents: 2_000 });
  const groupKey = operationKey(['de-group', 'purchase-1', 1, 'commit', 'employee', 'diner']);
  const member = (self: string) => ({ key: groupKey, self, members: ['employee', 'diner'] });
  const legA = deLeg({ deGroup: member('employee') });
  const legB = deLeg({ role: 'diner', payerId: 'diner-1', principalCents: 700, feeCents: 0, deGroup: member('diner') });
  const ra = await w.alice.reserve(legA, deEvidence(legA));
  const rb = await w.bob.reserve(legB, deEvidence(legB));
  assert.equal(ra.status, 'succeeded');
  assert.equal(rb.status, 'succeeded');
  const holdA = ra.acceptedHold as AcceptedHold;
  const holdB = rb.acceptedHold as AcceptedHold;

  const requests = new RequestLog(w.trace, 'orchestrator');
  const group = await commitAcceptedDigitalEuroGroup([holdA, holdB], w.owners, requests);
  assert.equal(group.status, 'succeeded');

  // The holds expire at reserve + 0.5 simulated minutes; the commit is
  // already recorded — a later replay recovers the same outcome.
  w.set(20);
  const replayed = await commitAcceptedDigitalEuroGroup([holdA, holdB], w.owners, requests);
  assert.equal(replayed.status, 'succeeded');
  assert.equal(replayed.key, groupKey);
  assert.equal(replayed.members.length, 2);
  assert.equal(w.de.holdAudit(ra.holdRef!).status, 'committed');

  // A foreign world's registry cannot resolve the owner token: owner ids
  // are scoped to the world that minted them.
  const w2 = providerWorld();
  const foreign = await commitAcceptedDigitalEuroGroup([holdA, holdB], w2.owners, requests);
  assert.equal(foreign.status, 'rejected');
  assert.equal(foreign.reason, 'unknown_provider');
  // The unresolved owner answers as the providers' collective, naming the
  // claimed provider and the reason — never a silent helper refusal.
  assert.ok(
    w.trace.events.some(
      (e) =>
        e.event === 'de_group_vouch_refused' &&
        e.actor === 'de-providers' &&
        e.detail?.provider === 'psp-alice' &&
        e.detail?.reason === 'unknown_provider',
    ),
  );
});

test('de_group_vouch_refusal_names_provider_and_reason', async () => {
  // The vouch hop is logged per member: an expired acceptance shows the
  // request to its owning provider and the refusal naming provider and
  // reason — previously visible only indirectly as de_group.reason.
  const w = providerWorld({ employeeDeCents: 2_000 });
  const groupKey = operationKey(['de-group', 'purchase-1', 1, 'commit', 'employee', 'diner']);
  const member = (self: string) => ({ key: groupKey, self, members: ['employee', 'diner'] });
  const legA = deLeg({ deGroup: member('employee') });
  const legB = deLeg({ role: 'diner', payerId: 'diner-1', principalCents: 700, feeCents: 0, deGroup: member('diner') });
  const ra = await w.alice.reserve(legA, deEvidence(legA));
  const rb = await w.bob.reserve(legB, deEvidence(legB));
  const holdA = ra.acceptedHold as AcceptedHold;
  const holdB = rb.acceptedHold as AcceptedHold;

  // The holds expire at reserve + 0.5 simulated minutes with no recorded
  // group operation: alice's vouch is refused before any ledger dispatch.
  w.set(20);
  const requests = new RequestLog(w.trace, 'orchestrator');
  const group = await commitAcceptedDigitalEuroGroup([holdA, holdB], w.owners, requests);
  assert.equal(group.status, 'rejected');
  assert.equal(group.reason, 'acceptance_expired');

  const events = w.trace.events;
  const vouchReq = events.find((e) => e.event === 'de_group_vouch_requested' && e.detail?.key === holdA.holdRef)!;
  assert.equal(vouchReq.actor, 'orchestrator');
  assert.equal(vouchReq.detail?.to, 'psp-alice');
  assert.equal(vouchReq.detail?.parent, groupKey);
  const refused = events.find((e) => e.event === 'de_group_vouch_refused')!;
  assert.equal(refused.actor, 'psp-alice');
  assert.equal(refused.detail?.key, holdA.holdRef);
  assert.equal(refused.detail?.provider, 'psp-alice');
  assert.equal(refused.detail?.holdRef, holdA.holdRef);
  assert.equal(refused.detail?.reason, 'acceptance_expired');
  // Bob's vouch and the ledger dispatch never ran — no fabricated hops.
  assert.ok(!events.some((e) => e.event === 'de_group_vouch_requested' && e.detail?.key === holdB.holdRef));
  assert.ok(!events.some((e) => e.event === 'de_group_ledger_commit_requested'));
  assert.ok(!events.some((e) => e.event === 'de_group_committed'));
});

for (const mode of ['confirmed', 'refused', 'deferred', 'lost', 'deferred-restoration']) test(`unwind_after_excess_defund_restores_only_credited_portion:${mode}`, async () => {
  const refusedExcess = ['refused', 'deferred', 'deferred-restoration'].includes(mode);
  // 200 pre-existing digital euro under a 300 holding limit: the 825 need
  // funds 625 from bank, of which only 100 becomes spendable digital euro —
  // the 525 excess returns to bank through defunding transit. When the
  // payment hold then fails, the unwind must defund only the credited 100,
  // never the 625 bank shortfall (spec §6.1 conservation).
  const w = providerWorld({ employeeDeCents: 200, employeeDeLimitCents: 300 });
  const leg = deLeg();
  const excessKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'fund', 'defund']);
  if (refusedExcess) w.alice.setFault(excessKey, 'defund', mode === 'deferred' ? 'defer' : 'reject_before_effect');
  if (mode === 'lost') w.alice.setFault(excessKey, 'defund', 'lose_response_after_effect');
  const restoreKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'restore', 'funding-excess']);
  if (mode === 'deferred-restoration') w.alice.setFault(restoreKey, 'bank_restore', 'defer');
  let res = await w.alice.reserve(leg, deEvidence(leg));
  if (['deferred', 'lost', 'deferred-restoration'].includes(mode)) {
    assert.equal(res.status, mode === 'lost' ? 'unknown' : 'pending');
    assert.equal(res.cleanupConfirmed, false);
    assert.equal(w.alice.account('employee-1').spendableCents, 99_375);
    assert.equal(w.de.holding('ps-emp').deCents, 300);
    assert.equal(w.shop.account().bankCents, 0);
    assert.equal(w.de.holds().length, 0);
    if (mode === 'deferred') {
      assert.equal(w.de.transit()[0].status, 'in_transit');
      assert.equal((await w.alice.status(res.key)).status, 'pending');
      w.de.resolveDeferred(excessKey, 'reject', 'defund_rejected');
    }
    if (mode === 'deferred-restoration') {
      assert.equal(w.bank.transit().length, 0);
      assert.equal(totalMoney(w), 161_200, 'cancelled funding excess remains accounted for before customer restoration');
      assert.equal(w.de.transit()[0].status, 'cancelled');
      assert.equal((await w.alice.status(res.key)).status, 'pending');
      w.alice.resolveDeferred(restoreKey, 'succeed');
    }
    res = await w.alice.status(res.key);
  }
  assert.equal(res.status, 'rejected');
  assert.equal(res.reason, refusedExcess ? 'fund_excess_rejected:defund_rejected' : 'hold_rejected:insufficient_funds');
  // Exactly one bank debit for the shortfall; the excess 525 and the
  // credited 100 both came back: the entitlement is whole again.
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
  assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
  assert.equal(w.alice.poolCents, 100_000);
  // The pre-existing digital euro was never consumed by the unwind.
  assert.equal(w.de.holding('ps-emp').deCents, 200);
  assert.equal(w.de.holds().length, 0);
  // The funding excess transit is confirmed defunded; nothing in flight.
  assert.equal(w.de.transit().filter((x) => x.status === 'in_transit').length, 0);
  assert.equal(w.alice.fundingTransitCents(), 0);
  // Cleanup is confirmed: every funded effect is restored.
  assert.equal(res.cleanupConfirmed, true);
  assert.equal(w.shop.account().bankCents, 0);
  const original = w.de.status(excessKey);
  assert.equal(original?.status, refusedExcess ? 'rejected' : 'succeeded');
  for (let replay = 0; replay < 3; replay++) {
    assert.deepEqual(await w.alice.reserve(leg, deEvidence(leg)), res);
    assert.deepEqual(await w.alice.status(res.key), res);
  }
  assert.deepEqual(w.de.status(excessKey), original);
  assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
  assert.equal(w.de.holding('ps-emp').deCents, 200);
  assert.equal(w.shop.account().bankCents, 0);
});

test('fund_rejected_path_reports_cleanup_confirmed', async () => {
  // A conclusively refused ledger credit restores the parked bank debit
  // once — the reserve outcome must report cleanupConfirmed, not leave
  // funding restoration invisible forever.
  const w = providerWorld();
  const leg = deLeg();
  const fundKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'fund', 'digital_euro']);
  w.alice.setFault(fundKey, 'fund', 'reject_before_effect');

  const res = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(res.status, 'rejected');
  assert.equal(res.reason, 'fund_rejected:fund_rejected');
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
  assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
  assert.equal(w.alice.fundingTransitCents(), 0);
  assert.equal(w.de.holding('ps-emp').deCents, 0);
  assert.equal(res.cleanupConfirmed, true);
});

test('lost_non_group_commit_response_recovers_via_status', async () => {
  // lose_response_after_effect on the principal commit: the hold settles
  // but the credit evidence never reaches the provider. A replayed commit
  // recovers the recorded effects under the original child key and
  // finishes the destination confirm and the fee — never a second debit.
  const w = providerWorld({ employeeDeCents: 2_000 });
  const leg = deLeg();
  const res = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(res.status, 'succeeded');
  const commitKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit', 'principal']);
  w.alice.setFault(commitKey, 'commit', 'lose_response_after_effect');

  const lost = await w.alice.commit(res.holdRef!);
  assert.equal(lost.status, 'unknown');
  assert.equal(w.de.holdAudit(res.holdRef!).status, 'committed');
  // The destination credit already sits in defunding transit; the shop
  // has no bank credit and the fee is uncharged while evidence is lost.
  assert.equal(w.de.transit().length, 1);
  assert.equal(w.shop.account().bankCents, 0);
  assert.equal(w.alice.feesCents, 0);

  const done = await w.alice.commit(res.holdRef!);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.committedCents, 800);
  assert.equal(done.destinationCreditConfirmed, true);
  assert.equal(done.feeChargedCents, 25);
  assert.equal(done.unresolved.length, 0);
  assert.equal(w.shop.account().bankCents, 800);
  assert.equal(w.de.transit().filter((x) => x.status === 'in_transit').length, 0);
  assert.equal(w.de.holding('ps-emp').deCents, 1_175);
  assert.equal(w.alice.feesCents, 25);
});

test('rejected_fee_transit_confirm_never_double_represents', async () => {
  // A refused fee transit confirm leaves the fee claimable in tracked
  // transit: the commit exposes refusal and must not book the paired
  // bank credit beside it — the fee is represented exactly once (§6.1).
  const w = providerWorld({ employeeDeCents: 2_000 });
  const leg = deLeg();
  const res = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(res.status, 'succeeded');
  const feeDefundKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit', 'fee-defund']);
  w.alice.setFault(feeDefundKey, 'defund', 'reject_before_effect');

  const commit = await w.alice.commit(res.holdRef!);
  assert.equal(commit.status, 'rejected');
  assert.equal(commit.cleanupConfirmed, false);
  // The destination leg of settlement confirmed; only the fee is stuck.
  assert.equal(commit.committedCents, 800);
  assert.equal(commit.destinationCreditConfirmed, true);
  assert.equal(w.shop.account().bankCents, 800);
  // No fee revenue booked and no pool credit beside the stranded transit.
  assert.equal(commit.feeChargedCents, 25);
  assert.equal(w.alice.feesCents, 0);
  assert.equal(w.alice.poolCents, 100_000);
  const inTransit = w.de.transit().filter((x) => x.status === 'in_transit');
  assert.equal(inTransit.length, 1);
  assert.equal(inTransit[0].amountCents, 25);
});

test('commit_before_confirmed_reserve_parks', async () => {
  // Reserve parks between the principal and fee holds; committing the
  // already-created hold must wait for the reserve to confirm rather than
  // mutate around the missing fee hold.
  const w = providerWorld({ employeeDeCents: 2_000 });
  const leg = deLeg();
  const feeHoldKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'hold', 'ps-fee-alice']);
  w.alice.setFault(feeHoldKey, 'hold', 'defer');

  const res = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(res.status, 'pending');
  assert.equal(typeof res.holdRef, 'string');

  // The commit parks pending — the principal hold is never consumed while
  // its sibling fee hold is unfinished.
  const early = await w.alice.commit(res.holdRef!);
  assert.equal(early.status, 'pending');
  assert.equal(w.de.holdAudit(res.holdRef!).status, 'active');
  assert.equal(w.de.holding('ps-emp').heldCents, 800);
  assert.equal(w.shop.account().bankCents, 0);

  // Resolving the deferred fee hold lets reserve and then commit finish.
  w.alice.resolveDeferred(feeHoldKey, 'succeed');
  const resumed = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(resumed.status, 'succeeded');
  const commit = await w.alice.commit(res.holdRef!);
  assert.equal(commit.status, 'succeeded');
  assert.equal(commit.committedCents, 800);
  assert.equal(w.shop.account().bankCents, 800);
});

test('failed_return_releases_latch_for_later_attempt', async () => {
  // A conclusive return refusal before any money moved must not latch the
  // execution: the failed attempt stays terminal under its key while a
  // later return — same execution, new key — may be attempted (spec §6
  // recoverable failed-return exposure). The once-guard binds successes.
  const w = providerWorld();
  const leg = bankLeg();
  const res = await w.biz.reserve(leg, deEvidence(leg, 'mandate-1'));
  const commit = await w.biz.commit(res.holdRef!);
  assert.equal(commit.status, 'succeeded');
  assert.equal(w.shop.account().bankCents, 800);

  // The shop provider is momentarily unreachable: the return rejects
  // before the referenced bank debit ever begins.
  w.biz.shops.delete('psp-shop');
  const k1 = operationKey(['return', 'purchase-1', 1, 'employer', 'refund-1']);
  const failed = await w.biz.refund(commit.reference!, k1, 'principal_only');
  assert.equal(failed.status, 'rejected');
  assert.equal(failed.reason, 'destination_unknown');
  assert.equal(w.shop.account().bankCents, 800);

  // Same key replays the terminal refusal; a new key is attempted, not
  // refused as return_in_progress — and now completes the return.
  const again = await w.biz.refund(commit.reference!, k1, 'principal_only');
  assert.equal(again.status, 'rejected');
  w.biz.shops.set('psp-shop', w.shop);
  const k2 = operationKey(['return', 'purchase-1', 1, 'employer', 'refund-2']);
  const retried = await w.biz.refund(commit.reference!, k2, 'principal_only');
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.principalReturnedCents, 800);
  assert.equal(w.shop.account().bankCents, 0);
  assert.equal(w.biz.account('employer-1').spendableCents, 49_975);

  // The once-guard still binds: a third return on the same execution is
  // refused because it already returned, not because a key is latched.
  const k3 = operationKey(['return', 'purchase-1', 1, 'employer', 'refund-3']);
  const third = await w.biz.refund(commit.reference!, k3, 'principal_only');
  assert.equal(third.status, 'rejected');
  assert.equal(third.reason, 'already_returned');
});

test('self_destination_legs_are_refused_at_validate', async () => {
  // A leg cannot pay its own provider's book or its own pseudonym: the
  // waterfall confirm needs a reachable destination provider, and a
  // bank transfer cannot move money from a book to itself.
  const w = providerWorld();
  const deSelf = deLeg({ destination: { dePseudonym: 'ps-emp' } });
  const resDe = await w.alice.reserve(deSelf, deEvidence(deSelf));
  assert.equal(resDe.status, 'rejected');
  assert.equal(resDe.reason, 'self_destination');
  assert.equal(w.alice.account('employee-1').bankDebits, 0);
  assert.equal(w.alice.account('employee-1').spendableCents, 100_000);

  const bankSelf = { ...bankLeg(), destination: { bankProvider: 'psp-biz' } };
  const resBank = await w.biz.reserve(bankSelf, deEvidence(bankSelf, 'mandate-1'));
  assert.equal(resBank.status, 'rejected');
  assert.equal(resBank.reason, 'self_destination');
  assert.equal(w.biz.account('employer-1').spendableCents, 50_000);
});

test('malformed_group_descriptor_rejects_reserve', async () => {
  // A bad group descriptor is a conclusive terms refusal at validation —
  // the reserve reports a rejected outcome, never a thrown crash and
  // never a bank debit for the refused leg.
  const w = providerWorld({ employeeDeCents: 2_000 });
  const bad = deLeg({ deGroup: { key: '', self: 'employee', members: ['employee'] } });
  const res = await w.alice.reserve(bad, deEvidence(bad));
  assert.equal(res.status, 'rejected');
  assert.equal(res.reason, 'group_membership_invalid');
  assert.equal(w.alice.account('employee-1').bankDebits, 0);
  assert.equal(w.de.holding('ps-emp').deCents, 2_000);
});

// Provider identity owns both conversions and hold cleanup. Valid external
// pseudonyms must never alias a conversion stage in the ledger's store.
for (const target of ['shop', 'fee'] as const) for (const deferred of [false, true]) {
  test(`hold release separates destination from conversion stage:${target}:${deferred}`, async () => {
    const fee = target === 'fee';
    const w = providerWorld({
      employeeDeCents: fee ? 825 : 0,
      shopPseudonym: fee ? 'ps-shop' : 'digital_euro',
      feePseudonym: fee ? 'digital_euro' : 'ps-fee-alice',
    });
    const leg = deLeg({ destination: { dePseudonym: fee ? 'ps-shop' : 'digital_euro' } });
    const before = totalMoney(w);
    const reserve = await w.alice.reserve(leg, deEvidence(leg));
    assert.equal(reserve.status, 'succeeded');
    let executionRef: string | undefined;
    const feeCommitKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit', 'fee']);
    if (fee) {
      w.alice.setFault(feeCommitKey, 'commit', 'reject_before_effect');
      const commit = await w.alice.commit(reserve.holdRef!);
      assert.equal(commit.status, 'succeeded');
      assert.equal(commit.feeChargedCents, 0);
      executionRef = commit.reference!;
    }
    const op = fee ? 'return' : 'release';
    const releaseKey = operationKey(['leg', 'purchase-1', 1, 'employee', op, 'hold', 'digital_euro']);
    if (deferred) w.alice.setFault(releaseKey, 'release', 'defer');
    const drive = () => fee
      ? w.alice.refund(executionRef!, 'collision-return', 'principal_only')
      : w.alice.release(reserve.holdRef!);
    let done = await drive();
    if (deferred) {
      assert.equal(done.status, 'pending');
      assert.equal(done.cleanupConfirmed, false);
      assert.equal(done.unresolved.some(child => child.key === releaseKey && child.status === 'pending'), true);
      assert.equal(w.de.holds().some(h => h.destination === 'digital_euro' && h.status === 'active'), true);
      assert.equal(totalMoney(w), before);
      assert.equal((await w.alice.status(done.key)).status, 'pending');
      w.de.resolveDeferred(releaseKey, 'succeed');
      done = await w.alice.status(done.key);
    }
    assert.equal(done.status, 'succeeded');
    assert.equal(done.cleanupConfirmed, true);
    assert.deepEqual(done.unresolved, []);
    assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
    assert.equal(w.alice.account('employee-1').bankDebits, fee ? 0 : 1);
    assert.equal(w.alice.poolCents, 100_000);
    assert.equal(w.alice.feesCents, 0);
    assert.equal(w.de.holding('ps-emp').deCents, fee ? 825 : 0);
    assert.equal(w.de.holding('ps-emp').heldCents, 0);
    assert.equal(w.shop.account().bankCents, 0);
    assert.equal(w.bank.transit().length, 0);
    assert.equal(w.de.transit().some(t => t.status === 'in_transit'), false);
    assert.equal(totalMoney(w), before);
    const conversionKey = operationKey(['leg', 'purchase-1', 1, 'employee', op, 'digital_euro']);
    const conversion = w.de.status(conversionKey);
    const released = w.de.status(releaseKey);
    assert.equal(conversion?.status, 'succeeded');
    assert.equal(released?.status, 'succeeded');
    const refusal = w.de.status(feeCommitKey);
    if (fee) assert.equal(refusal?.status, 'rejected');
    for (let replay = 0; replay < 2; replay++) {
      assert.deepEqual(await drive(), done);
      assert.deepEqual(await w.alice.status(done.key), done);
      const reserveReplay = await w.alice.reserve(leg, deEvidence(leg));
      assert.equal(reserveReplay.key, reserve.key);
      assert.equal(reserveReplay.status, reserve.status);
      assert.equal(reserveReplay.holdRef, reserve.holdRef);
      assert.equal(reserveReplay.expiresAt, reserve.expiresAt);
      assert.equal(totalMoney(w), before);
    }
    assert.deepEqual(w.de.status(conversionKey), conversion);
    assert.deepEqual(w.de.status(releaseKey), released);
    assert.deepEqual(w.de.status(feeCommitKey), refusal);
    assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
    assert.equal(w.de.holding('ps-emp').deCents, fee ? 825 : 0);
  });
}

test('uncharged_fee_hold_released_during_compensation', async () => {
  // The fee commit can be conclusively refused after the destination
  // settled — the fee is then uncharged but its hold is still active.
  // The return path must release that reservation so cleanup confirms
  // instead of leaking the hold until expiry.
  const w = providerWorld({ employeeDeCents: 2_000 });
  const leg = deLeg();
  const res = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(res.status, 'succeeded');
  const feeCommitKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit', 'fee']);
  w.alice.setFault(feeCommitKey, 'commit', 'reject_before_effect');

  const commit = await w.alice.commit(res.holdRef!);
  assert.equal(commit.status, 'succeeded');
  assert.equal(commit.committedCents, 800);
  assert.equal(commit.feeChargedCents, 0);
  assert.equal(w.alice.feesCents, 0);
  // The uncharged fee hold is still active — cleanup is not confirmed.
  const feeHold = w.de.holds().find((h) => h.destination === 'ps-fee-alice');
  assert.equal(feeHold?.status, 'active');
  assert.equal(commit.cleanupConfirmed, false);

  const ret = await w.alice.refund(
    commit.reference!,
    operationKey(['return', 'purchase-1', 1, 'employee', 'compensation']),
    'principal_and_fee',
  );
  assert.equal(ret.status, 'succeeded');
  assert.equal(ret.principalReturnedCents, 800);
  // No fee was ever charged, so nothing returns — but the hold released.
  assert.equal(ret.feeReturnedCents ?? 0, 0);
  assert.equal(w.de.holdAudit(feeHold!.holdRef).status, 'released');
  assert.equal(ret.cleanupConfirmed, true);
  assert.equal(w.shop.account().bankCents, 0);
  assert.equal(w.de.holding('ps-emp').deCents, 2_000);
});

// §6.1: physical money must remain located even while the caller cannot
// observe a conversion result. Entitlements/fees partition the pool.
for (const path of ['unwind', 'reserve-fund', 'return-fund', 'destination', 'fee-defund', 'reserve-excess', 'return-excess'] as const) {
  for (const fault of path === 'unwind' ? ['defer'] as const : ['lose_response_after_effect', 'defer'] as const) {
    test(`conversion conserves physical money before reconciliation:${path}:${fault}`, async () => {
      const reserve = path.startsWith('reserve') || path === 'unwind';
      const returning = path.startsWith('return');
      const excess = path.endsWith('excess');
      const w = providerWorld({
        employeeDeCents: path === 'reserve-fund' ? 0 : reserve ? 200 : 825,
        employeeDeLimitCents: excess ? (reserve ? 300 : 825) : undefined,
      });
      const leg = deLeg();
      const key = (op: string, stage: string) => operationKey(['leg', 'purchase-1', 1, 'employee', op, stage]);
      let holdRef: string | undefined;
      let executionRef: string | undefined;
      if (!reserve) {
        holdRef = (await w.alice.reserve(leg, deEvidence(leg))).holdRef!;
        if (returning) executionRef = (await w.alice.commit(holdRef)).reference!;
      }
      if (path === 'return-excess') {
        w.de.fund({ key: 'independent-credit', provider: 'psp-alice', pseudonym: 'ps-emp', amountCents: 825 });
      }
      const faultKey = path === 'unwind' ? key('defund', 'bank')
        : path === 'reserve-fund' ? key('fund', 'digital_euro')
        : path === 'return-fund' ? key('return', 'digital_euro')
        : path === 'reserve-excess' ? key('fund', 'defund')
        : path === 'return-excess' ? key('return', 'defund') : key('commit', path);
      if (path === 'unwind') w.alice.setFault(key('hold', 'ps-shop'), 'hold', 'reject_before_effect');
      w.alice.setFault(faultKey, path === 'unwind' ? 'bank_restore' : (path === 'reserve-fund' || path === 'return-fund') ? 'fund' : 'defund', fault);
      const before = totalMoney(w);
      const drive = () => reserve ? w.alice.reserve(leg, deEvidence(leg))
        : returning ? w.alice.refund(executionRef!, 'conversion-return', 'principal_only') : w.alice.commit(holdRef!);
      const first = await drive();
      assert.equal(first.status, fault === 'defer' ? 'pending' : 'unknown');
      assert.equal(totalMoney(w), before, 'pending/unknown conversion has a physical destination');
      if (path === 'unwind') assert.equal(w.alice.account('employee-1').spendableCents, 99_375);
      if (fault === 'defer') {
        // Resolve at the actual owner, with no caller drive in between.
        if (path === 'unwind') w.alice.resolveDeferred(faultKey, 'succeed');
        else w.de.resolveDeferred(faultKey, 'succeed');
        assert.equal(totalMoney(w), before, 'applied deferred effect is paired before caller resumes');
      }
      assert.equal(first.cleanupConfirmed, false);
      const done = await w.alice.status(first.key);
      assert.ok(done.status === 'succeeded' || done.status === 'rejected');
      assert.equal(totalMoney(w), before);
      const balances = [w.alice.poolCents, w.alice.account('employee-1'), w.alice.feesCents, w.shop.account(), w.de.holdings()];
      for (let replay = 0; replay < 2; replay++) {
        assert.deepEqual(await drive(), done);
        assert.deepEqual(await w.alice.status(first.key), done);
        assert.equal(totalMoney(w), before);
      }
      assert.deepEqual([w.alice.poolCents, w.alice.account('employee-1'), w.alice.feesCents, w.shop.account(), w.de.holdings()], balances);
      if (path === 'unwind' || path === 'reserve-excess') {
        assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
        assert.equal(done.cleanupConfirmed, true);
      }
    });
  }
}
