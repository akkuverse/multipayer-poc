// Signed caller requests: every call that starts or ends a purchase names
// its caller, carries that caller's signature, and is checked and logged by
// the coordinator — the session's claim alone is never enough.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  world,
  approveAs,
  lunch,
  proposeAs,
  proposeSplitAs,
  changeOfferAs,
  cancelAs,
  refundAs,
  submitAs,
  AUTO_EMPLOYEE_TERMS,
  EMPLOYEE,
  COLLEAGUE_1,
  COLLEAGUE_2,
  MERCHANT_A,
  MERCHANT_B,
} from '../src/scenarios.ts';
import { signPayload } from '../src/core/signing.ts';
import type { Signed } from '../src/core/signing.ts';
import type { CancelRequest, DelegationGrant, ProposerSplitRequest, SplitRequest } from '../src/core/types.ts';

// A signed EUR 13 lunch proposal at merchant-a under the world's default
// 'on_request'/'atomic' submission terms.
const signedLunch = (w: ReturnType<typeof world>, purchaseId = 'purchase-1') =>
  proposeAs(w, { purchaseId, employeeId: EMPLOYEE, merchantId: MERCHANT_A, totalCents: 1_300, mandateRef: w.mandate.mandateRef, expiresAt: 100 });

const requestRefusals = (w: ReturnType<typeof world>) => w.trace.events.filter((e) => e.event === 'request_refused');

test('a request signed under an unregistered key is bad_signature and logged', () => {
  const w = world();
  const p = signedLunch(w);
  // 'mallory-1' holds no registered key: the request signs cleanly with an
  // unregistered fixture key and the coordinator still rejects it.
  assert.throws(() => cancelAs(w, p, 'mallory-1'), /bad_signature/);
  const refusal = requestRefusals(w).at(-1);
  assert.equal(refusal?.detail?.reason, 'bad_signature');
  assert.equal(refusal?.detail?.kind, 'cancel');
  assert.equal(refusal?.detail?.by, 'mallory-1');
});

test('a split proposal from a non-payer is proposer_not_a_payer', () => {
  const w = world();
  assert.throws(
    () =>
      proposeSplitAs(
        w,
        {
          purchaseId: 'purchase-1',
          merchantId: MERCHANT_B,
          amountsFrom: 'proposer',
          shares: [
            { role: 'a', payerId: EMPLOYEE, amountCents: 500 },
            { role: 'b', payerId: COLLEAGUE_1, amountCents: 500 },
          ],
          expiresAt: 100,
        },
        COLLEAGUE_2,
      ),
    /proposer_not_a_payer/,
  );
  assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'proposer_not_a_payer');
});

test('a request bound to a superseded proposal version is stale_version', () => {
  const w = world();
  const p = signedLunch(w);
  // A verified offer change bumps the committed version to 2.
  changeOfferAs(w, p, { merchantId: MERCHANT_A, totalCents: 1_400, expiresAt: 100 }, MERCHANT_A);
  assert.equal(p.proposal.version, 2);
  // A correct signature over version 1 — what the signer saw — is stale.
  const stale = signPayload({ kind: 'cancel', purchaseId: p.purchaseId, proposalVersion: 1, by: EMPLOYEE } satisfies CancelRequest, w.signers.get(EMPLOYEE)!);
  assert.throws(() => w.coordinator.cancel(p.purchaseId, stale), /stale_version/);
  assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'stale_version');
});

test('a payer may cancel: the purchase is cancelled and the event names the caller', () => {
  const w = world();
  const p = signedLunch(w);
  cancelAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'cancelled');
  const state = w.trace.events.filter((e) => e.event === 'state').at(-1);
  assert.equal(state?.detail?.to, 'cancelled');
  assert.equal(state?.detail?.by, EMPLOYEE);
});

