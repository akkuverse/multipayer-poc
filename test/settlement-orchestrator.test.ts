// The settlement orchestrator behind its three-operation interface (spec
// §4.5, §6, §7, §7.1): reserve every leg through its payer provider with a
// first-handoff authority recheck, commit bank legs in frozen proposal
// order then the digital-euro atomic group, complete only when every leg
// is confirmed settled, and compensate — never recover by new keys — when
// a conclusive failure follows committed money. Owning layer: the
// orchestrator; ledger and provider tests already prove their own
// invariants, so faults are injected at named operation stages and
// balances are asserted at the owning modules.
//
// The lunch: employee EUR 8 digital euro + employer EUR 5 bank — a
// cross-ledger purchase.

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
import { SettlementOrchestrator } from '../src/settlement/orchestrator.ts';
import type {
  AuthorityDecision,
  SettlementIntent,
  SettlementLeg,
  SettlementSnapshot,
} from '../src/settlement/types.ts';

// The provider world the orchestrator drives: the employee's provider
// owns a bank entitlement and pseudonym 'ps-emp', the employer's provider
// a bank-only customer, and one receive-only shop provider per payee —
// 'ps-shop' and optionally 'ps-shop2' for the multi-payee case, both at
// holding limit zero so every DE credit defunds to bank.
function providerWorld(opts?: { employeeDeCents?: number; secondShop?: boolean }) {
  const trace = new Trace();
  let t = 10;
  const de = new DigitalEuroLedger(() => t, trace);
  const bank = new InterbankTransfer(() => t, trace);
  const owners = new ProviderOwners();
  de.registerHolding({
    pseudonym: 'ps-emp',
    provider: 'psp-alice',
    holdingLimitCents: 300_000,
    deCents: opts?.employeeDeCents ?? 0,
  });
  de.registerHolding({ pseudonym: 'ps-fee-alice', provider: 'psp-alice', holdingLimitCents: 0 });
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
  const shops = new Map<string, ShopProvider>([['psp-shop', shop]]);
  let shop2: ShopProvider | undefined;
  if (opts?.secondShop === true) {
    de.registerHolding({ pseudonym: 'ps-shop2', provider: 'psp-shop2', holdingLimitCents: 0 });
    shop2 = new ShopProvider({
      provider: 'psp-shop2',
      payeeId: 'merchant-2',
      dePseudonym: 'ps-shop2',
      bankCents: 0,
      now: () => t,
      trace,
      digitalEuro: de,
      interbank: bank,
    });
    shops.set('psp-shop2', shop2);
  }
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
    shop2,
    alice,
    biz,
    owners,
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
}

// EUR 8 digital euro + EUR 0.25 fee on the employee rail.
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

// EUR 5 bank + EUR 0.15 fee on the employer mandate rail.
function bankLeg(extra?: Partial<SettlementLeg>): SettlementLeg {
  return {
    purchaseId: 'purchase-1',
    proposalVersion: 1,
    role: 'employer',
    payerId: 'employer-1',
    payeeId: 'merchant-1',
    rail: 'bank',
    principalCents: 500,
    feeCents: 15,
    authority: 'employer_mandate',
    destination: { bankProvider: 'psp-shop' },
    ...extra,
  };
}

function lunchIntent(mode: SettlementIntent['mode'] = 'atomic'): SettlementIntent {
  return {
    purchaseRef: 'purchase-1',
    purchaseId: 'purchase-1',
    proposalVersion: 1,
    mode,
    legs: [deLeg(), bankLeg()],
    budgets: { benefit: { mandateRef: 'mandate-1', amountCents: 500 } },
  };
}

type World = ReturnType<typeof providerWorld>;

// The coordinator-owned first-handoff recheck, stubbed: every leg is
// accepted with evidence echoing its exact terms unless a per-role
// refusal is configured. A real coordinator verifies signed records here.
function orchestrator(w: World, refusals: Record<string, string> = {}) {
  const authorizeFirstHandoff = (leg: SettlementLeg): AuthorityDecision => {
    const reason = refusals[leg.role];
    if (reason !== undefined) return { accepted: false, reason };
    return {
      accepted: true,
      evidence: {
        purchaseId: leg.purchaseId,
        proposalVersion: leg.proposalVersion,
        role: leg.role,
        payerId: leg.payerId,
        rail: leg.rail,
        principalCents: leg.principalCents,
        feeCents: leg.feeCents,
        authority: leg.authority,
        authorityRef: leg.authority === 'employer_mandate' ? 'mandate-1' : 'approval-1',
      },
    };
  };
  return new SettlementOrchestrator({
    providers: new Map<string, PayerProvider>([
      ['employee-1', w.alice],
      ['employer-1', w.biz],
    ]),
    owners: w.owners,
    commitDeGroup: commitAcceptedDigitalEuroGroup,
    digitalEuro: w.de,
    now: w.now,
    trace: w.trace,
    authorizeFirstHandoff,
  });
}

