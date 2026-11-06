// Conditional-fund purchases through the coordinator: the payee's signed
// open_fund request, contributors' signed pledges, unsigned evaluation and
// payee-only cancellation — the wiring between signed envelopes, the pure
// funding decision module and the purchase store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approveAs,
  advance,
  cancelAs,
  changeOfferAs,
  deGroupKey,
  legChildKey,
  lunch,
  openFundAs,
  payeeBankCents,
  payerBankCents,
  payerDeCents,
  pledgeAs,
  submitAs,
  world,
  EMPLOYEE,
  MERCHANT_B,
  PROJECT_1,
  RESIDENT_1,
  RESIDENT_2,
  RESIDENT_3,
} from '../src/scenarios.ts';
import { campaignDigestOf, keyPairFromSeed, signPayload } from '../src/core/signing.ts';
import { unwrapView } from '../src/core/live-view.ts';
import type { Signed } from '../src/core/signing.ts';
import type { CampaignTerms, OpenFundRequest, PledgeRequest } from '../src/core/types.ts';
import type { World } from '../src/scenarios.ts';

// The world's clock starts at minute 10; the defaults below keep every
// pledge window and campaign cutoff ahead of it.
const TERMS = (over: Partial<CampaignTerms> = {}): CampaignTerms => ({
  purchaseId: 'fund-1',
  payeeId: PROJECT_1,
  condition: { minPayers: 2 },
  fundingEndsAt: 20,
  settleBy: 30,
  acceptPledgesUntil: 'condition_met',
  submitPolicy: 'on_request',
  settlementMode: 'atomic',
  privacyProfile: 'public_good_pledge_v1',
  ...over,
});

const openSigned = (w: World, terms: CampaignTerms, by = terms.payeeId, overrides: Record<string, unknown> = {}) =>
  signPayload(
    { kind: 'open_fund', proposalVersion: 1, by, ...terms, ...overrides } as OpenFundRequest,
    w.signers.get(by) ?? keyPairFromSeed(`unregistered-${by}`, by),
  );

const refusals = (w: World) => w.trace.events.filter((e) => e.event === 'request_refused');
const eventsFor = (w: World, id: string) => w.trace.events.filter((e) => e.detail?.purchaseId === id);

test('open → awaiting_approvals with total 0 → two pledges → ready; replay returns the same acceptance and no events', () => {
  const w = world();
  const id = openFundAs(w, {
    purchaseId: 'fund-count',
    payeeId: 'project-1',
    condition: { minPayers: 2 },
    fundingEndsAt: 20,
    settleBy: 30,
    acceptPledgesUntil: 'condition_met',
    submitPolicy: 'on_request',
    settlementMode: 'atomic',
    privacyProfile: 'public_good_pledge_v1',
  });
  assert.equal(w.coordinator.view(id).state, 'awaiting_approvals');
  assert.equal(w.coordinator.view(id).proposal.totalCents, 0);
  const first = pledgeAs(w, id, 'resident-1', 'r1', 300, 30, { feeCents: 0, rail: 'digital_euro' });
  pledgeAs(w, id, 'resident-2', 'r2', 700, 30, { feeCents: 0, rail: 'digital_euro' });
  assert.equal(w.coordinator.view(id).state, 'ready');
  const events = w.trace.events.length;
  assert.deepEqual(w.coordinator.pledge(first.signed), first.acceptance);
  assert.equal(w.trace.events.length, events);
  assert.equal(w.coordinator.view(id).proposal.totalCents, 1000);
});

test('openFund commits campaign terms, digest, funding state and frozen campaign privacy terms', () => {
  const w = world();
  const id = openFundAs(w, TERMS());
  const v = w.coordinator.view(id);
  assert.equal(v.proposal.version, 1);
  assert.equal(v.proposal.merchantId, PROJECT_1);
  assert.equal(v.proposal.proposedBy, PROJECT_1);
  assert.equal(v.proposal.expiresAt, 30, 'settleBy maps to the proposal expiry');
  assert.deepEqual(v.proposal.shares, []);
  assert.equal(v.funding?.phase, 'collecting');
  assert.deepEqual(v.funding?.history, []);
  assert.deepEqual(v.funding?.progress, { livePayers: 0, liveTotalCents: 0, met: false });
  assert.equal(v.funding?.campaignDigest, campaignDigestOf(v.funding!.terms));
  assert.equal(v.proposal.privacy.profile, 'public_good_pledge_v1');
  assert.equal(v.proposal.privacy.source.kind, 'campaign');
  const opened = w.trace.events.find((e) => e.event === 'fund_opened');
  assert.equal(opened?.origin, 'LOCAL');
  assert.equal(opened?.detail?.payeeId, PROJECT_1);
});

