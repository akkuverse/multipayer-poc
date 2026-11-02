// One test per scenario, plus a cross-scenario invariant test encoding the
// core safety rule. Amounts are integer euro cents; see src/scenarios.ts for
// the fixture world each scenario builds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, world, lunch, approveAs, updateEmployeeMandate, autopayWorld, autopaySession, OFFER_AUTO_9, EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, MERCHANT_B, MERCHANT_C, PLATFORM } from '../src/scenarios.ts';
import { shareCents } from '../src/core/coordinator.ts';

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
  assert.deepEqual(states, ['awaiting_approvals', 'ready', 'recovery_required', 'cancelled']);
  const flagged = w.trace.events.find((e) => e.event === 'state' && e.detail?.to === 'recovery_required');
  assert.equal(flagged?.detail?.outstandingCents, 500);
  assert.equal(p.state, 'cancelled');
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000, 'employer contribution returned');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0);
});

test('S04 atomic settlement: same failure moves no money', async () => {
  const { w, p } = await run('S04');
  assert.equal(p.state, 'failed');
  assert.equal(w.coordinator.outstandingCents(p.purchaseId), 0);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 300);
});

test('S05 recovery unsupported: purchase never reads as complete, EUR 5 stays outstanding', async () => {
  const { w, p } = await run('S05');
  assert.equal(p.state, 'recovery_required');
  assert.equal(p.returnStatus, 'unsupported');
  assert.equal(w.coordinator.outstandingCents(p.purchaseId), 500);
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
  assert.equal(p.authorizations[0]?.basis === 'device' ? p.authorizations[0].approval.payload.proposalVersion : undefined, 3);
  assert.equal(w.backend.account(MERCHANT_C).linkedBankCents, 1_300);
  assert.equal(w.trace.events.filter((e) => e.event === 'approval_invalidated').length, 1);
});

test('S07 stale approval cannot authorise the EUR 14 offer', async () => {
  const w = world();
  const p = lunch(w);
  const stale = approveAs(w, p);
  w.coordinator.changeOffer(p.purchaseId, { merchantId: 'merchant-b', totalCents: 1_400, expiresAt: 100 });
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.employeeAssessment?.authZone, 'Exception');
  assert.equal(shareCents(p.proposal, 'employee'), 900);
  assert.throws(() => w.coordinator.approve(p.purchaseId, stale));
  // An ordinary signature cannot authorise over the standing maximum.
  assert.throws(() => approveAs(w, p), /does not match/);
  await assert.rejects(() => w.coordinator.submit(p.purchaseId, 'atomic'));
  // Only a signed revision of the standing maximum lets the EUR 9 share proceed.
  updateEmployeeMandate(w, { maxCents: 900 });
  approveAs(w, p);
  await w.coordinator.submit(p.purchaseId, 'atomic');
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
  assert.deepEqual(states, ['awaiting_approvals', 'ready', 'pending', 'completed']);
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
  assert.equal(p.state, 'awaiting_approvals');
  const proposal = w.trace.events.filter((e) => e.event === 'proposal').at(-1);
  assert.equal(proposal?.detail?.purchaseId, 'purchase-2', 'the second lunch owns this proposal event');
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
  assert.equal(p.authorizations.length, 1);
  assert.deepEqual(p.legs.map((l) => [l.payeeId, l.amountCents]), [[MERCHANT_A, 1_250], [PLATFORM, 250]]);
  assert.equal(new Set(p.legs.map((l) => l.executionRef)).size, 2);
  assert.equal(w.backend.account(PLATFORM).linkedBankCents, 250);
});

test('S16 per-PSP atomic: the first PSP sees pending until the group completes', async () => {
  const { w, p } = await run('S16');
  const states = w.trace.events.filter((e) => e.event === 'state').map((e) => e.detail?.to);
  assert.deepEqual(states, ['awaiting_approvals', 'ready', 'pending', 'completed']);
  assert.ok(w.trace.events.some((e) => e.event === 'group_assembled'));
  assert.deepEqual(w.trace.events.filter((e) => e.event === 'forward').map((e) => e.actor), ['psp-employee-1', 'psp-employer-1']);
});

