// Anonymous-charity proposals (spec §3.2): the buyer-signed variant asks
// the coordinator to match one donor allowance for the buyer's attested
// class. The buyer's signature verifies before any authority lookup; a
// matched proposal always starts awaiting explicit buyer approval — even
// fully sponsored — and a missing/no-capacity match falls back to
// buyer-only funding under anonymous request_only terms, recording the
// reason as evidence rather than refusing the request. Corrupt retained
// authority refuses instead of silently omitting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  world,
  publishAllowanceAs,
  publishAttestationAs,
  proposeCharityAs,
  approveAs,
  changeOfferAs,
  refundAs,
  submitAs,
  legChildKey,
  advance,
  payerBankCents,
  payerDeCents,
  payeeBankCents,
  CHARITY_1,
  DONOR_1,
  DONOR_2,
  IN_NEED,
  ORACLE_1,
  RESIDENT_1,
  RESIDENT_2,
} from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';
import { keyPairFromSeed, sharesDigestOf, signPayload } from '../src/core/signing.ts';
import type { Signed } from '../src/core/signing.ts';
import { attestationKey } from '../src/core/authority.ts';
import { viewFor } from '../src/core/privacy.ts';
import type { PayerView } from '../src/core/privacy.ts';
import { unwrapView } from '../src/core/live-view.ts';
import type { AllowanceMandate, CharityProposeRequest, EligibilityAttestation, PayerApproval, Purchase } from '../src/core/types.ts';

const ALLOWANCE: AllowanceMandate = {
  allowanceRef: 'allowance-1',
  donorId: DONOR_1,
  version: 1,
  beneficiaryClass: IN_NEED,
  maxPerPurchaseCents: 500,
  maxPerDayCents: 2_000,
  maxPurchasesPerDay: 2,
  totalEndowmentCents: 10_000,
  eligibleMerchants: [CHARITY_1],
  validFrom: 0,
  validUntil: 1_000,
  revoked: false,
  privacyProfile: 'anonymous_donation_v1',
};

const allowance = (over: Partial<AllowanceMandate> = {}): AllowanceMandate => ({ ...ALLOWANCE, ...over });

const ATTESTATION: EligibilityAttestation = {
  attestorId: ORACLE_1,
  subjectId: RESIDENT_1,
  classId: IN_NEED,
  validFrom: 0,
  validUntil: 1_000,
  version: 1,
  revoked: false,
};

const attestation = (over: Partial<EligibilityAttestation> = {}): EligibilityAttestation => ({ ...ATTESTATION, ...over });

const propose = (w: World, over: object = {}) =>
  proposeCharityAs(w, { purchaseId: 'charity-1', employeeId: RESIDENT_1, merchantId: CHARITY_1, totalCents: 1_000, expiresAt: 100, ...over });

const payerView = (w: World, p: { proposal: unknown; purchaseId: string }): PayerView => {
  const v = viewFor(p as never, { partyId: RESIDENT_1, facet: 'payer' });
  if (!('approval' in v)) throw new Error('expected an ordinary payer view');
  return v;
};

const requestRefusals = (w: World) => w.trace.events.filter((e) => e.event === 'request_refused');

// --- Matching and shares ---------------------------------------------------

test('a matched proposal funds the donor share from the selected allowance and waits for buyer approval', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  assert.equal(p.state, 'awaiting_approvals');
  assert.deepEqual(
    p.proposal.shares.map((s) => [s.role, s.payerId, s.amountCents, s.feeCents, s.rail, s.authority, s.authorityRef]),
    [
      ['buyer', RESIDENT_1, 500, 0, 'digital_euro', 'payer', undefined],
      ['donor', DONOR_1, 500, 0, 'bank', 'sponsor_mandate', 'allowance-1'],
    ],
  );
  assert.deepEqual(p.charity, { buyerId: RESIDENT_1, benefitClass: IN_NEED, allowanceRef: 'allowance-1', donorId: DONOR_1 });
  assert.deepEqual(p.proposal.privacy, {
    profile: 'anonymous_donation_v1',
    source: { kind: 'allowance', allowanceRef: 'allowance-1', version: 1, donorId: DONOR_1 },
  });
  // The match is recorded once, with magnitude — never in a refusal.
  const matched = w.trace.events.filter((e) => e.event === 'allowance_matched');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].origin, 'LOCAL');
  assert.equal(matched[0].detail?.allowanceRef, 'allowance-1');
  assert.equal(matched[0].detail?.donorCents, 500);
  assert.equal(requestRefusals(w).length, 0);
  approveAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'ready');
});

test('the greatest positive contribution wins; reference order breaks a tie', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  // 'allowance-b' sorts later but contributes more: it wins over 'allowance-a'.
  publishAllowanceAs(w, allowance({ allowanceRef: 'allowance-a', donorId: DONOR_1, maxPerPurchaseCents: 100 }));
  publishAllowanceAs(w, allowance({ allowanceRef: 'allowance-b', donorId: DONOR_2, maxPerPurchaseCents: 400 }));
  const p = propose(w);
  assert.equal(p.charity?.allowanceRef, 'allowance-b');
  assert.equal(p.charity?.donorId, DONOR_2);
  assert.equal(p.proposal.shares.find((s) => s.role === 'donor')?.amountCents, 400);
  // The equal-contribution tie resolves to the smallest reference,
  // independent of publication order.
  const w2 = world();
  publishAttestationAs(w2, attestation());
  publishAllowanceAs(w2, allowance({ allowanceRef: 'allowance-b', donorId: DONOR_2, maxPerPurchaseCents: 400 }));
  publishAllowanceAs(w2, allowance({ allowanceRef: 'allowance-a', donorId: DONOR_1, maxPerPurchaseCents: 400 }));
  const p2 = proposeCharityAs(w2, { purchaseId: 'charity-1', employeeId: RESIDENT_1, merchantId: CHARITY_1, totalCents: 1_000, expiresAt: 100 });
  assert.equal(p2.charity?.allowanceRef, 'allowance-a', 'equal contributions resolve to the smallest reference');
  assert.equal(p2.charity?.donorId, DONOR_1);
});