function leg(snap: SettlementSnapshot, role: string) {
  const l = snap.legs.find((x) => x.role === role);
  assert.ok(l !== undefined, `leg ${role} present in snapshot`);
  return l;
}

test('reserve_timeout_does_not_reject', async () => {
  // A parked bank hold is never a refusal: the reserve stays unresolved,
  // the other leg still reserves, and reconciliation under the original
  // key completes the purchase — no rejection, no new operation identity.
  const w = providerWorld();
  const orch = orchestrator(w);
  const holdKey = operationKey(['leg', 'purchase-1', 1, 'employer', 'hold', 'bank']);
  w.biz.setFault(holdKey, 'hold', 'defer');

  const s1 = await orch.submit(lunchIntent());
  assert.equal(s1.phase, 'reserving');
  const employer1 = leg(s1, 'employer');
  assert.equal(employer1.reserve?.status, 'pending');
  assert.equal(employer1.refusal, undefined);
  assert.equal(s1.unresolved.some((op) => op.key === holdKey), true);
  // The independent DE leg reserved while the employer reserve was open.
  assert.equal(leg(s1, 'employee').reserve?.status, 'succeeded');
  assert.equal(s1.committedCents, 0);
  assert.equal(w.shop.account().bankCents, 0);

  // The parked work resolves only through explicit simulation control;
  // reconcile() resumes every unresolved operation by its original key.
  w.biz.resolveDeferred(holdKey, 'succeed');
  const s2 = await orch.reconcile('purchase-1');
  assert.equal(s2.phase, 'settled');
  assert.equal(s2.unresolved.length, 0);
  assert.equal(s2.settledCents, 1_300);
  assert.equal(w.shop.account().bankCents, 1_300);
  // One funding debit, one hold, one transfer — the timeout never caused
  // a repeated operation.
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
  assert.equal(w.bank.transfers().length, 1);
});

test('bank_first_then_de_group', async () => {
  // Commit order is observable in evidence: the employer's bank transfer
  // is credited before the digital-euro group commits — separate commits,
  // no cross-ledger atomicity.
  const w = providerWorld();
  const orch = orchestrator(w);

  const s = await orch.submit(lunchIntent());
  assert.equal(s.phase, 'settled');
  assert.equal(s.settledCents, 1_300);
  assert.equal(w.shop.account().bankCents, 1_300);
  assert.equal(w.alice.feesCents, 25);
  assert.equal(w.biz.feesCents, 15);

  const credited = w.trace.events.findIndex((e) => e.event === 'bank_transfer_credited');
  const groupCommitted = w.trace.events.findIndex((e) => e.event === 'de_group_committed');
  assert.ok(credited !== -1, 'a bank credit happened');
  assert.ok(groupCommitted !== -1, 'the DE group committed');
  assert.ok(credited < groupCommitted, 'bank leg committed before the DE group');

  // The frozen group key binds the ordered member leg list; the DE leg is
  // distinguishable as committed-with-destination-credit-confirmed.
  assert.equal(s.group?.key, operationKey(['de-group', 'purchase-1', 1, 'commit', 'employee']));
  const employee = leg(s, 'employee');
  assert.equal(employee.settled, true);
  assert.equal(employee.destinationCreditConfirmed, true);
  assert.equal(employee.committedCents, 800);
  assert.equal(leg(s, 'employer').settled, true);
  assert.equal(s.cleanupConfirmed, true);
  assert.equal(s.exposureCents, 0);
});