test('a payee may refund a completed purchase', async () => {
  const w = world();
  const p = signedLunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  await refundAs(w, p, MERCHANT_A);
  assert.equal(p.returnStatus, 'completed');
  assert.equal(w.trace.events.find((e) => e.event === 'refund_requested')?.detail?.by, MERCHANT_A);
});

test("a payer's signed refund is not_authorized and names the dispute path", async () => {
  const w = world();
  const p = signedLunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  await assert.rejects(() => refundAs(w, p, EMPLOYEE), /not_authorized.*dispute/s);
  const refusal = requestRefusals(w).at(-1);
  assert.equal(refusal?.detail?.reason, 'not_authorized');
  assert.match(String(refusal?.detail?.hint), /dispute/);
});

test("a non-payer's signed submit under on_request is not_authorized", async () => {
  const w = world();
  const p = signedLunch(w);
  approveAs(w, p);
  await assert.rejects(() => submitAs(w, p, COLLEAGUE_1), /not_authorized/);
  assert.equal(p.state, 'ready');
});

test("an amountsFrom 'proposer' split is ready at proposal: the signature is the proposer's approval", () => {
  const w = world();
  const p = proposeSplitAs(
    w,
    {
      purchaseId: 'purchase-1',
      merchantId: MERCHANT_B,
      amountsFrom: 'proposer',
      shares: [{ role: 'me', payerId: EMPLOYEE, amountCents: 2_000 }],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  assert.equal(p.state, 'ready');
  const recorded = w.trace.events.find((e) => e.event === 'approval_recorded');
  assert.equal(recorded?.detail?.source, 'proposal');
  assert.equal(recorded?.detail?.payerId, EMPLOYEE);
  // No Authorization entry was fabricated: coverage is the proposal itself.
  assert.equal(p.authorizations.length, 0);
});

test('an equal_split proposal computes the shares and waits for every payer', () => {
  const w = world();
  const p = proposeSplitAs(
    w,
    {
      purchaseId: 'purchase-1',
      merchantId: MERCHANT_B,
      amountsFrom: 'equal_split',
      totalCents: 4_000,
      shares: [
        { role: 'a', payerId: EMPLOYEE },
        { role: 'b', payerId: COLLEAGUE_1 },
        { role: 'c', payerId: COLLEAGUE_2 },
      ],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  assert.equal(p.state, 'awaiting_approvals');
  assert.deepEqual(
    p.proposal.shares.map((s) => s.amountCents),
    [1_334, 1_333, 1_333],
  );
  for (const id of [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2]) approveAs(w, p, id);
  assert.equal(p.state, 'ready');
});

test('on_ready self-submits at the ready transition; idle() drains the fired submission', async () => {
  const w = world({}, {}, { submitPolicy: 'on_ready' });
  const p = signedLunch(w);
  assert.equal(p.state, 'awaiting_approvals');
  approveAs(w, p);
  // The approve returned before the fired submission finished: the
  // coordinator tracks it and idle() waits for it.
  await w.coordinator.idle();
  assert.equal(p.state, 'completed');
  const submit = w.trace.events.find((e) => e.event === 'submit');
  assert.equal(submit?.detail?.trigger, 'auto');
});

test('on_request requires a signed request and accepts a payer-signed one', async () => {
  const w = world();
  const p = signedLunch(w);
  approveAs(w, p);
  await assert.rejects(() => w.coordinator.submit(p.purchaseId), /request_required/);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  const submit = w.trace.events.find((e) => e.event === 'submit');
  assert.equal(submit?.detail?.trigger, 'request');
  assert.equal(submit?.detail?.by, EMPLOYEE);
});

test('a request-less public submit is refused under on_ready too: only the self-fire logs auto', async () => {
  const w = world({}, {}, { submitPolicy: 'on_ready' });
  const p = signedLunch(w);
  approveAs(w, p);
  await w.coordinator.idle();
  assert.equal(p.state, 'completed');
  // The coordinator's own fire is the only request-less submission: a
  // caller invoking submit() without a request is refused identically to
  // 'on_request', so 'auto' in the trace can only ever name the self-fire.
  await assert.rejects(() => w.coordinator.submit(p.purchaseId), /request_required/);
  assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'request_required');
});

const agentGrant = (w: ReturnType<typeof world>, purchaseId: string, changes: Partial<DelegationGrant> = {}) =>
  signPayload(
    {
      grantRef: `grant-${purchaseId}`,
      agentId: 'agent-1',
      principalId: EMPLOYEE,
      sessionId: `session-${purchaseId}`,
      purchaseId,
      capabilities: ['discover', 'propose', 'explain'],
      expiresAt: 10_000,
      ...changes,
    },
    w.signers.get(EMPLOYEE)!,
  );

test("an agent's signed propose under a valid delegation grant is accepted and logged", () => {
  const w = world();
  const p = proposeAs(
    w,
    {
      purchaseId: 'purchase-1',
      employeeId: EMPLOYEE,
      merchantId: MERCHANT_A,
      totalCents: 1_300,
      mandateRef: w.mandate.mandateRef,
      expiresAt: 100,
      grant: agentGrant(w, 'purchase-1'),
    },
    'agent-1',
  );
  assert.equal(p.proposal.proposedBy, 'agent-1');
  const proposal = w.trace.events.filter((e) => e.event === 'proposal').at(-1);
  assert.equal(proposal?.detail?.proposedBy, 'agent-1');
});

test("an agent's signed propose without or with a mismatched grant is not_authorized", () => {
  const w = world();
  const input = (grant?: ReturnType<typeof agentGrant>) => ({
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
    grant,
  });
  // No grant at all.
  assert.throws(() => proposeAs(w, input(), 'agent-1'), /not_authorized/);
  // A grant delegating a different agent.
  assert.throws(() => proposeAs(w, input(agentGrant(w, 'purchase-1', { agentId: 'agent-2' })), 'agent-1'), /not_authorized/);
  // A grant scoped to a different purchase.
  assert.throws(() => proposeAs(w, input(agentGrant(w, 'purchase-2')), 'agent-1'), /not_authorized/);
  // A grant without the propose capability.
  assert.throws(() => proposeAs(w, input(agentGrant(w, 'purchase-1', { capabilities: ['discover', 'explain'] })), 'agent-1'), /not_authorized/);
});

test("an agent's signed propose under an expired grant is not_authorized", () => {
  const w = world();
  // The grant's deadline passed before the world's t=10: a live agent and a
  // correctly scoped grant still fail the liveness check.
  const input = {
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
    grant: agentGrant(w, 'purchase-1', { expiresAt: 5 }),
  };
  assert.throws(() => proposeAs(w, input, 'agent-1'), /not_authorized/);
  assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'not_authorized');
});

test("an agent's signed propose under a badly signed grant is bad_signature", () => {
  const w = world();
  // A grant whose signature does not verify under the employee's key never
  // reaches the content checks — the grant's own signature fails first.
  const grant = agentGrant(w, 'purchase-1');
  grant.signature = 'forged';
  const input = {
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandateRef: w.mandate.mandateRef,
    expiresAt: 100,
    grant,
  };
  assert.throws(() => proposeAs(w, input, 'agent-1'), /bad_signature/);
  assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'bad_signature');
});

test('a change offer signed by a non-signer is not_authorized', () => {
  const w = world();
  const p = signedLunch(w);
  // Signers are the merchant of record, the current proposer and the
  // employee — a colleague with a valid registered key names none of them.
  assert.throws(() => changeOfferAs(w, p, { merchantId: MERCHANT_A, totalCents: 1_400, expiresAt: 100 }, COLLEAGUE_1), /not_authorized/);
  const refusal = requestRefusals(w).at(-1);
  assert.equal(refusal?.detail?.reason, 'not_authorized');
  assert.equal(refusal?.detail?.kind, 'change_offer');
});

// A split request the discriminated union cannot express: the caller signs
// a payload that contradicts its own amountsFrom, which the coordinator
// must refuse rather than silently reinterpret.
const signSplitPayload = (w: ReturnType<typeof world>, payload: unknown) =>
  w.coordinator.proposeSplit(signPayload(payload, w.signers.get(EMPLOYEE)!) as Signed<SplitRequest>);

test("an 'equal_split' request carrying share amounts is refused, not reinterpreted", () => {
  const w = world();
  assert.throws(
    () =>
      signSplitPayload(w, {
        kind: 'propose_split',
        purchaseId: 'purchase-1',
        proposalVersion: 1,
        by: EMPLOYEE,
        merchantId: MERCHANT_B,
        amountsFrom: 'equal_split',
        totalCents: 4_000,
        shares: [
          { role: 'a', payerId: EMPLOYEE, amountCents: 500, rail: 'digital_euro' },
          { role: 'b', payerId: COLLEAGUE_1, rail: 'digital_euro' },
        ],
        expiresAt: 100,
        submitPolicy: 'on_request',
        settlementMode: 'atomic',
      }),
    /must not carry amounts/,
  );
  // Nothing committed: the refusal created no record.
  assert.throws(() => w.coordinator.view('purchase-1'), /unknown_purchase/);
});

test("a 'proposer' request whose total contradicts its shares is refused", () => {
  const w = world();
  assert.throws(
    () =>
      signSplitPayload(w, {
        kind: 'propose_split',
        purchaseId: 'purchase-1',
        proposalVersion: 1,
        by: EMPLOYEE,
        merchantId: MERCHANT_B,
        amountsFrom: 'proposer',
        totalCents: 9_999,
        shares: [
          { role: 'a', payerId: EMPLOYEE, amountCents: 500, rail: 'digital_euro' },
          { role: 'b', payerId: COLLEAGUE_1, amountCents: 500, rail: 'digital_euro' },
        ],
        expiresAt: 100,
        submitPolicy: 'on_request',
        settlementMode: 'atomic',
      }),
    /contradicts the share sum/,
  );
  assert.throws(() => w.coordinator.view('purchase-1'), /unknown_purchase/);
});

test("a 'proposer' request whose redundant total equals the share sum commits", () => {
  const w = world();
  signSplitPayload(w, {
    kind: 'propose_split',
    purchaseId: 'purchase-1',
    proposalVersion: 1,
    by: EMPLOYEE,
    merchantId: MERCHANT_B,
    amountsFrom: 'proposer',
    totalCents: 1_000,
    shares: [
      { role: 'a', payerId: EMPLOYEE, amountCents: 500, rail: 'digital_euro' },
      { role: 'b', payerId: COLLEAGUE_1, amountCents: 500, rail: 'digital_euro' },
    ],
    expiresAt: 100,
    submitPolicy: 'on_request',
    settlementMode: 'atomic',
  });
  assert.equal(w.coordinator.view('purchase-1').proposal.totalCents, 1_000);
});

test('a signed request carrying an out-of-union enum is refused', () => {
  const w = world();
  assert.throws(
    () =>
      signSplitPayload(w, {
        kind: 'propose_split',
        purchaseId: 'purchase-1',
        proposalVersion: 1,
        by: EMPLOYEE,
        merchantId: MERCHANT_B,
        amountsFrom: 'halves',
        shares: [{ role: 'a', payerId: EMPLOYEE, amountCents: 500, rail: 'digital_euro' }],
        expiresAt: 100,
        submitPolicy: 'on_request',
        settlementMode: 'atomic',
      }),
    /unknown amountsFrom/,
  );
});

test('on_ready logs submit_auto_refused on a pre-dispatch refusal and stays ready; a signed submit is the way forward', async () => {
  // Deliberately the test-bypass fixture: the assertion is about the
  // whole-request conclusive refusal rolling back to 'ready' — under
  // per-payer initiation the same backend refusal lands on the leg.
  const w = world({}, {}, { submitPolicy: 'on_ready', initiation: 'test_bypass_psp' });
  // The share pays a payee with no account: the backend's refusal is
  // conclusive and pre-dispatch, so the self-fired submission rolls the
  // purchase back to 'ready' and its rejection is logged, never unhandled.
  const p = proposeSplitAs(
    w,
    {
      purchaseId: 'purchase-1',
      merchantId: MERCHANT_B,
      amountsFrom: 'proposer',
      shares: [{ role: 'me', payerId: EMPLOYEE, payeeId: 'ghost-merchant', amountCents: 500 }],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  await w.coordinator.idle();
  assert.equal(p.state, 'ready');
  assert.ok(w.trace.events.some((e) => e.event === 'submit_auto_refused'));
  assert.equal(w.trace.events.find((e) => e.event === 'submit' && e.actor === 'coordinator')?.detail?.trigger, 'auto');
  // Register the missing payee: the once-per-ready marker bars a refire,
  // so the payer's own signed request is the way forward — verified and
  // logged like an 'on_request' submit.
  w.backend.addAccount({ id: 'ghost-merchant', kind: 'business', deCents: 0, holdingLimitCents: 0, linkedBankCents: 0, reverseWaterfall: true });
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  // The backend logs 'submit' too: the trigger/by assertions name the
  // coordinator's event specifically.
  const submit = w.trace.events.filter((e) => e.event === 'submit' && e.actor === 'coordinator').at(-1);
  assert.equal(submit?.detail?.trigger, 'request');
  assert.equal(submit?.detail?.by, EMPLOYEE);
});

// A share's rail is part of the signed terms: retargeting it after signing
// invalidates the signature, and standing terms that never permitted the
// rail cannot silently produce mandate authority for it.
test('rail_tampering_invalidates_authority', () => {
  const w = world();
  // Mutate a signed split's share rail DE→bank under the old signature: the
  // request is refused before any purchase — or money operation — exists.
  const signed = signPayload(
    {
      kind: 'propose_split',
      purchaseId: 'purchase-1',
      proposalVersion: 1,
      by: EMPLOYEE,
      merchantId: MERCHANT_B,
      amountsFrom: 'proposer',
      shares: [{ role: 'a', payerId: EMPLOYEE, payeeId: MERCHANT_B, rail: 'digital_euro', amountCents: 500 }],
      expiresAt: 100,
      submitPolicy: 'on_request',
      settlementMode: 'atomic',
    } satisfies ProposerSplitRequest,
    w.signers.get(EMPLOYEE)!,
  );
  signed.payload.shares[0].rail = 'bank';
  assert.throws(() => w.coordinator.proposeSplit(signed), /bad_signature/);
  assert.throws(() => w.coordinator.view('purchase-1'), /unknown_purchase/);
  assert.equal(w.backend.executionCount(), 0);

  // An otherwise valid re-signed request whose rail lies outside the
  // employee's standing allowedRails must not obtain mandate authority: the
  // derived digital-euro debit is outside the bank-only terms, so the Auto
  // path cannot record standing authorization for it.
  const w2 = world(
    {},
    { maxPerDayCents: 10_000, maxPurchasesPerDay: 10 },
    { supportsMandatePayments: true, employeeMandate: { ...AUTO_EMPLOYEE_TERMS, allowedRails: ['bank'] } },
  );
  const p2 = lunch(w2, 900); // EUR 4 employee debit on the derived digital-euro rail
  assert.equal(p2.employeeAssessment?.authZone, 'Confirm');
  assert.equal(p2.employeeAssessment?.autoPayBlockedReason, 'rail_not_permitted');
  assert.equal(p2.authorizations.length, 0, 'no mandate evidence recorded for an unpermitted rail');
  assert.equal(p2.state, 'awaiting_approvals');
});
