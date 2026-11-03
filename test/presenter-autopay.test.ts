// The trusted presenter runner and the employee controls on a session: an
// agent selection may complete with no tap under signed standing terms, but
// the runner — never the agent — is what advances it, and only under
// currently valid mandate authority. Manual purchases are never initiated;
// standing-terms changes and disputes stay behind the trusted user flow and
// the device's own signatures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  world,
  advance,
  approveAs,
  updateMandate,
  updateEmployeeMandate,
  createScenarioSession,
  AUTO_EMPLOYEE_TERMS,
  EMPLOYEE,
  EMPLOYER,
  MERCHANT_A,
  MERCHANT_B,
  MERCHANT_C,
} from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';
import { createPresenterSession } from '../src/presenter/session.ts';
import type { AgentGrant, CatalogOffer, PresenterSession } from '../src/presenter/session.ts';
import { signPayload } from '../src/core/signing.ts';
import type { EmployeeMandate, EmployerMandate } from '../src/core/types.ts';
import type { Account } from '../src/settlement/mock-backend.ts';

// A EUR 9 lunch splits EUR 4 employee + EUR 5 employer — inside the AUTO
// fixture's EUR 6 per-purchase automatic limit at trusted merchant-a.
const AUTO_OFFER: CatalogOffer = {
  offerRef: 'offer-auto',
  merchantId: MERCHANT_A,
  title: 'Vegetarian lunch bowl',
  tags: ['lunch', 'vegetarian'],
  priceCents: 900,
  availability: { from: 0, until: 600 },
  source: 'synthetic-menu-feed',
  walkingMinutes: 5,
};

// EUR 15 at the same trusted merchant: EUR 10 employee debit is above the
// EUR 6 automatic limit but inside the EUR 10 standing maximum — Confirm.
const OVER_OFFER: CatalogOffer = {
  offerRef: 'offer-over',
  merchantId: MERCHANT_A,
  title: 'Vegetarian lunch plate',
  tags: ['lunch', 'vegetarian'],
  priceCents: 1_500,
  availability: { from: 0, until: 600 },
  source: 'synthetic-menu-feed',
  walkingMinutes: 7,
};

// EUR 16 at the same trusted merchant: EUR 11 exceeds the standing EUR 10
// maximum — a signed one-off exception or nothing.
const EXCEPTION_OFFER: CatalogOffer = {
  offerRef: 'offer-exception',
  merchantId: MERCHANT_A,
  title: 'Vegetarian tasting menu',
  tags: ['lunch', 'vegetarian'],
  priceCents: 1_600,
  availability: { from: 0, until: 600 },
  source: 'synthetic-menu-feed',
  walkingMinutes: 9,
};

// The same EUR 9 lunch at an eligible but untrusted merchant.
const NEW_MERCHANT_OFFER: CatalogOffer = {
  offerRef: 'offer-new-merchant',
  merchantId: MERCHANT_B,
  title: 'Vegetarian soup and salad',
  tags: ['lunch', 'vegetarian'],
  priceCents: 900,
  availability: { from: 0, until: 600 },
  source: 'synthetic-menu-feed',
  walkingMinutes: 6,
};

// The same EUR 9 lunch at the merchant blocked in some fixture variants.
const BLOCKED_MERCHANT_OFFER: CatalogOffer = {
  offerRef: 'offer-blocked-merchant',
  merchantId: MERCHANT_C,
  title: 'Vegetarian wrap',
  tags: ['lunch', 'vegetarian'],
  priceCents: 900,
  availability: { from: 0, until: 600 },
  source: 'synthetic-menu-feed',
  walkingMinutes: 4,
};

const TEST_CATALOG: CatalogOffer[] = [AUTO_OFFER, OVER_OFFER, EXCEPTION_OFFER, NEW_MERCHANT_OFFER, BLOCKED_MERCHANT_OFFER];

interface Setup {
  w: World;
  session: PresenterSession;
}

const setup = (
  opts: {
    employeeMandate?: EmployeeMandate | null;
    employer?: Partial<EmployerMandate>;
    employee?: Partial<Account>;
    supportsMandatePayments?: boolean;
    catalog?: CatalogOffer[];
    grantExpiresAt?: number;
    initiation?: 'per_payer_psp' | 'coordinator_as_psp' | 'test_bypass_psp';
  } = {},
): Setup => {
  const w = world(opts.employee ?? {}, opts.employer ?? {}, {
    employeeMandate: opts.employeeMandate === undefined ? AUTO_EMPLOYEE_TERMS : opts.employeeMandate,
    supportsMandatePayments: opts.supportsMandatePayments ?? true,
    initiation: opts.initiation,
  });
  const session = createScenarioSession(w, {
    purchaseId: 'purchase-1',
    catalog: opts.catalog ?? TEST_CATALOG,
    ...(opts.grantExpiresAt !== undefined ? { grantExpiresAt: opts.grantExpiresAt } : {}),
  });
  return { w, session };
};