test('de_group_commit_log_shows_provider_mediation', async () => {
  // The group path reads orchestrator → providers → ledger: the
  // orchestrator's request addresses the owning providers collectively,
  // each provider's vouch is logged and answered, and the providers send
  // the one ledger commit — never an orchestrator→ledger call.
  const w = providerWorld();
  const orch = orchestrator(w);
  const s = await orch.submit(lunchIntent());
  assert.equal(s.phase, 'settled');
  const events = w.trace.events;
  const groupKey = operationKey(['de-group', 'purchase-1', 1, 'commit', 'employee']);

  const req = events.find((e) => e.event === 'de_group_commit_requested')!;
  assert.equal(req.actor, 'orchestrator');
  assert.equal(req.detail?.to, 'de-providers');
  assert.equal(req.detail?.key, groupKey);
  assert.equal(req.detail?.parent, 'purchase-1');
  assert.deepEqual(req.detail?.members, [{ role: 'employee', payerId: 'employee-1', provider: 'psp-alice' }]);

  const vouchReq = events.find((e) => e.event === 'de_group_vouch_requested')!;
  assert.equal(vouchReq.actor, 'orchestrator');
  assert.equal(vouchReq.detail?.to, 'psp-alice');
  assert.equal(vouchReq.detail?.parent, groupKey);
  const vouched = events.find((e) => e.event === 'de_group_vouched')!;
  assert.equal(vouched.actor, 'psp-alice');
  assert.equal(vouched.detail?.provider, 'psp-alice');
  assert.equal(vouched.detail?.holdRef, vouchReq.detail?.key);

  const ledgerReq = events.find((e) => e.event === 'de_group_ledger_commit_requested')!;
  assert.equal(ledgerReq.actor, 'de-providers');
  assert.equal(ledgerReq.detail?.to, 'de-ledger');
  assert.equal(ledgerReq.detail?.key, groupKey);
  assert.equal(ledgerReq.detail?.parent, groupKey);
  assert.deepEqual(ledgerReq.detail?.members, [{ provider: 'psp-alice', holdRef: vouchReq.detail?.key }]);

  const committed = events.find((e) => e.event === 'de_group_committed')!;
  assert.ok(req.seq < vouchReq.seq);
  assert.ok(vouchReq.seq < vouched.seq);
  assert.ok(vouched.seq < ledgerReq.seq);
  assert.ok(ledgerReq.seq < committed.seq);

  // The member's own commit is the provider's fee/waterfall bookkeeping —
  // the group already moved its money. The bank leg's is a real commit.
  const memberCommit = events.find((e) => e.event === 'commit_requested' && e.detail?.role === 'employee')!;
  assert.equal(memberCommit.detail?.bookkeeping, true);
  const bankCommit = events.find((e) => e.event === 'commit_requested' && e.detail?.role === 'employer')!;
  assert.equal(bankCommit.detail?.bookkeeping, undefined);

  // The orchestrator never names the digital-euro ledger as a receiver.
  assert.ok(!events.some((e) => e.event.endsWith('_requested') && e.actor === 'orchestrator' && e.detail?.to === 'de-ledger'));
});

test('de_group_retry_repeats_every_hop_at_a_higher_attempt', async () => {
  // A lost group response leaves the operation 'unknown': reconcile
  // re-dispatches the whole provider-mediated path under the original keys —
  // commit request, vouch and ledger request each at a higher attempt,
  // while the ledger's deduped commit is never repeated.
  const w = providerWorld();
  const orch = orchestrator(w);
  const groupKey = operationKey(['de-group', 'purchase-1', 1, 'commit', 'employee']);
  w.de.setFault(groupKey, 'commit', 'lose_response_after_effect');

  const s1 = await orch.submit(lunchIntent());
  assert.equal(s1.group?.status, 'unknown');
  assert.equal(s1.phase, 'committing');

  const s2 = await orch.reconcile('purchase-1');
  assert.equal(s2.phase, 'settled');
  const events = w.trace.events;
  const attempts = (event: string) =>
    events.filter((e) => e.event === event && e.detail?.key !== undefined).map((e) => e.detail?.attempt);
  assert.deepEqual(attempts('de_group_commit_requested'), [1, 2]);
  const holdRef = events.find((e) => e.event === 'de_group_vouched')!.detail?.holdRef;
  assert.deepEqual(
    events.filter((e) => e.event === 'de_group_vouch_requested' && e.detail?.key === holdRef).map((e) => e.detail?.attempt),
    [1, 2],
  );
  assert.deepEqual(attempts('de_group_ledger_commit_requested'), [1, 2]);
  // The ledger committed once; the replay resolved the recorded outcome.
  assert.equal(events.filter((e) => e.event === 'de_group_committed').length, 1);
  assert.equal(w.de.holdAudit(holdRef as string).status, 'committed');
});

test('bank_settled_de_rejected_compensates', async () => {
  // The bank leg commits, then the DE group is conclusively refused:
  // the orchestrator stops commits, releases the uncommitted DE holds,
  // unwinds the employee's funding and returns the employer's confirmed
  // settlement — principal and charged fee — under the original keys.
  const w = providerWorld();
  const orch = orchestrator(w);
  const groupKey = operationKey(['de-group', 'purchase-1', 1, 'commit', 'employee']);
  w.de.setFault(groupKey, 'commit', 'reject_before_effect');

  const s = await orch.submit(lunchIntent());
  assert.equal(s.phase, 'compensated');
  assert.equal(s.exposureCents, 0);
  assert.equal(s.retainedFeeCents, 0);
  assert.equal(s.cleanupConfirmed, true);

  const employer = leg(s, 'employer');
  assert.equal(employer.commit?.status, 'succeeded');
  assert.equal(employer.returned?.status, 'succeeded');
  assert.equal(employer.returned?.key, operationKey(['return', 'purchase-1', 1, 'employer', 'compensation']));
  assert.equal(employer.principalReturnedCents, 500);
  assert.equal(employer.feeReturnedCents, 15);

  // Money truth: the shop keeps nothing, the employer is whole again.
  assert.equal(w.shop.account().bankCents, 0);
  assert.equal(w.biz.account('employer-1').spendableCents, 50_000);
  assert.equal(w.biz.feesCents, 0);
  // The DE side unwound completely: holds released, the intent's funding
  // defunded and the bank debit restored — exactly one debit ever.
  assert.equal(w.de.holds().filter((h) => h.status === 'active').length, 0);
  assert.equal(w.de.holding('ps-emp').deCents, 0);
  assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
  assert.equal(leg(s, 'employee').commit, undefined);

  // The refusal record names the provider and the reason: the member's
  // vouch succeeded, the providers' ledger request went out, and the
  // ledger's rejection pairs with that request — the orchestrator's own
  // request was only to the providers.
  const events = w.trace.events;
  const vouched = events.find((e) => e.event === 'de_group_vouched')!;
  assert.equal(vouched.detail?.provider, 'psp-alice');
  const ledgerReq = events.find((e) => e.event === 'de_group_ledger_commit_requested' && e.detail?.key === groupKey)!;
  const rejected = events.find((e) => e.event === 'de_op_rejected' && e.detail?.key === groupKey)!;
  assert.ok(ledgerReq.seq < rejected.seq);
  const groupOutcome = events.find((e) => e.event === 'de_group' && e.detail?.key === groupKey)!;
  assert.equal(groupOutcome.detail?.status, 'rejected');
  const members = groupOutcome.detail?.members as { provider: string; status: string; reason: string }[];
  assert.deepEqual(
    members.map((m) => `${m.provider}:${m.status}:${m.reason}`),
    ['psp-alice:rejected:commit_rejected'],
  );
});