test('S17 per-PSP atomic, employer PSP down: the group expires and no money moves', async () => {
  const { w, p } = await run('S17');
  assert.equal(p.state, 'failed');
  assert.ok(w.trace.events.some((e) => e.event === 'group_expired'));
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
});

test('S18 per-PSP independent, employer PSP down: the employee leg is returned, never topped up', async () => {
  const { w, p } = await run('S18');
  const states = w.trace.events.filter((e) => e.event === 'state').map((e) => e.detail?.to);
  assert.deepEqual(states, ['awaiting_approvals', 'ready', 'recovery_required', 'cancelled']);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.executionCount(), 1);
});

test('S19 auto within terms: EUR 4 pays with no tap; one receipt, no device signature', async () => {
  const { w, p } = await run('S19');
  assert.equal(p.state, 'completed');
  assert.deepEqual(p.legs.map((l) => [l.leg, l.amountCents, l.status]), [
    ['employee', 400, 'settled'],
    ['employer', 500, 'settled'],
  ]);
  assert.equal(p.receipt?.mandateVersion, 1);
  assert.equal(p.receipt?.receiptAt, 10);
  assert.equal(p.receipt?.disputeUntil, 1_450);
  assert.equal(p.receipt?.debitCents, 400);
  assert.equal(w.trace.events.filter((e) => e.event === 'autopay_receipt').length, 1);
  // Only standing-mandate evidence funded it — no per-purchase signature.
  assert.deepEqual(
    w.trace.events.filter((e) => e.event === 'approval_recorded').map((e) => e.detail?.basis),
    ['mandate'],
  );
  assert.equal(
    w.trace.events.find((e) => e.event === 'approval_recorded')?.detail?.now,
    10,
    'the recorded evidence carries simulated time',
  );
  assert.ok(!w.trace.events.some((e) => e.event === 'presenter_approve'));
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_600);
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 900);
});

test('S19 per-PSP variant: the same selection completes across two runner steps', async () => {
  const w = autopayWorld({ initiation: 'per_payer_psp' });
  const session = autopaySession(w, 'purchase-1');
  assert.equal(session.agent.selectOffer(OFFER_AUTO_9.offerRef).value.payer.state, 'ready');
  // The employee PSP's leg arrives first and sees the group incomplete.
  assert.equal((await session.runner.step()).value.payer.state, 'pending');
  assert.equal((await session.runner.step()).value.payer.state, 'completed');
  const p = session.userFlow.snapshot();
  assert.equal(p.receipt?.mandateVersion, 1);
  assert.deepEqual(w.trace.events.filter((e) => e.event === 'forward').map((e) => e.actor), [
    'psp-employee-1',
    'psp-employer-1',
  ]);
  assert.ok(w.trace.events.some((e) => e.event === 'group_assembled'));
  assert.equal(w.trace.events.filter((e) => e.event === 'autopay_receipt').length, 1);
  assert.equal(w.backend.executionCount(), 2);
});

test('S19 capability-off variant: the same selection stops for a device signature', async () => {
  // Capability absent on the employee's route only: even with every other
  // payer capable, automatic payment cannot initiate.
  const w = autopayWorld({ supportsMandatePayments: (id) => id !== EMPLOYEE });
  const session = autopaySession(w, 'purchase-1');
  const sel = session.agent.selectOffer(OFFER_AUTO_9.offerRef).value;
  assert.equal(sel.authZone, 'Confirm');
  assert.equal(sel.autoPayBlockedReason, 'psp_unsupported');
  await session.runner.step();
  assert.equal(session.userFlow.snapshot().state, 'awaiting_approvals');
  session.userFlow.approve(1);
  await session.userFlow.submit(1);
  const p = session.userFlow.snapshot();
  assert.equal(p.state, 'completed');
  assert.equal(p.receipt, undefined);
  assert.equal(p.authorizations[0]?.basis, 'device');
  // No mandate evidence, reservation or Auto receipt was ever produced.
  assert.ok(!w.trace.events.some((e) => e.event.startsWith('autopay_')));
  assert.ok(!w.trace.events.some((e) => e.event === 'approval_recorded' && e.detail?.basis === 'mandate'));
});