test('a fully sponsored proposal still starts awaiting_approvals and becomes ready only on buyer approval', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance({ maxPerPurchaseCents: 1_000 }));
  const p = propose(w);
  assert.equal(p.state, 'awaiting_approvals');
  // The buyer's share exists even at zero: consent is still required — the
  // proposal itself is not approval.
  const buyer = p.proposal.shares.find((s) => s.role === 'buyer')!;
  assert.equal(buyer.amountCents, 0);
  assert.equal(buyer.authority, 'payer');
  assert.equal(p.authorizations.length, 0, 'no automatic authorization, even fully sponsored');
  approveAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'ready');
  assert.equal(p.authorizations.length, 1);
  const approval = p.authorizations[0];
  assert.ok(approval.basis === 'device');
  assert.equal(approval.approval.payload.amountCents, 0, 'zero-debit consent is real approval evidence');
});

// --- Buyer-only fallback ----------------------------------------------------

test('no attestation records no_live_attestation and falls back to buyer-only request_only', () => {
  const w = world();
  publishAllowanceAs(w, allowance());
  // Nothing attested for resident-1 — but an allowance exists: absence is a
  // genuine no-match, evidence rather than refusal.
  const p = propose(w);
  assert.equal(p.state, 'awaiting_approvals');
  assert.deepEqual(p.charity, { buyerId: RESIDENT_1, benefitClass: IN_NEED, unmatchedReason: 'no_live_attestation' });
  assert.deepEqual(p.proposal.shares.map((s) => [s.role, s.payerId, s.amountCents, s.authority]), [['buyer', RESIDENT_1, 1_000, 'payer']]);
  assert.deepEqual(p.proposal.privacy, { profile: 'anonymous_donation_v1', source: { kind: 'request_only' } });
  const unmatched = w.trace.events.filter((e) => e.event === 'allowance_unmatched');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].origin, 'LOCAL');
  assert.equal(unmatched[0].detail?.reason, 'no_live_attestation');
  assert.equal(w.trace.events.filter((e) => e.event === 'allowance_matched').length, 0);
  assert.equal(requestRefusals(w).length, 0);
});

test('a revoked or expired attestation is no_live_attestation, not a refusal', () => {
  for (const over of [{ revoked: true }, { validFrom: 0, validUntil: 5 }, { validFrom: 500, validUntil: 1_000 }]) {
    const w = world();
    publishAttestationAs(w, attestation(over));
    publishAllowanceAs(w, allowance());
    const p = propose(w);
    assert.equal(p.charity?.unmatchedReason, 'no_live_attestation', JSON.stringify(over));
    assert.equal(p.proposal.privacy.source.kind, 'request_only');
    assert.equal(requestRefusals(w).length, 0);
  }
});

test('an exhausted allowance falls back with its no-capacity reason, not a refusal', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance({ totalEndowmentCents: 0 }));
  const p = propose(w);
  assert.equal(p.charity?.unmatchedReason, 'lifetime_cap_used');
  assert.equal(p.proposal.privacy.source.kind, 'request_only');
  assert.equal(p.proposal.shares.length, 1, 'buyer-only: no donor share');
  const unmatched = w.trace.events.find((e) => e.event === 'allowance_unmatched');
  assert.equal(unmatched?.detail?.reason, 'lifetime_cap_used');
  // The fallback is not ready until a fresh approval of the full buyer price.
  assert.equal(p.state, 'awaiting_approvals');
  approveAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'ready');
  const a = p.authorizations[0];
  assert.ok(a.basis === 'device' && a.approval.payload.amountCents === 1_000);
});

test('an ineligible-merchant allowance is skipped by the match', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance({ eligibleMerchants: ['other-shop'] }));
  const p = propose(w);
  assert.equal(p.charity?.unmatchedReason, 'merchant_not_eligible');
  assert.equal(p.proposal.privacy.source.kind, 'request_only');
});

// --- Refusals: corrupt retained authority and malformed requests -----------

test('corrupt retained attestation or allowance refuses instead of falling back', () => {
  // A retained record that fails schema, binding, issuer trust or signature
  // is invalid authority, not absence — the request fails closed.
  const w = world();
  publishAttestationAs(w, attestation());
  const stored = w.authority.eligibilityAttestation(RESIDENT_1, IN_NEED)!;
  stored.signed.payload.revoked = true; // post-acceptance corruption breaks the signature
  assert.throws(() => propose(w), /attestation_signature_invalid/);
  assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'attestation_signature_invalid');
  assert.throws(() => w.coordinator.view('charity-1'), /unknown_purchase/);

  const w2 = world();
  publishAttestationAs(w2, attestation());
  publishAllowanceAs(w2, allowance());
  const retained = w2.authority.allowanceMandate('allowance-1')!;
  retained.signed.payload.maxPerPurchaseCents = 9_999; // corrupt after acceptance
  assert.throws(() => propose(w2), /allowance_signature_invalid/);
  assert.throws(() => w2.coordinator.view('charity-1'), /unknown_purchase/);
});

for (const [store, key, reason] of [
  ['attestations', attestationKey(RESIDENT_1, IN_NEED), 'attestation_malformed'],
  ['attestationsAccepted', attestationKey(RESIDENT_1, IN_NEED), 'attestation_malformed'],
  ['allowances', 'allowance-1', 'allowance_malformed'],
  ['allowancesAccepted', 'allowance-1', 'allowance_malformed'],
] as const) {
  test(`a published charity authority missing ${store} refuses without buyer-only fallback`, () => {
    const w = world();
    publishAttestationAs(w, attestation());
    publishAllowanceAs(w, allowance());
    // Either half surviving publication proves this is retained corruption,
    // not a never-published pair or reference. Exercise the real proposal
    // path so allowance enumeration cannot silently hide the corruption.
    const retained = w.authority as unknown as Record<typeof store, Map<string, unknown>>;
    assert.equal(retained[store].delete(key), true);
    assert.throws(() => propose(w), new RegExp(reason));
    assert.equal(requestRefusals(w).at(-1)?.detail?.reason, reason);
    assert.throws(() => w.coordinator.view('charity-1'), /unknown_purchase/);
    assert.equal(w.trace.events.some((e) => e.event === 'allowance_unmatched'), false);
  });
}