test('openFund verifies the payee signer, registered key, version and unused id before opening', () => {
  const w = world();
  // A registered holder that is not the named payee.
  assert.throws(() => w.coordinator.openFund(openSigned(w, TERMS(), RESIDENT_1)), /not_authorized/);
  assert.equal(refusals(w).at(-1)?.detail?.reason, 'not_authorized');
  // An unregistered key for the payee.
  const forged = signPayload(
    { kind: 'open_fund', proposalVersion: 1, by: PROJECT_1, ...TERMS() } as OpenFundRequest,
    keyPairFromSeed('forged', 'forged'),
  );
  assert.throws(() => w.coordinator.openFund(forged), /bad_signature/);
  // A signed version other than 1.
  assert.throws(() => w.coordinator.openFund(openSigned(w, TERMS(), PROJECT_1, { proposalVersion: 2 })), /stale_version/);
  // Independent settlement is refused before any record.
  assert.throws(
    () => w.coordinator.openFund(openSigned(w, TERMS(), PROJECT_1, { settlementMode: 'independent' })),
    /fund_atomic_required/,
  );
  assert.equal(refusals(w).at(-1)?.detail?.reason, 'fund_atomic_required');
  assert.throws(() => w.coordinator.view('fund-1'), /unknown_purchase/);
});

test('openFund refuses malformed or already-closed campaign terms and reused ids', () => {
  const w = world();
  const bad: [Partial<CampaignTerms>, RegExp][] = [
    [{ condition: {} }, /campaign_terms_invalid/],
    [{ condition: { minPayers: 0 } }, /campaign_terms_invalid/],
    [{ fundingEndsAt: 30, settleBy: 20 }, /campaign_terms_invalid/],
    [{ acceptPledgesUntil: 'whenever' as 'deadline' }, /campaign_terms_invalid/],
    [{ privacyProfile: 'split_bill_v1' as 'public_good_pledge_v1' }, /campaign_terms_invalid/],
    [{ submitPolicy: 'eventually' as 'on_request' }, /campaign_terms_invalid/],
    // The cutoff is behind the world's opening clock (now = 10).
    [{ fundingEndsAt: 5 }, /campaign_terms_invalid/],
  ];
  for (const [over, pattern] of bad) {
    const before = w.trace.events.length;
    assert.throws(() => openFundAs(w, TERMS(over)), pattern, JSON.stringify(over));
    assert.equal(w.trace.events.length, before + 1, 'only the refusal event');
    assert.equal(w.trace.events.at(-1)?.event, 'request_refused');
  }
  assert.throws(() => w.coordinator.view('fund-1'), /unknown_purchase/);
  // A reused id is refused either direction around the ordinary entry points.
  const id = openFundAs(w, TERMS({ purchaseId: 'fund-x' }));
  assert.throws(() => openFundAs(w, TERMS({ purchaseId: 'fund-x' })), /duplicate_purchase/);
  lunch(w);
  assert.throws(() => openFundAs(w, TERMS({ purchaseId: 'purchase-1' })), /duplicate_purchase/);
  assert.throws(() => lunch(w, 1_300, MERCHANT_B, { purchaseId: id }), /duplicate_purchase/);
});

test('a pledge appends share and authorization under one version bump; events are LOCAL', () => {
  const w = world();
  const id = openFundAs(w, TERMS());
  const before = pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30, { feeCents: 7, rail: 'bank' });
  const v = w.coordinator.view(id);
  assert.equal(v.proposal.version, 2);
  assert.equal(v.proposal.totalCents, 300);
  assert.deepEqual(
    v.proposal.shares,
    [{ role: 'pledge:r1', payerId: RESIDENT_1, payeeId: PROJECT_1, amountCents: 300, feeCents: 7, rail: 'bank', authority: 'payer' }],
  );
  assert.equal(v.authorizations.length, 1);
  assert.equal(v.authorizations[0].basis, 'pledge');
  assert.equal(v.state, 'awaiting_approvals');
  assert.equal(v.funding?.history.length, 1);
  assert.equal(v.funding?.history[0].outcome, 'active');
  assert.deepEqual(v.funding?.progress, { livePayers: 1, liveTotalCents: 300, met: false });
  assert.deepEqual(before.acceptance, { purchaseId: id, pledgeRef: 'r1', acceptedAt: 10, proposalVersion: 2 });
  const names = eventsFor(w, id).map((e) => e.event);
  assert.ok(names.includes('pledge_recorded'));
  assert.ok(names.includes('funding_evaluated'));
  assert.ok(eventsFor(w, id).every((e) => e.origin === 'LOCAL'));
});