test('a step before any selection refuses no_proposal and is audited', async () => {
  const { w, session } = setup();
  await assert.rejects(session.runner.step(), /^Error: no_proposal$/);
  const r = w.trace.events.at(-1)!;
  assert.equal(r.origin, 'LOCAL');
  assert.equal(r.event, 'presenter_refused');
  assert.equal(r.detail?.op, 'step');
  assert.equal(r.detail?.channel, 'user');
  assert.equal(r.detail?.reason, 'no_proposal');
  assert.equal(w.backend.executionCount(), 0);
});

test('an Auto selection completes on a trusted runner step with no device signature', async () => {
  const { w, session } = setup();
  const sel = session.agent.selectOffer(AUTO_OFFER.offerRef);
  const v = sel.value;
  // The accepted selection retained standing-mandate authority: ready with
  // no tap, and the agent still saw only a safe projection.
  assert.equal(v.payer.state, 'ready');
  assert.equal(v.authZone, 'Auto');
  assert.equal(v.authorizations.length, 1);
  assert.equal(v.authorizations[0].basis, 'mandate');
  assert.equal(v.authorizations[0].mandateVersion, 1);
  assert.equal(v.authorizations[0].currentlyValid, true);

  const step = await session.runner.step();
  const done = step.value;
  assert.equal(done.payer.state, 'completed');
  assert.equal(done.payer.ownCents, 400);
  assert.equal(done.payer.othersCents, 500);
  assert.equal(done.payer.authorizationBasis, 'mandate');
  // The retained receipt: observation time, fixed dispute deadline and the
  // standing-terms revision that paid — no mandate reference or signature.
  assert.deepEqual(done.payer.receipt, { receiptAt: 10, disputeUntil: 1_450, mandateVersion: 1 });
  // One purchase was ever proposed; the step synthesized no second one.
  assert.equal(w.trace.events.filter((e) => e.event === 'proposal').length, 1);

  // The agent handle is exactly the four delegated operations: no runner,
  // approval, submission, terms or dispute surface exists on it.
  assert.deepEqual(Object.keys(session.agent).sort(), ['discover', 'evaluate', 'explain', 'selectOffer']);
  for (const m of ['step', 'approve', 'submit', 'reconcile', 'resubmit', 'recover', 'refund', 'dispute', 'snapshot', 'terms', 'revokeMandate', 'trustMerchant']) {
    assert.equal((session.agent as unknown as Record<string, unknown>)[m], undefined, m);
  }

  // No device signature exists anywhere: one mandate-basis record and no
  // user-channel approval; the step is a trusted observation of its own.
  assert.ok(!w.trace.events.some((e) => e.event === 'presenter_approve'));
  assert.deepEqual(
    w.trace.events.filter((e) => e.event === 'approval_recorded').map((e) => e.detail?.basis),
    ['mandate'],
  );
  assert.equal(w.trace.events.filter((e) => e.event === 'presenter_select').length, 1, 'the runner made no new selection');
  const stepEvent = w.trace.events.at(-1)!;
  assert.equal(stepEvent.event, 'presenter_step');
  assert.equal(stepEvent.detail?.channel, 'user');
  assert.equal(stepEvent.detail?.onBehalfOf, undefined);

  assert.equal(w.trace.events.filter((e) => e.event === 'autopay_receipt').length, 1);
  assert.equal(w.backend.executionCount(), 2);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_600);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 99_500);
  // The step's evidence chains to the coordinator events behind it.
  const stepEvents = step.eventSeqs.map((s) => w.trace.events[s - 1]);
  assert.ok(stepEvents.some((e) => e.actor === 'coordinator' && e.event === 'submit'));
  assert.ok(stepEvents.some((e) => e.event === 'autopay_receipt'));
});

test('the no-tap session contract holds under per-PSP initiation: two steps to completion', async () => {
  const { w, session } = setup({ initiation: 'per_payer_psp' });
  // The pending now comes from a lost response, not first-arrival: the
  // employer leg's outcome is deferred, so no leg reports a conclusive
  // outcome and nothing resolves the group inside the same send.
  w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
  session.agent.selectOffer(AUTO_OFFER.offerRef);
  assert.equal((await session.runner.step()).value.payer.state, 'pending');
  // The runner reconciles through each PSP's own status seam — no new
  // purchase, approval or retry keys are invented.
  const done = await session.runner.step();
  assert.equal(done.value.payer.state, 'completed');
  assert.equal(done.value.payer.ownCents, 400);
  assert.equal(done.value.payer.receipt?.mandateVersion, 1);
  assert.deepEqual(w.trace.events.filter((e) => e.event === 'forward').map((e) => e.actor), [
    'psp-employee-1',
    'psp-employer-1',
  ]);
  assert.ok(w.trace.events.some((e) => e.event === 'group_assembled'));
  assert.equal(w.trace.events.filter((e) => e.event === 'proposal').length, 1);
  assert.equal(w.trace.events.filter((e) => e.event === 'autopay_receipt').length, 1);
  assert.equal(w.backend.executionCount(), 2);
});