test('a charity request carrying forbidden fields is refused, not reinterpreted', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const base = {
    kind: 'propose',
    purchaseId: 'charity-1',
    proposalVersion: 1,
    by: RESIDENT_1,
    employeeId: RESIDENT_1,
    merchantId: CHARITY_1,
    totalCents: 1_000,
    expiresAt: 100,
    submitPolicy: 'on_request',
    settlementMode: 'atomic',
    privacyProfile: 'anonymous_donation_v1',
    benefitClass: IN_NEED,
  };
  for (const extra of [
    { grant: {} },
    { mandateRef: 'allowance-1' },
    { feesCents: 10 },
    { shares: [{ role: 'donor', payerId: DONOR_1, amountCents: 1_000 }] },
    { rail: 'bank' },
    { donorCents: 1_000 },
    { amountsFrom: 'proposer' },
  ]) {
    const signed = signPayload({ ...base, ...extra } as never, w.signers.get(RESIDENT_1)!);
    assert.throws(() => w.coordinator.propose(signed as Signed<CharityProposeRequest>), /charity_request_invalid/, JSON.stringify(extra));
    assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'charity_request_invalid');
  }
  assert.throws(() => w.coordinator.view('charity-1'), /unknown_purchase/, 'no record survived a refused variant');
  // The purchaseId was not burned: a clean variant still commits on it.
  assert.equal(propose(w).state, 'awaiting_approvals');
});

test('a charity request carrying a malformed scalar field is refused, not reinterpreted', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const base = {
    kind: 'propose',
    purchaseId: 'charity-1',
    proposalVersion: 1,
    by: RESIDENT_1,
    employeeId: RESIDENT_1,
    merchantId: CHARITY_1,
    totalCents: 1_000,
    expiresAt: 100,
    submitPolicy: 'on_request',
    settlementMode: 'atomic',
    privacyProfile: 'anonymous_donation_v1',
    benefitClass: IN_NEED,
  };
  // A verified signature proves who signed, not that the terms are
  // usable: every field the variant carries gets a shape check — an
  // empty or non-string purchaseId and a non-finite expiry refuse like
  // the other allowlist checks.
  for (const over of [
    { purchaseId: '' },
    { purchaseId: 42 },
    { expiresAt: Number.NaN },
    { expiresAt: Number.POSITIVE_INFINITY },
    { expiresAt: 'soon' },
  ]) {
    const signed = signPayload({ ...base, ...over } as never, w.signers.get(RESIDENT_1)!);
    assert.throws(() => w.coordinator.propose(signed as Signed<CharityProposeRequest>), /charity_request_invalid/, JSON.stringify(over));
    assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'charity_request_invalid', JSON.stringify(over));
  }
  assert.throws(() => w.coordinator.view('charity-1'), /unknown_purchase/, 'no record survived a refused variant');
  assert.equal(propose(w).state, 'awaiting_approvals');
});

test('an agent signature cannot carry a charity proposal — even under a valid grant', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  // 'agent-1' holds a registered key: the charity variant accepts only the
  // buyer's own signature, so the request is not_authorized before any
  // authority read.
  assert.throws(
    () => proposeCharityAs(w, { purchaseId: 'charity-1', employeeId: RESIDENT_1, merchantId: CHARITY_1, totalCents: 1_000, expiresAt: 100 }, 'agent-1'),
    /not_authorized/,
  );
  assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'not_authorized');
  assert.throws(() => w.coordinator.view('charity-1'), /unknown_purchase/);
});

test('a wrong signer or a bad signature is refused before the match runs', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  // Signed by a different registered party than the named buyer.
  assert.throws(
    () => proposeCharityAs(w, { purchaseId: 'charity-1', employeeId: RESIDENT_1, merchantId: CHARITY_1, totalCents: 1_000, expiresAt: 100 }, RESIDENT_2),
    /not_authorized/,
  );
  // Signed under an unregistered key: bad_signature precedes every other check.
  const payload: CharityProposeRequest = {
    kind: 'propose',
    purchaseId: 'charity-1',
    proposalVersion: 1,
    by: 'mallory-1',
    employeeId: 'mallory-1',
    merchantId: CHARITY_1,
    totalCents: 1_000,
    expiresAt: 100,
    submitPolicy: 'on_request',
    settlementMode: 'atomic',
    privacyProfile: 'anonymous_donation_v1',
    benefitClass: IN_NEED,
  };
  assert.throws(() => w.coordinator.propose(signPayload(payload, keyPairFromSeed('k-rogue', 'rogue'))), /bad_signature/);
  assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'bad_signature');
  assert.throws(() => w.coordinator.view('charity-1'), /unknown_purchase/);
});

// --- Consent ----------------------------------------------------------------

test("an Auto-capable standing mandate never substitutes for explicit buyer approval", () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance({ maxPerPurchaseCents: 1_000 }));
  // The buyer's own standing terms would be Auto under a benefit purchase —
  // a charity purchase records no mandate evidence either way.
  w.authority.publishEmployeeMandate(
    signPayload(
      {
        mandateRef: 'resident-terms',
        employeeId: RESIDENT_1,
        version: 1,
        autoPayMaxCents: 5_000,
        maxCents: 5_000,
        autoPayMonthlyCents: 50_000,
        trustedMerchants: [CHARITY_1],
        blockedMerchants: [],
        allowedRails: ['digital_euro'],
        validUntil: 1_000,
        revoked: false,
      },
      w.signers.get(RESIDENT_1)!,
    ),
  );
  const p = propose(w);
  assert.equal(p.state, 'awaiting_approvals', 'standing terms cannot bypass explicit charity consent');
  assert.equal(p.authorizations.length, 0);
  assert.equal(p.employeeAssessment, undefined, 'no benefit assessment exists on a charity purchase');
});

test('an exception basis or another payer cannot approve a charity purchase', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  // The donor is not an approver: its share is sponsor-authority.
  assert.throws(() => approveAs(w, p, DONOR_1), /does not match/);
  // An exception acknowledgment is no charity basis — device only.
  const exception: PayerApproval = {
    approvalRef: 'appr-charity-exception',
    purchaseId: p.purchaseId,
    payerId: RESIDENT_1,
    proposalVersion: p.proposal.version,
    merchantId: p.proposal.merchantId,
    totalCents: p.proposal.totalCents,
    amountCents: 500,
    feeCents: 0,
    sharesDigest: payerView(w, p).approval.sharesDigest,
    privacyProfile: 'anonymous_donation_v1',
    expiresAt: p.proposal.expiresAt,
    basis: 'exception',
    exception: true,
  };
  assert.throws(() => w.coordinator.approve(p.purchaseId, signPayload(exception, w.signers.get(RESIDENT_1)!)), /does not match/);
  assert.equal(w.trace.events.filter((e) => e.event === 'approval_rejected').at(-1)?.detail?.reason, 'terms_mismatch');
  assert.equal(p.authorizations.length, 0);
});