test('S20 new merchant: Confirm for an untrusted merchant; a device signature completes; nothing is published', async () => {
  const { w, p } = await run('S20');
  assert.equal(p.state, 'completed');
  assert.equal(p.authorizations[0]?.basis, 'device');
  assert.equal(p.employeeAssessment?.autoPayBlockedReason, 'untrusted_merchant');
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 99_500);
  // The runner observed the awaiting purchase without dispatching it.
  assert.ok(w.trace.events.some((e) => e.event === 'presenter_step'));
  // Setup remains the only publication; merchant-b stays untrusted.
  assert.equal(w.trace.events.filter((e) => e.event === 'employee_mandate_published').length, 1);
  assert.deepEqual(w.coordinator.employeeMandate(EMPLOYEE)!.payload.trustedMerchants, [MERCHANT_A]);
});

test('S21 over-auto: the EUR 8 debit needs a tap for over_auto_limit, not cap or capability', async () => {
  const { w, p } = await run('S21');
  assert.equal(p.state, 'completed');
  assert.equal(p.employeeAssessment?.autoPayBlockedReason, 'over_auto_limit');
  assert.equal(p.authorizations[0]?.basis, 'device');
  assert.ok(!w.trace.events.some((e) => e.event.startsWith('autopay_')));
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_200);
});

test('S22 one-off exception: plain approval refused; a signed EUR 1 exception pays once; the maximum is unchanged', async () => {
  const { w, p } = await run('S22');
  assert.equal(p.state, 'completed');
  const auth = p.authorizations[0];
  assert.equal(auth.basis, 'exception');
  assert.equal(auth.basis === 'exception' ? auth.approval.payload.overByCents : undefined, 100);
  const refused = w.trace.events.find((e) => e.event === 'approval_rejected');
  assert.equal(refused?.detail?.reason, 'exceeds_mandate');
  assert.equal(refused?.detail?.now, 10, 'the rejection records simulated time');
  // The next purchase — no benefit left that day — debits EUR 11 fully and
  // lands in Exception again: the one-off exception raised nothing.
  const zone = w.trace.events.find((e) => e.event === 'auth_zone' && e.detail?.purchaseId === 'purchase-2');
  assert.equal(zone?.detail?.authZone, 'Exception');
  assert.equal(zone?.detail?.employeeDebitCents, 1_100);
  assert.equal(zone?.detail?.now, 10, 'the zone assessment records simulated time');
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)!.payload.maxCents, 1_000);
  assert.ok(!w.trace.events.some((e) => e.event.startsWith('autopay_')));
  assert.equal(w.backend.account(EMPLOYEE).deCents, 900);
});

test('S23 monthly cap: EUR 4 automatic then EUR 4 manual under the EUR 6 cap, benefit intact', async () => {
  const { w, p } = await run('S23');
  assert.equal(p.state, 'completed');
  assert.equal(p.employeeAssessment?.autoPayBlockedReason, 'monthly_cap');
  assert.equal(shareCents(p.proposal, 'employer'), 500);
  assert.equal(p.authorizations[0]?.basis, 'device');
  // Only the first purchase ever held automatic budget.
  const reserved = w.trace.events.filter((e) => e.event === 'autopay_reserved');
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].detail?.purchaseId, 'purchase-1');
  assert.ok(!w.trace.events.some((e) => e.event.startsWith('autopay_') && e.detail?.purchaseId === 'purchase-2'));
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_200);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 99_000);
  assert.equal(w.backend.executionCount(), 4);
});

