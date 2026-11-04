// Behaviour every settlement orchestrator must show for the coordinator's
// safety rules to hold (spec §6, §7, §7.1): the three-operation public
// interface driven over a synthetic cross-ledger intent — one digital-euro
// leg, one bank leg, one shop payee. The in-memory modules run it in
// test/settlement-orchestrator.contract.test.ts; a future private adapter
// may run the same contract against its environment under a versioned
// interface — compatibility is versioned, not assumed. A case whose fault
// control the fixture cannot provide is skipped and reads as 'not tested',
// never as a pass.
//
// The contract asserts per-leg evidence and money truth only: 'atomic' is
// reserve-all with compensation across ledgers, never a cross-ledger
// atomic settlement step, and no case may assume one exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  DeferredOutcome,
  SettlementIntent,
  SettlementLeg,
  SettlementMode,
  SettlementSnapshot,
} from '../../src/settlement/types.ts';
import type { SettlementOrchestrator } from '../../src/settlement/orchestrator.ts';

// Where a staged fault attaches (decision 12 of the settlement plan): the
// fixture maps each semantic target to its own modules' operation key and
// stage — the contract never parses keys for money semantics.
export type OrchestratorFaultTarget =
  // The leg's hold acceptance inside reserve.
  | { kind: 'leg'; leg: SettlementLeg; stage: 'hold' }
  // The leg's destination payment inside commit.
  | { kind: 'leg'; leg: SettlementLeg; stage: 'pay' }
  // The leg's hold release inside cleanup.
  | { kind: 'leg'; leg: SettlementLeg; stage: 'release' }
  // The frozen digital-euro group commit of the intent's DE legs.
  | { kind: 'group'; intent: SettlementIntent };

export interface OrchestratorAudit {
  // The shop's bank balance — what the payee was confirmed paid.
  shopBankCents: number;
  // Interbank transfers ever recorded: a lost response may never add one.
  bankTransfers: number;
  // The fixture clock's current simulated minute; holds expire at
  // reserve + 0.5.
  now: number;
}

export interface OrchestratorFixture {
  // The public orchestrator under test.
  orchestrator: SettlementOrchestrator;
  // A fresh synthetic intent with a unique purchaseRef per call: one leg
  // on the digital-euro rail and one on the bank rail, each with nonzero
  // principal and fee, paying the fixture's shop.
  intent(mode?: SettlementMode): SettlementIntent;
  // Detached audit reads the cases use as the money oracle — never
  // production aggregates.
  audit(): OrchestratorAudit;
  // Optional simulation controls. A case whose control is absent is
  // skipped as 'not tested', never counted as a pass.
  rejectBeforeEffect?(target: OrchestratorFaultTarget): void;
  loseResponseAfterEffect?(target: OrchestratorFaultTarget): void;
  defer?(target: OrchestratorFaultTarget): void;
  resolveDeferred?(target: OrchestratorFaultTarget, outcome: DeferredOutcome): void;
  setProviderAvailable?(payerId: string, available: boolean): void;
  setReturnsSupported?(payerId: string, supported: boolean): void;
  setNow?(now: number): void;
}