test('changing a displayed approval field or the allocation commitment refuses', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  const terms = payerView(w, p).approval;
  const sign = (over: object) =>
    w.coordinator.approve(
      p.purchaseId,
      signPayload({ approvalRef: 'appr-tampered', ...terms, ...over, basis: 'device' } as PayerApproval, w.signers.get(RESIDENT_1)!),
    );
  for (const over of [
    { totalCents: 999 },
    { amountCents: 0 },
    { merchantId: 'merchant-a' },
    { expiresAt: 150 },
    { privacyProfile: 'employer_benefit_v1' },
    { sharesDigest: '0'.repeat(64) },
    { disclosureGroupRef: 'colleagues-v1' },
  ]) {
    assert.throws(() => sign(over), /does not match/, JSON.stringify(over));
    assert.equal(w.trace.events.filter((e) => e.event === 'approval_rejected').at(-1)?.detail?.reason, 'terms_mismatch', JSON.stringify(over));
  }
  assert.equal(p.authorizations.length, 0);
  assert.equal(p.state, 'awaiting_approvals');
  // The exact displayed terms still approve.
  approveAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'ready');
});

test('retained approval validity checks every original proposal binding', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  const terms = payerView(w, p).approval;
  const approval = (over: object) => signPayload({ ...terms, approvalRef: 'retained-consent', basis: 'device', ...over } as PayerApproval, w.signers.get(RESIDENT_1)!);
  assert.equal(w.coordinator.authorizationCurrentlyValid(p.purchaseId, { basis: 'device', approval: approval({}) }), true);
  for (const over of [
    { purchaseId: 'other-purchase' },
    { merchantId: 'other-merchant' },
    { totalCents: 999 },
    { amountCents: 0 },
    { feeCents: 1 },
    { expiresAt: 101 },
    { basis: 'exception', exception: true },
  ]) {
    assert.equal(w.coordinator.authorizationCurrentlyValid(p.purchaseId, { basis: 'device', approval: approval(over) }), false, JSON.stringify(over));
  }
});

test('a charity offer change is refused — a changed arrangement needs a fresh purchase and approval', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  assert.throws(() => changeOfferAs(w, p, { merchantId: CHARITY_1, totalCents: 900, expiresAt: 100 }, RESIDENT_1), /charity_terms_immutable/);
  assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'charity_terms_immutable');
  assert.equal(p.proposal.version, 1, 'the refusal never bumped the version');
  assert.equal(p.state, 'ready');
});

// --- Buyer projection and detached approval ---------------------------------

test('the buyer projection shows the donor contribution as role and magnitude — never identity or reference', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  const v = payerView(w, p);
  assert.equal(v.privacyProfile, 'anonymous_donation_v1');
  assert.equal(v.ownCents, 500);
  assert.equal(v.othersCents, 500, 'the donor magnitude is visible');
  assert.deepEqual(v.donorContribution, { role: 'donor', amountCents: 500 });
  // The approval projection carries the opaque commitment, never raw shares.
  assert.equal(v.approval.payerId, RESIDENT_1);
  assert.equal(v.approval.amountCents, 500);
  assert.equal(v.approval.privacyProfile, 'anonymous_donation_v1');
  assert.match(v.approval.sharesDigest, /^[0-9a-f]{64}$/);
  const json = JSON.stringify(v);
  for (const leak of [DONOR_1, 'allowance-1', 'sponsor_mandate', 'attestation']) {
    assert.equal(json.includes(leak), false, leak);
  }
  // The donor gets no per-purchase view at all — no sponsor facet either.
  assert.throws(() => viewFor(p, { partyId: DONOR_1, facet: 'payer' }), /recipient_not_entitled/);
  assert.throws(() => viewFor(p, { partyId: DONOR_1, facet: 'sponsor' }), /recipient_not_entitled/);
  // An outsider buyer-side reads nothing.
  assert.throws(() => viewFor(p, { partyId: RESIDENT_2, facet: 'payer' }), /recipient_not_entitled/);
});

test('approveAs signs the detached projection alone — the helper never receives hidden donor data', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  // The display the device actually saw: role+magnitude and the opaque
  // commitment — no donor identity anywhere in what approveAs consumes.
  const shown = payerView(w, p);
  assert.equal(JSON.stringify(shown).includes(DONOR_1), false);
  const signed = approveAs(w, shown, RESIDENT_1);
  assert.equal(p.state, 'ready');
  assert.equal(signed.payload.payerId, RESIDENT_1);
  // The buyer's approval binds the complete hidden allocation — the digest
  // the projection showed equals the digest over the retained shares.
  assert.equal(signed.payload.sharesDigest, shown.approval.sharesDigest);
  assert.equal(signed.payload.sharesDigest, sharesDigestOf(p.proposal.shares));
});

test('a buyer-only fallback view carries no donor contribution but still carries the approval commitment', () => {
  const w = world();
  // No attestation at all: request_only anonymous terms.
  const p = propose(w);
  const v = payerView(w, p);
  assert.equal(v.donorContribution, undefined);
  assert.equal(v.ownCents, 1_000);
  assert.equal(v.othersCents, 0);
  assert.match(v.approval.sharesDigest, /^[0-9a-f]{64}$/);
});