test('repeated steps after completion are harmless observations', async () => {
  const { w, session } = setup();
  session.agent.selectOffer(AUTO_OFFER.offerRef);
  await session.runner.step();
  const seqs = w.trace.events.length;
  const again = await session.runner.step();
  assert.equal(again.value.payer.state, 'completed');
  assert.equal(again.value.payer.receipt?.disputeUntil, 1_450);
  // No second payment, no second receipt, no replay.
  assert.equal(w.backend.executionCount(), 2);
  assert.equal(w.trace.events.filter((e) => e.event === 'autopay_receipt').length, 1);
  assert.ok(!w.trace.events.slice(seqs).some((e) => e.event === 'submit' || e.event === 'resubmit_same_keys'));
});

test('the runner never initiates a manual purchase — not even an approved ready one', async () => {
  const { w, session } = setup();
  const sel = session.agent.selectOffer(NEW_MERCHANT_OFFER.offerRef).value;
  assert.equal(sel.payer.state, 'awaiting_approvals');
  assert.equal(sel.authZone, 'Confirm');
  assert.equal(sel.autoPayBlockedReason, 'untrusted_merchant');
  const idle = await session.runner.step();
  assert.equal(idle.value.payer.state, 'awaiting_approvals');
  assert.equal(w.backend.executionCount(), 0);
  // A signed ready purchase under device authority stays manual too: the
  // runner submits only under standing-mandate evidence.
  session.userFlow.approve(sel.proposalVersion);
  const ready = await session.runner.step();
  assert.equal(ready.value.payer.state, 'ready');
  assert.equal(ready.value.payer.authorizationBasis, 'device');
  assert.equal(w.backend.executionCount(), 0);
  const done = await session.userFlow.submit(sel.proposalVersion);
  assert.equal(done.value.payer.state, 'completed');
  // A device-funded completion earns no automatic receipt or budget entry.
  assert.equal(done.value.payer.receipt, undefined);
  assert.ok(!w.trace.events.some((e) => e.event === 'autopay_receipt' || e.event === 'autopay_reserved'));
});

test('an offer replaced before the step drops the queued automatic authorization', async () => {
  const { w, session } = setup();
  const v1 = session.agent.selectOffer(AUTO_OFFER.offerRef).value;
  assert.equal(v1.authorizations[0].basis, 'mandate');
  // S24-style: the Auto-authorized v1 is replaced before the runner steps.
  // The new version awaits ordinary authority and the old evidence is gone.
  const v2 = session.agent.selectOffer(OVER_OFFER.offerRef).value;
  assert.equal(v2.proposalVersion, 2);
  assert.equal(v2.authZone, 'Confirm');
  assert.equal(v2.autoPayBlockedReason, 'over_auto_limit');
  assert.equal(v2.payer.state, 'awaiting_approvals');
  assert.ok(w.trace.events.some((e) => e.event === 'approval_invalidated' && e.detail?.basis === 'mandate'));
  const step = await session.runner.step();
  assert.equal(step.value.payer.state, 'awaiting_approvals');
  assert.equal(step.value.authorizations.length, 0);
  assert.equal(w.backend.executionCount(), 0);
  assert.ok(!w.trace.events.some((e) => e.event === 'autopay_reserved'));
});

test('selecting a blocked merchant refuses and preserves the earlier proposal', async () => {
  const { w, session } = setup({ employeeMandate: { ...AUTO_EMPLOYEE_TERMS, blockedMerchants: [MERCHANT_C] } });
  const v1 = session.agent.selectOffer(AUTO_OFFER.offerRef).value;
  assert.equal(v1.proposalVersion, 1);
  assert.throws(() => session.agent.selectOffer(BLOCKED_MERCHANT_OFFER.offerRef), /merchant blocked/);
  assert.ok(w.trace.events.some((e) => e.event === 'proposal_rejected' && e.detail?.reason === 'blocked_merchant'));
  // The retained proposal is unchanged: still v1 at the trusted merchant.
  const view = session.userFlow.explain().value;
  assert.equal(view.proposalVersion, 1);
  assert.equal(view.payer.state, 'ready');
  assert.equal(w.backend.executionCount(), 0);
});

