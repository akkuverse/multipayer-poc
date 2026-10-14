// Behaviour every SettlementBackend must show for the coordinator's safety
// rules to hold. The mock runs it in test/mock-backend.contract.test.ts; the
// ECB adapter, kept outside this repository, imports this file and runs it
// against the test environment. A case whose fault control the fixture cannot
// provide is skipped and reads as 'not tested', never as a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LegRequest, SettlementBackend, SubmitRequest } from '../../src/backend.ts';
import type { SettlementMode } from '../../src/types.ts';

export interface ContractFixture {
  backend: SettlementBackend;
  payeeId: string;
  // Two payers, each able to fund EUR 10 on their own.
  payers: [string, string];
  decline?: (payerId: string) => void;
  loseResponse?: (payerId: string, outcome: 'settle' | 'reject') => void;
  disableRefunds?: () => void;
}

export function settlementBackendContract(name: string, make: () => ContractFixture): void {
  const caps = make();
  const needs = (control: 'decline' | 'loseResponse' | 'disableRefunds'): false | string =>
    caps[control] ? false : `fixture has no ${control} control`;
  let n = 0;
  const request = (f: ContractFixture, mode: SettlementMode): SubmitRequest => {
    n += 1;
    const legs: LegRequest[] = f.payers.map((payerId, i) => ({
      payerId,
      payeeId: f.payeeId,
      amountCents: 500 + 300 * i,
      feeCents: 0,
      idempotencyKey: `contract-${n}-${i}`,
    }));
    return { groupRef: `contract-group-${n}`, mode, legs };
  };
  const statuses = (rs: { status: string }[]): string[] => rs.map((r) => r.status);

  test(`${name}: an atomic group settles every leg`, async () => {
    const f = make();
    const res = await f.backend.submit(request(f, 'atomic'));
    assert.deepEqual(statuses(res), ['settled', 'settled']);
    for (const r of res) assert.equal(await f.backend.status(r.executionRef), 'settled');
  });

  test(`${name}: a retry with the same keys returns the original executions`, async () => {
    const f = make();
    const req = request(f, 'atomic');
    const first = await f.backend.submit(req);
    const again = await f.backend.submit(req);
    assert.deepEqual(
      again.map((r) => r.executionRef),
      first.map((r) => r.executionRef),
    );
    assert.deepEqual(statuses(again), statuses(first));
  });

  test(`${name}: one declined leg rejects the whole atomic group`, { skip: needs('decline') }, async () => {
    const f = make();
    f.decline!(f.payers[1]);
    const res = await f.backend.submit(request(f, 'atomic'));
    assert.deepEqual(statuses(res), ['rejected', 'rejected']);
  });

  test(`${name}: independent legs settle or fail on their own`, { skip: needs('decline') }, async () => {
    const f = make();
    f.decline!(f.payers[1]);
    const res = await f.backend.submit(request(f, 'independent'));
    assert.deepEqual(statuses(res), ['settled', 'rejected']);
  });

  test(
    `${name}: a lost response stays unknown until a status query resolves it`,
    { skip: needs('loseResponse') },
    async () => {
      const f = make();
      f.loseResponse!(f.payers[0], 'settle');
      const req = request(f, 'independent');
      const res = await f.backend.submit(req);
      assert.equal(res[0].status, 'unknown');
      const retry = await f.backend.submit(req);
      assert.equal(retry[0].executionRef, res[0].executionRef, 'a retry while unknown is deduplicated');
      assert.equal(await f.backend.status(res[0].executionRef), 'settled');
    },
  );

  test(
    `${name}: a lost response on a rejected leg resolves as rejected`,
    { skip: needs('loseResponse') },
    async () => {
      const f = make();
      f.loseResponse!(f.payers[0], 'reject');
      const res = await f.backend.submit(request(f, 'independent'));
      assert.equal(res[0].status, 'unknown');
      assert.equal(await f.backend.status(res[0].executionRef), 'rejected');
    },
  );

  test(`${name}: a refund returns a settled leg and keeps the execution`, async () => {
    const f = make();
    const [leg] = await f.backend.submit(request(f, 'atomic'));
    assert.equal(await f.backend.refund(leg.executionRef), 'returned');
    assert.equal(await f.backend.status(leg.executionRef), 'returned');
  });

  test(`${name}: a rejected leg cannot be refunded`, { skip: needs('decline') }, async () => {
    const f = make();
    f.decline!(f.payers[0]);
    const [leg] = await f.backend.submit(request(f, 'independent'));
    await assert.rejects(() => f.backend.refund(leg.executionRef));
  });

  test(
    `${name}: a backend without returns says so instead of failing silently`,
    { skip: needs('disableRefunds') },
    async () => {
      const f = make();
      f.disableRefunds!();
      const [leg] = await f.backend.submit(request(f, 'atomic'));
      assert.equal(await f.backend.refund(leg.executionRef), 'unsupported');
      assert.equal(await f.backend.status(leg.executionRef), 'settled');
    },
  );
}