test('corrupted retained charity evidence refuses every facet', () => {
  const facets = [
    { partyId: RESIDENT_1, facet: 'payer' },
    { partyId: CHARITY_1, facet: 'payee' },
    { partyId: DONOR_1, facet: 'sponsor' },
  ] as const;
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  const record = unwrapView(p) as { charity?: { donorId?: string } };
  record.charity!.donorId = 'donor-swapped';
  for (const r of facets) {
    assert.throws(() => viewFor(p, r), { message: 'privacy_profile_invalid' }, r.facet);
  }
  // The allowance source records a match: deleting the donor share after
  // the fact leaves a proposal claiming sponsorship it no longer carries —
  // corrupted evidence, refused for every facet like any other
  // disagreement between the record and its frozen source.
  const w2 = world();
  publishAttestationAs(w2, attestation());
  publishAllowanceAs(w2, allowance());
  const p2 = propose(w2);
  const rec2 = unwrapView(p2) as { proposal: { shares: { authority?: string }[] } };
  rec2.proposal.shares = rec2.proposal.shares.filter((s) => s.authority !== 'sponsor_mandate');
  for (const r of facets) {
    assert.throws(() => viewFor(p2, r), { message: 'privacy_profile_invalid' }, `donor share dropped: ${r.facet}`);
  }
});

// --- Sponsor admission and budget booking ------------------------------------

test('an approved matched purchase admits, books and settles the donor share', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  const signedAllowance = publishAllowanceAs(w, allowance());
  const p = propose(w);
  const approval = approveAs(w, p, RESIDENT_1);
  await submitAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'completed');
  // The buyer's digital-euro leg and the donor's bank leg both carried the
  // authority that funds them; the donor leg names the selected reference.
  assert.deepEqual(
    p.legs.map((l) => [l.leg, l.payerId, l.amountCents, l.rail, l.authorityRef, l.status]),
    [
      ['buyer', RESIDENT_1, 500, 'digital_euro', approval.payload.approvalRef, 'settled'],
      ['donor', DONOR_1, 500, 'bank', 'allowance-1', 'settled'],
    ],
  );
  // The frozen submission retains the detached admission evidence: the
  // selected reference and donor, the booking day and the signed records.
  const admitted = p.submission!.charity!;
  assert.equal(admitted.allowanceRef, 'allowance-1');
  assert.equal(admitted.donorId, DONOR_1);
  assert.equal(admitted.bookingDay, 0);
  assert.equal(admitted.allowance.signature, signedAllowance.signature);
  assert.equal(admitted.buyerApproval.signature, approval.signature);
  assert.equal(p.submission!.legs.length, 2);
  const donorLeg = p.submission!.legs.find((l) => l.authority === 'sponsor_mandate')!;
  assert.equal(donorLeg.payerId, DONOR_1);
  // The booking was reserved at admission and consumed on completion —
  // against the daily and the lifetime budget alike.
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
  assert.deepEqual(w.coordinator.ledger.allowanceUsage('allowance-1', 0), {
    daily: { cents: 500, purchases: 1 },
    lifetime: { cents: 500, purchases: 1 },
  });
  assert.equal(w.trace.events.filter((e) => e.event === 'allowance_reserved').length, 1);
  assert.equal(payerBankCents(w, DONOR_1), 99_500);
  assert.equal(payerDeCents(w, RESIDENT_1), 1_500);
  assert.equal(payeeBankCents(w, CHARITY_1), 1_000);
});

test('a fully sponsored purchase emits only the donor leg and keeps the zero-debit consent', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance({ maxPerPurchaseCents: 1_000 }));
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  await submitAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'completed');
  // Zero principal and zero fee: the buyer consented but pays no leg — the
  // donor share is the only leg the frozen submission carries.
  assert.deepEqual(p.legs.map((l) => l.leg), ['donor']);
  assert.equal(p.legs[0].authorityRef, 'allowance-1');
  assert.equal(p.submission!.legs.length, 1);
  assert.equal(p.submission!.legs[0].authority, 'sponsor_mandate');
  assert.equal(p.submission!.charity!.buyerApproval.payload.amountCents, 0, 'the zero-debit consent is the retained evidence');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
  assert.equal(payerDeCents(w, RESIDENT_1), 2_000, 'the buyer was never debited');
  assert.equal(payerBankCents(w, DONOR_1), 99_000);
  assert.equal(payeeBankCents(w, CHARITY_1), 1_000);
});

test('a buyer-only fallback submits without sponsor authority or a booking', async () => {
  const w = world();
  // No attestation: the purchase committed as request_only buyer funding.
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  await submitAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'completed');
  assert.deepEqual(p.legs.map((l) => l.leg), ['buyer']);
  assert.equal(p.submission!.charity, undefined, 'no sponsor evidence exists for a fallback');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined, 'no allowance budget was booked');
  assert.equal(w.trace.events.filter((e) => e.event === 'allowance_reserved').length, 0);
  assert.equal(payeeBankCents(w, CHARITY_1), 1_000);
});

test('a revoked or shrunken allowance fails admission — never a replacement or a grown buyer debit', async () => {
  for (const [revision, reason] of [
    [{ version: 2, revoked: true }, 'donor_authority_invalid:allowance_revoked'],
    [{ version: 2, maxPerPurchaseCents: 200 }, 'donor_authority_invalid:cap_exceeded'],
  ] as const) {
    const w = world();
    publishAttestationAs(w, attestation());
    publishAllowanceAs(w, allowance());
    const p = propose(w);
    approveAs(w, p, RESIDENT_1);
    // The donor revises its allowance before the purchase is submitted: the
    // recheck only ever considers the SAME selected reference.
    publishAllowanceAs(w, allowance(revision));
    // A second eligible allowance appears that could fund the purchase —
    // admission never re-selects.
    publishAllowanceAs(w, allowance({ allowanceRef: 'allowance-2', donorId: DONOR_2, version: 1 }));
    await submitAs(w, p, RESIDENT_1);
    assert.equal(p.state, 'failed', JSON.stringify(revision));
    assert.equal(p.reason, reason);
    // Nothing moved, nothing booked, and the buyer's share never grew.
    assert.equal(p.legs.length, 0);
    assert.equal(p.submission, undefined);
    assert.equal(p.proposal.shares.find((s) => s.role === 'buyer')!.amountCents, 500);
    assert.equal(p.charity?.allowanceRef, 'allowance-1', 'the selected reference is never replaced');
    assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
    assert.equal(payerBankCents(w, DONOR_1), 100_000);
    assert.equal(payerBankCents(w, DONOR_2), 100_000);
    assert.equal(payeeBankCents(w, CHARITY_1), 0);
  }
});