test('unknown_commit_is_resolved_before_return', async () => {
  // A bank transfer whose credit response is parked stays pending: the
  // orchestrator stops dependent work, a return request resolves the
  // original operation's status first and issues nothing against the
  // unresolved commit — only after authoritative success does the return
  // proceed, principal-only under its own stable key.
  const w = providerWorld();
  const orch = orchestrator(w);
  const payKey = operationKey(['leg', 'purchase-1', 1, 'employer', 'pay', 'psp-shop']);
  w.biz.setFault(payKey, 'credit', 'defer');

  const s1 = await orch.submit(lunchIntent());
  assert.equal(s1.phase, 'committing');
  assert.equal(leg(s1, 'employer').commit?.status, 'pending');
  assert.equal(s1.unresolved.some((op) => op.key === payKey), true);
  // The bank debit already sits in tracked transit; the DE group was not
  // handed off while a required operation was unresolved.
  assert.equal(w.bank.transferAudit(payKey)?.debited, true);
  assert.equal(w.de.holds().filter((h) => h.status === 'committed').length, 0);
  assert.equal(w.shop.account().bankCents, 0);

  // Never race a return against the unresolved original operation.
  const s2 = await orch.returnSettled('purchase-1', { reason: 'refund', legs: ['employer'] });
  assert.equal(s2.phase, 'committing');
  assert.equal(leg(s2, 'employer').returned, undefined);
  assert.equal(w.shop.account().bankCents, 0);

  w.biz.resolveDeferred(payKey, 'succeed');
  const s3 = await orch.reconcile('purchase-1');
  assert.equal(s3.phase, 'settled');
  assert.equal(w.shop.account().bankCents, 1_300);

  const s4 = await orch.returnSettled('purchase-1', { reason: 'refund', legs: ['employer'] });
  assert.equal(s4.phase, 'settled');
  const employer4 = leg(s4, 'employer');
  assert.equal(employer4.returned?.status, 'succeeded');
  assert.equal(employer4.returned?.key, operationKey(['return', 'purchase-1', 1, 'employer', 'refund']));
  // Ordinary refund: principal only — the charged fee stays retained
  // and visible.
  assert.equal(employer4.principalReturnedCents, 500);
  assert.equal(employer4.feeReturnedCents ?? 0, 0);
  assert.equal(s4.retainedFeeCents, 15);
  assert.equal(w.biz.feesCents, 15);
  assert.equal(w.biz.account('employer-1').spendableCents, 50_000 - 15);
  assert.equal(w.shop.account().bankCents, 800);
  // Exactly the two original transfers ever ran — pay and its return.
  assert.equal(w.bank.transfers().length, 2);
});