test('a replacement stopped by employer funding loss still identifies the retained offer', () => {
  const { w, session } = setup();
  const first = session.agent.selectOffer(AUTO_OFFER.offerRef).value;
  updateMandate(w, { revoked: true });
  const result = session.agent.selectOffer(NEW_MERCHANT_OFFER.offerRef).value;
  for (const view of [result, session.agent.explain().value]) {
    assert.equal(view.payer.state, 'failed');
    assert.equal(view.offerRef, first.offerRef);
    assert.equal(view.offer.merchantId, MERCHANT_A);
    assert.equal(view.payer.merchantId, MERCHANT_A);
    assert.equal(view.proposalVersion, first.proposalVersion);
    assert.equal(view.payer.ownCents, 400);
  }
  assert.equal(w.backend.executionCount(), 0);
});

test('with mandate capability off the same selection waits for a device signature', async () => {
  const { w, session } = setup({ supportsMandatePayments: false });
  const sel = session.agent.selectOffer(AUTO_OFFER.offerRef).value;
  assert.equal(sel.authZone, 'Confirm');
  assert.equal(sel.autoPayBlockedReason, 'psp_unsupported');
  const step = await session.runner.step();
  assert.equal(step.value.payer.state, 'awaiting_approvals');
  assert.equal(step.value.authorizations.length, 0);
  assert.equal(w.backend.executionCount(), 0);
  session.userFlow.approve(1);
  const done = await session.userFlow.submit(1);
  assert.equal(done.value.payer.state, 'completed');
  assert.equal(done.value.payer.receipt, undefined);
  // Capability off: no mandate authority, no reservation, no Auto receipt.
  assert.ok(!w.trace.events.some((e) => ['autopay_reserved', 'autopay_consumed', 'autopay_receipt'].includes(e.event)));
});

test('an offer that expired before the step fails the purchase instead of paying', async () => {
  const short: CatalogOffer = { ...AUTO_OFFER, availability: { from: 0, until: 50 } };
  const { w, session } = setup({ catalog: [short] });
  session.agent.selectOffer(short.offerRef);
  advance(w, 60);
  const step = await session.runner.step();
  assert.equal(step.value.payer.state, 'failed');
  assert.ok(step.value.reasons.includes('offer_expired'));
  assert.equal(w.backend.executionCount(), 0);
  assert.ok(!w.trace.events.some((e) => e.event === 'autopay_reserved'));
});

test('a lost submission response resolves through the frozen intent on the next step', async () => {
  const { w, session } = setup();
  const realSubmit = w.backend.submit.bind(w.backend);
  let lose = true;
  w.backend.submit = async (req) => {
    const r = await realSubmit(req);
    if (lose) {
      lose = false;
      throw new Error('synthetic lost submission response');
    }
    return r;
  };
  session.agent.selectOffer(AUTO_OFFER.offerRef);
  const first = await session.runner.step();
  assert.equal(first.value.payer.state, 'pending');
  // The leg whose response was lost came back with no execution reference,
  // so a status query cannot poll one; the replay reuses the frozen intent
  // — same keys, never new ones. The sibling whose own response did arrive
  // settled conclusively inside the same send.
  const legsNow = session.userFlow.snapshot().legs;
  assert.equal(legsNow[0].executionRef, undefined, 'the lost response carried no execution reference');
  assert.equal(legsNow[1].status, 'settled');
  const second = await session.runner.step();
  assert.equal(second.value.payer.state, 'completed');
  assert.equal(w.backend.executionCount(), 2);
  assert.ok(w.trace.events.some((e) => e.event === 'resubmit_same_keys' || e.event === 'duplicate_request_ignored'));
  assert.equal(w.trace.events.filter((e) => e.event === 'autopay_receipt').length, 1);
});

test('a step holds the session async guard: nothing overlaps it', async () => {
  const { w, session } = setup();
  session.agent.selectOffer(AUTO_OFFER.offerRef);
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  const realSubmit = w.coordinator.submit.bind(w.coordinator);
  w.coordinator.submit = (p, request) => gate.then(() => realSubmit(p, request));
  const stepped = session.runner.step();
  // Every sync operation refuses while the step is in flight, audited like
  // the other in-flight refusals; the async ones reject identically.
  assert.throws(() => session.userFlow.selectOffer(NEW_MERCHANT_OFFER.offerRef), /^Error: operation_in_progress$/);
  assert.throws(() => session.userFlow.approve(1), /^Error: operation_in_progress$/);
  assert.throws(() => session.userFlow.explain(), /^Error: operation_in_progress$/);
  assert.throws(() => session.userFlow.snapshot(), /^Error: operation_in_progress$/);
  assert.throws(() => session.userFlow.terms(), /^Error: operation_in_progress$/);
  // The terms conveniences share checkFree: one representative stands for both.
  assert.throws(() => session.userFlow.trustMerchant(MERCHANT_B), /^Error: operation_in_progress$/);
  assert.throws(() => session.agent.selectOffer(NEW_MERCHANT_OFFER.offerRef), /^Error: operation_in_progress$/);
  await assert.rejects(session.userFlow.submit(1), /^Error: operation_in_progress$/);
  await assert.rejects(session.userFlow.reconcile(), /^Error: operation_in_progress$/);
  await assert.rejects(session.userFlow.dispute(), /^Error: operation_in_progress$/);
  await assert.rejects(session.runner.step(), /^Error: operation_in_progress$/);
  assert.equal(w.backend.executionCount(), 0);
  release();
  const done = await stepped;
  assert.equal(done.value.payer.state, 'completed');
});