test('pledge refusals: binding, replay-conflict, second payer pledge, expiry and closed roster', () => {
  const w = world();
  const id = openFundAs(w, TERMS());
  const terms = w.coordinator.view(id).funding!.terms;
  const sign = (over: Record<string, unknown>, by: string = RESIDENT_1): Signed<PledgeRequest> =>
    signPayload(
      {
        kind: 'pledge',
        purchaseId: id,
        by,
        pledgeRef: 'r1',
        campaignDigest: campaignDigestOf(terms),
        share: { role: 'pledge:r1', payerId: by, payeeId: terms.payeeId, amountCents: 300, feeCents: 0, rail: 'digital_euro' },
        expiresAt: 30,
        privacyProfile: 'public_good_pledge_v1',
        ...over,
      } as PledgeRequest,
      w.signers.get(by)!,
    );
  const attempt = (signed: Signed<PledgeRequest>, pattern: RegExp): void => {
    assert.throws(() => w.coordinator.pledge(signed), pattern);
    assert.equal(refusals(w).at(-1)?.detail?.kind, 'pledge');
  };
  attempt(sign({ campaignDigest: '0'.repeat(64) }), /campaign_terms_mismatch/);
  attempt(sign({ purchaseId: 'other' }), /unknown_purchase/);
  attempt(sign({ proposalVersion: 1 }), /pledge_malformed/);
  attempt(sign({ cancelUntil: 5 }), /pledge_malformed/);
  attempt(sign({ expiresAt: 10 }), /pledge_expired/);
  attempt(sign({ expiresAt: 31 }), /pledge_expiry_invalid/);
  attempt(sign({ share: { role: 'friend', payerId: RESIDENT_1, payeeId: PROJECT_1, amountCents: 300, feeCents: 0, rail: 'digital_euro' } }), /pledge_malformed/);
  // A refusal consumes no reference: the same ref with valid terms lands.
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  // A second pledge from the same payer under a new ref is refused.
  attempt(sign({ pledgeRef: 'r9', share: { role: 'pledge:r9', payerId: RESIDENT_1, payeeId: PROJECT_1, amountCents: 50, feeCents: 0, rail: 'digital_euro' } }), /payer_already_pledged/);
  // The accepted ref over different bytes is a conflict, never a rewrite.
  attempt(sign({ share: { role: 'pledge:r1', payerId: RESIDENT_1, payeeId: PROJECT_1, amountCents: 301, feeCents: 0, rail: 'digital_euro' } }), /pledge_ref_conflict/);
  // A pledge addressed to an ordinary purchase or a nonexistent id.
  lunch(w, 1_300, MERCHANT_B, { purchaseId: 'ordinary-1' });
  assert.throws(() => w.coordinator.pledge(sign({ purchaseId: 'ordinary-1' })), /not_a_fund/);
  assert.throws(() => w.coordinator.pledge(sign({ purchaseId: 'ghost' })), /unknown_purchase/);
});

