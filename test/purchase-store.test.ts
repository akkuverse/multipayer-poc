// The coordinator-owned purchase store: ids in, live read-only views out,
// and a reused purchaseId refused before any state or trace change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveAs, lunch, world, COLLEAGUE_1, EMPLOYEE, MERCHANT_A, MERCHANT_B } from '../src/scenarios.ts';
import { readonlyView, unwrapView } from '../src/core/live-view.ts';
import { ADOPTABLE, TRANSITIONS, canTransition } from '../src/core/states.ts';
import type { Purchase, PurchaseState } from '../src/core/types.ts';

const SPLIT = {
  purchaseId: 'split-1',
  merchantId: MERCHANT_B,
  expiresAt: 100,
  shares: [
    { role: 'a', payerId: EMPLOYEE, amountCents: 500 },
    { role: 'b', payerId: COLLEAGUE_1, amountCents: 500 },
  ],
};

const READ_ONLY = { name: 'TypeError', message: 'purchase view is read-only' };

test('propose refuses a reused purchaseId and appends no trace events', () => {
  const w = world();
  lunch(w);
  const events = w.trace.events.length;
  assert.throws(() => lunch(w), /duplicate_purchase/);
  assert.equal(w.trace.events.length, events);
});

test('proposeSplit refuses a reused purchaseId and appends no trace events', () => {
  const w = world();
  w.coordinator.proposeSplit(SPLIT);
  const events = w.trace.events.length;
  assert.throws(() => w.coordinator.proposeSplit(SPLIT), /duplicate_purchase/);
  // A reused id is refused at whichever entry point takes it.
  assert.throws(() => lunch(w, 1_300, MERCHANT_A, { purchaseId: SPLIT.purchaseId }), /duplicate_purchase/);
  assert.equal(w.trace.events.length, events);
});

test('view reads current fields and reflects later mutations', () => {
  const w = world();
  const p = lunch(w);
  const v = w.coordinator.view(p.purchaseId);
  assert.equal(v.purchaseId, 'purchase-1');
  assert.equal(v.state, 'awaiting_approvals');
  assert.equal(v.proposal.version, 1);
  assert.equal(v.proposal.totalCents, 1_300);
  assert.equal(v.benefit?.employeeId, EMPLOYEE);
  assert.deepEqual(
    v.proposal.shares.map((s) => `${s.role}:${s.amountCents}`),
    ['employee:800', 'employer:500'],
  );
  approveAs(w, p, EMPLOYEE);
  assert.equal(v.state, 'ready');
  assert.equal(v.authorizations.length, 1);
});

test('every write shape through a view throws', async () => {
  const w = world();
  const p = w.coordinator.proposeSplit(SPLIT);
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, COLLEAGUE_1);
  await w.coordinator.submit(p, 'atomic');
  const v = w.coordinator.view(p.purchaseId);
  assert.equal(v.state, 'completed');
  assert.equal(v.legs.length, 2);
  assert.throws(() => {
    (v as Purchase).state = 'failed';
  }, READ_ONLY);
  assert.throws(() => {
    (v.legs as unknown[]).push({});
  }, READ_ONLY);
  assert.throws(() => {
    (v.legs[0] as { status: string }).status = 'settled';
  }, READ_ONLY);
  assert.throws(() => {
    delete (v as Partial<Purchase>).state;
  }, READ_ONLY);
  assert.throws(() => Object.defineProperty(v, 'extra', { value: 1 }), READ_ONLY);
  assert.throws(() => Object.setPrototypeOf(v, null), READ_ONLY);
  assert.throws(() => Object.preventExtensions(v), READ_ONLY);
  assert.throws(() => Object.freeze(v), READ_ONLY);
  // A failed freeze must not leave the record non-extensible: fields the
  // coordinator adds later (receipt, dispute, …) would silently die.
  assert.equal(Object.isExtensible(unwrapView(v)), true);
});