test('a user operation holds the same guard: a step refuses while a submit is in flight', async () => {
  const { w, session } = setup();
  session.agent.selectOffer(AUTO_OFFER.offerRef);
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  const realSubmit = w.coordinator.submit.bind(w.coordinator);
  w.coordinator.submit = (p, request) => gate.then(() => realSubmit(p, request));
  const submitted = session.userFlow.submit(1);
  // The guard runs in both directions: the runner cannot interleave a step
  // into a manual submission's backend round trip.
  await assert.rejects(session.runner.step(), /^Error: operation_in_progress$/);
  const refusal = w.trace.events.at(-1)!;
  assert.equal(refusal.event, 'presenter_refused');
  assert.equal(refusal.detail?.op, 'step');
  assert.equal(refusal.detail?.reason, 'operation_in_progress');
  release();
  const done = await submitted;
  assert.equal(done.value.payer.state, 'completed');
  assert.equal(w.backend.executionCount(), 2);
});

test('the runner is trusted: an expired agent grant does not gate it', async () => {
  const { w, session } = setup({ grantExpiresAt: 50 });
  session.agent.selectOffer(AUTO_OFFER.offerRef);
  advance(w, 60);
  assert.throws(() => session.agent.explain(), /presenter access denied/);
  const step = await session.runner.step();
  assert.equal(step.value.payer.state, 'completed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_600);
});

test('the trusted terms view and publication conveniences sign on the device', () => {
  const { w, session } = setup();
  const t = session.userFlow.terms().value;
  assert.equal(t?.version, 1);
  assert.equal(t?.maxCents, 1_000);
  assert.equal(t?.autoPayMaxCents, 600);
  assert.equal(t?.autoPayMonthlyCents, 3_000);
  assert.deepEqual(t?.trustedMerchants, [MERCHANT_A]);
  assert.deepEqual(t?.blockedMerchants, []);
  assert.equal(t?.validUntil, 1_000);
  assert.equal(t?.revoked, false);
  // The recipient-safe view carries no mandate reference, signature or key.
  const serialized = JSON.stringify(t);
  for (const leak of ['mandateRef', 'mandate-', 'signature', 'keyId', 'employee-mandate-1']) {
    assert.ok(!serialized.includes(leak), `terms view leaks ${leak}`);
  }
  // Mutating the projection cannot rewrite the accepted record.
  t!.maxCents = 99_999;
  t!.trustedMerchants.push('mallory');
  assert.equal(session.userFlow.terms().value?.maxCents, 1_000);
  assert.deepEqual(session.userFlow.terms().value?.trustedMerchants, [MERCHANT_A]);

  // Trusting a new merchant signs and publishes the next revision.
  const trusted = session.userFlow.trustMerchant(MERCHANT_B).value;
  assert.equal(trusted.version, 2);
  assert.deepEqual(trusted.trustedMerchants, [MERCHANT_A, MERCHANT_B]);
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)?.payload.version, 2);
  // Trusting an already trusted merchant publishes nothing.
  const again = session.userFlow.trustMerchant(MERCHANT_A).value;
  assert.equal(again.version, 2);
  // Setup plus the trust-b revision: exactly two publications, nothing more.
  assert.equal(w.trace.events.filter((e) => e.event === 'employee_mandate_published').length, 2);
  // Revocation is its own signed revision, not an unsigned shortcut.
  const revoked = session.userFlow.revokeMandate().value;
  assert.equal(revoked.version, 3);
  assert.equal(revoked.revoked, true);
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)?.payload.revoked, true);
  assert.equal(w.trace.events.filter((e) => e.event === 'employee_mandate_revoked').length, 1);
});