for (const restoration of ['confirmed', 'rejected'] as const) test(`unsupported_return_keeps_exposure:${restoration}`, async () => {
  // A provider that conclusively refuses support for returns turns the
  // required compensation into visible, recoverable exposure — never a
  // terminal 'compensated' beside unrestored money.
  const w = providerWorld({ employeeDeCents: 300 });
  const restoreKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'release', 'bank']);
  if (restoration === 'rejected') w.alice.setFault(restoreKey, 'bank_restore', 'reject_before_effect');
  w.biz.returnsSupported = false;
  const orch = orchestrator(w);
  const groupKey = operationKey(['de-group', 'purchase-1', 1, 'commit', 'employee']);
  w.de.setFault(groupKey, 'commit', 'reject_before_effect');

  const s = await orch.submit(lunchIntent());
  assert.equal(s.phase, 'recovery_required');
  const employer = leg(s, 'employer');
  assert.equal(employer.returned?.status, 'rejected');
  assert.equal(employer.returned?.reason, 'unsupported');
  // Committed principal and the charged fee remain unreturned exposure.
  assert.equal(s.exposureCents, 500 + 15);
  assert.equal(s.retainedFeeCents, 15);
  assert.equal(s.cleanupConfirmed, false);
  assert.equal(w.shop.account().bankCents, 500);
  // Principal defunding can complete while customer entitlement restoration
  // is conclusively refused; no open operation is needed to retain cleanup.
  assert.equal(w.alice.account('employee-1').spendableCents, restoration === 'confirmed' ? 100_000 : 99_475);

  // The exposure is recoverable: once returns are supported, an explicit
  // recovery scope restores the principal under its own reason's key and
  // retains the fee by policy.
  w.biz.returnsSupported = true;
  const s2 = await orch.returnSettled('purchase-1', { reason: 'recovery', legs: ['employer'] });
  const employer2 = leg(s2, 'employer');
  assert.equal(employer2.returned?.status, 'succeeded');
  assert.equal(employer2.returned?.key, operationKey(['return', 'purchase-1', 1, 'employer', 'recovery']));
  assert.equal(employer2.principalReturnedCents, 500);
  assert.equal(employer2.feeReturnedCents ?? 0, 0);
  assert.equal(s2.phase, restoration === 'confirmed' ? 'recovered' : 'recovery_required');
  assert.equal(s2.cleanupConfirmed, restoration === 'confirmed');
  assert.deepEqual(s2.unresolved, []);
  assert.equal(s2.retainedFeeCents, 15);
  assert.equal(s2.exposureCents, 15);
  assert.equal(w.shop.account().bankCents, 0);
  assert.equal(w.biz.account('employer-1').spendableCents, 50_000 - 15);
  if (restoration === 'rejected') {
    const refusal = await w.alice.status(restoreKey);
    assert.equal(refusal.status, 'rejected');
    for (let replay = 0; replay < 2; replay++) {
      assert.deepEqual(await orch.reconcile('purchase-1'), s2);
      assert.deepEqual(await orch.returnSettled('purchase-1', { reason: 'recovery', legs: ['employer'] }), s2);
    }
    assert.deepEqual(await w.alice.status(restoreKey), refusal);
    assert.equal(w.alice.account('employee-1').spendableCents, 99_475);
    assert.equal(w.alice.poolCents, 100_000);
    assert.equal(w.biz.feesCents, 15);
  }
});

test('same_payer_multi_payee_has_distinct_operations', async () => {
  // One payer paying two payees in one intent: every leg keeps its own
  // role identity, hold and operation keys — nothing aliases across
  // payees — while both DE legs still commit inside the one atomic group.
  const w = providerWorld({ secondShop: true });
  const orch = orchestrator(w);
  const intent: SettlementIntent = {
    purchaseRef: 'purchase-2',
    purchaseId: 'purchase-2',
    proposalVersion: 1,
    mode: 'atomic',
    legs: [
      deLeg({ purchaseId: 'purchase-2' }),
      deLeg({
        purchaseId: 'purchase-2',
        role: 'dessert',
        payeeId: 'merchant-2',
        principalCents: 300,
        feeCents: 0,
        destination: { dePseudonym: 'ps-shop2' },
      }),
    ],
  };

  const s = await orch.submit(intent);
  assert.equal(s.phase, 'settled');
  const main = leg(s, 'employee');
  const dessert = leg(s, 'dessert');
  assert.notEqual(main.reserve?.key, dessert.reserve?.key);
  assert.notEqual(main.commit?.key, dessert.commit?.key);
  assert.notEqual(main.hold?.holdRef, dessert.hold?.holdRef);
  // The group committed both members in one step under their own member
  // identities.
  assert.equal(s.group?.members.length, 2);
  assert.deepEqual(
    s.group?.members.map((m) => m.leg),
    ['employee', 'dessert'],
  );
  // Each payee received only its own leg's money; the payer funded each
  // leg through its own distinct child operation.
  assert.equal(w.shop.account().bankCents, 800);
  assert.equal(w.shop2!.account().bankCents, 300);
  assert.equal(w.alice.account('employee-1').bankDebits, 2);
  assert.equal(w.alice.feesCents, 25);

  // Two DE members on one owning provider: one vouch request per member
  // answered before the providers' single ledger commit naming both holds.
  const groupKey = operationKey(['de-group', 'purchase-2', 1, 'commit', 'employee', 'dessert']);
  const vouchReqs = w.trace.events.filter((e) => e.event === 'de_group_vouch_requested' && e.detail?.parent === groupKey);
  assert.equal(vouchReqs.length, 2);
  assert.ok(vouchReqs.every((e) => e.actor === 'orchestrator' && e.detail?.to === 'psp-alice'));
  const ledgerReq = w.trace.events.find((e) => e.event === 'de_group_ledger_commit_requested' && e.detail?.key === groupKey)!;
  assert.equal(ledgerReq.actor, 'de-providers');
  assert.deepEqual(
    (ledgerReq.detail?.members as { provider: string }[]).map((m) => m.provider),
    ['psp-alice', 'psp-alice'],
  );
  for (const r of vouchReqs) {
    const vouched = w.trace.events.find((e) => e.event === 'de_group_vouched' && e.detail?.key === r.detail?.key)!;
    assert.equal(vouched.actor, 'psp-alice');
    assert.ok(r.seq < vouched.seq && vouched.seq < ledgerReq.seq);
  }
});

