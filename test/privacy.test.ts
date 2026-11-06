// Disclosure contracts (src/core/privacy.ts): the closed profile catalog
// resolves verified signed sources into frozen proposal terms, and viewFor
// is the only recipient projection — entitlement checked before a detached
// view is emitted, never a permissive default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, world, lunch, proposeAs, proposeSplitAs, approveAs, changeOfferAs, submitAs, openFundAs, pledgeAs, advance, COLLEAGUES_V1_GROUP, EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, MERCHANT_B, PROJECT_1, RESIDENT_1, RESIDENT_2, RESIDENT_3 } from '../src/scenarios.ts';
import { resolveProfile, viewFor } from '../src/core/privacy.ts';
import type { FundPayerView, KnownSplitGroup } from '../src/core/privacy.ts';
import type { CampaignTerms, Purchase } from '../src/core/types.ts';
import { unwrapView } from '../src/core/live-view.ts';
import { campaignDigestOf, signPayload, verifyPayload } from '../src/core/signing.ts';

const GROUP: KnownSplitGroup = COLLEAGUES_V1_GROUP;
const MANDATE = {
  mandateRef: 'mandate-1',
  employerId: EMPLOYER,
  version: 1,
  beneficiaryRef: EMPLOYEE,
  maxPerPurchaseCents: 500,
  maxPerDayCents: 767,
  maxPurchasesPerDay: 1,
  eligibleMerchants: [MERCHANT_A],
  validFrom: 0,
  validUntil: 1_000,
  revoked: false,
  privacyProfile: 'employer_benefit_v1',
} as const;

const run = (id: string) => scenarios.find((s) => s.id.startsWith(id))!.run();

// --- Source resolution -------------------------------------------------------

test('a verified employer mandate resolves to mandate-backed benefit terms', () => {
  const t = resolveProfile({ kind: 'employer_mandate', requested: 'employer_benefit_v1', mandate: MANDATE });
  assert.deepEqual(t, {
    profile: 'employer_benefit_v1',
    source: { kind: 'employer_mandate', mandateRef: 'mandate-1', mandateVersion: 1, employerId: EMPLOYER },
  });
});

test('an absent mandate resolves the signed restrictive request to request_only', () => {
  assert.deepEqual(resolveProfile({ kind: 'employer_mandate', requested: 'employer_benefit_v1', mandate: undefined }), {
    profile: 'employer_benefit_v1',
    source: { kind: 'request_only' },
  });
});

test('unsupported, mismatched and cross-arrangement profiles are refused', () => {
  // A benefit request can never select split disclosure, and vice versa.
  assert.throws(() => resolveProfile({ kind: 'employer_mandate', requested: 'split_bill_v1', mandate: MANDATE }), /privacy_profile_unsupported/);
  assert.throws(() => resolveProfile({ kind: 'employer_mandate', requested: undefined, mandate: MANDATE }), /privacy_profile_unsupported/);
  assert.throws(() => resolveProfile({ kind: 'split_request', requested: 'employer_benefit_v1', groupRef: 'colleagues-v1', payerIds: [EMPLOYEE], group: GROUP }), /privacy_profile_unsupported/);
  // A verified mandate disagreeing with the requested profile.
  assert.throws(
    () => resolveProfile({ kind: 'employer_mandate', requested: 'employer_benefit_v1', mandate: { ...MANDATE, privacyProfile: 'split_bill_v1' as never } }),
    /privacy_profile_mismatch/,
  );
});

test('a missing, wrong or non-covering group is refused', () => {
  const src = (over: object) => resolveProfile({ kind: 'split_request', requested: 'split_bill_v1', groupRef: 'colleagues-v1', payerIds: [EMPLOYEE, COLLEAGUE_1], group: GROUP, ...over });
  assert.throws(() => src({ group: undefined }), /split_group_unknown/);
  assert.throws(() => src({ groupRef: 'unknown-group' }), /split_group_unknown/);
  // A registered identity outside the agreement's members is an outsider.
  assert.throws(() => src({ payerIds: [EMPLOYEE, EMPLOYER] }), /split_group_mismatch/);
  assert.throws(() => src({ payerIds: [] }), /split_group_mismatch/);
});

test('resolution clones the audience and returns frozen terms', () => {
  const payerIds = [EMPLOYEE, COLLEAGUE_1];
  const t = resolveProfile({ kind: 'split_request', requested: 'split_bill_v1', groupRef: 'colleagues-v1', payerIds, group: GROUP });
  assert.ok(t.source.kind === 'known_group');
  payerIds.push(COLLEAGUE_2);
  assert.deepEqual(t.source.participantIds, [EMPLOYEE, COLLEAGUE_1]);
  assert.throws(() => {
    (t.source as { participantIds: string[] }).participantIds.push('mallory');
  }, TypeError);
});

// --- Recipient disclosure on admitted purchases ------------------------------