test('revoking already-revoked terms is a harmless observation, not a second revision', () => {
  const { w, session } = setup();
  const first = session.userFlow.revokeMandate().value;
  assert.equal(first.revoked, true);
  const again = session.userFlow.revokeMandate().value;
  // The repeat returns the current verified record; nothing was republished.
  assert.equal(again.revoked, true);
  assert.equal(again.version, 2);
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)?.payload.version, 2);
  assert.equal(w.trace.events.filter((e) => e.event === 'employee_mandate_revoked').length, 1);
  assert.equal(w.trace.events.filter((e) => e.event === 'employee_mandate_published').length, 1);
});

test('a device callback that publishes nothing fails instead of returning stale terms', () => {
  const w = world({}, {}, { employeeMandate: AUTO_EMPLOYEE_TERMS, supportsMandatePayments: true });
  // A mis-wired device callback: it accepts the change but signs and
  // publishes nothing the coordinator would accept.
  const session = createPresenterSession({
    sessionId: 'session-miswired',
    purchaseId: 'purchase-1',
    agentId: 'agent-1',
    employeeId: EMPLOYEE,
    employeeFeeCents: 0,
    mandateRef: w.mandate.mandateRef,
    grant: signPayload(
      {
        grantRef: 'grant-miswired',
        agentId: 'agent-1',
        principalId: EMPLOYEE,
        sessionId: 'session-miswired',
        purchaseId: 'purchase-1',
        capabilities: ['discover', 'propose', 'explain'],
        expiresAt: 10_000,
      } satisfies AgentGrant,
      w.signers.get(EMPLOYEE)!,
    ),
    catalog: TEST_CATALOG,
    coordinator: w.coordinator,
    trace: w.trace,
    keys: w.keys,
    signAsPrincipal: (payload) => signPayload(payload, w.signers.get(EMPLOYEE)!),
    signAsAgent: (payload) => signPayload(payload, w.signers.get('agent-1')!),
    approveOnDevice: (p) => approveAs(w, p, EMPLOYEE),
    updateEmployeeMandateOnDevice: () => {},
  });
  assert.throws(() => session.userFlow.revokeMandate(), /^Error: mandate_revision_not_published$/);
  assert.throws(() => session.userFlow.trustMerchant(MERCHANT_B), /^Error: mandate_revision_not_published$/);
  // Neither refusal pretended a result: the accepted record is untouched.
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)?.payload.version, 1);
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)?.payload.revoked, false);
  assert.equal(w.trace.events.filter((e) => e.event === 'employee_mandate_published').length, 1);
  assert.ok(!w.trace.events.some((e) => e.event === 'employee_mandate_revoked'));
  assert.ok(
    w.trace.events.some((e) => e.event === 'presenter_refused' && e.detail?.reason === 'mandate_revision_not_published'),
  );
});

test('a blocked merchant cannot be trusted until its block is explicitly removed', () => {
  const { w, session } = setup({ employeeMandate: { ...AUTO_EMPLOYEE_TERMS, blockedMerchants: [MERCHANT_C] } });
  assert.throws(() => session.userFlow.trustMerchant(MERCHANT_C), /merchant_blocked/);
  assert.throws(() => session.userFlow.trustMerchant({ id: MERCHANT_C } as never), /non-empty string/);
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)?.payload.version, 1);
  // Setup only: the refused conveniences published nothing.
  assert.equal(w.trace.events.filter((e) => e.event === 'employee_mandate_published').length, 1);
});

test('without published terms the conveniences refuse and the step stays manual', async () => {
  const { w, session } = setup({ employeeMandate: null });
  assert.equal(session.userFlow.terms().value, undefined);
  assert.throws(() => session.userFlow.revokeMandate(), /no_employee_mandate/);
  assert.throws(() => session.userFlow.trustMerchant(MERCHANT_B), /no_employee_mandate/);
  const sel = session.agent.selectOffer(AUTO_OFFER.offerRef).value;
  assert.equal(sel.authZone, 'Confirm');
  assert.equal(sel.autoPayBlockedReason, 'no_employee_mandate');
  const step = await session.runner.step();
  assert.equal(step.value.payer.state, 'awaiting_approvals');
  assert.equal(w.backend.executionCount(), 0);
});

test('revocation between selection and step stops the automatic dispatch', async () => {
  const { w, session } = setup();
  session.agent.selectOffer(AUTO_OFFER.offerRef);
  session.userFlow.revokeMandate();
  const step = await session.runner.step();
  assert.equal(step.value.payer.state, 'awaiting_approvals');
  assert.equal(step.value.authZone, 'Confirm');
  assert.equal(step.value.autoPayBlockedReason, 'mandate_revoked');
  assert.equal(w.backend.executionCount(), 0);
});

