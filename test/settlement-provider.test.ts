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
import { Trace } from '../src/evidence/trace.ts';
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
function providerWorld(opts?: { employeeDeCents?: number; employeeDeLimitCents?: number }) {
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
  de.registerHolding({ pseudonym: 'ps-fee-alice', provider: 'psp-alice', holdingLimitCents: 0 });
  de.registerHolding({ pseudonym: 'ps-bob', provider: 'psp-bob', holdingLimitCents: 300_000, deCents: 1_000 });
  de.registerHolding({ pseudonym: 'ps-fee-bob', provider: 'psp-bob', holdingLimitCents: 0 });
  de.registerHolding({ pseudonym: 'ps-shop', provider: 'psp-shop', holdingLimitCents: 0 });
  const shop = new ShopProvider({
    provider: 'psp-shop',
    payeeId: 'merchant-1',
    dePseudonym: 'ps-shop',
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
    feePseudonym: 'ps-fee-alice',
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
  // defund — no FEE_COLLECTOR.
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

test('compensation_returns_fee_once', async () => {
  // Digital-euro rail: automatic compensation restores principal and the
  // charged fee, exactly once, and the same execution can never be
  // returned twice under another return key (decision 9).
  const w = providerWorld({ employeeDeCents: 2_000 });
  const leg = deLeg();
  const res = await w.alice.reserve(leg, deEvidence(leg));
  const commit = await w.alice.commit(res.holdRef!);
  assert.equal(commit.status, 'succeeded');
  assert.equal(w.de.holding('ps-emp').deCents, 1_175);
  assert.equal(w.alice.feesCents, 25);
  assert.equal(w.shop.account().bankCents, 800);

  const returnKey = operationKey(['return', 'purchase-1', 1, 'employee', 'comp-1']);
  const ret = await w.alice.refund(commit.reference!, returnKey, 'principal_and_fee');
  assert.equal(ret.status, 'succeeded');
  assert.equal(ret.principalReturnedCents, 800);
  assert.equal(ret.feeReturnedCents, 25);
  // The shop's bank debit funds the interbank return to the provider's
  // book, which converts 825 back to the payer's digital euro.
  assert.equal(w.shop.account().bankCents, 0);
  assert.equal(w.de.holding('ps-emp').deCents, 2_000);
  assert.equal(w.alice.feesCents, 0);
  assert.equal(w.alice.poolCents, 100_000);
  assert.equal(w.bank.transit().length, 0);
  assert.equal(w.de.transit().filter((x) => x.status === 'in_transit').length, 0);

  // Idempotent replay under the same return key: same outcome, no second
  // movement.
  const again = await w.alice.refund(commit.reference!, returnKey, 'principal_and_fee');
  assert.equal(again.status, 'succeeded');
  assert.equal(again.principalReturnedCents, 800);
  assert.equal(w.de.holding('ps-emp').deCents, 2_000);
  assert.equal(w.shop.account().bankCents, 0);

  // A different return key on the same execution is refused — a second
  // return under a new key, reason or scope is never a fresh payment.
  const twice = await w.alice.refund(
    commit.reference!,
    operationKey(['return', 'purchase-1', 1, 'employee', 'comp-2']),
    'principal_and_fee',
  );
  assert.equal(twice.status, 'rejected');
  assert.equal(twice.reason, 'already_returned');
  assert.equal(w.de.holding('ps-emp').deCents, 2_000);
  assert.equal(w.shop.account().bankCents, 0);
  assert.equal(w.alice.feesCents, 0);
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

  const group = await commitAcceptedDigitalEuroGroup([holdA, holdB], w.owners);
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
  const again = await commitAcceptedDigitalEuroGroup([holdA, holdB], w.owners);
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

  const group = await commitAcceptedDigitalEuroGroup([holdA, holdB], w.owners);
  assert.equal(group.status, 'succeeded');

  // The holds expire at reserve + 0.5 simulated minutes; the commit is
  // already recorded — a later replay recovers the same outcome.
  w.set(20);
  const replayed = await commitAcceptedDigitalEuroGroup([holdA, holdB], w.owners);
  assert.equal(replayed.status, 'succeeded');
  assert.equal(replayed.key, groupKey);
  assert.equal(replayed.members.length, 2);
  assert.equal(w.de.holdAudit(ra.holdRef!).status, 'committed');

  // A foreign world's registry cannot resolve the owner token: owner ids
  // are scoped to the world that minted them.
  const w2 = providerWorld();
  const foreign = await commitAcceptedDigitalEuroGroup([holdA, holdB], w2.owners);
  assert.equal(foreign.status, 'rejected');
  assert.equal(foreign.reason, 'unknown_provider');
});

test('unwind_after_excess_defund_restores_only_credited_portion', async () => {
  // 200 pre-existing digital euro under a 300 holding limit: the 825 need
  // funds 625 from bank, of which only 100 becomes spendable digital euro —
  // the 525 excess returns to bank through defunding transit. When the
  // payment hold then fails, the unwind must defund only the credited 100,
  // never the 625 bank shortfall (spec §6.1 conservation).
  const w = providerWorld({ employeeDeCents: 200, employeeDeLimitCents: 300 });
  const leg = deLeg();
  const res = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(res.status, 'rejected');
  assert.equal(res.reason, 'hold_rejected:insufficient_funds');
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
  // transit: the commit must stay unresolved and must not book the paired
  // bank credit beside it — the fee is represented exactly once (§6.1).
  const w = providerWorld({ employeeDeCents: 2_000 });
  const leg = deLeg();
  const res = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(res.status, 'succeeded');
  const feeDefundKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit', 'fee-defund']);
  w.alice.setFault(feeDefundKey, 'defund', 'reject_before_effect');

  const commit = await w.alice.commit(res.holdRef!);
  assert.equal(commit.status, 'unknown');
  // The destination leg of settlement confirmed; only the fee is stuck.
  assert.equal(commit.committedCents, 800);
  assert.equal(commit.destinationCreditConfirmed, true);
  assert.equal(w.shop.account().bankCents, 800);
  // No fee revenue booked and no pool credit beside the stranded transit.
  assert.equal(commit.feeChargedCents ?? 0, 0);
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

test('unresolved_release_children_surface_in_outcome', async () => {
  // DE hold releases are keyed by destination pseudonym: a parked release
  // child must appear in ProviderOutcome.unresolved, not hide under a
  // destination name the key never used.
  const w = providerWorld({ employeeDeCents: 2_000 });
  const leg = deLeg();
  const res = await w.alice.reserve(leg, deEvidence(leg));
  assert.equal(res.status, 'succeeded');
  const releaseKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'release', 'ps-shop']);
  w.alice.setFault(releaseKey, 'release', 'defer');

  const outcome = await w.alice.release(res.holdRef!);
  assert.equal(outcome.status, 'pending');
  assert.equal(outcome.unresolved.some((op) => op.key === releaseKey), true);
  // The fee-hold release never ran: the second hold is still active.
  assert.equal(w.de.holdAudit(res.holdRef!).status, 'active');
});

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
