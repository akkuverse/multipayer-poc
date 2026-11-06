// Pure donor-allowance evaluation and selection: eligibility terms, the
// exact contribution formula, greatest-contribution choice and the
// code-unit reference tie-break. Selection never authorizes the buyer —
// no positive candidate is simply zero donor contribution.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAllowance, selectAllowance } from '../src/core/policy.ts';
import type { AllowanceInput } from '../src/core/policy.ts';
import type { AllowanceUsage } from '../src/core/ledger.ts';
import type { AllowanceMandate, EligibilityAttestation } from '../src/core/types.ts';

const allowance = (over: Partial<AllowanceMandate> = {}): AllowanceMandate => ({
  allowanceRef: 'al-1',
  donorId: 'donor-1',
  version: 1,
  beneficiaryClass: 'in_need',
  maxPerPurchaseCents: 500,
  maxPerDayCents: 1_000,
  maxPurchasesPerDay: 3,
  totalEndowmentCents: 5_000,
  eligibleMerchants: ['merch-1'],
  validFrom: 0,
  validUntil: 10_000,
  revoked: false,
  privacyProfile: 'anonymous_donation_v1',
  ...over,
});

const attestation = (over: Partial<EligibilityAttestation> = {}): EligibilityAttestation => ({
  attestorId: 'oracle-1',
  subjectId: 'buyer-1',
  classId: 'in_need',
  validFrom: 0,
  validUntil: 10_000,
  version: 1,
  revoked: false,
  ...over,
});

const usage = (
  daily: { cents: number; purchases: number } = { cents: 0, purchases: 0 },
  lifetime: { cents: number; purchases: number } = daily,
): AllowanceUsage => ({ daily, lifetime });

const input = (over: Partial<AllowanceInput> = {}): AllowanceInput => ({
  totalCents: 800,
  merchantId: 'merch-1',
  buyerId: 'buyer-1',
  beneficiaryClass: 'in_need',
  allowance: allowance(),
  attestation: attestation(),
  now: 100,
  usage: usage(),
  ...over,
});

test('contribution_is_the_tightest_cap_and_buyer_covers_the_rest', () => {
  // min(800 total, 500 per-purchase, 1000 daily, 5000 lifetime) = 500.
  assert.deepEqual(evaluateAllowance(input()), {
    donorCents: 500,
    buyerCents: 300,
    ineligibleReason: undefined,
  });
  // A fully sponsored purchase is legal: the buyer share reaches zero.
  const sponsored = evaluateAllowance(input({ totalCents: 200 }));
  assert.equal(sponsored.donorCents, 200);
  assert.equal(sponsored.buyerCents, 0);
  // No lifetime cap means that term imposes no limit beyond the total.
  const uncapped = evaluateAllowance(
    input({
      totalCents: 2_000,
      allowance: allowance({ maxPerPurchaseCents: 9_000, maxPerDayCents: 9_000, totalEndowmentCents: undefined }),
      usage: usage({ cents: 0, purchases: 0 }, { cents: 90_000, purchases: 50 }),
    }),
  );
  assert.equal(uncapped.donorCents, 2_000);
});

test('lifetime_endowment_binds_and_lifetime_zero_means_zero', () => {
  // 1500 endowment with 600 consumed + 400 reserved leaves exactly 500.
  const r = evaluateAllowance(
    input({
      allowance: allowance({ maxPerPurchaseCents: 9_000, maxPerDayCents: 9_000, totalEndowmentCents: 1_500 }),
      usage: usage({ cents: 0, purchases: 0 }, { cents: 1_000, purchases: 2 }),
    }),
  );
  assert.equal(r.donorCents, 500);
  assert.equal(r.buyerCents, 300);
  // An endowment revised below already-held usage grants no new capacity;
  // it never erases existing bookings.
  const spent = evaluateAllowance(
    input({
      allowance: allowance({ totalEndowmentCents: 900 }),
      usage: usage({ cents: 0, purchases: 0 }, { cents: 1_000, purchases: 2 }),
    }),
  );
  assert.equal(spent.donorCents, 0);
  assert.equal(spent.ineligibleReason, 'lifetime_cap_used');
});

test('reduced_daily_cap_below_usage_contributes_zero', () => {
  const r = evaluateAllowance(
    input({
      allowance: allowance({ maxPerDayCents: 900 }),
      usage: usage({ cents: 1_000, purchases: 1 }),
    }),
  );
  assert.equal(r.donorCents, 0);
  assert.equal(r.buyerCents, 800);
  assert.equal(r.ineligibleReason, 'daily_cap_used');
});

test('daily_purchase_count_exhaustion_zeroes_even_with_cents_remaining', () => {
  const r = evaluateAllowance(
    input({
      usage: usage({ cents: 100, purchases: 3 }),
    }),
  );
  assert.equal(r.donorCents, 0);
  assert.equal(r.buyerCents, 800);
  assert.equal(r.ineligibleReason, 'daily_purchase_limit_reached');
  // A missing or malformed purchase limit fails closed, never open.
  const malformed = evaluateAllowance(
    input({ allowance: allowance({ maxPurchasesPerDay: Number.NaN }) }),
  );
  assert.equal(malformed.donorCents, 0);
  assert.equal(malformed.ineligibleReason, 'daily_purchase_limit_reached');
});

