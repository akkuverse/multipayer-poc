// One test per scenario, plus a cross-scenario invariant test encoding the
// core safety rule. Amounts are integer euro cents; see src/scenarios.ts for
// the fixture world each scenario builds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, world, lunch, approveAs, EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, MERCHANT_B, MERCHANT_C, PLATFORM } from '../src/scenarios.ts';
import { shareCents } from '../src/coordinator.ts';

const run = async (id: string) => {
  const s = scenarios.find((x) => x.id.startsWith(id));
  if (!s) throw new Error(`no scenario ${id}`);
  return s.run();
};

test('S01 both approve: EUR 8 + EUR 5 reconcile to EUR 13 and complete', async () => {
  const { w, p } = await run('S01');
  assert.equal(p.state, 'completed');
  assert.deepEqual(p.legs.map((l) => [l.leg, l.amountCents, l.status]), [
    ['employee', 800, 'settled'],
    ['employer', 500, 'settled'],
  ]);
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300);
  assert.equal(w.backend.account(MERCHANT_A).deCents, 0, 'merchant holds no digital euro');
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000 - 500, 'employer funded by reverse waterfall');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000 - 800);
});

test('S02 employee short of holdings: reverse waterfall covers the gap', async () => {
  const { w, p } = await run('S02');
  assert.equal(p.state, 'completed');
  const e = w.backend.account(EMPLOYEE);
  assert.equal(e.deCents, 0);
  assert.equal(e.linkedBankCents, 50_000 - 500);
  assert.ok(w.trace.events.some((x) => x.event === 'reverse_waterfall' && x.detail?.account === EMPLOYEE));
});

test('S03 independent payments: partial success requires recovery, then cancels', async () => {
  const { w, p } = await run('S03');
  const states = w.trace.events.filter((e) => e.event === 'state').map((e) => e.detail?.to);
  assert.deepEqual(states, ['recovery_required', 'cancelled']);
  const flagged = w.trace.events.find((e) => e.event === 'state' && e.detail?.to === 'recovery_required');
  assert.equal(flagged?.detail?.outstandingCents, 500);
  assert.equal(p.state, 'cancelled');
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000, 'employer contribution returned');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0);
});

test('S04 atomic settlement: same failure moves no money', async () => {
  const { w, p } = await run('S04');
  assert.equal(p.state, 'failed');
  assert.equal(w.coordinator.outstandingCents(p), 0);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 300);
});

test('S05 recovery unsupported: purchase never reads as complete, EUR 5 stays outstanding', async () => {
  const { w, p } = await run('S05');
  assert.equal(p.state, 'recovery_required');
  assert.equal(p.returnStatus, 'unsupported');
  assert.equal(w.coordinator.outstandingCents(p), 500);
});

test('S06 employer authority expired before initiation: no execution, employee share stays EUR 8', async () => {
  const { w, p } = await run('S06');
  assert.equal(p.state, 'failed');
  assert.match(p.reason ?? '', /employer_authority_invalid/);
  assert.equal(shareCents(p.proposal, 'employee'), 800);
  assert.equal(w.backend.executionCount(), 0);
});

test('S07 changed offer invalidates approval; renewed approval on eligible alternative completes', async () => {
  const { w, p } = await run('S07');
  assert.equal(p.state, 'completed');
  assert.equal(p.proposal.version, 3);
  assert.equal(p.approvals[0]?.proposalVersion, 3);
  assert.equal(w.backend.account(MERCHANT_C).linkedBankCents, 1_300);
  assert.equal(w.trace.events.filter((e) => e.event === 'approval_invalidated').length, 1);
});

