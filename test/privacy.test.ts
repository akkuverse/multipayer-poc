// Disclosure contracts (src/core/privacy.ts): the closed profile catalog
// resolves verified signed sources into frozen proposal terms, and viewFor
// is the only recipient projection — entitlement checked before a detached
// view is emitted, never a permissive default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, world, lunch, proposeAs, proposeSplitAs, approveAs, changeOfferAs, submitAs, COLLEAGUES_V1_GROUP, EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, MERCHANT_B } from '../src/scenarios.ts';
import { resolveProfile, viewFor } from '../src/core/privacy.ts';
import type { KnownSplitGroup } from '../src/core/privacy.ts';
import type { Purchase } from '../src/core/types.ts';
import { unwrapView } from '../src/core/live-view.ts';
import { signPayload, verifyPayload } from '../src/core/signing.ts';

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