test('the user-flow dispute supplies the session principal and resumes one case', async () => {
  const { w, session } = setup();
  session.agent.selectOffer(AUTO_OFFER.offerRef);
  await session.runner.step();
  const d = await session.userFlow.dispute();
  const v = d.value;
  assert.equal(v.payer.state, 'completed');
  assert.equal(v.payer.returnStatus, 'completed');
  assert.equal(v.payer.returnedCents, 400);
  assert.equal(v.payer.unreturnedFeeCents, 0);
  assert.deepEqual(v.payer.dispute, { openedAt: 10, outcome: 'returned' });
  // Every settled share went back to its original payer; the automatic
  // budget hold was released exactly once.
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 0);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  assert.equal(w.trace.events.filter((e) => e.event === 'dispute_opened').length, 1);
  assert.equal(w.trace.events.filter((e) => e.event === 'autopay_released').length, 1);
  // Repeating the request resumes the same case; nothing returns twice.
  const again = await session.userFlow.dispute();
  assert.equal(again.value.payer.returnStatus, 'completed');
  assert.equal(w.trace.events.filter((e) => e.event === 'autopay_released').length, 1);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
});

test('a dispute on a non-automatic purchase is rejected with its own reason', async () => {
  const { w, session } = setup();
  await assert.rejects(session.userFlow.dispute(), /no_proposal/);
  // A device-funded completed purchase has no Auto receipt: rejected.
  session.agent.selectOffer(NEW_MERCHANT_OFFER.offerRef);
  session.userFlow.approve(1);
  await session.userFlow.submit(1);
  await assert.rejects(session.userFlow.dispute(), /dispute rejected: no_receipt/);
  assert.ok(w.trace.events.some((e) => e.event === 'dispute_rejected' && e.detail?.reason === 'no_receipt'));
});

test('the exception choice is signed by the device callback, never an unsigned upgrade', async () => {
  const { w, session } = setup();
  const sel = session.agent.selectOffer(EXCEPTION_OFFER.offerRef).value;
  assert.equal(sel.authZone, 'Exception');
  assert.equal(sel.payer.ownCents, 1_100);
  // An ordinary signature is not authority above the standing maximum.
  assert.throws(() => session.userFlow.approve(1), /does not match/);
  assert.ok(w.trace.events.some((e) => e.event === 'approval_rejected' && e.detail?.reason === 'exceeds_mandate'));
  const ap = session.userFlow.approve(1, { exception: true }).value;
  assert.equal(ap.authorizations.length, 1);
  assert.equal(ap.authorizations[0].basis, 'exception');
  // What the coordinator recorded is the signed acknowledgment, not the
  // option flag: revision, acknowledged maximum and the exact overage.
  const snap = session.userFlow.snapshot();
  const auth = snap.authorizations[0];
  assert.equal(auth.basis, 'exception');
  assert.equal(auth.approval.payload.exception, true);
  assert.equal(auth.approval.payload.mandateVersion, 1);
  assert.equal(auth.approval.payload.maxCents, 1_000);
  assert.equal(auth.approval.payload.overByCents, 100);
  const done = await session.userFlow.submit(1);
  assert.equal(done.value.payer.state, 'completed');
  // An exception is manual authority: no Auto receipt, no automatic usage.
  assert.equal(done.value.payer.receipt, undefined);
  assert.ok(!w.trace.events.some((e) => e.event === 'autopay_reserved'));
  assert.equal(w.backend.account(EMPLOYEE).deCents, 900);
});

for (const [basis, offer, changes, refusal] of [
  ['device', OVER_OFFER, { maxCents: 900 }, 'exceeds_mandate'],
  ['exception', EXCEPTION_OFFER, {}, 'exception_superseded'],
] as const) {
  test(`B24 explanations invalidate retained ${basis} authority after standing terms change`, async () => {
    const { w, session } = setup({ initiation: 'per_payer_psp' });
    session.agent.selectOffer(offer.offerRef);
    const approved = session.userFlow.approve(1, { exception: basis === 'exception' }).value;
    assert.equal(approved.authorizations[0].basis, basis);
    assert.equal(approved.authorizations[0].currentlyValid, true);
    w.psps.get(EMPLOYEE)!.available = false;
    const pending = (await session.userFlow.submit(1)).value;
    assert.equal(pending.payer.state, 'pending');
    assert.equal(pending.authorizations[0].currentlyValid, true);

    // Pending purchases retain the signed evidence. It still binds the
    // proposal and has not expired, but no longer permits its first send.
    updateEmployeeMandate(w, changes);
    const authorityEvents = w.trace.events.filter((e) => e.event === 'auth_zone').length;
    for (const view of [session.agent.explain().value, session.userFlow.explain().value]) {
      assert.equal(view.authZone, 'Exception');
      assert.equal(view.authorizations.length, 1);
      assert.equal(view.authorizations[0].basis, basis);
      assert.equal(view.authorizations[0].bindsCurrentProposal, true);
      assert.equal(view.authorizations[0].currentlyValid, false);
    }
    assert.equal(w.trace.events.filter((e) => e.event === 'auth_zone').length, authorityEvents);

    w.psps.get(EMPLOYEE)!.available = true;
    await session.runner.step();
    const snapshot = session.userFlow.snapshot();
    assert.equal(snapshot.legs.find((l) => l.payerId === EMPLOYEE)!.rejectReason, refusal);
    assert.equal(w.backend.executionCount(), 1, 'only the employer leg reached the backend');
    assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  });
}