test('independent_keeps_successful_leg', async () => {
  // Independent mode reserves and commits each leg separately: the
  // employee leg's first-handoff refusal stops only that leg — the
  // employer leg settles and is kept, and the partial payment stays
  // visible for the explicit recovery path rather than auto-compensating.
  const w = providerWorld();
  const orch = orchestrator(w, { employee: 'approval_revoked' });

  const s = await orch.submit(lunchIntent('independent'));
  assert.equal(s.phase, 'recovery_required');
  const employee = leg(s, 'employee');
  assert.equal(employee.refusal, 'approval_revoked');
  assert.equal(employee.reserve, undefined);
  // The refused leg was never handed off — no funding debit happened.
  assert.equal(w.alice.account('employee-1').bankDebits, 0);
  const employer = leg(s, 'employer');
  assert.equal(employer.settled, true);
  assert.equal(employer.returned, undefined);
  assert.equal(w.shop.account().bankCents, 500);
  // The kept settlement is confirmed committed exposure the caller may
  // recover explicitly.
  assert.equal(s.exposureCents, 500 + 15);

  const s2 = await orch.returnSettled('purchase-1', { reason: 'recovery', legs: ['employer'] });
  assert.equal(s2.phase, 'recovered');
  const employer2 = leg(s2, 'employer');
  assert.equal(employer2.principalReturnedCents, 500);
  assert.equal(employer2.feeReturnedCents ?? 0, 0);
  assert.equal(s2.retainedFeeCents, 15);
  assert.equal(w.shop.account().bankCents, 0);
});

test('uncertain_status_call_converges_and_clears', async () => {
  // A provider status call that throws mid-drive loses the commit key;
  // the recorded 'unknown' placeholder keeps the operation resolvable so
  // that once status answers again the lost marker clears — unresolved
  // drains and cleanup confirms instead of poisoning the snapshot.
  const w = providerWorld();
  const orch = orchestrator(w);
  const commitKey = operationKey(['leg', 'purchase-1', 1, 'employer', 'commit']);
  const orig = w.biz.status.bind(w.biz);
  let fail = true;
  w.biz.status = (key: string) =>
    fail && key === commitKey ? Promise.reject(new Error('status_lost')) : orig(key);

  const s1 = await orch.submit(lunchIntent());
  assert.equal(s1.phase, 'committing');
  assert.equal(leg(s1, 'employer').commit?.status, 'unknown');
  assert.equal(s1.unresolved.some((op) => op.key === commitKey), true);
  assert.equal(s1.cleanupConfirmed, false);

  fail = false;
  const s2 = await orch.reconcile('purchase-1');
  assert.equal(s2.phase, 'settled');
  assert.equal(s2.unresolved.length, 0);
  assert.equal(s2.cleanupConfirmed, true);
  assert.equal(w.shop.account().bankCents, 1_300);
  assert.equal(w.bank.transfers().length, 1);
});

test('lost_release_status_clears_after_reconcile', async () => {
  // Same lost-call path on a release: an abort releases the DE holds, a
  // thrown status call on the release key must leave a recorded open
  // outcome — not an orphaned lost marker — so the next reconcile
  // converges it and cleanup confirms.
  const w = providerWorld();
  const orch = orchestrator(w, { employer: 'mandate_revoked' });
  const releaseKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'release']);
  const orig = w.alice.status.bind(w.alice);
  let fail = true;
  w.alice.status = (key: string) =>
    fail && key === releaseKey ? Promise.reject(new Error('status_lost')) : orig(key);

  const s1 = await orch.submit(lunchIntent());
  assert.equal(s1.phase, 'unwinding');
  assert.equal(leg(s1, 'employee').release?.status, 'unknown');
  assert.equal(s1.unresolved.some((op) => op.key === releaseKey), true);
  assert.equal(s1.cleanupConfirmed, false);

  fail = false;
  const s2 = await orch.reconcile('purchase-1');
  assert.equal(leg(s2, 'employee').release?.status, 'succeeded');
  assert.equal(s2.unresolved.length, 0);
  assert.equal(s2.cleanupConfirmed, true);
  assert.equal(s2.phase, 'failed');
  assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
  assert.equal(w.alice.account('employee-1').bankDebits, 1);
});