test('a known-group split discloses each principal share in order only to actual payers', () => {
  const w = world();
  const p = proposeSplitAs(w, {
    purchaseId: 'purchase-1',
    merchantId: MERCHANT_B,
    amountsFrom: 'proposer',
    shares: [
      { role: 'private-role-a', payerId: EMPLOYEE, amountCents: 300, feeCents: 10 },
      { role: 'private-role-b', payerId: COLLEAGUE_1, amountCents: 200, rail: 'bank' },
      { role: 'private-role-c', payerId: EMPLOYEE, amountCents: 100 },
    ],
    expiresAt: 100,
  }, EMPLOYEE);
  const peerView = viewFor(p, { partyId: COLLEAGUE_1, facet: 'payer' });
  assert.deepEqual(peerView.sharedContributions, [
    { payerId: EMPLOYEE, amountCents: 300 },
    { payerId: COLLEAGUE_1, amountCents: 200 },
    { payerId: EMPLOYEE, amountCents: 100 },
  ]);
  assert.equal(JSON.stringify(peerView).includes(COLLEAGUE_2), false, 'the wider group membership stays private');
  assert.throws(() => viewFor(p, { partyId: COLLEAGUE_2, facet: 'payer' }), /recipient_not_entitled/);
  assert.throws(() => viewFor(p, { partyId: EMPLOYER, facet: 'payer' }), /recipient_not_entitled/);
});

test('a benefit purchase keeps the payer projection restricted — no employer identity or funding detail', async () => {
  const { p } = await run('S01');
  const v = viewFor(p, { partyId: EMPLOYEE, facet: 'payer' });
  assert.equal(v.privacyProfile, 'employer_benefit_v1');
  assert.equal(v.sharedContributions, undefined);
  const json = JSON.stringify(v);
  assert.equal(json.includes(EMPLOYER), false);
  assert.equal(json.includes('mandate-1'), false);
});

test('sponsor entitlement follows the frozen employer source, never a later mandate', async () => {
  const { w, p } = await run('S01');
  const v = viewFor(p, { partyId: EMPLOYER, facet: 'sponsor' });
  assert.equal(v.contributionCents, 500);
  assert.equal(v.mandateRef, 'mandate-1');
  // A later mandate revision cannot rewrite what this purchase froze.
  const { updateMandate } = await import('../src/scenarios.ts');
  updateMandate(w, { maxPerPurchaseCents: 999 });
  assert.equal(viewFor(p, { partyId: EMPLOYER, facet: 'sponsor' }).mandateRef, 'mandate-1');
  assert.equal(p.proposal.privacy.profile, 'employer_benefit_v1');
  // The employee is not a sponsor; an outsider is nobody.
  assert.throws(() => viewFor(p, { partyId: EMPLOYEE, facet: 'sponsor' }), /recipient_not_entitled/);
  assert.throws(() => viewFor(p, { partyId: 'mallory-1', facet: 'sponsor' }), /recipient_not_entitled/);
});

test('request_only terms grant no sponsor projection', () => {
  // A mandate the registry never heard of: zero employer contribution and
  // no sponsor facet — yet the purchase is still admissible.
  const w = world();
  const p = proposeAs(w, { purchaseId: 'purchase-1', employeeId: EMPLOYEE, merchantId: MERCHANT_A, totalCents: 500, mandateRef: 'mandate-missing', expiresAt: 100 });
  assert.deepEqual(p.proposal.privacy, { profile: 'employer_benefit_v1', source: { kind: 'request_only' } });
  assert.throws(() => viewFor(p, { partyId: EMPLOYER, facet: 'sponsor' }), /recipient_not_entitled/);
  assert.equal(viewFor(p, { partyId: EMPLOYEE, facet: 'payer' }).ownCents, 500);
});

test('request_only offer changes refuse newly available employer funding before mutating approved terms', async () => {
  const w = world();
  const input = { purchaseId: 'purchase-1', employeeId: EMPLOYEE, merchantId: MERCHANT_A, totalCents: 700, mandateRef: 'mandate-missing', expiresAt: 100 };
  const p = proposeAs(w, input);
  approveAs(w, p);
  const before = structuredClone(unwrapView(p));
  w.authority.publishEmployerMandate(signPayload({ ...w.mandate, mandateRef: input.mandateRef }, w.signers.get(EMPLOYER)!));

  assert.throws(
    () => changeOfferAs(w, p, { merchantId: MERCHANT_A, totalCents: 600, expiresAt: 100 }, EMPLOYEE),
    /employer funding requires a new purchase/,
  );
  assert.deepEqual(unwrapView(p), before, 'the prior proposal, authorizations and state survive the refusal');
  const refusal = w.trace.events.at(-1)!;
  assert.equal(refusal.event, 'proposal_rejected');
  assert.equal(refusal.origin, 'LOCAL');
  assert.equal(refusal.detail?.reason, 'employer_funding_requires_new_purchase');
  assert.equal(w.trace.events.filter((e) => e.event === 'submit').length, 0);

  const fresh = proposeAs(w, { ...input, purchaseId: 'purchase-2', totalCents: 600 });
  assert.equal(fresh.proposal.privacy.source.kind, 'employer_mandate');
  approveAs(w, fresh);
  await submitAs(w, fresh, EMPLOYEE);
  assert.equal(fresh.state, 'completed');
  assert.equal(viewFor(fresh, { partyId: EMPLOYER, facet: 'sponsor' }).contributionCents, 500);
  assert.deepEqual(unwrapView(p), before);
});

