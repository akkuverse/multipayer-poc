// The coordinator must work against any SettlementBackend, not just the mock.
// This fake answers every leg 'unknown' and settles on the first status query,
// like a backend whose responses are slow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionStatus, LegResponse, SettlementBackend, SubmitRequest } from '../src/settlement/backend.ts';
import { RequestRefusedError } from '../src/settlement/backend.ts';
import { Coordinator } from '../src/core/coordinator.ts';
import { Trace } from '../src/evidence/trace.ts';
import { world, approveAs, EMPLOYEE, MERCHANT_A } from '../src/scenarios.ts';

class SlowBackend implements SettlementBackend {
  readonly name = 'slow-fake';
  readonly origin = 'LOCAL' as const;
  readonly specVersion = 'test';
  readonly requests: SubmitRequest[] = [];

  async submit(req: SubmitRequest): Promise<LegResponse[]> {
    this.requests.push(req);
    return req.legs.map((l, i) => ({ idempotencyKey: l.idempotencyKey, executionRef: `slow-${i}`, status: 'unknown' }));
  }

  async status(): Promise<ExecutionStatus> {
    return 'settled';
  }

  async refund(): Promise<'returned' | 'unsupported'> {
    return 'unsupported';
  }
}

test('the coordinator drives any SettlementBackend through the port', async () => {
  const w = world(); // fixtures only: keys, registry and the mandate
  const backend = new SlowBackend();
  const c = new Coordinator(backend, new Trace(), { now: 10, keys: w.keys, mandates: w.mandates });
  const p = c.propose({
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
  });
  approveAs({ coordinator: c, signers: w.signers }, p);
  await c.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  assert.deepEqual(
    backend.requests[0].legs.map((l) => [l.payerId, l.payeeId, l.amountCents]),
    [['employee-1', 'merchant-a', 800], ['employer-1', 'merchant-a', 500]],
  );
  await c.reconcile(p);
  assert.equal(p.state, 'completed');
});

test('a post-acceptance error through the port keeps the intent and reservation', async () => {
  const w = world();
  const backend = new SlowBackend();
  // Lose the response after the request was accepted: a generic error is not
  // proof nothing moved, so the purchase must stay pending with legs, keys
  // and benefit reservation retained — never released or failed.
  const submit = backend.submit.bind(backend);
  let loseResponse = true;
  backend.submit = async (req) => {
    const response = await submit(req);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('synthetic lost submission response');
    }
    return response;
  };
  const c = new Coordinator(backend, new Trace(), { now: 10, keys: w.keys, mandates: w.mandates });
  const p = c.propose({
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
  });
  approveAs({ coordinator: c, signers: w.signers }, p);
  await c.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  assert.equal(c.ledger.state('purchase-1'), 'reserved', 'a lost response cannot release a live reservation');
  const keys = p.legs.map((l) => l.idempotencyKey);
  await c.resubmit(p);
  assert.deepEqual(p.legs.map((l) => l.idempotencyKey), keys, 'the replay used the same keys');
  await c.reconcile(p);
  assert.equal(p.state, 'completed');
  assert.equal(c.ledger.state('purchase-1'), 'consumed');
});

test('a conclusive refusal through the port throws and leaves the purchase repairable', async () => {
  const w = world();
  const backend = new SlowBackend();
  // A conclusive pre-dispatch refusal is not a lost response: the caller
  // error surfaces, the fresh reservation is rolled back and no intent is
  // retained for a request that provably never moved.
  backend.submit = () => Promise.reject(new RequestRefusedError('request refused at the port'));
  const c = new Coordinator(backend, new Trace(), { now: 10, keys: w.keys, mandates: w.mandates });
  const p = c.propose({
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
  });
  approveAs({ coordinator: c, signers: w.signers }, p);
  await assert.rejects(() => c.submit(p, 'atomic'), /request refused at the port/);
  assert.equal(p.state, 'ready');
  assert.equal(c.ledger.state('purchase-1'), undefined);
  await assert.rejects(() => c.resubmit(p), /nothing to resubmit/);
});

test('a conclusive refusal on a replay propagates out of resubmit', async () => {
  const w = world();
  const backend = new SlowBackend();
  const c = new Coordinator(backend, new Trace(), { now: 10, keys: w.keys, mandates: w.mandates });
  const p = c.propose({
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
  });
  approveAs({ coordinator: c, signers: w.signers }, p);
  await c.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  // The whole-request route now conclusively refuses the replay: that is a
  // pre-forward refusal for every leg, so the error surfaces rather than
  // being recorded as an outcome — and the in-flight intent stays put.
  const ok = backend.submit.bind(backend);
  backend.submit = () => Promise.reject(new RequestRefusedError('request refused on replay'));
  await assert.rejects(() => c.resubmit(p), /request refused on replay/);
  assert.equal(p.state, 'pending');
  assert.equal(p.legs.length, 2);
  assert.equal(c.ledger.state('purchase-1'), 'reserved');
  // A healthy replay still dedupes on the frozen keys and resolves normally.
  backend.submit = ok;
  await c.resubmit(p);
  await c.reconcile(p);
  assert.equal(p.state, 'completed');
});