test('a pledge on a closed roster or at the cutoff is roster_closed', () => {
  const w = world();
  const id = openFundAs(w, TERMS({ condition: { minPayers: 1 } }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  assert.equal(w.coordinator.view(id).state, 'ready');
  assert.throws(() => pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30), /roster_closed/);
  // Collecting until the deadline but a pledge arriving AT the cutoff is out.
  const w2 = world();
  const id2 = openFundAs(w2, TERMS({ purchaseId: 'fund-2', acceptPledgesUntil: 'deadline' }));
  advance(w2, 20);
  assert.throws(() => pledgeAs(w2, id2, RESIDENT_1, 'r1', 300, 30), /roster_closed/);
});

test('evaluation lapses an expired pledge in one batch bump and keeps its history', () => {
  const w = world();
  // minPayers 3 keeps the roster collecting after two pledges.
  const id = openFundAs(w, TERMS({ condition: { minPayers: 3 }, fundingEndsAt: 40, settleBy: 50 }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 15);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 45);
  assert.deepEqual(w.coordinator.openFor(RESIDENT_1), [id]);
  advance(w, 16);
  w.coordinator.evaluate(id);
  const v = w.coordinator.view(id);
  assert.equal(v.proposal.version, 4, 'one bump for the whole lapse batch');
  assert.equal(v.proposal.totalCents, 700);
  assert.deepEqual(v.proposal.shares.map((s) => s.payerId), [RESIDENT_2]);
  assert.equal(v.authorizations.length, 1);
  assert.deepEqual(v.funding?.history.map((e) => e.outcome), ['lapsed', 'active']);
  assert.deepEqual(v.funding?.progress, { livePayers: 1, liveTotalCents: 700, met: false });
  // The lapsed payer leaves the active index; entitlement comes from history.
  assert.deepEqual(w.coordinator.openFor(RESIDENT_1), []);
  assert.deepEqual(w.coordinator.openFor(RESIDENT_2), [id]);
  const names = eventsFor(w, id).map((e) => e.event);
  assert.ok(names.includes('pledge_lapsed'));
  // A replay of the lapsed pledge still returns its original acknowledgment.
  const events = w.trace.events.length;
  const replay = w.coordinator.pledge(v.funding!.history[0].signed);
  assert.equal(replay.pledgeRef, 'r1');
  assert.equal(w.trace.events.length, events, 'replay emits nothing');
});

test('a lapse batch ending in cutoff failure leaves the surviving payer out of byPayer', () => {
  const w = world();
  // 'deadline' keeps the roster collecting until the cutoff and requires
  // every pledge to outlive it: r1 expires at 45, r2 at settleBy. The
  // evaluation at 46 lapses r1 (one batch bump) and fails the unmet
  // condition in the SAME roster commit — the surviving r2 share lands in
  // the failing version, so its index entry must go with the terminal
  // transition, not be rebuilt.
  const id = openFundAs(w, TERMS({ acceptPledgesUntil: 'deadline', fundingEndsAt: 40, settleBy: 50 }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 45);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 50);
  assert.deepEqual(w.coordinator.openFor(RESIDENT_1), [id]);
  assert.deepEqual(w.coordinator.openFor(RESIDENT_2), [id]);
  advance(w, 46);
  w.coordinator.evaluate(id);
  const v = w.coordinator.view(id);
  assert.equal(v.state, 'failed');
  assert.equal(v.reason, 'funding_condition_unmet');
  assert.equal(v.proposal.version, 4, 'one bump for the lapse batch');
  assert.deepEqual(v.proposal.shares.map((s) => s.payerId), [RESIDENT_2]);
  // Entries exist exactly while a purchase is open: neither payer indexes
  // the failed purchase — not even the one still on the committed roster.
  assert.deepEqual(w.coordinator.openFor(RESIDENT_1), []);
  assert.deepEqual(w.coordinator.openFor(RESIDENT_2), []);
});

test('a pledge expiring inside a CLOSED roster fails the whole purchase — never pruned', () => {
  const w = world();
  const id = openFundAs(w, TERMS({ condition: { minPayers: 2 }, fundingEndsAt: 40, settleBy: 50 }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 15);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 45);
  assert.equal(w.coordinator.view(id).state, 'ready', 'closed on the tipping pledge');
  advance(w, 16);
  w.coordinator.evaluate(id);
  const v = w.coordinator.view(id);
  assert.equal(v.state, 'failed');
  assert.equal(v.reason, 'pledge_expired');
  assert.equal(v.proposal.version, 3, 'closed roster never bumps');
  assert.equal(v.proposal.totalCents, 1_000, 'frozen roster preserved');
  assert.equal(v.authorizations.length, 2, 'materialized evidence preserved');
  assert.deepEqual(v.funding?.history.map((e) => e.outcome), ['active', 'active'], 'never pruned');
  assert.equal(eventsFor(w, id).at(-1)?.event, 'funding_failed');
});

test('evaluate at the cutoff resolves the roster: met → ready, unmet or empty → failed', () => {
  // Unmet: a single pledge short of minPayers 2 fails at the cutoff.
  const w = world();
  const id = openFundAs(w, TERMS());
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  advance(w, 20);
  w.coordinator.evaluate(id);
  assert.equal(w.coordinator.view(id).state, 'failed');
  assert.equal(w.coordinator.view(id).reason, 'funding_condition_unmet');
  assert.equal(eventsFor(w, id).at(-1)?.event, 'funding_failed');
  // An empty roster fails the same way — no money effects, no shares.
  const w2 = world();
  const id2 = openFundAs(w2, TERMS({ purchaseId: 'fund-2' }));
  advance(w2, 21);
  w2.coordinator.evaluate(id2);
  assert.equal(w2.coordinator.view(id2).state, 'failed');
  assert.equal(w2.coordinator.view(id2).reason, 'funding_condition_unmet');
  assert.equal(w2.coordinator.view(id2).legs.length, 0);
  // 'deadline' mode closes ready at the cutoff on the full roster.
  const w3 = world();
  const id3 = openFundAs(w3, TERMS({ purchaseId: 'fund-3', acceptPledgesUntil: 'deadline', condition: { minPayers: 2 } }));
  pledgeAs(w3, id3, RESIDENT_1, 'r1', 300, 25);
  pledgeAs(w3, id3, RESIDENT_2, 'r2', 700, 25);
  assert.equal(w3.coordinator.view(id3).state, 'awaiting_approvals', 'deadline mode never closes early');
  advance(w3, 20);
  w3.coordinator.evaluate(id3);
  assert.equal(w3.coordinator.view(id3).state, 'ready');
  assert.equal(w3.coordinator.view(id3).funding?.phase, 'closed');
});

test('evaluate delayed past settleBy fails with funding_settlement_expired', () => {
  const w = world();
  const id = openFundAs(w, TERMS());
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  advance(w, 31);
  w.coordinator.evaluate(id);
  assert.equal(w.coordinator.view(id).state, 'failed');
  assert.equal(w.coordinator.view(id).reason, 'funding_settlement_expired');
});

test('the payee alone cancels — bound to the current roster version — before admission', () => {
  const w = world();
  const id = openFundAs(w, TERMS());
  // A contributor can never cancel, not even as the only active payer.
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  const v = w.coordinator.view(id);
  assert.throws(() => cancelAs(w, v, RESIDENT_1), /not_authorized/);
  // A stale binding is refused even for the payee.
  const stale = signPayload({ kind: 'cancel', purchaseId: id, proposalVersion: 1, by: PROJECT_1 }, w.signers.get(PROJECT_1)!);
  assert.throws(() => w.coordinator.cancel(id, stale), /stale_version/);
  // The payee cancels at the current version; the roster index clears.
  cancelAs(w, w.coordinator.view(id), PROJECT_1);
  assert.equal(w.coordinator.view(id).state, 'cancelled');
  assert.deepEqual(w.coordinator.openFor(RESIDENT_1), []);
  // And on a ready fund under on_request: cancel wins over evaluation or
  // submission — the roster closed but nothing was ever sent.
  const w2 = world();
  const id2 = openFundAs(w2, TERMS({ purchaseId: 'fund-2', condition: { minPayers: 1 } }));
  pledgeAs(w2, id2, RESIDENT_1, 'r1', 300, 30);
  assert.equal(w2.coordinator.view(id2).state, 'ready');
  cancelAs(w2, w2.coordinator.view(id2), PROJECT_1);
  assert.equal(w2.coordinator.view(id2).state, 'cancelled');
  assert.ok(!eventsFor(w2, id2).some((e) => e.event === 'submit'), 'cancellation never submits');
});

test('generic approval and offer change refuse fund purchases; refresh routes through evaluation', () => {
  const w = world();
  const id = openFundAs(w, TERMS());
  const v = w.coordinator.view(id);
  assert.throws(() => approveAs(w, v, RESIDENT_1), /fund_requires_pledge/);
  assert.equal(w.trace.events.at(-1)?.event, 'approval_rejected');
  assert.equal(w.trace.events.at(-1)?.detail?.reason, 'fund_requires_pledge');
  assert.throws(() => changeOfferAs(w, v, { merchantId: PROJECT_1, totalCents: 900, expiresAt: 30 }, PROJECT_1), /fund_terms_immutable/);
  // The shared refresh on a fund runs the funding evaluation: advance past
  // a pledge's expiry and refreshAuthorization lapses it.
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 15);
  advance(w, 16);
  w.coordinator.refreshAuthorization(id);
  assert.equal(w.coordinator.view(id).proposal.totalCents, 0);
  assert.deepEqual(w.coordinator.view(id).funding?.history.map((e) => e.outcome), ['lapsed']);
  // evaluate() is unsigned maintenance — and refuses a non-fund purchase.
  lunch(w, 1_300, MERCHANT_B, { purchaseId: 'ordinary-1' });
  assert.throws(() => w.coordinator.evaluate('ordinary-1'), /not_a_fund/);
});

