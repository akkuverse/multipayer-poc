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
import { viewFor } from '../src/core/privacy.ts';
import type { PayerView } from '../src/core/privacy.ts';
import { unwrapView } from '../src/core/live-view.ts';
import type { AllowanceMandate, CharityProposeRequest, EligibilityAttestation, PayerApproval } from '../src/core/types.ts';

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

test('an enumerated allowance whose retained record was deleted refuses — never a silent skip', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  publishAllowanceAs(w, allowance());
  // The acceptance metadata survives while the retained record is gone:
  // the reference still enumerates but resolves to 'allowance_unknown'.
  // On an enumerated reference that is corrupt retained authority, not
  // absence — the match fails closed rather than dropping the candidate
  // and quietly falling back to buyer-only terms.
  (w.authority as unknown as { allowances: Map<string, unknown> }).allowances.delete('allowance-1');
  assert.equal(w.authority.allowanceRefs().includes('allowance-1'), true, 'the reference still enumerates');
  assert.throws(() => propose(w), /allowance_unknown/);
  assert.equal(requestRefusals(w).at(-1)?.detail?.reason, 'allowance_unknown');
  assert.throws(() => w.coordinator.view('charity-1'), /unknown_purchase/);
});

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