test('a revoked attestation fails sponsor admission', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  publishAttestationAs(w, attestation({ version: 2, revoked: true }));
  await submitAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'failed');
  assert.equal(p.reason, 'donor_authority_invalid:attestation_revoked');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.equal(payeeBankCents(w, CHARITY_1), 0);
});

test('a conclusive pre-dispatch refusal releases only the booking this attempt acquired', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  const real = w.settlement.submit.bind(w.settlement);
  w.settlement.submit = async () => {
    throw new Error('unknown payee charity-1');
  };
  await assert.rejects(() => submitAs(w, p, RESIDENT_1), /unknown payee/);
  // The admission rolled back: the booking this attempt acquired is
  // released, the frozen intent cleared and the purchase left repairable.
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.deepEqual(w.coordinator.ledger.allowanceUsage('allowance-1', 0).lifetime, { cents: 0, purchases: 0 });
  assert.equal(p.state, 'ready');
  assert.equal(p.submission, undefined);
  w.settlement.submit = real;
  await submitAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'completed');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
});

test('a no-exposure failure releases the allowance booking exactly once', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  // The buyer's digital-euro hold is conclusively refused: the atomic
  // intent unwinds with nothing committed — the donor's accepted hold is
  // released and the confirmed failure hands the booking back once.
  w.digitalEuro.setFault(legChildKey('charity-1', 1, 'buyer', 'hold', w.pseudonyms.get(CHARITY_1)!), 'hold', 'reject_before_effect');
  await submitAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'failed');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.deepEqual(w.coordinator.ledger.allowanceUsage('allowance-1', 0).lifetime, { cents: 0, purchases: 0 });
  assert.equal(payerBankCents(w, DONOR_1), 100_000);
  assert.equal(payerDeCents(w, RESIDENT_1), 2_000);
  assert.equal(payeeBankCents(w, CHARITY_1), 0);
});

test('a confirmed full return restores the allowance budget once', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  await submitAs(w, p, RESIDENT_1);
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
  await refundAs(w, p, CHARITY_1);
  assert.equal(p.returnStatus, 'completed');
  // The shared snapshot-derived full-return path released the booking:
  // the donor's daily and lifetime usage are restored, and a repeat
  // reconcile cannot release again.
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.deepEqual(w.coordinator.ledger.allowanceUsage('allowance-1', 0), {
    daily: { cents: 0, purchases: 0 },
    lifetime: { cents: 0, purchases: 0 },
  });
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.equal(payerBankCents(w, DONOR_1), 100_000);
  assert.equal(payeeBankCents(w, CHARITY_1), 0);
});

// --- Delayed donor first handoff ---------------------------------------------

test('a deferred donor handoff refreshes evidence to the exact revisions used — then keeps it frozen', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  // The donor's provider cannot be reached at submission: the reserve is
  // conclusively unstarted, so its retry runs the whole first-handoff
  // recheck — not a replay.
  w.providers.get(DONOR_1)!.available = false;
  await submitAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'pending');
  assert.equal(p.submission!.charity!.allowance.payload.version, 1);
  // A revision published while the leg waits still covers the same frozen
  // arrangement — same donor, same class, enough capacity — so the
  // recheck authorizes under it and the retained evidence refreshes to
  // exactly that revision.
  publishAllowanceAs(w, allowance({ version: 2, maxPerDayCents: 900 }));
  w.providers.get(DONOR_1)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(p.submission!.charity!.allowance.payload.version, 2);
  assert.equal(p.submission!.charity!.attestation.payload.version, 1);
  assert.equal(p.submission!.charity!.bookingDay, 0, 'the booking day stays as admitted');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
  // Once forwarded, later revisions never rewrite the retained record:
  // the replay presents the evidence the handoff used, not current terms.
  publishAllowanceAs(w, allowance({ version: 3, maxPerDayCents: 5 }));
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(p.submission!.charity!.allowance.payload.version, 2);
  assert.equal(payerBankCents(w, DONOR_1), 99_500, 'the replay never charges twice');
});

test("a fully sponsored purchase still needs live buyer consent at the donor leg's deferred first handoff", async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance({ maxPerPurchaseCents: 1_000 }));
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  w.providers.get(DONOR_1)!.available = false;
  await submitAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'pending');
  // The zero-debit buyer has no leg of its own: its consent is proven only
  // through the donor leg's first-handoff recheck. Dropping the retained
  // authorization removes it.
  (unwrapView(p) as { authorizations: unknown[] }).authorizations = [];
  w.providers.get(DONOR_1)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[0].status, 'rejected');
  assert.equal(p.legs[0].rejectReason, 'donor_authority_invalid:buyer_consent_missing');
  assert.equal(p.state, 'failed');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.equal(payerBankCents(w, DONOR_1), 100_000);
  assert.equal(payerDeCents(w, RESIDENT_1), 2_000);
  assert.equal(payeeBankCents(w, CHARITY_1), 0);
});

test('mutating the caller approval cannot renew expired consent during a deferred donor handoff', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance({ maxPerPurchaseCents: 1_000 }));
  const p = propose(w);
  const terms = payerView(w, p).approval;
  const signed = signPayload({ ...terms, approvalRef: 'original-consent', basis: 'device', expiresAt: 11 } as PayerApproval, w.signers.get(RESIDENT_1)!);
  w.coordinator.approve(p.purchaseId, signed);
  w.providers.get(DONOR_1)!.available = false;
  await submitAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'pending');
  advance(w, 12);
  Object.assign(signed, signPayload({ ...terms, purchaseId: 'other-purchase', approvalRef: 'replacement', basis: 'device', expiresAt: 100 } as PayerApproval, w.signers.get(RESIDENT_1)!));
  w.providers.get(DONOR_1)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'failed');
  assert.equal(p.legs[0].rejectReason, `donor_authority_invalid:approval_expired:${RESIDENT_1}`);
  assert.equal(p.submission!.charity!.buyerApproval.payload.expiresAt, 11);
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.equal(payerBankCents(w, DONOR_1), 100_000);
  assert.equal(payerDeCents(w, RESIDENT_1), 2_000);
  assert.equal(payeeBankCents(w, CHARITY_1), 0);
});