test('view identity is stable per record, nested objects included', () => {
  const w = world();
  const p = w.coordinator.proposeSplit(SPLIT);
  assert.equal(w.coordinator.view(p.purchaseId), w.coordinator.view(p.purchaseId));
  const v = w.coordinator.view(p.purchaseId);
  assert.equal(v.legs, v.legs);
  assert.equal(v.proposal, v.proposal);
});

test('a view deep-equals the plain literal of its record', () => {
  const w = world();
  w.coordinator.proposeSplit(SPLIT);
  assert.deepEqual(w.coordinator.view('split-1'), {
    purchaseId: 'split-1',
    state: 'awaiting_approvals',
    proposal: {
      version: 1,
      merchantId: MERCHANT_B,
      totalCents: 1_000,
      shares: [
        { role: 'a', payerId: EMPLOYEE, payeeId: MERCHANT_B, amountCents: 500, feeCents: 0, authority: 'payer' },
        { role: 'b', payerId: COLLEAGUE_1, payeeId: MERCHANT_B, amountCents: 500, feeCents: 0, authority: 'payer' },
      ],
      expiresAt: 100,
    },
    authorizations: [],
    legs: [],
    returnStatus: 'none',
  });
});

test('view of an unknown purchaseId throws', () => {
  const w = world();
  assert.throws(() => w.coordinator.view('nope'), /unknown_purchase/);
});

test('a raw view cannot be cloned; unwrapView yields the record to detach', () => {
  const w = world();
  const p = w.coordinator.proposeSplit(SPLIT);
  const v = w.coordinator.view(p.purchaseId);
  assert.throws(() => structuredClone(v), (err: unknown) => (err as { name?: string }).name === 'DataCloneError');
  const copy = structuredClone(unwrapView(v)) as Purchase;
  copy.state = 'cancelled';
  copy.reason = 'detached';
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, COLLEAGUE_1);
  assert.equal(v.state, 'ready');
  // The detached copy no longer tracks the record.
  assert.equal(copy.state, 'cancelled');
  assert.equal(copy.proposal.version, 1);
});

test('the view refuses non-plain values rather than proxying them', () => {
  class Foreign {
    x = 1;
  }
  assert.throws(() => readonlyView({ m: new Map() }), /plain data/);
  assert.throws(() => readonlyView({ nested: { d: new Date() } }), /plain data/);
  assert.throws(() => readonlyView({ c: new Foreign() }), /plain data/);
});

test('canTransition accepts every table pair and refuses unreachable moves', () => {
  for (const [from, targets] of Object.entries(TRANSITIONS) as [PurchaseState, PurchaseState[]][]) {
    for (const to of targets) assert.equal(canTransition(from, to), true, `${from} → ${to}`);
  }
  assert.deepEqual(ADOPTABLE, ['awaiting_approvals', 'ready']);
  assert.equal(canTransition('completed', 'cancelled'), false);
  assert.equal(canTransition('pending', 'draft'), false);
  assert.equal(canTransition('draft', 'pending'), false);
  // completed, failed and cancelled are terminal: nothing leaves them.
  for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
    for (const to of Object.keys(TRANSITIONS) as PurchaseState[]) {
      assert.equal(canTransition(terminal, to), false, `${terminal} → ${to}`);
    }
  }
});

test('folded state events reproduce view(id).state after a full run', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE);
  await w.coordinator.submit(p, 'atomic');
  await w.coordinator.reconcile(p);
  let folded: PurchaseState | undefined;
  for (const e of w.trace.events.filter((e) => e.event === 'state' && e.detail?.purchaseId === p.purchaseId)) {
    // A move continues the last reported state; a re-report repeats it.
    if (e.detail?.from !== undefined && folded !== undefined) assert.equal(e.detail.from, folded);
    folded = e.detail?.to as PurchaseState;
  }
  assert.equal(folded, w.coordinator.view(p.purchaseId).state);
  assert.equal(folded, 'completed');
});

test('approve emits a state event for the awaiting_approvals → ready move', () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE);
  const ready = w.trace.events.find(
    (e) => e.event === 'state' && e.detail?.purchaseId === p.purchaseId && e.detail?.to === 'ready',
  );
  assert.equal(ready?.detail?.from, 'awaiting_approvals');
});
