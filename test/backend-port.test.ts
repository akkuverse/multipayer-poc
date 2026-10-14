// The coordinator must work against any SettlementBackend, not just the mock.
// This fake answers every leg 'unknown' and settles on the first status query,
// like a backend whose responses are slow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionStatus, LegResponse, SettlementBackend, SubmitRequest } from '../src/backend.ts';
import { Coordinator } from '../src/coordinator.ts';
import { Trace } from '../src/trace.ts';
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
  const w = world(); // fixtures only: the mandate
  const backend = new SlowBackend();
  const c = new Coordinator(backend, new Trace(), { now: 10 });
  const p = c.propose({
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    employeeMaxCents: 800,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandate: w.mandate,
    expiresAt: 100,
  });
  approveAs({ coordinator: c }, p);
  await c.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  assert.deepEqual(
    backend.requests[0].legs.map((l) => [l.payerId, l.payeeId, l.amountCents]),
    [['employee-1', 'merchant-a', 800], ['employer-1', 'merchant-a', 500]],
  );
  await c.reconcile(p);
  assert.equal(p.state, 'completed');
});