test('corrupted retained booking evidence refuses the deferred donor handoff', async () => {
  const corruptions: [string, (p: Purchase, w: World) => void][] = [
    // The retained day disagrees with the ledger's own entry: the recheck
    // would count the wrong day's usage, so the handoff fails closed.
    ['a moved booking day', (p) => { p.submission!.charity!.bookingDay = 7; }],
    // The frozen submission leg must agree with the intent leg it names.
    ['a changed frozen payee', (p) => { p.submission!.legs[1].payeeId = 'merchant-a'; }],
    ['a changed frozen amount', (p) => { p.submission!.legs[1].amountCents = 499; }],
    ['a substituted frozen consent', (p, w) => {
      const frozen = p.submission!.charity!.buyerApproval;
      p.submission!.charity!.buyerApproval = signPayload({ ...frozen.payload, approvalRef: 'substituted-consent' }, w.signers.get(RESIDENT_1)!);
    }],
    // The ownership flag is what lets this purchase release its booking —
    // without it the ledger entry may belong to a reusing purchaseId.
    ['a dropped ownership flag', (p) => { p.charityHeld = false; }],
  ];
  for (const [name, corrupt] of corruptions) {
    const w = world();
    publishAttestationAs(w, attestation());
    publishAllowanceAs(w, allowance());
    const p = propose(w);
    approveAs(w, p, RESIDENT_1);
    w.providers.get(DONOR_1)!.available = false;
    await submitAs(w, p, RESIDENT_1);
    assert.equal(p.state, 'pending', name);
    corrupt(unwrapView(p) as unknown as Purchase, w);
    w.providers.get(DONOR_1)!.available = true;
    await w.coordinator.resubmit(p.purchaseId);
    assert.equal(p.legs[1].status, 'rejected', name);
    assert.equal(p.legs[1].rejectReason, 'donor_authority_invalid:terms_mismatch', name);
    assert.equal(p.state, 'failed', name);
    assert.equal(payerBankCents(w, DONOR_1), 100_000, name);
    assert.equal(payeeBankCents(w, CHARITY_1), 0, name);
    // Except for the dropped-flag case — where the purchase can no longer
    // prove it owns the entry — the failed unwind releases this
    // purchase's booking, and only this purchase's.
    if (name !== 'a dropped ownership flag') {
      assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined, name);
    } else {
      assert.equal(w.coordinator.ledger.state(p.purchaseId), 'reserved', name + ': a booking nobody owns is never released by a naked id');
    }
  }
});

test('pending and partial returns keep the booking; confirmed full return restores it exactly once', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  await submitAs(w, p, RESIDENT_1);
  assert.equal(p.state, 'completed');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
  // The donor leg's return parks mid-effect: the refund observes the
  // buyer's confirmed return while the donor's stays unresolved — a
  // partial return keeps every cent of usage committed.
  const returnKey = legChildKey('charity-1', 1, 'donor', 'return', 'bank');
  w.providers.get(DONOR_1)!.setFault(returnKey, 'debit', 'defer');
  await refundAs(w, p, CHARITY_1);
  assert.equal(p.returnStatus, 'partial');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed', 'a partial return restores nothing');
  assert.deepEqual(w.coordinator.ledger.allowanceUsage('allowance-1', 0).lifetime, { cents: 500, purchases: 1 });
  // Resolving the deferred debit confirms the last return under its
  // original key: cleanup is proven, so the booking releases — once.
  w.providers.get(DONOR_1)!.resolveDeferred(returnKey, 'succeed');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.returnStatus, 'completed');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.deepEqual(w.coordinator.ledger.allowanceUsage('allowance-1', 0).lifetime, { cents: 0, purchases: 0 });
  // Repeat reconciliation and refund replay under the same return keys:
  // restored capacity is never released twice.
  await w.coordinator.reconcile(p.purchaseId);
  await refundAs(w, p, CHARITY_1);
  assert.equal(p.returnStatus, 'completed');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), undefined);
  assert.equal(payerDeCents(w, RESIDENT_1), 2_000);
  assert.equal(payerBankCents(w, DONOR_1), 100_000);
  assert.equal(payeeBankCents(w, CHARITY_1), 0);
});

// --- Aggregate donor reports (spec §4) -----------------------------------------
// The ownership-checked cross-purchase read: Coordinator.allowanceReport
// composes a verified allowance read, the ledger's detached all-days
// summary and the privacy projection. Only the owning donor's sponsor
// facet receives it — every other read is one generic refusal with no
// balance, no ownership detail and no trace event.

test('the owning donor reads aggregates across consumed, reserved, partial and returned bookings', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const report = () => w.coordinator.allowanceReport('allowance-1', { partyId: DONOR_1, facet: 'sponsor' });
  assert.deepEqual(report(), {
    allowanceRef: 'allowance-1',
    reservedCents: 0,
    reservedPurchases: 0,
    consumedCents: 0,
    consumedPurchases: 0,
    remainingLifetimeCents: 10_000,
  });
  // A completed purchase consumes its booking.
  const done = proposeCharityAs(w, { purchaseId: 'charity-done', employeeId: RESIDENT_1, merchantId: CHARITY_1, totalCents: 1_000, expiresAt: 200 });
  approveAs(w, done, RESIDENT_1);
  await submitAs(w, done, RESIDENT_1);
  assert.equal(done.state, 'completed');
  assert.deepEqual(report(), {
    allowanceRef: 'allowance-1', reservedCents: 0, reservedPurchases: 0, consumedCents: 500, consumedPurchases: 1, remainingLifetimeCents: 9_500,
  });
  // A pending purchase keeps its reservation: uncertain work is counted
  // apart from completed consumption.
  const held = proposeCharityAs(w, { purchaseId: 'charity-held', employeeId: RESIDENT_1, merchantId: CHARITY_1, totalCents: 1_000, expiresAt: 200 });
  approveAs(w, held, RESIDENT_1);
  w.providers.get(DONOR_1)!.available = false;
  await submitAs(w, held, RESIDENT_1);
  assert.equal(held.state, 'pending');
  w.providers.get(DONOR_1)!.available = true;
  assert.deepEqual(report(), {
    allowanceRef: 'allowance-1', reservedCents: 500, reservedPurchases: 1, consumedCents: 500, consumedPurchases: 1, remainingLifetimeCents: 9_000,
  });
  // A partial return restores nothing: the consumed booking stays.
  const returnKey = legChildKey('charity-done', 1, 'donor', 'return', 'bank');
  w.providers.get(DONOR_1)!.setFault(returnKey, 'debit', 'defer');
  await refundAs(w, done, CHARITY_1);
  assert.equal(done.returnStatus, 'partial');
  assert.deepEqual(report(), {
    allowanceRef: 'allowance-1', reservedCents: 500, reservedPurchases: 1, consumedCents: 500, consumedPurchases: 1, remainingLifetimeCents: 9_000,
  });
  // The confirmed full return releases the booking — exactly once.
  w.providers.get(DONOR_1)!.resolveDeferred(returnKey, 'succeed');
  await w.coordinator.reconcile(done.purchaseId);
  assert.equal(done.returnStatus, 'completed');
  assert.deepEqual(report(), {
    allowanceRef: 'allowance-1', reservedCents: 500, reservedPurchases: 1, consumedCents: 0, consumedPurchases: 0, remainingLifetimeCents: 9_500,
  });
});