test('request_only offer changes still reprice when employer funding remains zero', async () => {
  const w = world();
  const p = proposeAs(w, { purchaseId: 'purchase-1', employeeId: EMPLOYEE, merchantId: MERCHANT_A, totalCents: 500, mandateRef: 'mandate-missing', expiresAt: 100 });
  assert.equal(changeOfferAs(w, p, { merchantId: MERCHANT_B, totalCents: 600, expiresAt: 100 }, EMPLOYEE).outcome, 'replaced');
  // Even a newly published mandate is harmless when this merchant is ineligible.
  w.authority.publishEmployerMandate(signPayload({ ...w.mandate, mandateRef: 'mandate-missing', eligibleMerchants: [MERCHANT_A] }, w.signers.get(EMPLOYER)!));
  assert.equal(changeOfferAs(w, p, { merchantId: MERCHANT_B, totalCents: 700, expiresAt: 100 }, EMPLOYEE).outcome, 'replaced');
  assert.equal(p.proposal.version, 3);
  assert.deepEqual(p.proposal.privacy, { profile: 'employer_benefit_v1', source: { kind: 'request_only' } });
  assert.equal(viewFor(p, { partyId: EMPLOYEE, facet: 'payer' }).ownCents, 700);
  assert.throws(() => viewFor(p, { partyId: EMPLOYER, facet: 'sponsor' }), /recipient_not_entitled/);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  assert.equal(p.legs.length, 1);
  assert.equal(p.legs[0].payerId, EMPLOYEE);
});

test('a payee facet requires the merchant of record or an actual share payee', async () => {
  const { p } = await run('S01');
  assert.equal(viewFor(p, { partyId: MERCHANT_A, facet: 'payee' }).receivedCents, 1_300);
  assert.throws(() => viewFor(p, { partyId: MERCHANT_B, facet: 'payee' }), /recipient_not_entitled/);
  assert.throws(() => viewFor(p, { partyId: EMPLOYEE, facet: 'payee' }), /recipient_not_entitled/);
  // No profile id on the payee view — it would reveal funding composition.
  assert.equal(JSON.stringify(viewFor(p, { partyId: MERCHANT_A, facet: 'payee' })).includes('employer_benefit_v1'), false);
});

test('projections are detached — mutating the view never reaches the purchase', async () => {
  const { p } = await run('S03');
  const v = viewFor(p, { partyId: COLLEAGUE_1, facet: 'payer' });
  v.sharedContributions![0].amountCents = 1;
  v.ownLegs.push({ payeeId: 'x', amountCents: 1, status: 'settled' });
  const again = viewFor(p, { partyId: COLLEAGUE_1, facet: 'payer' });
  assert.equal(again.sharedContributions![0].amountCents, 1_334);
  assert.equal(again.ownLegs.length, 1);
  assert.equal(unwrapView(p).proposal.shares[1].amountCents, 1_333);
});