test('B25 retained Auto authority uses its booking month while fresh eligibility uses the current month', async () => {
  const w = world({}, { maxPerDayCents: 10_000, maxPurchasesPerDay: 10 }, {
    initiation: 'per_payer_psp', supportsMandatePayments: true,
    calendarEpoch: '2026-01-31T23:49:00Z',
    employeeMandate: { ...AUTO_EMPLOYEE_TERMS, autoPayMonthlyCents: 600 },
  });
  const one = createScenarioSession(w, { purchaseId: 'january', catalog: [AUTO_OFFER] });
  w.psps.get(EMPLOYEE)!.available = false;
  one.agent.selectOffer(AUTO_OFFER.offerRef);
  await one.runner.step();
  assert.equal(one.userFlow.snapshot().submission?.bookingMonth, '2026-01');
  advance(w, 12);
  w.psps.get(EMPLOYEE)!.available = true;
  const two = createScenarioSession(w, { purchaseId: 'february', catalog: [AUTO_OFFER] });
  two.agent.selectOffer(AUTO_OFFER.offerRef);
  await two.runner.step();
  await two.runner.step();
  assert.equal(two.userFlow.snapshot().state, 'completed');

  const view = one.agent.explain().value;
  assert.equal(view.authZone, 'Confirm', 'fresh eligibility still counts February usage');
  assert.equal(view.authorizations[0].currentlyValid, true, 'retained authority counts its January reservation');
  assert.equal(w.coordinator.quote({ employeeId: EMPLOYEE, mandateRef: w.mandate.mandateRef, merchantId: MERCHANT_A, totalCents: 900 }).assessment.autoPayBlockedReason, 'monthly_cap');
  const done = (await one.runner.step()).value;
  assert.equal(done.payer.state, 'completed');
  assert.equal(done.authorizations[0].currentlyValid, true);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_200, 'both original employee shares settle once');
});

test('explain shows the current zone without recording new authority events', async () => {
  const { w, session } = setup();
  session.agent.selectOffer(AUTO_OFFER.offerRef);
  await session.runner.step();
  // Revocation after completion changes the current eligibility answer;
  // the stored assessment and the authority that paid stay as recorded.
  session.userFlow.revokeMandate();
  const before = w.trace.events.filter((e) => e.event === 'auth_zone').length;
  const v = session.userFlow.explain().value;
  assert.equal(v.authZone, 'Confirm');
  assert.equal(v.autoPayBlockedReason, 'mandate_revoked');
  assert.equal(v.mandateVersion, 2);
  // The recorded basis and last mutating assessment still say what paid.
  assert.equal(v.payer.authorizationBasis, 'mandate');
  assert.equal(v.payer.assessment?.authZone, 'Auto');
  assert.equal(w.trace.events.filter((e) => e.event === 'auth_zone').length, before, 'explain appended authority events');
});

test('mutating returned views cannot alter mandate, purchase or budget', async () => {
  const { w, session } = setup();
  session.agent.selectOffer(AUTO_OFFER.offerRef);
  const step = await session.runner.step();
  const v = step.value;
  v.payer.state = 'failed';
  v.payer.ownCents = 0;
  v.mandateVersion = 99;
  v.payer.receipt!.disputeUntil = 1;
  v.authorizations.push({
    basis: 'mandate',
    payerId: EMPLOYEE,
    mandateVersion: 9,
    proposalVersion: 1,
    bindsCurrentProposal: true,
    currentlyValid: true,
  });
  const terms = session.userFlow.terms().value!;
  terms.autoPayMonthlyCents = 0;
  terms.trustedMerchants.length = 0;
  // Retained state is untouched: purchase, receipt, standing terms, budget.
  const snap = session.userFlow.snapshot();
  assert.equal(snap.state, 'completed');
  assert.equal(snap.receipt?.disputeUntil, 1_450);
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)?.payload.autoPayMonthlyCents, 3_000);
  assert.deepEqual(w.coordinator.employeeMandate(EMPLOYEE)?.payload.trustedMerchants, [MERCHANT_A]);
  const again = await session.runner.step();
  assert.equal(again.value.payer.state, 'completed');
  assert.equal(again.value.payer.ownCents, 400);
  assert.equal(again.value.payer.receipt?.disputeUntil, 1_450);
});
