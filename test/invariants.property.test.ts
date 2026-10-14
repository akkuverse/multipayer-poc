// Randomised check of the safety rules in AGENTS.md. Each seed builds a
// fixture with random funding, faults, return support and initiation model,
// then applies a random sequence of operations. After every step the
// invariants must hold. A failure names the seed and the operations so the
// case can be replayed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, lunch, approveAs, updateMandate, advance, EMPLOYEE, EMPLOYER } from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';
import type { Fault } from '../src/mock-backend.ts';
import type { Purchase, SettlementMode } from '../src/types.ts';
import { PspUnavailableError } from '../src/psp.ts';

const SEEDS = 300;
const STEPS = 12;

// mulberry32: small, fast, deterministic.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

const FAULTS: Fault[] = ['none', 'decline', 'timeout_then_settle', 'timeout_then_reject'];
const MODES: SettlementMode[] = ['atomic', 'independent'];
// Approve and submit appear twice so runs reach the backend often.
const ACTIONS = [
  'approve', 'approve', 'submit', 'submit', 'resubmit', 'reconcile', 'reconcile',
  'recover', 'refund', 'advance', 'reprice', 'revoke', 'lowerCap', 'pspFlip',
] as const;
type Action = (typeof ACTIONS)[number];

// Errors the coordinator raises on purpose when an operation is not allowed
// in the current state. Anything else is a bug.
const REFUSALS = /^(cannot |approval does not match|nothing to |split purchases cannot)/;

const totalMoney = (w: World): number =>
  [...w.backend.accounts.values()].reduce((s, a) => s + a.deCents + a.linkedBankCents, 0);

interface Ctx {
  money: number;
  keys: Set<string>;
  // Keys are fixed once legs exist: terms are locked after submission, so a
  // retry can only ever reuse the first key set — never mint a new one.
  firstKeys?: Set<string>;
}

function checkInvariants(w: World, p: Purchase, ctx: Ctx): void {
  assert.equal(totalMoney(w), ctx.money, 'money is neither created nor destroyed');
  assert.ok(w.trace.events.every((e) => e.origin === 'LOCAL'), 'local runs only produce LOCAL evidence');
  for (const l of p.legs) ctx.keys.add(l.idempotencyKey);
  assert.ok(w.backend.executionCount() <= ctx.keys.size, 'at most one execution per idempotency key');
  if (p.legs.length > 0 && !ctx.firstKeys) ctx.firstKeys = new Set(p.legs.map((l) => l.idempotencyKey));
  if (ctx.firstKeys) {
    for (const l of p.legs) assert.ok(ctx.firstKeys.has(l.idempotencyKey), 'a retry never mints a new idempotency key');
  }
  if (p.state === 'completed') {
    assert.equal(p.legs.reduce((s, l) => s + l.amountCents, 0), p.proposal.totalCents, 'completed legs add up to the total');
    assert.ok(p.legs.every((l) => l.status === 'settled' || l.status === 'returned'), 'completed only when every leg settled');
  }
  if (p.legs.some((l) => l.status === 'unknown')) assert.equal(p.state, 'pending', 'an unknown outcome is pending, not failed');
  if (p.state === 'recovery_required') assert.ok(w.coordinator.outstandingCents(p) > 0, 'recovery keeps the outstanding amount visible');
  const employeeLeg = p.legs.find((l) => l.leg === 'employee');
  if (employeeLeg) {
    const approval = p.approvals.find((a) => a.payload.payerId === EMPLOYEE);
    assert.ok(approval, 'an employee leg exists only with an employee approval');
    assert.equal(employeeLeg.amountCents, approval.payload.amountCents, 'the employee pays exactly what they approved');
    assert.equal(employeeLeg.feeCents, approval.payload.feeCents, 'and exactly the fee they approved');
  }
}

async function step(r: () => number, w: World, p: Purchase, action: Action): Promise<void> {
  const c = w.coordinator;
  switch (action) {
    case 'approve':
      approveAs(w, p);
      break;
    case 'submit':
      await c.submit(p, pick(r, MODES));
      break;
    case 'resubmit':
      await c.resubmit(p);
      break;
    case 'reconcile':
      await c.reconcile(p);
      break;
    case 'recover':
      await c.recover(p);
      break;
    case 'refund':
      await c.refund(p);
      break;
    case 'advance':
      advance(w, c.now + Math.floor(r() * 40));
      break;
    case 'reprice':
      c.changeOffer(p, { merchantId: p.proposal.merchantId, totalCents: 300 + Math.floor(r() * 1_300), expiresAt: 100 });
      break;
    case 'revoke':
      updateMandate(w, { revoked: true });
      break;
    case 'lowerCap':
      updateMandate(w, { maxPerPurchaseCents: Math.floor(r() * 500) });
      break;
    case 'pspFlip':
      for (const psp of w.psps.values()) psp.available = r() < 0.5;
      break;
  }
}

test(`safety invariants hold across ${SEEDS} random runs`, async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const w = world(
      { deCents: Math.floor(r() * 2_000), reverseWaterfall: r() < 0.5 },
      {},
      { initiation: r() < 0.3 ? 'per_payer_psp' : 'coordinator' },
    );
    w.backend.faults.set(EMPLOYEE, pick(r, FAULTS));
    w.backend.faults.set(EMPLOYER, pick(r, FAULTS));
    w.backend.refundsSupported = r() < 0.7;
    const p = lunch(w);
    const ctx: Ctx = { money: totalMoney(w), keys: new Set() };
    const done: Action[] = [];
    for (let i = 0; i < STEPS; i++) {
      const action = pick(r, ACTIONS);
      done.push(action);
      try {
        await step(r, w, p, action);
      } catch (err) {
        const refused = err instanceof PspUnavailableError || (err instanceof Error && REFUSALS.test(err.message));
        if (!refused) throw new Error(`seed ${seed} after ${done.join(' > ')}: ${String(err)}`);
      }
      try {
        checkInvariants(w, p, ctx);
      } catch (err) {
        throw new Error(`seed ${seed} after ${done.join(' > ')}: ${(err as Error).message}`);
      }
    }
  }
});