test('S07 stale approval cannot authorise the EUR 14 offer', async () => {
  const w = world();
  const p = lunch(w);
  const stale = approveAs(w, p);
  w.coordinator.changeOffer(p, { merchantId: 'merchant-b', totalCents: 1_400, expiresAt: 100 });
  assert.equal(p.state, 'draft');
  assert.equal(p.reason, 'employee_share_exceeds_instruction');
  assert.equal(shareCents(p.proposal, 'employee'), 900);
  assert.throws(() => w.coordinator.approve(p, stale));
  await assert.rejects(() => w.coordinator.submit(p, 'atomic'));
  // Only an explicit new instruction from the employee lets the EUR 9 share proceed.
  w.coordinator.reviseInstruction(p, 900);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
});

test('S08 retry with same keys does not execute twice', async () => {
  const { w, p } = await run('S08');
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.executionCount(), 2);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000 - 800);
  assert.ok(w.trace.events.some((e) => e.event === 'duplicate_request_ignored'));
});

test('S09 unknown outcome stays pending until authoritative status', async () => {
  const { w, p } = await run('S09');
  const states = w.trace.events.filter((e) => e.event === 'state').map((e) => e.detail?.to);
  assert.deepEqual(states, ['pending', 'completed']);
  assert.equal(w.backend.executionCount(), 2, 'no speculative replacement payment');
  assert.equal(p.state, 'completed');
});

test('S10 refund returns each share to its payer and respects the holding limit', async () => {
  const { w, p } = await run('S10');
  assert.equal(p.state, 'completed');
  assert.equal(p.returnStatus, 'completed');
  const e = w.backend.account(EMPLOYEE);
  assert.equal(e.deCents, 300_000, 'topped up to the holding limit');
  assert.equal(e.linkedBankCents, 50_000 + 700, 'excess EUR 7 waterfalled');
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0);
});

test('S11 second lunch on the same working day gets no employer share', async () => {
  const { w, p } = await run('S11');
  assert.equal(shareCents(p.proposal, 'employer'), 0);
  assert.equal(shareCents(p.proposal, 'employee'), 1_300);
  assert.equal(p.state, 'draft');
  const proposal = w.trace.events.filter((e) => e.event === 'proposal').at(-1);
  assert.equal(proposal?.detail?.ineligibleReason, 'daily_purchase_limit_reached');
});

test('S12 employer decline never shifts the share onto the employee', async () => {
  const { w, p } = await run('S12');
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.ok(p.legs.every((l) => l.rejectReason?.startsWith('group_rejected')));
});

test('S13 bill split: three shares in integer cents settle as one transaction', async () => {
  const { w, p } = await run('S13');
  assert.equal(p.state, 'completed');
  assert.deepEqual(p.legs.map((l) => l.amountCents), [1_334, 1_333, 1_333]);
  assert.equal(w.backend.account(MERCHANT_B).linkedBankCents, 4_000);
});

test('S14 group gift: a declined share is not re-split across the others', async () => {
  const { w, p } = await run('S14');
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(COLLEAGUE_1).deCents, 2_000);
  assert.ok(p.legs.every((l) => l.rejectReason?.startsWith('group_rejected')));
});

test('S15 multi-payee: one approval, one leg per payee, each with its own reference', async () => {
  const { w, p } = await run('S15');
  assert.equal(p.state, 'completed');
  assert.equal(p.approvals.length, 1);
  assert.deepEqual(p.legs.map((l) => [l.payeeId, l.amountCents]), [[MERCHANT_A, 1_250], [PLATFORM, 250]]);
  assert.equal(new Set(p.legs.map((l) => l.executionRef)).size, 2);
  assert.equal(w.backend.account(PLATFORM).linkedBankCents, 250);
});

test('invariant: no scenario completes a purchase whose legs do not all settle', async () => {
  for (const s of scenarios) {
    const { p } = await s.run();
    if (p.state === 'completed') {
      const sum = p.legs.reduce((a, l) => a + l.amountCents, 0);
      assert.equal(sum, p.proposal.totalCents, s.id);
      assert.ok(p.legs.every((l) => l.status === 'settled' || l.status === 'returned'), s.id);
    }
  }
});