test('frozen terms inconsistent with the actual shares refuse every facet', () => {
  const w = world();
  const p = proposeSplitAs(
    w,
    {
      purchaseId: 'purchase-1',
      merchantId: MERCHANT_B,
      amountsFrom: 'proposer',
      shares: [
        { role: 'a', payerId: EMPLOYEE, amountCents: 300 },
        { role: 'b', payerId: COLLEAGUE_1, amountCents: 200 },
      ],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  const audiences = [
    [EMPLOYEE, COLLEAGUE_2], // wrong participant
    [EMPLOYEE], // missing participant
    [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2], // extra participant
    [EMPLOYEE, EMPLOYEE], // same length, but a duplicate hides a missing payer
  ];
  for (const participantIds of audiences) {
    unwrapView(p).proposal.privacy = { profile: 'split_bill_v1', source: { kind: 'known_group', groupRef: 'colleagues-v1', participantIds } };
    for (const recipient of [
      { partyId: EMPLOYEE, facet: 'payer' },
      { partyId: COLLEAGUE_1, facet: 'payer' },
      { partyId: MERCHANT_B, facet: 'payee' },
      { partyId: EMPLOYER, facet: 'sponsor' },
    ] as const) {
      assert.throws(() => viewFor(p, recipient), { message: 'privacy_profile_invalid' }, `${participantIds.join(',')}: ${recipient.facet} ${recipient.partyId}`);
    }
  }
});

// --- Signed admission effects ------------------------------------------------

test('split admission failures leave no purchase, approval or settlement effect', async () => {
  const w = world();
  const events = () => w.trace.events.filter((e) => e.event === 'request_refused');
  const base = events().length;
  const attempt = (over: object) =>
    proposeSplitAs(
      w,
      {
        purchaseId: 'purchase-1',
        merchantId: MERCHANT_B,
        amountsFrom: 'equal_split',
        totalCents: 1_000,
        expiresAt: 100,
        shares: [
          { role: 'a', payerId: EMPLOYEE },
          { role: 'b', payerId: COLLEAGUE_1 },
        ],
        ...over,
      },
      EMPLOYEE,
    );
  // Unknown group reference.
  assert.throws(() => attempt({ disclosureGroupRef: 'strangers-1' }), /split_group_unknown/);
  // A registered identity outside the group's members.
  const w2 = world({}, {}, { knownSplitGroups: [COLLEAGUES_V1_GROUP, { groupRef: 'employee-employer-fixture', privacyProfile: 'split_bill_v1', memberIds: [EMPLOYEE, EMPLOYER] }] });
  assert.throws(
    () =>
      proposeSplitAs(
        w2,
        {
          purchaseId: 'purchase-1',
          merchantId: MERCHANT_B,
          amountsFrom: 'equal_split',
          totalCents: 1_000,
          disclosureGroupRef: 'employee-employer-fixture',
          expiresAt: 100,
          shares: [
            { role: 'a', payerId: EMPLOYEE },
            { role: 'b', payerId: COLLEAGUE_1 },
          ],
        },
        EMPLOYEE,
      ),
    /split_group_mismatch/,
  );
  // A payer with no registered identity key — member of a configured group
  // but holding no key the agreement presumes.
  const w3 = world({}, {}, { knownSplitGroups: [{ groupRef: 'ghost-group', privacyProfile: 'split_bill_v1', memberIds: [EMPLOYEE, 'ghost-1'] }] });
  assert.throws(
    () =>
      proposeSplitAs(
        w3,
        {
          purchaseId: 'purchase-1',
          merchantId: MERCHANT_B,
          amountsFrom: 'equal_split',
          totalCents: 1_000,
          disclosureGroupRef: 'ghost-group',
          expiresAt: 100,
          shares: [
            { role: 'a', payerId: EMPLOYEE },
            { role: 'b', payerId: 'ghost-1' },
          ],
        },
        EMPLOYEE,
      ),
    /split_participant_unknown/,
  );
  // A world configured with no groups admits no split at all.
  const w4 = world({}, {}, { knownSplitGroups: [] });
  assert.throws(
    () =>
      proposeSplitAs(
        w4,
        { purchaseId: 'purchase-1', merchantId: MERCHANT_B, amountsFrom: 'equal_split', totalCents: 1_000, expiresAt: 100, shares: [{ role: 'a', payerId: EMPLOYEE }] },
        EMPLOYEE,
      ),
    /split_group_unknown/,
  );
  assert.equal(events().length - base, 1, 'only the first refusal ran on w');
  for (const ww of [w, w2, w3, w4]) {
    assert.throws(() => ww.coordinator.view('purchase-1'), /unknown_purchase/);
    assert.equal(ww.trace.events.filter((e) => e.event === 'approval_recorded').length, 0);
    assert.equal(ww.trace.events.filter((e) => e.event === 'submit').length, 0);
  }
  // The refusal never burned the purchaseId: a valid split commits on it.
  const p = attempt({});
  assert.equal(p.proposal.privacy.profile, 'split_bill_v1');
});

test('a tampered or cross-arrangement signed profile is refused distinctly from a valid one', async () => {
  const w = world();
  const { signPayload } = await import('../src/core/signing.ts');
  const payload = {
    kind: 'propose_split',
    purchaseId: 'purchase-1',
    proposalVersion: 1,
    by: EMPLOYEE,
    merchantId: MERCHANT_B,
    amountsFrom: 'equal_split',
    totalCents: 1_000,
    shares: [
      { role: 'a', payerId: EMPLOYEE, rail: 'digital_euro' },
      { role: 'b', payerId: COLLEAGUE_1, rail: 'digital_euro' },
    ],
    expiresAt: 100,
    submitPolicy: 'on_request',
    settlementMode: 'atomic',
    privacyProfile: 'split_bill_v1',
    disclosureGroupRef: 'colleagues-v1',
  };
  // A tampered profile: the signature covers the original profile value.
  const tampered = signPayload(payload, w.signers.get(EMPLOYEE)!);
  (tampered.payload as { privacyProfile: string }).privacyProfile = 'employer_benefit_v1';
  assert.throws(() => w.coordinator.proposeSplit(tampered as never), /bad_signature/);
  // A valid signature over a profile this entry point does not support.
  const cross = signPayload({ ...payload, privacyProfile: 'employer_benefit_v1' }, w.signers.get(EMPLOYEE)!);
  assert.throws(() => w.coordinator.proposeSplit(cross as never), /privacy_profile_unsupported/);
  assert.throws(() => w.coordinator.view('purchase-1'), /unknown_purchase/);
  // And a benefit request can never select split disclosure.
  const wrong = signPayload(
    {
      kind: 'propose',
      purchaseId: 'purchase-1',
      proposalVersion: 1,
      by: EMPLOYEE,
      employeeId: EMPLOYEE,
      merchantId: MERCHANT_A,
      totalCents: 1_300,
      mandateRef: 'mandate-1',
      expiresAt: 100,
      submitPolicy: 'on_request',
      settlementMode: 'atomic',
      privacyProfile: 'split_bill_v1',
    },
    w.signers.get(EMPLOYEE)!,
  );
  assert.throws(() => w.coordinator.propose(wrong as never), /privacy_profile_unsupported/);
});

test('an approval signed over a wrong or missing profile is refused as terms_mismatch', async () => {
  const w = world();
  const p = lunch(w);
  const q = p.proposal;
  const { signPayload, sharesDigestOf } = await import('../src/core/signing.ts');
  const { approvalCents, approvalFeeCents } = await import('../src/core/coordinator.ts');
  const base = {
    approvalRef: 'appr-privacy',
    purchaseId: p.purchaseId,
    payerId: EMPLOYEE,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, EMPLOYEE),
    feeCents: approvalFeeCents(q, EMPLOYEE),
    sharesDigest: sharesDigestOf(q.shares),
    expiresAt: q.expiresAt,
    basis: 'device',
  };
  // Correctly signed approvals whose only fault is the signed profile —
  // the wrong literal, a missing field or a group reference that a benefit
  // approval must never carry — all fail the frozen-terms binding.
  const mismatches = [
    { privacyProfile: 'split_bill_v1' },
    { privacyProfile: 'employer_benefit_v1', disclosureGroupRef: 'colleagues-v1' },
    {},
  ];
  for (const over of mismatches) {
    assert.throws(() => w.coordinator.approve(p.purchaseId, signPayload({ ...base, ...over } as never, w.signers.get(EMPLOYEE)!)), /does not match/);
    assert.equal(w.trace.events.at(-1)?.detail?.reason, 'terms_mismatch', JSON.stringify(over));
  }
  assert.equal(p.authorizations.length, 0);
  // Inject re-signed incompatible evidence through the existing retained
  // record seam. Its signature remains valid, so only the frozen privacy
  // binding can invalidate the authorization at refresh.
  for (const [index, over] of mismatches.entries()) {
    approveAs(w, p);
    const authorization = (unwrapView(p) as Purchase).authorizations[0];
    // Only approval-bearing records (device/exception) carry .approval —
    // a pledge record must never be read through it.
    assert.ok(authorization.basis !== 'mandate' && authorization.basis !== 'pledge');
    assert.equal(w.coordinator.authorizationCurrentlyValid(p.purchaseId, authorization), true);
    authorization.approval = signPayload({ ...base, ...over } as never, w.signers.get(EMPLOYEE)!);
    assert.equal(verifyPayload(authorization.approval, w.keys, EMPLOYEE), true);
    w.coordinator.refreshAuthorization(p.purchaseId);
    assert.equal(p.authorizations.length, 0, JSON.stringify(over));
    assert.equal(w.trace.events.filter((e) => e.event === 'approval_invalidated').length, index + 1);
  }
});

test('a split approval signed over a wrong or missing group reference is refused as terms_mismatch', async () => {
  const w = world();
  const p = proposeSplitAs(
    w,
    {
      purchaseId: 'purchase-1',
      merchantId: MERCHANT_B,
      amountsFrom: 'equal_split',
      totalCents: 1_000,
      shares: [
        { role: 'a', payerId: EMPLOYEE },
        { role: 'b', payerId: COLLEAGUE_1 },
      ],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  const q = p.proposal;
  assert.equal(q.privacy.profile, 'split_bill_v1');
  const { signPayload, sharesDigestOf } = await import('../src/core/signing.ts');
  const { approvalCents, approvalFeeCents } = await import('../src/core/coordinator.ts');
  const base = {
    approvalRef: 'appr-group-ref',
    purchaseId: p.purchaseId,
    payerId: COLLEAGUE_1,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, COLLEAGUE_1),
    feeCents: approvalFeeCents(q, COLLEAGUE_1),
    sharesDigest: sharesDigestOf(q.shares),
    expiresAt: q.expiresAt,
    basis: 'device',
    privacyProfile: 'split_bill_v1',
  };
  // Correctly signed approvals whose only fault is the group reference — a
  // different agreement's or none at all on a known-group split — fail the
  // frozen-terms binding.
  const mismatches = [{ disclosureGroupRef: 'strangers-1' }, {}];
  for (const over of mismatches) {
    assert.throws(() => w.coordinator.approve(p.purchaseId, signPayload({ ...base, ...over } as never, w.signers.get(COLLEAGUE_1)!)), /does not match/);
    assert.equal(w.trace.events.at(-1)?.detail?.reason, 'terms_mismatch', JSON.stringify(over));
  }
  // No settlement effect: no authorization recorded, nothing submitted, the
  // purchase still waits for approval.
  assert.equal(p.authorizations.length, 0);
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(w.trace.events.filter((e) => e.event === 'submit').length, 0);
  // The correctly bound approval is recorded. Re-signed retained evidence
  // must still match the frozen agreement; split liveness uses the same
  // authorization survival rule without adding a standing-terms refresh.
  approveAs(w, p, COLLEAGUE_1);
  assert.equal(p.authorizations.length, 1);
  const authorization = (unwrapView(p) as Purchase).authorizations[0];
  // Only approval-bearing records (device/exception) carry .approval —
  // a pledge record must never be read through it.
  assert.ok(authorization.basis !== 'mandate' && authorization.basis !== 'pledge');
  const correct = authorization.approval;
  assert.equal(w.coordinator.authorizationCurrentlyValid(p.purchaseId, authorization), true);
  for (const over of mismatches) {
    authorization.approval = signPayload({ ...base, ...over } as never, w.signers.get(COLLEAGUE_1)!);
    assert.equal(verifyPayload(authorization.approval, w.keys, COLLEAGUE_1), true);
    assert.equal(w.coordinator.authorizationCurrentlyValid(p.purchaseId, authorization), false, JSON.stringify(over));
  }
  authorization.approval = correct;
  assert.equal(w.coordinator.authorizationCurrentlyValid(p.purchaseId, authorization), true);
});

// --- Conditional-fund disclosure (public_good_pledge_v1) -------------------

// The world's clock starts at minute 10; these terms keep the cutoff and
// settlement deadline ahead of it. The condition defaults to count-only.
const FUND_TERMS = (over: Partial<CampaignTerms> = {}): CampaignTerms => ({
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

// The payer facet on a campaign profile projects the distinct FundPayerView —
// narrowing asserts the fund was never cast into the ordinary view.
const fundView = (p: Parameters<typeof viewFor>[0], payerId: string): FundPayerView => {
  const v = viewFor(p, { partyId: payerId, facet: 'payer' });
  assert.ok('pledge' in v, 'a campaign profile projects the fund view');
  return v;
};

test('a verified open_fund request resolves to frozen campaign terms', () => {
  const terms = FUND_TERMS();
  const campaignDigest = campaignDigestOf(terms);
  const t = resolveProfile({ kind: 'campaign', requested: 'public_good_pledge_v1', campaignDigest, terms });
  assert.deepEqual(t, { profile: 'public_good_pledge_v1', source: { kind: 'campaign', campaignDigest, terms } });
  // A campaign source can only ever be requested under its own profile.
  assert.throws(() => resolveProfile({ kind: 'campaign', requested: 'split_bill_v1', campaignDigest, terms }), /privacy_profile_unsupported/);
  assert.throws(() => resolveProfile({ kind: 'campaign', requested: 'employer_benefit_v1', campaignDigest, terms }), /privacy_profile_unsupported/);
  // The frozen table is a detached clone: neither side mutates the other.
  terms.condition.minPayers = 99;
  assert.equal(t.source.kind === 'campaign' && t.source.terms.condition.minPayers, 2);
  assert.throws(() => {
    (t.source as { terms: { fundingEndsAt: number } }).terms.fundingEndsAt = 99;
  }, TypeError);
});

test('a count-only fund shows a contributor its own pledge and the live count — never the total or other payers', () => {
  const w = world();
  const terms = FUND_TERMS();
  const id = openFundAs(w, terms);
  // Nonuniform principal, fee and rail so total/others/fee leakage is
  // detectable, not masked by symmetric fixtures.
  const first = pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30, { feeCents: 7, rail: 'bank' });
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  const p = w.coordinator.view(id);
  assert.equal(p.state, 'ready');
  const v = fundView(p, RESIDENT_1);
  assert.equal(v.privacyProfile, 'public_good_pledge_v1');
  assert.equal(v.state, 'ready');
  assert.equal(v.merchantId, PROJECT_1);
  assert.deepEqual(v.campaign, terms);
  assert.deepEqual(v.pledge, { pledgeRef: 'r1', amountCents: 300, feeCents: 7, rail: 'bank', expiresAt: 30 });
  assert.deepEqual(v.acceptance, { acceptedAt: first.acceptance.acceptedAt, proposalVersion: first.acceptance.proposalVersion });
  assert.equal(v.outcome, 'active');
  assert.deepEqual(v.ownLegs, []);
  assert.equal(v.progress.contributors, 2);
  assert.equal('pledgedCents' in v.progress, false, 'a count-only condition authorizes no principal total — absent, not zeroed');
  assert.equal(v.progress.met, true);
  // The ordinary total-bearing fields are absent, not just zeroed.
  for (const key of ['totalCents', 'ownCents', 'othersCents', 'ownFeeCents', 'sharedContributions', 'authorizationBasis', 'authorizationRef']) {
    assert.equal(key in v, false, key);
  }
  const json = JSON.stringify(v);
  for (const leak of [RESIDENT_2, 'r2', '700', 'signature', 'canonicalPayload']) {
    assert.equal(json.includes(leak), false, leak);
  }
  assert.equal(json.includes(first.signed.signature), false, 'raw signature material stays out');
});

test('the signed condition selects which progress counters a fund view exposes', () => {
  const w = world();
  const budgetId = openFundAs(w, FUND_TERMS({ purchaseId: 'fund-budget', condition: { minTotalCents: 1_000 } }));
  pledgeAs(w, budgetId, RESIDENT_1, 'r1', 300, 30);
  pledgeAs(w, budgetId, RESIDENT_2, 'r2', 700, 30);
  const budget = fundView(w.coordinator.view(budgetId), RESIDENT_1);
  assert.equal(budget.progress.pledgedCents, 1_000);
  assert.equal('contributors' in budget.progress, false, 'a budget-only condition authorizes no contributor count — absent, not zeroed');
  assert.equal(budget.progress.met, true);
  const bothId = openFundAs(w, FUND_TERMS({ purchaseId: 'fund-both', condition: { minPayers: 2, minTotalCents: 1_000 } }));
  pledgeAs(w, bothId, RESIDENT_1, 'r1', 300, 30);
  pledgeAs(w, bothId, RESIDENT_2, 'r2', 700, 30);
  const both = fundView(w.coordinator.view(bothId), RESIDENT_2);
  assert.deepEqual(both.progress, { contributors: 2, pledgedCents: 1_000, met: true });
});

test('a lapsed contributor keeps its own outcome and the permitted progress — retained history, not the active index, entitles it', () => {
  const w = world();
  const id = openFundAs(w, FUND_TERMS({ condition: { minPayers: 3 } }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 15, { feeCents: 4 });
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  // r1's personal expiry passes while the roster still collects; the next
  // evaluation lapses it and removes its materialized share.
  advance(w, 16);
  w.coordinator.evaluate(id);
  const p = w.coordinator.view(id);
  assert.equal(p.funding?.history[0].outcome, 'lapsed');
  assert.equal(p.proposal.shares.length, 1, 'the lapsed share is no longer materialized');
  const v = fundView(p, RESIDENT_1);
  assert.equal(v.outcome, 'lapsed');
  assert.deepEqual(v.pledge, { pledgeRef: 'r1', amountCents: 300, feeCents: 4, rail: 'digital_euro', expiresAt: 15 });
  assert.equal(v.progress.contributors, 1, 'only live pledges count');
  assert.equal(v.progress.met, false);
});

test('a failed fund still projects retained pledge outcomes', () => {
  const w = world();
  const id = openFundAs(w, FUND_TERMS({ condition: { minPayers: 3 } }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  advance(w, 21); // past the cutoff, still within settleBy
  w.coordinator.evaluate(id);
  const p = w.coordinator.view(id);
  assert.equal(p.state, 'failed');
  const v = fundView(p, RESIDENT_1);
  assert.equal(v.state, 'failed');
  assert.equal(v.outcome, 'active', 'an unmet campaign never lapsed the pledge itself');
  assert.equal(v.progress.met, false);
});

test('fund projections are pure reads — no events, no lapse, detached results', () => {
  const w = world();
  const id = openFundAs(w, FUND_TERMS({ condition: { minPayers: 3 } }));
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 15);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  // r1 expired but no evaluation has lapsed it: reading must not change
  // that — a projection never evaluates, lapses, reserves or submits.
  advance(w, 16);
  const p = w.coordinator.view(id);
  const before = structuredClone(unwrapView(p));
  const events = w.trace.events.length;
  const v = fundView(p, RESIDENT_1);
  assert.equal(v.outcome, 'active', 'a read never lapses an expired pledge');
  assert.equal(v.progress.contributors, 2, 'the retained counters are reported, never re-evaluated');
  assert.equal(w.trace.events.length, events, 'reading emits nothing');
  assert.deepEqual(unwrapView(p), before, 'reading mutates nothing');
  // Mutating the returned view never reaches the retained records.
  v.pledge.amountCents = 1;
  v.progress.contributors = 99;
  v.campaign.fundingEndsAt = 1;
  v.ownLegs.push({ payeeId: 'x', amountCents: 1, status: 'settled' });
  const again = fundView(p, RESIDENT_1);
  assert.equal(again.pledge.amountCents, 300);
  assert.equal(again.progress.contributors, 2);
  assert.equal(again.campaign.fundingEndsAt, 20);
  assert.equal(again.ownLegs.length, 0);
  assert.deepEqual(unwrapView(p), before);
});

test('fund projections refuse outsiders and the sponsor facet', () => {
  const w = world();
  const id = openFundAs(w, FUND_TERMS());
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  const p = w.coordinator.view(id);
  // Anyone without an accepted pledge gets no payer view — including the
  // campaign payee, which is a recipient, never a contributor.
  for (const partyId of [RESIDENT_3, EMPLOYEE, PROJECT_1]) {
    assert.throws(() => viewFor(p, { partyId, facet: 'payer' }), /recipient_not_entitled/, partyId);
  }
  // A fund has no sponsor facet — not even for a contributor or a
  // registered employer identity.
  assert.throws(() => viewFor(p, { partyId: RESIDENT_1, facet: 'sponsor' }), /recipient_not_entitled/);
  assert.throws(() => viewFor(p, { partyId: EMPLOYER, facet: 'sponsor' }), /recipient_not_entitled/);
});

test('malformed or inconsistent retained campaign data refuses every facet', () => {
  const fresh = () => {
    const w = world();
    const id = openFundAs(w, FUND_TERMS());
    pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
    pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
    return w.coordinator.view(id);
  };
  const every = [
    { partyId: RESIDENT_1, facet: 'payer' },
    { partyId: PROJECT_1, facet: 'payee' },
    { partyId: EMPLOYER, facet: 'sponsor' },
  ] as const;
  const invalid = (p: Parameters<typeof viewFor>[0], label: string): void => {
    for (const r of every) {
      assert.throws(() => viewFor(p, r), { message: 'privacy_profile_invalid' }, `${label}: ${r.facet}`);
    }
  };
  // A frozen campaign source whose digest no longer commits to its terms,
  // or whose terms no longer describe this purchase.
  {
    const p = fresh();
    const privacy = (unwrapView(p) as Purchase).proposal.privacy;
    assert.ok(privacy.profile === 'public_good_pledge_v1' && privacy.source.kind === 'campaign');
    const sources = [
      { ...privacy.source, campaignDigest: '0'.repeat(64) },
      { ...privacy.source, terms: { ...privacy.source.terms, purchaseId: 'other-fund' } },
      { ...privacy.source, terms: { ...privacy.source.terms, fundingEndsAt: 40 } },
      { ...privacy.source, terms: { ...privacy.source.terms, settlementMode: 'independent' } },
      { kind: 'campaign', campaignDigest: privacy.source.campaignDigest, terms: { bogus: true } },
    ];
    for (const source of sources) {
      const q = fresh();
      (unwrapView(q) as Purchase).proposal.privacy = { profile: 'public_good_pledge_v1', source } as never;
      invalid(q, JSON.stringify(source).slice(0, 80));
    }
    // A campaign source under another profile is refused, never read as a
    // split; a funding record under non-campaign terms is corrupted too.
    const cross = fresh();
    (unwrapView(cross) as Purchase).proposal.privacy = { profile: 'split_bill_v1', source: privacy.source } as never;
    invalid(cross, 'campaign source under split profile');
    const requestOnly = fresh();
    (unwrapView(requestOnly) as Purchase).proposal.privacy = { profile: 'employer_benefit_v1', source: { kind: 'request_only' } };
    invalid(requestOnly, 'funding record under request_only terms');
  }
  // A funding record disagreeing with the frozen source — digest, terms,
  // phase, counters or history — is corrupted evidence for every facet.
  {
    const mutations: [string, (p: Purchase) => void][] = [
      ['stored digest disagrees', (p) => void (p.funding!.campaignDigest = '0'.repeat(64))],
      ['retained terms recompute differently', (p) => void (p.funding!.terms = { ...p.funding!.terms, settleBy: 99 })],
      ['unknown phase', (p) => void (p.funding!.phase = 'bogus' as never)],
      ['malformed counters', (p) => void (p.funding!.progress = { livePayers: -1, liveTotalCents: 0, met: false })],
      ['unknown outcome', (p) => void (p.funding!.history = [{ ...p.funding!.history[0], outcome: 'gone' as never }, ...p.funding!.history.slice(1)])],
      // The payload drifted from its stored canonical bytes — still
      // well-formed (29 <= settleBy), so only the canonical check catches
      // it. The pledgor's own payer view must refuse like every facet.
      ['stored canonicalPayload stale', (p) => void (p.funding!.history[0].signed.payload.expiresAt = 29)],
      ['duplicate payer', (p) => void (p.funding!.history = [p.funding!.history[0], { ...p.funding!.history[1], signed: { ...p.funding!.history[1].signed, payload: { ...p.funding!.history[1].signed.payload, by: RESIDENT_1 } } }])],
    ];
    for (const [label, mutate] of mutations) {
      const q = fresh();
      mutate(unwrapView(q) as Purchase);
      invalid(q, label);
    }
  }
});

test('the campaign payee sees anonymous contribution items and the funding outcome', async () => {
  const w = world();
  // A still-collecting fund reports its phase and the unmet condition —
  // never contributor detail.
  const collectingId = openFundAs(w, FUND_TERMS({ purchaseId: 'fund-collecting', condition: { minPayers: 3 } }));
  pledgeAs(w, collectingId, RESIDENT_1, 'c1', 300, 30);
  pledgeAs(w, collectingId, RESIDENT_2, 'c2', 700, 30);
  const collecting = viewFor(w.coordinator.view(collectingId), { partyId: PROJECT_1, facet: 'payee' });
  assert.deepEqual(collecting.fundingOutcome, { phase: 'collecting', met: false });
  assert.equal(collecting.receivedCents, 0);
  assert.equal(JSON.stringify(collecting).includes(RESIDENT_1), false);
  const id = openFundAs(w, FUND_TERMS());
  pledgeAs(w, id, RESIDENT_1, 'r1', 300, 30);
  pledgeAs(w, id, RESIDENT_2, 'r2', 700, 30);
  const p = w.coordinator.view(id);
  const v = viewFor(p, { partyId: PROJECT_1, facet: 'payee' });
  assert.deepEqual(v.fundingOutcome, { phase: 'closed', met: true });
  assert.equal(v.receivedCents, 0);
  assert.equal(v.contributions.length, 0, 'no legs exist before admission');
  const json = JSON.stringify(v);
  for (const leak of [RESIDENT_1, RESIDENT_2, 'r1', 'r2', 'pledge', 'public_good_pledge_v1']) {
    assert.equal(json.includes(leak), false, leak);
  }
  // An outsider payee learns nothing.
  assert.throws(() => viewFor(p, { partyId: MERCHANT_A, facet: 'payee' }), /recipient_not_entitled/);
  // After settlement the items are still anonymous amounts and statuses.
  await submitAs(w, p, RESIDENT_1);
  const done = viewFor(w.coordinator.view(id), { partyId: PROJECT_1, facet: 'payee' });
  assert.equal(done.receivedCents, 1_000);
  assert.deepEqual(done.contributions.map((c) => c.status), ['settled', 'settled']);
  assert.deepEqual(done.fundingOutcome, { phase: 'admitted', met: true });
  const doneJson = JSON.stringify(done);
  for (const leak of [RESIDENT_1, RESIDENT_2]) assert.equal(doneJson.includes(leak), false, leak);
});