export function settlementOrchestratorContract(name: string, make: () => OrchestratorFixture): void {
  const needs = (control: keyof OrchestratorFixture): false | string =>
    make()[control] === undefined ? `fixture has no ${control} control` : false;
  const deLeg = (i: SettlementIntent): SettlementLeg => i.legs.find((l) => l.rail === 'digital_euro')!;
  const bankLeg = (i: SettlementIntent): SettlementLeg => i.legs.find((l) => l.rail === 'bank')!;
  const legOf = (s: SettlementSnapshot, role: string) => {
    const l = s.legs.find((x) => x.role === role);
    assert.ok(l !== undefined, `leg ${role} present in the snapshot`);
    return l;
  };
  const principal = (i: SettlementIntent): number => i.legs.reduce((s, l) => s + l.principalCents, 0);

  test(`${name}: submit reports a settled snapshot of the same intent`, async () => {
    const f = make();
    const intent = f.intent('atomic');
    const s = await f.orchestrator.submit(intent);
    // The snapshot echoes the admitted identity and terms.
    assert.equal(s.purchaseRef, intent.purchaseRef);
    assert.equal(s.purchaseId, intent.purchaseId);
    assert.equal(s.proposalVersion, intent.proposalVersion);
    assert.equal(s.mode, 'atomic');
    assert.equal(s.phase, 'settled');
    // Every leg settled only on confirmed destination credit — payment
    // committed is distinguished from destination credit complete.
    for (const l of s.legs) {
      assert.equal(l.settled, true, `leg ${l.role} confirmed settled`);
      assert.equal(l.reserve?.status, 'succeeded');
      assert.equal(l.commit?.status, 'succeeded');
      assert.equal(l.destinationCreditConfirmed, true);
      assert.equal(l.committedCents, intent.legs.find((x) => x.role === l.role)!.principalCents);
    }
    assert.equal(s.committedCents, principal(intent));
    assert.equal(s.settledCents, principal(intent));
    assert.equal(s.unresolved.length, 0);
    assert.equal(s.cleanupConfirmed, true);
    assert.equal(s.exposureCents, 0);
    assert.equal(f.audit().shopBankCents, principal(intent));
  });

  test(`${name}: a replay under the same purchaseRef returns the recorded intent`, async () => {
    const f = make();
    const intent = f.intent('atomic');
    const s1 = await f.orchestrator.submit(intent);
    const s2 = await f.orchestrator.submit(intent);
    // The frozen intent replays as itself: same snapshot, same operation
    // keys and references — and the money moved exactly once.
    assert.deepEqual(s2, s1);
    assert.equal(f.audit().shopBankCents, principal(intent));
    assert.equal(f.audit().bankTransfers, 1);
  });

  test(`${name}: changed terms under a recorded purchaseRef are a conclusive refusal`, async () => {
    const f = make();
    const intent = f.intent('atomic');
    await f.orchestrator.submit(intent);
    const changed = structuredClone(intent);
    changed.legs[0].principalCents += 1;
    await assert.rejects(() => f.orchestrator.submit(changed), /conflict/);
    // The recorded world is untouched by the refused replay.
    const s = await f.orchestrator.reconcile(intent.purchaseRef);
    assert.equal(s.phase, 'settled');
  });

  test(`${name}: a duplicated leg role is refused before any handoff`, async () => {
    const f = make();
    const intent = f.intent('atomic');
    intent.legs[1].role = intent.legs[0].role;
    await assert.rejects(() => f.orchestrator.submit(intent));
    // Nothing was admitted: the ref stays unknown and nothing settled.
    await assert.rejects(() => f.orchestrator.reconcile(intent.purchaseRef), /unknown_purchase/);
    assert.equal(f.audit().shopBankCents, 0);
  });

  test(`${name}: an unknown purchase is refused, never reported as a failure`, async () => {
    const f = make();
    await assert.rejects(() => f.orchestrator.reconcile('never-seen'), /unknown_purchase/);
    await assert.rejects(
      () => f.orchestrator.returnSettled('never-seen', { reason: 'refund', legs: ['de'] }),
      /unknown_purchase/,
    );
  });

  test(
    `${name}: one conclusively rejected leg unwinds the atomic intent with nothing committed`,
    { skip: needs('rejectBeforeEffect') },
    async () => {
      const f = make();
      const intent = f.intent('atomic');
      const bank = bankLeg(intent);
      f.rejectBeforeEffect!({ kind: 'leg', leg: bank, stage: 'hold' });
      const s = await f.orchestrator.submit(intent);
      assert.equal(s.phase, 'failed');
      assert.equal(legOf(s, bank.role).reserve?.status, 'rejected');
      // Reserve-all: the sibling's accepted hold released, never committed —
      // the snapshot shows cleanup confirmed beside zero committed money.
      const de = legOf(s, deLeg(intent).role);
      assert.equal(de.commit, undefined);
      assert.equal(de.committedCents ?? 0, 0);
      assert.equal(s.committedCents, 0);
      assert.equal(s.exposureCents, 0);
      assert.equal(s.cleanupConfirmed, true);
      assert.equal(f.audit().shopBankCents, 0);
    },
  );

  test(
    `${name}: a lost pay response stays unresolved until status reconciles the original key`,
    { skip: needs('loseResponseAfterEffect') },
    async () => {
      const f = make();
      const intent = f.intent('atomic');
      const bank = bankLeg(intent);
      f.loseResponseAfterEffect!({ kind: 'leg', leg: bank, stage: 'pay' });
      const s1 = await f.orchestrator.submit(intent);
      // A lost response is uncertainty, never failure: the leg stays open.
      assert.notEqual(s1.phase, 'failed');
      assert.notEqual(s1.phase, 'settled');
      const commit = legOf(s1, bank.role).commit;
      assert.ok(commit === undefined || commit.status === 'pending' || commit.status === 'unknown');
      assert.ok(s1.unresolved.length > 0, 'the lost operation is visible as unresolved');
      assert.equal(s1.cleanupConfirmed, false);
      const s2 = await f.orchestrator.reconcile(intent.purchaseRef);
      assert.equal(s2.phase, 'settled');
      assert.equal(s2.unresolved.length, 0);
      // The original operation applied exactly once — the replay paid once.
      assert.equal(f.audit().bankTransfers, 1);
      assert.equal(f.audit().shopBankCents, principal(intent));
    },
  );

  test(
    `${name}: a lost hold response is recovered under the original reserve key`,
    { skip: needs('loseResponseAfterEffect') },
    async () => {
      const f = make();
      const intent = f.intent('atomic');
      const de = deLeg(intent);
      f.loseResponseAfterEffect!({ kind: 'leg', leg: de, stage: 'hold' });
      const s1 = await f.orchestrator.submit(intent);
      assert.notEqual(s1.phase, 'failed');
      const s2 = await f.orchestrator.reconcile(intent.purchaseRef);
      assert.equal(s2.phase, 'settled');
      // One hold, one funding debit: the lost response never minted a twin.
      assert.equal(f.audit().shopBankCents, principal(intent));
      assert.equal(f.audit().bankTransfers, 1);
    },
  );

  test(
    `${name}: a deferred operation progresses only through explicit resolution`,
    { skip: needs('defer') || needs('resolveDeferred') },
    async () => {
      const f = make();
      const intent = f.intent('atomic');
      const bank = bankLeg(intent);
      const target = { kind: 'leg', leg: bank, stage: 'pay' } as const;
      f.defer!(target);
      const s1 = await f.orchestrator.submit(intent);
      assert.equal(s1.phase, 'committing');
      // Parked work does not advance on its own and is never a failure.
      const s2 = await f.orchestrator.reconcile(intent.purchaseRef);
      assert.equal(s2.phase, 'committing');
      assert.ok(s2.unresolved.length > 0);
      f.resolveDeferred!(target, 'succeed');
      const s3 = await f.orchestrator.reconcile(intent.purchaseRef);
      assert.equal(s3.phase, 'settled');
      assert.equal(f.audit().shopBankCents, principal(intent));
    },
  );

  test(
    `${name}: compensation restores principal and charged fees`,
    { skip: needs('rejectBeforeEffect') },
    async () => {
      const f = make();
      const intent = f.intent('atomic');
      const bank = bankLeg(intent);
      f.rejectBeforeEffect!({ kind: 'group', intent });
      const s = await f.orchestrator.submit(intent);
      // The bank leg confirmed settled before the DE group failed — it is
      // returned principal AND charged fee; only confirmed cleanup permits
      // 'compensated'.
      assert.equal(s.phase, 'compensated');
      const b = legOf(s, bank.role);
      assert.equal(b.commit?.status, 'succeeded');
      assert.equal(b.returned?.status, 'succeeded');
      assert.equal(b.principalReturnedCents, bank.principalCents);
      assert.equal(b.feeReturnedCents, bank.feeCents);
      assert.equal(s.principalReturnedCents, bank.principalCents);
      assert.equal(s.feeReturnedCents, bank.feeCents);
      assert.equal(s.retainedFeeCents, 0);
      assert.equal(s.exposureCents, 0);
      assert.equal(s.cleanupConfirmed, true);
      assert.equal(f.audit().shopBankCents, 0);
    },
  );

  test(
    `${name}: a conclusively refused return keeps exposure until explicit recovery`,
    { skip: needs('rejectBeforeEffect') || needs('setReturnsSupported') },
    async () => {
      const f = make();
      const intent = f.intent('atomic');
      const bank = bankLeg(intent);
      f.setReturnsSupported!(bank.payerId, false);
      f.rejectBeforeEffect!({ kind: 'group', intent });
      const s1 = await f.orchestrator.submit(intent);
      // The compensation return is refused 'unsupported': committed money
      // stays visible exposure — never a terminal 'compensated'.
      assert.equal(s1.phase, 'recovery_required');
      const b1 = legOf(s1, bank.role);
      assert.equal(b1.returned?.status, 'rejected');
      assert.equal(b1.returned?.reason, 'unsupported');
      assert.equal(s1.exposureCents, bank.principalCents + bank.feeCents);
      assert.equal(s1.cleanupConfirmed, false);
      assert.equal(f.audit().shopBankCents, bank.principalCents);
      // An explicit recovery scope restores the principal under its own
      // stable key, principal-only: the charged fee stays retained.
      f.setReturnsSupported!(bank.payerId, true);
      const s2 = await f.orchestrator.returnSettled(intent.purchaseRef, {
        reason: 'recovery',
        legs: [bank.role],
      });
      assert.equal(s2.phase, 'recovered');
      const b2 = legOf(s2, bank.role);
      assert.equal(b2.returned?.status, 'succeeded');
      assert.equal(b2.principalReturnedCents, bank.principalCents);
      assert.equal(b2.feeReturnedCents ?? 0, 0);
      assert.equal(s2.retainedFeeCents, bank.feeCents);
      assert.equal(f.audit().shopBankCents, 0);
    },
  );

  test(
    `${name}: independent mode keeps a settled leg beside a rejected sibling`,
    { skip: needs('rejectBeforeEffect') },
    async () => {
      const f = make();
      const intent = f.intent('independent');
      const de = deLeg(intent);
      const bank = bankLeg(intent);
      f.rejectBeforeEffect!({ kind: 'leg', leg: bank, stage: 'pay' });
      const s1 = await f.orchestrator.submit(intent);
      // The DE leg settles on its own; the rejected bank leg is cleaned up
      // and the kept settlement stays visible for explicit recovery —
      // independent mode never auto-compensates.
      assert.equal(s1.phase, 'recovery_required');
      assert.equal(legOf(s1, de.role).settled, true);
      const b = legOf(s1, bank.role);
      assert.equal(b.commit?.status, 'rejected');
      assert.equal(b.returned, undefined);
      assert.equal(s1.exposureCents, de.principalCents + de.feeCents);
      assert.equal(f.audit().shopBankCents, de.principalCents);
      const s2 = await f.orchestrator.returnSettled(intent.purchaseRef, {
        reason: 'recovery',
        legs: [de.role],
      });
      assert.equal(s2.phase, 'recovered');
      const d = legOf(s2, de.role);
      assert.equal(d.returned?.status, 'succeeded');
      assert.equal(d.principalReturnedCents, de.principalCents);
      assert.equal(d.feeReturnedCents ?? 0, 0);
      assert.equal(s2.retainedFeeCents, de.feeCents);
      assert.equal(f.audit().shopBankCents, 0);
    },
  );

  test(`${name}: an ordinary return restores principal only, under a stable key`, async () => {
    const f = make();
    const intent = f.intent('atomic');
    const bank = bankLeg(intent);
    await f.orchestrator.submit(intent);
    const s = await f.orchestrator.returnSettled(intent.purchaseRef, {
      reason: 'refund',
      legs: [bank.role],
    });
    const b = legOf(s, bank.role);
    assert.equal(b.returned?.status, 'succeeded');
    assert.equal(b.principalReturnedCents, bank.principalCents);
    assert.equal(b.feeReturnedCents ?? 0, 0);
    // A settled intent keeps reporting 'settled' across ordinary returns —
    // the return is recorded separately, never a rewrite of history.
    assert.equal(s.phase, 'settled');
    assert.equal(s.retainedFeeCents, bank.feeCents);
    // Pay and its return: exactly two transfers ever ran.
    assert.equal(f.audit().bankTransfers, 2);
    assert.equal(f.audit().shopBankCents, deLeg(intent).principalCents);
    // A replay of the same scope dedupes under the same return key.
    const s2 = await f.orchestrator.returnSettled(intent.purchaseRef, {
      reason: 'refund',
      legs: [bank.role],
    });
    assert.equal(legOf(s2, bank.role).returned?.key, b.returned?.key);
    assert.equal(f.audit().bankTransfers, 2);
  });

  test(
    `${name}: a return never races an unresolved original operation`,
    { skip: needs('defer') || needs('resolveDeferred') },
    async () => {
      const f = make();
      const intent = f.intent('atomic');
      const bank = bankLeg(intent);
      const target = { kind: 'leg', leg: bank, stage: 'pay' } as const;
      f.defer!(target);
      await f.orchestrator.submit(intent);
      // The original commit is unresolved: the scope is accepted but no
      // return issues against money whose state is unknown.
      const s1 = await f.orchestrator.returnSettled(intent.purchaseRef, {
        reason: 'refund',
        legs: [bank.role],
      });
      assert.equal(legOf(s1, bank.role).returned, undefined);
      f.resolveDeferred!(target, 'succeed');
      const s2 = await f.orchestrator.reconcile(intent.purchaseRef);
      assert.equal(s2.phase, 'settled');
      const s3 = await f.orchestrator.returnSettled(intent.purchaseRef, {
        reason: 'refund',
        legs: [bank.role],
      });
      assert.equal(legOf(s3, bank.role).returned?.status, 'succeeded');
    },
  );

  test(`${name}: returnSettled refuses an invalid scope before touching money`, async () => {
    const f = make();
    const intent = f.intent('atomic');
    await f.orchestrator.submit(intent);
    await assert.rejects(
      () =>
        f.orchestrator.returnSettled(intent.purchaseRef, {
          reason: 'bogus' as never,
          legs: [],
        }),
      /return_scope_invalid/,
    );
    await assert.rejects(
      () =>
        f.orchestrator.returnSettled(intent.purchaseRef, {
          reason: 'refund',
          legs: ['no-such-role'],
        }),
      /unknown_leg/,
    );
    assert.equal(f.audit().shopBankCents, principal(intent));
  });

  test(
    `${name}: an unreachable provider parks its leg, never a failure`,
    { skip: needs('setProviderAvailable') },
    async () => {
      const f = make();
      const intent = f.intent('atomic');
      const bank = bankLeg(intent);
      f.setProviderAvailable!(bank.payerId, false);
      const s1 = await f.orchestrator.submit(intent);
      assert.equal(s1.phase, 'reserving');
      const b = legOf(s1, bank.role);
      assert.equal(b.reserve?.status, 'pending');
      assert.equal(b.refusal, undefined);
      // The reachable leg still reserved.
      assert.equal(legOf(s1, deLeg(intent).role).reserve?.status, 'succeeded');
      assert.equal(f.audit().shopBankCents, 0);
      f.setProviderAvailable!(bank.payerId, true);
      const s2 = await f.orchestrator.reconcile(intent.purchaseRef);
      assert.equal(s2.phase, 'settled');
      assert.equal(f.audit().shopBankCents, principal(intent));
    },
  );

  test(
    `${name}: an accepted hold expires half a minute after reserve`,
    { skip: needs('setProviderAvailable') || needs('setNow') },
    async () => {
      const f = make();
      const intent = f.intent('atomic');
      const de = deLeg(intent);
      const bank = bankLeg(intent);
      // Park the bank leg: the DE hold accepts now, and expires 0.5
      // simulated minutes later — before the group commit can reach it.
      f.setProviderAvailable!(bank.payerId, false);
      await f.orchestrator.submit(intent);
      f.setNow!(f.audit().now + 0.5);
      f.setProviderAvailable!(bank.payerId, true);
      const s = await f.orchestrator.reconcile(intent.purchaseRef);
      // The group commit is refused on the expired hold; the committed
      // bank leg is compensated — expiry never completes a leg.
      assert.equal(s.phase, 'compensated');
      assert.equal(legOf(s, de.role).hold?.status, 'expired');
      const b = legOf(s, bank.role);
      assert.equal(b.returned?.status, 'succeeded');
      assert.equal(b.principalReturnedCents, bank.principalCents);
      assert.equal(f.audit().shopBankCents, 0);
    },
  );

  test(`${name}: a second public call joining a drive is refused`, async () => {
    const f = make();
    const intent = f.intent('atomic');
    const pending = f.orchestrator.submit(intent);
    await assert.rejects(f.orchestrator.reconcile(intent.purchaseRef), /drive_in_progress/);
    const s = await pending;
    assert.equal(s.phase, 'settled');
  });
}
