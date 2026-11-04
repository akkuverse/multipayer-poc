// The coordinator must work against any settlement implementation, not just
// the fixture orchestrator. This fake answers every submit 'pending' and
// settles on the first reconcile — like a settlement layer whose operations
// are slow. A throw from submit() is the conclusive pre-handoff refusal the
// port reserves for requests that provably never moved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/core/coordinator.ts';
import { Trace } from '../src/evidence/trace.ts';
import type { SettlementIntent, SettlementPhase, SettlementSnapshot } from '../src/settlement/types.ts';
import type { SettlementOrchestrator } from '../src/settlement/orchestrator.ts';
import { world, approveAs, proposeAs, submitAs, EMPLOYEE, MERCHANT_A } from '../src/scenarios.ts';

class SlowSettlement {
  readonly intents: SettlementIntent[] = [];
  settled = false;

  private snap(intent: SettlementIntent, phase: SettlementPhase): SettlementSnapshot {
    const settled = phase === 'settled';
    return {
      purchaseRef: intent.purchaseRef,
      purchaseId: intent.purchaseId,
      proposalVersion: intent.proposalVersion,
      mode: intent.mode,
      phase,
      legs: intent.legs.map((l) => ({
        purchaseId: l.purchaseId,
        proposalVersion: l.proposalVersion,
        role: l.role,
        payerId: l.payerId,
        payeeId: l.payeeId,
        rail: l.rail,
        principalCents: l.principalCents,
        feeCents: l.feeCents,
        authority: l.authority,
        reserve: { key: `${l.role}:reserve`, status: settled ? 'succeeded' : 'pending' },
        commit: settled ? { key: `${l.role}:commit`, status: 'succeeded', reference: `${l.role}-exec` } : undefined,
        committedCents: settled ? l.principalCents : undefined,
        destinationCreditConfirmed: settled,
        settled,
        cleanupConfirmed: true,
      })),
      committedCents: settled ? intent.legs.reduce((s, l) => s + l.principalCents, 0) : 0,
      settledCents: settled ? intent.legs.reduce((s, l) => s + l.principalCents, 0) : 0,
      principalReturnedCents: 0,
      feeReturnedCents: 0,
      retainedFeeCents: 0,
      exposureCents: 0,
      unresolved: [],
      cleanupConfirmed: true,
    };
  }

  async submit(intent: SettlementIntent): Promise<SettlementSnapshot> {
    this.intents.push(structuredClone(intent));
    return this.snap(intent, this.settled ? 'settled' : 'committing');
  }

  async reconcile(purchaseRef: string): Promise<SettlementSnapshot> {
    const intent = this.intents.find((i) => i.purchaseRef === purchaseRef);
    if (intent === undefined) throw new Error('unknown_purchase');
    return this.snap(intent, this.settled ? 'settled' : 'committing');
  }

  async returnSettled(): Promise<SettlementSnapshot> {
    throw new Error('returns unsupported');
  }
}

const driver = (w: ReturnType<typeof world>, settlement: SlowSettlement): Coordinator =>
  new Coordinator(() => settlement as unknown as SettlementOrchestrator, new Trace(), {
    now: 10,
    keys: w.keys,
    authority: w.authority,
    destinationFor: w.destinationFor,
  });

test('the coordinator drives any settlement implementation through the port', async () => {
  const w = world(); // fixtures only: keys, registry and the mandate
  const settlement = new SlowSettlement();
  const c = driver(w, settlement);
  const signing = { coordinator: c, signers: w.signers, submitPolicy: 'on_request' as const, settlementMode: 'atomic' as const };
  const p = proposeAs(signing, {
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
  });
  approveAs({ coordinator: c, signers: w.signers }, p);
  await submitAs(signing, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  assert.deepEqual(
    settlement.intents[0].legs.map((l) => [l.payerId, l.payeeId, l.principalCents]),
    [['employee-1', 'merchant-a', 800], ['employer-1', 'merchant-a', 500]],
  );
  settlement.settled = true;
  await c.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
});

test('an open outcome through the port keeps the intent and reservation', async () => {
  const w = world();
  const settlement = new SlowSettlement();
  const c = driver(w, settlement);
  const signing = { coordinator: c, signers: w.signers, submitPolicy: 'on_request' as const, settlementMode: 'atomic' as const };
  const p = proposeAs(signing, {
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
  });
  approveAs({ coordinator: c, signers: w.signers }, p);
  await submitAs(signing, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  assert.equal(c.ledger.state('purchase-1'), 'reserved', 'an open outcome cannot release a live reservation');
  const keys = p.legs.map((l) => l.idempotencyKey);
  await c.resubmit(p.purchaseId);
  assert.deepEqual(p.legs.map((l) => l.idempotencyKey), keys, 'the replay used the same keys');
  assert.deepEqual(settlement.intents[1], settlement.intents[0], 'the replay submitted the frozen intent');
  settlement.settled = true;
  await c.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(c.ledger.state('purchase-1'), 'consumed');
});

test('a conclusive refusal through the port throws and leaves the purchase repairable', async () => {
  const w = world();
  const settlement = new SlowSettlement();
  // A conclusive pre-handoff refusal is not a lost response: the caller
  // error surfaces, the fresh reservation is rolled back and no intent is
  // retained for a request that provably never moved.
  settlement.submit = () => Promise.reject(new Error('request refused at the port'));
  const c = driver(w, settlement);
  const signing = { coordinator: c, signers: w.signers, submitPolicy: 'on_request' as const, settlementMode: 'atomic' as const };
  const p = proposeAs(signing, {
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
  });
  approveAs({ coordinator: c, signers: w.signers }, p);
  await assert.rejects(() => submitAs(signing, p, EMPLOYEE), /request refused at the port/);
  assert.equal(p.state, 'ready');
  assert.equal(c.ledger.state('purchase-1'), undefined);
  await assert.rejects(() => c.resubmit(p.purchaseId), /nothing to resubmit/);
});

test('a conclusive refusal on a replay propagates out of resubmit', async () => {
  const w = world();
  const settlement = new SlowSettlement();
  const c = driver(w, settlement);
  const signing = { coordinator: c, signers: w.signers, submitPolicy: 'on_request' as const, settlementMode: 'atomic' as const };
  const p = proposeAs(signing, {
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
  });
  approveAs({ coordinator: c, signers: w.signers }, p);
  await submitAs(signing, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  // The port now conclusively refuses the replay: that is a pre-handoff
  // refusal, so the error surfaces rather than being recorded as an
  // outcome — and the in-flight intent stays put.
  const ok = settlement.submit.bind(settlement);
  settlement.submit = () => Promise.reject(new Error('request refused on replay'));
  await assert.rejects(() => c.resubmit(p.purchaseId), /request refused on replay/);
  assert.equal(p.state, 'pending');
  assert.equal(p.legs.length, 2);
  assert.equal(c.ledger.state('purchase-1'), 'reserved');
  // A healthy replay still dedupes on the frozen keys and resolves normally.
  settlement.submit = ok;
  settlement.settled = true;
  await c.resubmit(p.purchaseId);
  await c.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
});