test('unavailable_reserve_retries_on_reconcile', async () => {
  // A provider that cannot be reached before any handoff never proves
  // failure: the reserve stays open 'pending' under its original key and
  // retries once the provider answers — no terminal refusal.
  const w = providerWorld();
  const orch = orchestrator(w);
  w.biz.available = false;

  const s1 = await orch.submit(lunchIntent());
  const employer1 = leg(s1, 'employer');
  assert.equal(employer1.reserve?.status, 'pending');
  assert.equal(employer1.refusal, undefined);
  assert.equal(s1.phase, 'reserving');
  // The reachable employee leg still reserved.
  assert.equal(leg(s1, 'employee').reserve?.status, 'succeeded');
  assert.equal(w.biz.account('employer-1').spendableCents, 50_000);

  w.biz.available = true;
  const s2 = await orch.reconcile('purchase-1');
  assert.equal(s2.phase, 'settled');
  assert.equal(s2.unresolved.length, 0);
  assert.equal(s2.cleanupConfirmed, true);
  assert.equal(w.shop.account().bankCents, 1_300);
});

test('leg_identity_collision_across_purchase_refs_refused', async () => {
  // Provider operation keys bind (purchaseId, proposalVersion, role), not
  // purchaseRef: a second intent reusing the same leg identity under a
  // different purchaseRef would silently adopt the first world's
  // recorded outcomes — a conclusive pre-handoff refusal instead.
  const w = providerWorld();
  const orch = orchestrator(w);
  const s1 = await orch.submit(lunchIntent());
  assert.equal(s1.phase, 'settled');

  const aliasing = lunchIntent();
  aliasing.purchaseRef = 'purchase-2'; // same purchaseId, version and roles
  await assert.rejects(orch.submit(aliasing), /leg_identity_conflict/);
});

test('de_group_on_bank_leg_refused_pre_handoff', async () => {
  // A caller-supplied group descriptor on a non-DE leg is refused at
  // freeze — the prescribed pre-handoff refusal, not a provider
  // rejection discovered mid-drive.
  const w = providerWorld();
  const orch = orchestrator(w);
  const bad = lunchIntent();
  bad.legs[1] = bankLeg({ deGroup: { key: 'g', self: 'employer', members: ['employer'] } });
  await assert.rejects(orch.submit(bad), /group_on_bank_rail/);
});

test('independent_leg_cleanup_reports_unwinding', async () => {
  // Independent mode never compensates: a failed leg's open release
  // beside a committed sibling is cleanup — 'unwinding', never
  // 'compensating'.
  const w = providerWorld();
  const orch = orchestrator(w);
  const payKey = operationKey(['leg', 'purchase-1', 1, 'employer', 'pay', 'psp-shop']);
  const releaseKey = operationKey(['leg', 'purchase-1', 1, 'employer', 'release', 'bank']);
  w.biz.setFault(payKey, 'credit', 'reject_before_effect');
  w.biz.setFault(releaseKey, 'release', 'defer');

  const s1 = await orch.submit(lunchIntent('independent'));
  const employer1 = leg(s1, 'employer');
  assert.equal(employer1.commit?.status, 'rejected');
  assert.equal(employer1.release?.status, 'pending');
  assert.equal(leg(s1, 'employee').settled, true);
  assert.equal(s1.phase, 'unwinding');

  w.biz.resolveDeferred(releaseKey, 'succeed');
  const s2 = await orch.reconcile('purchase-1');
  assert.equal(leg(s2, 'employer').release?.status, 'succeeded');
  // The committed employee leg is never auto-compensated: it stays
  // recoverable exposure under the explicit recovery path.
  assert.equal(s2.phase, 'recovery_required');
});

test('overlapping_drive_is_refused', async () => {
  // Every await inside a drive is an interleaving point: a second public
  // call joining while the first is suspended is refused, never raced.
  const w = providerWorld();
  const orch = orchestrator(w);
  const pending = orch.submit(lunchIntent());
  await assert.rejects(orch.reconcile('purchase-1'), /drive_in_progress/);
  const s = await pending;
  assert.equal(s.phase, 'settled');
  assert.equal(s.cleanupConfirmed, true);
});

test('unresolved_snapshot_terms_are_detached', async () => {
  // Records inside snapshot.unresolved are detached: mutating reported
  // terms cannot reach the retained working truth.
  const w = providerWorld();
  const orch = orchestrator(w);
  const holdKey = operationKey(['leg', 'purchase-1', 1, 'employer', 'hold', 'bank']);
  w.biz.setFault(holdKey, 'hold', 'defer');

  const s1 = await orch.submit(lunchIntent());
  const rec = s1.unresolved.find((op) => op.key === holdKey);
  assert.ok(rec !== undefined);
  assert.ok(rec.terms !== undefined);
  (rec.terms as Record<string, unknown>).mutated = true;

  const s2 = await orch.reconcile('purchase-1');
  const again = s2.unresolved.find((op) => op.key === holdKey);
  assert.ok(again !== undefined);
  assert.equal((again.terms as Record<string, unknown>).mutated, undefined);
});