test('S24 offer change before the step: mandate evidence invalidated; the EUR 8 proposal waits, then pays manually', async () => {
  const { w, p } = await run('S24');
  assert.equal(p.state, 'completed');
  assert.equal(p.proposal.version, 2);
  assert.equal(p.authorizations[0]?.basis, 'device');
  const invalidated = w.trace.events.find((e) => e.event === 'approval_invalidated' && e.detail?.basis === 'mandate');
  assert.ok(invalidated, 'the mandate evidence was invalidated');
  assert.equal(invalidated?.detail?.now, 10, 'the invalidation records simulated time');
  assert.ok(!w.trace.events.some((e) => e.event.startsWith('autopay_')));
  // The only submission followed the v2 device signature — the runner sent
  // nothing while the purchase waited without valid authority.
  const deviceSeq = w.trace.events.find((e) => e.event === 'approval_recorded' && e.detail?.basis === 'device')!.seq;
  const submitSeq = w.trace.events.find((e) => e.event === 'submit' && e.actor === 'coordinator')!.seq;
  assert.ok(submitSeq > deviceSeq);
  assert.equal(w.backend.executionCount(), 2);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_200);
});

test('S25 second unsubsidised lunch: EUR 9 is Confirm, the EUR 13 variant is Exception, the first purchase is unchanged', async () => {
  const { w, p } = await run('S25');
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.proposal.version, 2);
  assert.equal(p.employeeAssessment?.authZone, 'Exception');
  assert.equal(shareCents(p.proposal, 'employer'), 0);
  const zones = w.trace.events
    .filter((e) => e.event === 'auth_zone' && e.detail?.purchaseId === 'purchase-2')
    .map((e) => [e.detail?.authZone, e.detail?.reason]);
  assert.deepEqual(zones, [
    ['Confirm', 'over_auto_limit'],
    ['Exception', 'exceeds_mandate'],
  ]);
  // The completed first purchase was never repriced.
  assert.ok(
    w.trace.events.every(
      (e) => e.event !== 'auth_zone' || e.detail?.purchaseId !== 'purchase-1' || e.detail?.proposalVersion === 1,
    ),
  );
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_600);
});

test('S26 dispute: each share returns to its payer; the automatic booking releases exactly once', async () => {
  const { w, p } = await run('S26');
  assert.equal(p.state, 'completed');
  assert.equal(p.returnStatus, 'completed');
  assert.equal(p.dispute?.outcome, 'returned');
  assert.equal(w.trace.events.filter((e) => e.event === 'dispute_opened').length, 1);
  const released = w.trace.events.filter((e) => e.event === 'autopay_released');
  assert.equal(released.length, 1);
  assert.equal(released[0].detail?.cents, 400);
  assert.equal(released[0].detail?.retainedCents, 0);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0);
});

test('S27 blocked merchant: the replacement selection is refused; the retained proposal is unchanged', async () => {
  const { w, p } = await run('S27');
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.proposal.version, 1);
  assert.equal(p.proposal.merchantId, MERCHANT_B);
  assert.equal(p.authorizations.length, 0);
  const rejected = w.trace.events.find((e) => e.event === 'proposal_rejected');
  assert.equal(rejected?.detail?.reason, 'blocked_merchant');
  assert.equal(rejected?.detail?.merchantId, MERCHANT_C);
  assert.equal(rejected?.detail?.now, 10, 'the rejection records simulated time');
  assert.equal(w.backend.executionCount(), 0);
});

test('S28 no mandate capability: the otherwise eligible selection waits for a device signature', async () => {
  const { w, p } = await run('S28');
  assert.equal(p.state, 'completed');
  assert.equal(p.employeeAssessment?.autoPayBlockedReason, 'psp_unsupported');
  assert.equal(p.authorizations[0]?.basis, 'device');
  assert.equal(p.receipt, undefined);
  assert.ok(!w.trace.events.some((e) => e.event.startsWith('autopay_')));
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_600);
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