test('term_ineligibility_table', () => {
  const cases: { name: string; over: Partial<AllowanceInput>; reason: string }[] = [
    { name: 'attestation subject', over: { attestation: attestation({ subjectId: 'buyer-2' }) }, reason: 'attestation_subject_mismatch' },
    { name: 'attestation class', over: { attestation: attestation({ classId: 'other' }) }, reason: 'attestation_class_mismatch' },
    { name: 'attestation revoked', over: { attestation: attestation({ revoked: true }) }, reason: 'attestation_revoked' },
    { name: 'attestation expired', over: { attestation: attestation({ validUntil: 99 }) }, reason: 'attestation_expired' },
    { name: 'attestation early', over: { attestation: attestation({ validFrom: 101 }) }, reason: 'attestation_expired' },
    { name: 'wrong profile', over: { allowance: allowance({ privacyProfile: 'employer_benefit_v1' as never }) }, reason: 'allowance_privacy_profile_invalid' },
    { name: 'allowance revoked', over: { allowance: allowance({ revoked: true }) }, reason: 'allowance_revoked' },
    { name: 'allowance expired', over: { allowance: allowance({ validUntil: 99 }) }, reason: 'allowance_expired' },
    { name: 'allowance early', over: { allowance: allowance({ validFrom: 101 }) }, reason: 'allowance_expired' },
    { name: 'wrong class', over: { beneficiaryClass: 'other' }, reason: 'attestation_class_mismatch' },
    { name: 'allowance class', over: { allowance: allowance({ beneficiaryClass: 'other' }) }, reason: 'beneficiary_class_mismatch' },
    { name: 'donor is buyer', over: { buyerId: 'donor-1' }, reason: 'attestation_subject_mismatch' },
    { name: 'donor equals buyer', over: { allowance: allowance({ donorId: 'buyer-1' }) }, reason: 'donor_is_buyer' },
    { name: 'merchant', over: { merchantId: 'merch-2' }, reason: 'merchant_not_eligible' },
  ];
  for (const c of cases) {
    const r = evaluateAllowance(input(c.over));
    assert.equal(r.donorCents, 0, c.name);
    assert.equal(r.buyerCents, 800, c.name);
    assert.equal(r.ineligibleReason, c.reason, c.name);
  }
  // Attestation problems are reported before allowance problems.
  const both = evaluateAllowance(
    input({ attestation: attestation({ revoked: true }), allowance: allowance({ revoked: true }) }),
  );
  assert.equal(both.ineligibleReason, 'attestation_revoked');
});

test('selection_prefers_the_larger_contribution_even_with_a_later_ref', () => {
  // 100 vs 1000: the 1000-contributing allowance wins although its
  // reference orders later in code units.
  const small = input({ totalCents: 2_000, allowance: allowance({ allowanceRef: 'al-a', maxPerPurchaseCents: 100 }) });
  const large = input({
    totalCents: 2_000,
    allowance: allowance({ allowanceRef: 'al-z', maxPerPurchaseCents: 1_000, maxPerDayCents: 9_000 }),
  });
  for (const candidates of [[small, large], [large, small]] as const) {
    assert.deepEqual(selectAllowance(candidates), { allowanceRef: 'al-z', donorCents: 1_000 });
  }
});

test('equal_contributions_tie_break_by_code_unit_ref_in_any_order', () => {
  const a = input({ allowance: allowance({ allowanceRef: 'al-1' }) });
  const b = input({ allowance: allowance({ allowanceRef: 'al-2' }) });
  for (const candidates of [[a, b], [b, a]] as const) {
    assert.deepEqual(selectAllowance(candidates), { allowanceRef: 'al-1', donorCents: 500 });
  }
});

test('no_positive_candidate_is_zero_contribution_not_authorization', () => {
  assert.deepEqual(selectAllowance([]), { donorCents: 0, ineligibleReason: 'no_eligible_allowance' });
  const revoked = input({ allowance: allowance({ revoked: true }) });
  const exhausted = input({ allowance: allowance({ allowanceRef: 'al-2' }), usage: usage({ cents: 0, purchases: 3 }) });
  assert.deepEqual(selectAllowance([revoked, exhausted]), {
    donorCents: 0,
    ineligibleReason: 'no_eligible_allowance',
  });
});

test('a_zero_contributor_never_beats_a_positive_one', () => {
  const zero = input({ allowance: allowance({ allowanceRef: 'al-0', revoked: true }) });
  const positive = input({ allowance: allowance({ allowanceRef: 'al-9' }) });
  assert.deepEqual(selectAllowance([zero, positive]), { allowanceRef: 'al-9', donorCents: 500 });
});