for (const stage of ['destination', 'fee-defund'] as const) {
  test(`rejected ${stage} cancels uncredited transit and compensates original money once`, async () => {
    const w = providerWorld({ employeeDeCents: 825 });
    const orch = orchestrator(w);
    const key = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit', stage]);
    w.alice.setFault(key, 'defund', 'reject_before_effect');
    const restore = operationKey(['leg', 'purchase-1', 1, 'employee', 'return', 'digital_euro']);
    w.alice.setFault(restore, 'fund', 'defer');
    const first = await orch.submit(lunchIntent());
    assert.equal(leg(first, 'employee').commit?.status, 'rejected');
    assert.ok(first.exposureCents > 0);
    assert.equal(first.cleanupConfirmed, false);
    w.alice.resolveDeferred(restore, 'succeed');
    const done = await orch.reconcile('purchase-1');
    assert.equal(done.phase, 'compensated');
    assert.equal(done.cleanupConfirmed, true);
    assert.equal(done.exposureCents, 0);
    assert.equal(w.shop.account().bankCents, 0);
    assert.equal(w.de.holding('ps-emp').spendableCents, 825);
    assert.equal(w.alice.feesCents, 0);
    assert.equal(w.alice.poolCents, 100_000);
    assert.equal(w.alice.account('employee-1').spendableCents, 100_000);
    assert.equal(w.biz.feesCents, 0);
    assert.equal(w.biz.account('employer-1').spendableCents, 50_000);
    assert.equal(w.de.transit().filter(t => t.status === 'in_transit').length, 0);
    if (stage === 'destination') {
      assert.equal(w.bank.transfers().filter(t => t.amountCents === 800).length, 0);
    }
    const balances = [w.alice.account('employee-1'), w.biz.account('employer-1'), w.de.holding('ps-emp')];
    await orch.submit(lunchIntent());
    await orch.reconcile('purchase-1');
    assert.deepEqual([w.alice.account('employee-1'), w.biz.account('employer-1'), w.de.holding('ps-emp')], balances);
    assert.equal((await w.alice.status(key)).status, 'rejected');
  });
}

for (const rail of ['bank', 'digital_euro'] as const) {
  for (const reason of ['refund', 'compensation'] as const) {
    test(`fee-only ${rail} supports ${reason} without zero money movements`, async () => {
      const w = providerWorld({ employeeDeCents: 25 });
      const orch = orchestrator(w);
      const intent = lunchIntent();
      intent.legs = [deLeg({ rail, principalCents: 0, destination: rail === 'bank' ? { bankProvider: 'psp-shop' } : { dePseudonym: 'ps-shop' } })];
      if (reason === 'compensation') {
        intent.legs.push(bankLeg());
        w.biz.setFault(operationKey(['leg', 'purchase-1', 1, 'employer', 'pay', 'psp-shop']), 'debit', 'reject_before_effect');
      }
      const settled = await orch.submit(intent);
      assert.equal(settled.phase, reason === 'refund' ? 'settled' : 'compensated');
      assert.equal(w.alice.feesCents, reason === 'refund' ? 25 : 0);
      await orch.submit(intent);
      assert.equal(w.alice.feesCents, reason === 'refund' ? 25 : 0);
      const returned = reason === 'refund'
        ? await orch.returnSettled('purchase-1', { reason, legs: ['employee'] })
        : await orch.reconcile('purchase-1');
      assert.equal(leg(returned, 'employee').returned?.status, 'succeeded');
      assert.equal(returned.cleanupConfirmed, true);
      assert.equal(w.alice.feesCents, reason === 'refund' ? 25 : 0);
      assert.equal(w.shop.account().bankCents, 0);
      assert.ok(w.bank.transfers().every(t => t.amountCents > 0));
    });
  }
}

for (const stage of ['destination', 'fee-defund'] as const) {
  test(`return waits for unresolved ${stage} before starting recovery`, async () => {
    const w = providerWorld({ employeeDeCents: 825 });
    const orch = orchestrator(w);
    const key = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit', stage]);
    w.alice.setFault(key, 'defund', 'defer');
    await orch.submit(lunchIntent());
    const waiting = await orch.returnSettled('purchase-1', { reason: 'refund', legs: ['employee'] });
    assert.equal(leg(waiting, 'employee').returned, undefined);
    assert.equal(w.shop.account().bankCents, stage === 'destination' ? 500 : 1_300);
    w.alice.resolveDeferred(key, 'succeed');
    const done = await orch.reconcile('purchase-1');
    assert.equal(leg(done, 'employee').returned?.status, 'succeeded');
    assert.equal(w.shop.account().bankCents, 500);
    assert.equal(w.alice.feesCents, 25);
  });
}