test('authorizationCurrentlyValid reads a lapsed pledge invalid through check_pledge', () => {
  const w = world();
  // minPayers 3 keeps the roster collecting while r1's expiry passes.
  const id = openFundAs(w, TERMS({ condition: { minPayers: 3 }, fundingEndsAt: 40, settleBy: 50 }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 15);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 45);
  const pledgeAuth = (ref: string) => {
    const a = w.coordinator.view(id).authorizations.find((x) => x.basis === 'pledge' && x.pledge.payload.pledgeRef === ref);
    assert.ok(a !== undefined, `materialized pledge authorization ${ref}`);
    return a;
  };
  // The same read-only check the payer projections expose as currentlyValid.
  assert.equal(w.coordinator.authorizationCurrentlyValid(id, pledgeAuth('r1')), true);
  // Past r1's expiry but before any evaluation lapses it, the materialized
  // authorization still sits on the open purchase — and the read reports it
  // invalid through the funding module's check_pledge, never still-valid.
  advance(w, 16);
  const retained = pledgeAuth('r1');
  assert.equal(w.coordinator.authorizationCurrentlyValid(id, retained), false);
  assert.equal(w.coordinator.authorizationCurrentlyValid(id, pledgeAuth('r2')), true, 'the unexpired pledge is unaffected');
  // Once evaluation has lapsed the record the stale view extract keeps
  // reading invalid — a lapsed pledge has no live authority left.
  w.coordinator.evaluate(id);
  assert.equal(w.coordinator.view(id).funding?.history[0].outcome, 'lapsed');
  assert.equal(w.coordinator.authorizationCurrentlyValid(id, retained), false);
});

test('the operation guard covers funding calls, including replay', async () => {
  const w = world();
  const id = openFundAs(w, TERMS());
  const first = pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  // Hold the guard with a slow settlement answer: every funding entry
  // point — even the otherwise-inert replay — reports operation_in_progress.
  const real = w.settlement.submit.bind(w.settlement);
  let release!: () => void;
  w.settlement.submit = (intent) =>
    new Promise((resolve) => {
      release = () => void real(intent).then(resolve);
    });
  const pending = submitAs(w, w.coordinator.view(id), RESIDENT_1);
  assert.throws(() => w.coordinator.pledge(first.signed), /operation_in_progress/);
  assert.throws(() => pledgeAs(w, id, RESIDENT_3, 'r3', 50, 30), /operation_in_progress/);
  assert.throws(() => w.coordinator.evaluate(id), /operation_in_progress/);
  assert.throws(() => w.coordinator.refreshAuthorization(id), /operation_in_progress/);
  // Payee cancellation and a second signed submit wait behind the same
  // guard while the admitted operation owns the purchase.
  assert.throws(() => cancelAs(w, w.coordinator.view(id), PROJECT_1), /operation_in_progress/);
  await assert.rejects(() => submitAs(w, w.coordinator.view(id), RESIDENT_2), /operation_in_progress/);
  release();
  await pending;
  await w.coordinator.idle();
});