test('revocation and expiry remove no owner history; an uncapped record reports a null remainder', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = proposeCharityAs(w, { purchaseId: 'charity-1', employeeId: RESIDENT_1, merchantId: CHARITY_1, totalCents: 1_000, expiresAt: 200 });
  approveAs(w, p, RESIDENT_1);
  await submitAs(w, p, RESIDENT_1);
  // The donor revokes its allowance, then time passes its validity window:
  // temporal terms never gate the owner's access to its own history.
  publishAllowanceAs(w, allowance({ version: 2, revoked: true }));
  advance(w, 1_500);
  assert.deepEqual(w.coordinator.allowanceReport('allowance-1', { partyId: DONOR_1, facet: 'sponsor' }), {
    allowanceRef: 'allowance-1', reservedCents: 0, reservedPurchases: 0, consumedCents: 500, consumedPurchases: 1, remainingLifetimeCents: 9_500,
  });
  // A record carrying no lifetime cap reports null, not a fabricated ceiling.
  const { totalEndowmentCents: _cap, ...uncapped } = allowance({ allowanceRef: 'allowance-2', donorId: DONOR_2 });
  publishAllowanceAs(w, uncapped);
  assert.deepEqual(w.coordinator.allowanceReport('allowance-2', { partyId: DONOR_2, facet: 'sponsor' }), {
    allowanceRef: 'allowance-2', reservedCents: 0, reservedPurchases: 0, consumedCents: 0, consumedPurchases: 0, remainingLifetimeCents: null,
  });
});

test('every non-owner, wrong-facet, unknown or corrupt report read is the same generic refusal — and silent', () => {
  const w = world();
  publishAllowanceAs(w, allowance());
  publishAllowanceAs(w, allowance({ allowanceRef: 'allowance-2', donorId: DONOR_2 }));
  const events = w.trace.events.length;
  const refused = { refused: 'allowance_report_refused' };
  for (const r of [
    // Nonowners — including a real donor whose reference this is not, and
    // the buyer and payee the purchase actually involved.
    { partyId: DONOR_2, facet: 'sponsor' },
    { partyId: RESIDENT_1, facet: 'sponsor' },
    { partyId: CHARITY_1, facet: 'sponsor' },
    // The owner through the wrong facet, plus the buyer and payee facets.
    { partyId: DONOR_1, facet: 'payer' },
    { partyId: DONOR_1, facet: 'payee' },
    { partyId: RESIDENT_1, facet: 'payer' },
    { partyId: CHARITY_1, facet: 'payee' },
  ] as const) {
    assert.deepEqual(w.coordinator.allowanceReport('allowance-1', r), refused, `${r.facet} ${r.partyId}`);
  }
  // An unknown reference and a malformed one.
  assert.deepEqual(w.coordinator.allowanceReport('allowance-missing', { partyId: DONOR_1, facet: 'sponsor' }), refused);
  // A retained record that no longer verifies is refused, not treated as
  // absent — and still indistinguishable from every other refusal.
  w.authority.allowanceMandate('allowance-1')!.signed.payload.maxPerPurchaseCents = 9_999;
  assert.deepEqual(w.coordinator.allowanceReport('allowance-1', { partyId: DONOR_1, facet: 'sponsor' }), refused);
  // Nothing was logged: a report read never writes an event, and the
  // privileged trace is not a reporting path.
  assert.equal(w.trace.events.length, events);
});

test('a report read is repeatable and detached — no events, no settlement call, no retained mutation', async () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const p = propose(w);
  approveAs(w, p, RESIDENT_1);
  await submitAs(w, p, RESIDENT_1);
  const events = w.trace.events.length;
  const first = w.coordinator.allowanceReport('allowance-1', { partyId: DONOR_1, facet: 'sponsor' });
  if ('refused' in first) throw new Error('expected a report for the owner');
  // Mutating the returned report reaches nothing retained.
  first.reservedCents = 9_999;
  first.allowanceRef = 'tampered';
  const again = w.coordinator.allowanceReport('allowance-1', { partyId: DONOR_1, facet: 'sponsor' });
  assert.deepEqual(again, {
    allowanceRef: 'allowance-1', reservedCents: 0, reservedPurchases: 0, consumedCents: 500, consumedPurchases: 1, remainingLifetimeCents: 9_500,
  });
  assert.equal(w.trace.events.length, events, 'reads emit nothing — no settlement call is observable either');
  assert.equal(w.coordinator.ledger.state(p.purchaseId), 'consumed');
  assert.deepEqual(w.coordinator.ledger.allowanceUsage('allowance-1', 0), {
    daily: { cents: 500, purchases: 1 },
    lifetime: { cents: 500, purchases: 1 },
  });
});

test('the per-purchase sponsor facet refuses every anonymous-profile purchase — even the selected donor', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  const matched = propose(w);
  // A buyer-only fallback under anonymous request_only terms refuses just
  // the same: this profile has no per-purchase sponsor projection at all.
  const w2 = world();
  const fallback = propose(w2);
  for (const p of [matched, fallback]) {
    for (const partyId of [DONOR_1, DONOR_2, RESIDENT_1, CHARITY_1]) {
      assert.throws(() => viewFor(p, { partyId, facet: 'sponsor' }), /recipient_not_entitled/, `${p.purchaseId}: ${partyId}`);
    }
  }
});