test('a closed fund settles its roster legs atomically under a payer-signed submit', async () => {
  const w = world();
  const id = openFundAs(w, TERMS());
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  await submitAs(w, w.coordinator.view(id), RESIDENT_1);
  const v = w.coordinator.view(id);
  assert.equal(v.state, 'completed');
  assert.equal(v.legs.length, 2);
  assert.deepEqual(v.legs.map((l) => l.leg), ['pledge:r1', 'pledge:r2']);
  assert.equal(v.legs[0].authorityRef, 'r1');
  assert.equal(payeeBankCents(w, PROJECT_1), 1_000);
  // Terminal evaluation is inert afterwards.
  const events = w.trace.events.length;
  w.coordinator.evaluate(id);
  assert.equal(w.trace.events.length, events);
});

test('an on_ready fund self-submits once the closing pledge lands — tracked by idle()', async () => {
  const w = world();
  const id = openFundAs(w, TERMS({ condition: { minPayers: 2 }, submitPolicy: 'on_ready' }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  assert.equal(w.coordinator.view(id).state, 'awaiting_approvals');
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  assert.equal(w.coordinator.view(id).state, 'ready');
  await w.coordinator.idle();
  assert.equal(w.coordinator.view(id).state, 'completed');
  const submit = eventsFor(w, id).find((e) => e.event === 'submit');
  assert.equal(submit?.detail?.trigger, 'auto');
});

// --- Admission, deferred first handoff and replay -----------------------------

test('admission freezes the roster: admitted phase, pledge evidence on the frozen submission, unchanged keys and roster', async () => {
  const w = world();
  const id = openFundAs(w, TERMS());
  const first = pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  const second = pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  const version = w.coordinator.view(id).proposal.version;
  const history = structuredClone(unwrapView(w.coordinator.view(id).funding!.history));
  const seen: unknown[] = [];
  const real = w.settlement.submit.bind(w.settlement);
  w.settlement.submit = async (intent) => {
    seen.push(structuredClone(intent));
    return real(intent);
  };
  await submitAs(w, w.coordinator.view(id), RESIDENT_1);
  const v = w.coordinator.view(id);
  assert.equal(v.state, 'completed');
  assert.equal(v.funding?.phase, 'admitted');
  assert.equal(v.proposal.version, version, 'admission never bumps the roster version');
  assert.deepEqual(v.funding?.history, history, 'admitted funding retains identical evidence');
  assert.deepEqual(
    v.legs.map((l) => [l.leg, l.idempotencyKey, l.authorityRef, l.rail]),
    [
      ['pledge:r1', `${id}:v${version}:pledge:r1`, 'r1', 'digital_euro'],
      ['pledge:r2', `${id}:v${version}:pledge:r2`, 'r2', 'digital_euro'],
    ],
  );
  // The signed pledges froze with the submission — detached copies of the
  // evidence verified at admission.
  assert.deepEqual(
    v.submission?.legs.map((l) => l.pledge?.payload.pledgeRef),
    ['r1', 'r2'],
  );
  assert.equal(v.submission?.legs[0].pledge?.signature, first.signed.signature);
  assert.equal(v.submission?.legs[1].pledge?.signature, second.signed.signature);
  assert.equal(v.submission?.legs[0].dispatch, 'forwarded');
  assert.equal(payeeBankCents(w, PROJECT_1), 1_000);
  assert.equal(payerDeCents(w, RESIDENT_1), 1_700);
  assert.equal(payerDeCents(w, RESIDENT_2), 1_300);
  // A replay hands the orchestrator the identical intent under the same
  // keys and charges nothing twice.
  await w.coordinator.resubmit(id);
  assert.deepEqual(seen[0], seen[1], 'the replay used the frozen intent, not fresh terms');
  assert.equal(payeeBankCents(w, PROJECT_1), 1_000);
  assert.equal(w.coordinator.view(id).state, 'completed');
  // An exact pledge replay stays inert after admission: no events, no
  // roster or version change, no new charge.
  const events = w.trace.events.length;
  assert.deepEqual(w.coordinator.pledge(first.signed), first.acceptance);
  assert.equal(w.trace.events.length, events);
  assert.equal(payeeBankCents(w, PROJECT_1), 1_000);
});

test('a pledge expiring before its first handoff refuses the leg; the other hold is released, never charged', async () => {
  const w = world();
  const id = openFundAs(w, TERMS({ fundingEndsAt: 40, settleBy: 50 }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 15);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 45);
  assert.equal(w.coordinator.view(id).state, 'ready');
  // r1's provider never began: its reserve is conclusively unstarted while
  // r2's accepted hold waits — admission already froze the roster.
  w.providers.get(RESIDENT_1)!.available = false;
  await submitAs(w, w.coordinator.view(id), RESIDENT_1);
  let v = w.coordinator.view(id);
  assert.equal(v.state, 'pending');
  assert.equal(v.funding?.phase, 'admitted');
  assert.equal(v.submission?.legs[0].dispatch, 'planned', 'unstarted — the provider never reported work');
  assert.equal(v.settlement?.legs[0].reserve?.reason, 'provider_unavailable');
  assert.equal(v.submission?.legs[1].dispatch, 'forwarded');
  // Past r1's expiry its deferred first handoff revalidates through the
  // funding module's check_pledge — never a second binding rule — and the
  // atomic abort releases r2's hold without charging anyone.
  advance(w, 16);
  w.providers.get(RESIDENT_1)!.available = true;
  await w.coordinator.resubmit(id);
  v = w.coordinator.view(id);
  assert.equal(v.state, 'failed');
  assert.equal(v.legs[0].status, 'rejected');
  assert.equal(v.legs[0].rejectReason, 'pledge_expired');
  assert.equal(v.submission?.legs[0].dispatch, 'refused');
  assert.equal(v.legs[1].status, 'rejected', "r2's accepted hold was released, never committed");
  assert.equal(payerDeCents(w, RESIDENT_1), 2_000);
  assert.equal(payerDeCents(w, RESIDENT_2), 2_000);
  assert.equal(payeeBankCents(w, PROJECT_1), 0);
  // Admission stands — settlement owned the outcome — and the frozen
  // roster, keys and pledge evidence are untouched.
  assert.equal(v.funding?.phase, 'admitted');
  assert.equal(v.proposal.version, 3);
  assert.deepEqual(v.funding?.history.map((e) => e.outcome), ['active', 'active']);
  assert.ok(
    w.trace.events.some(
      (e) => e.event === 'leg_authority_refused' && e.detail?.role === 'pledge:r1' && e.detail?.reason === 'pledge_expired',
    ),
  );
  const events = w.trace.events.length;
  w.coordinator.evaluate(id);
  assert.equal(w.trace.events.length, events, 'repeated evaluation is inert on a settlement-owned purchase');
});

test('an unstarted first handoff past settleBy refuses with funding_settlement_expired', async () => {
  const w = world();
  const id = openFundAs(w, TERMS({ fundingEndsAt: 20, settleBy: 30 }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  w.providers.get(RESIDENT_1)!.available = false;
  await submitAs(w, w.coordinator.view(id), RESIDENT_1);
  assert.equal(w.coordinator.view(id).state, 'pending');
  // The whole settlement window closed while r1's leg waited.
  advance(w, 31);
  w.providers.get(RESIDENT_1)!.available = true;
  await w.coordinator.resubmit(id);
  const v = w.coordinator.view(id);
  assert.equal(v.state, 'failed');
  assert.equal(v.legs[0].rejectReason, 'funding_settlement_expired');
  assert.equal(payerDeCents(w, RESIDENT_1), 2_000);
  assert.equal(payerDeCents(w, RESIDENT_2), 2_000);
  assert.equal(payeeBankCents(w, PROJECT_1), 0);
});

test('a forwarded pledge leg reconciles after response loss even once its pledge expired', async () => {
  const w = world();
  const id = openFundAs(w, TERMS({ fundingEndsAt: 20, settleBy: 30 }));
  // r1 pays by bank: its reserve reaches the provider but the bank-hold
  // response is lost AFTER the effect — forwarded work, never a fresh
  // first handoff. Its pledge expires at 10.2, before the provider hold's
  // own TTL, so the loss window crosses the pledge expiry.
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 10.2, { rail: 'bank' });
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 10.4, { rail: 'digital_euro' });
  const version = w.coordinator.view(id).proposal.version;
  w.providers.get(RESIDENT_1)!.setFault(legChildKey(id, version, 'pledge:r1', 'hold', 'bank'), 'hold', 'lose_response_after_effect');
  await submitAs(w, w.coordinator.view(id), RESIDENT_1);
  let v = w.coordinator.view(id);
  assert.equal(v.state, 'pending');
  assert.equal(v.submission?.legs[0].dispatch, 'forwarded', 'the provider may hold state — money could be out');
  assert.equal(v.settlement?.legs[0].reserve?.status, 'unknown');
  // The pledge expired meanwhile: expiry never invalidates a forwarded
  // operation — the authoritative status under the original key resumes
  // the same work and the same intent completes.
  advance(w, 10.3);
  await w.coordinator.reconcile(id);
  v = w.coordinator.view(id);
  assert.equal(v.state, 'completed');
  assert.equal(v.funding?.phase, 'admitted');
  assert.equal(v.submission?.legs[0].pledge?.payload.expiresAt, 10.2, 'the frozen evidence travels with the replay');
  assert.equal(payeeBankCents(w, PROJECT_1), 1_000);
  assert.equal(payerBankCents(w, RESIDENT_1), 49_700);
  assert.equal(payerDeCents(w, RESIDENT_2), 1_300);
});

test('a conclusive rejection before intent registration restores the same closed roster; an explicit submit retries', async () => {
  const w = world();
  const id = openFundAs(w, TERMS());
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  const version = w.coordinator.view(id).proposal.version;
  const history = structuredClone(unwrapView(w.coordinator.view(id).funding!.history));
  const real = w.settlement.submit.bind(w.settlement);
  w.settlement.submit = async () => {
    throw new Error('settlement_intent_rejected');
  };
  await assert.rejects(() => submitAs(w, w.coordinator.view(id), RESIDENT_1), /settlement_intent_rejected/);
  const rolled = w.coordinator.view(id);
  assert.equal(rolled.state, 'ready', 'pre-dispatch rollback keeps the purchase repairable');
  assert.equal(rolled.funding?.phase, 'closed', 'the attempt restores the same closed phase — never collecting');
  assert.equal(rolled.proposal.version, version, 'no membership or version change');
  assert.deepEqual(rolled.funding?.history, history, 'pledge evidence untouched');
  assert.equal(rolled.authorizations.length, 2);
  assert.equal(rolled.legs.length, 0);
  assert.equal(rolled.submission, undefined, 'only this attempt’s unadmitted work is cleared');
  // An explicit signed submit is the way forward — same roster, same keys.
  w.settlement.submit = real;
  await submitAs(w, rolled, RESIDENT_2);
  const done = w.coordinator.view(id);
  assert.equal(done.state, 'completed');
  assert.equal(done.funding?.phase, 'admitted');
  assert.deepEqual(
    done.legs.map((l) => l.idempotencyKey),
    [`${id}:v${version}:pledge:r1`, `${id}:v${version}:pledge:r2`],
  );
  assert.equal(payeeBankCents(w, PROJECT_1), 1_000);
});

test('an on_ready fund rolled back before dispatch never refires; an explicit submit is the only way forward', async () => {
  const w = world();
  const id = openFundAs(w, TERMS({ submitPolicy: 'on_ready' }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  const real = w.settlement.submit.bind(w.settlement);
  w.settlement.submit = async () => {
    throw new Error('settlement_intent_rejected');
  };
  // The closing pledge fires the coordinator's own submission, which is
  // refused before intent registration: the rollback restores 'closed'.
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  await w.coordinator.idle();
  const v = w.coordinator.view(id);
  assert.equal(v.state, 'ready');
  assert.equal(v.funding?.phase, 'closed');
  assert.ok(eventsFor(w, id).some((e) => e.event === 'submit_auto_refused'));
  const submits = eventsFor(w, id).filter((e) => e.event === 'submit').length;
  // A later evaluation cannot refire the once-per-ready self-submission.
  w.coordinator.evaluate(id);
  assert.equal(eventsFor(w, id).filter((e) => e.event === 'submit').length, submits);
  w.settlement.submit = real;
  await submitAs(w, w.coordinator.view(id), RESIDENT_1);
  assert.equal(w.coordinator.view(id).state, 'completed');
});

test('a fee-bearing bank pledge is compensated principal AND fee when the digital-euro group refuses', async () => {
  const w = world();
  const id = openFundAs(w, TERMS({ fundingEndsAt: 40, settleBy: 50 }));
  // Both rails in one atomic intent: r1 bank with a PSP fee, r2 digital euro.
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 45, { feeCents: 7, rail: 'bank' });
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 45, { rail: 'digital_euro' });
  const version = w.coordinator.view(id).proposal.version;
  // The DE group commit is conclusively refused after the bank leg
  // committed: the unwind compensates under the original keys.
  w.digitalEuro.setFault(deGroupKey(id, version, ['pledge:r2']), 'commit', 'reject_before_effect');
  await submitAs(w, w.coordinator.view(id), RESIDENT_1);
  const v = w.coordinator.view(id);
  assert.equal(v.state, 'compensated');
  assert.equal(v.funding?.phase, 'admitted');
  assert.equal(v.legs[0].status, 'returned');
  assert.equal(v.legs[1].status, 'rejected');
  assert.equal(payerBankCents(w, RESIDENT_1), 50_000, 'principal and fee came back');
  assert.equal(payerDeCents(w, RESIDENT_2), 2_000, 'the DE hold was released, never charged');
  assert.equal(payeeBankCents(w, PROJECT_1), 0);
  assert.equal(v.returnStatus, 'completed');
  // The frozen keys and roster are exactly what the attempt used; a
  // reconcile reports the same outcome and charges nothing again.
  assert.deepEqual(
    v.legs.map((l) => l.idempotencyKey),
    [`${id}:v${version}:pledge:r1`, `${id}:v${version}:pledge:r2`],
  );
  await w.coordinator.reconcile(id);
  assert.equal(w.coordinator.view(id).state, 'compensated');
  assert.equal(payerBankCents(w, RESIDENT_1), 50_000);
  assert.equal(payeeBankCents(w, PROJECT_1), 0);
});
