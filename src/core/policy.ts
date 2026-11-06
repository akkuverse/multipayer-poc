// Deterministic benefit evaluation. No AI and no payment side effects: it only
// decides eligibility and amounts. Conditions live here, in the application,
// never in the money itself.

import type { AllowanceMandate, Cents, EligibilityAttestation, EmployerMandate } from './types.ts';
import type { AllowanceUsage, DailyUsage } from './ledger.ts';

export interface BenefitInput {
  totalCents: Cents;
  merchantId: string;
  // Whose purchase this is; must be the mandate's beneficiary.
  beneficiaryId: string;
  mandate: EmployerMandate;
  // Injectable clock so every evaluation is deterministic and replayable.
  now: number;
  // Employer benefit other purchases already hold or used today (ledger).
  usedToday: DailyUsage;
}

export interface BenefitResult {
  employerCents: Cents;
  employeeCents: Cents;
  // Why the employer contributes nothing, if it does not.
  ineligibleReason?: string;
}

// Why the mandate cannot fund this purchase right now, or undefined when it
// can. Checked both at proposal time and again at initiation.
export function mandateProblem(m: EmployerMandate, merchantId: string, beneficiaryId: string, now: number): string | undefined {
  if (m.revoked) return 'mandate_revoked';
  if (now < m.validFrom || now > m.validUntil) return 'mandate_expired';
  if (m.beneficiaryRef !== beneficiaryId) return 'beneficiary_mismatch';
  if (!m.eligibleMerchants.includes(merchantId)) return 'merchant_not_eligible';
  return undefined;
}

// Equal split in integer cents. The remainder goes one cent at a time to the
// first payers in the order given, so the split is deterministic and sums
// exactly to the total.
export function equalShares(totalCents: Cents, n: number): Cents[] {
  if (!Number.isInteger(totalCents) || !Number.isInteger(n) || n <= 0) {
    throw new Error('equalShares needs integer cents and a positive integer count');
  }
  const base = Math.floor(totalCents / n);
  const rest = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

export function evaluateBenefit(input: BenefitInput): BenefitResult {
  const problem = mandateProblem(input.mandate, input.merchantId, input.beneficiaryId, input.now);
  // A missing or malformed daily purchase limit fails closed, as if the
  // mandate allowed no subsidised purchases at all.
  const maxPurchases = Number.isInteger(input.mandate.maxPurchasesPerDay) ? input.mandate.maxPurchasesPerDay : 0;
  const limitReached = input.usedToday.purchases >= maxPurchases;
  const remainingToday = Math.max(0, input.mandate.maxPerDayCents - input.usedToday.cents);
  // The employer share is the tightest of the per-purchase cap, the remaining
  // daily budget and the purchase total. A mandate problem or a used-up daily
  // purchase zeroes it rather than falling back to a partial contribution.
  const employerCents =
    problem || limitReached ? 0 : Math.min(input.mandate.maxPerPurchaseCents, remainingToday, input.totalCents);
  // The employee always covers the remainder; nothing about the employer's
  // answer changes the total owed.
  const employeeCents = input.totalCents - employerCents;
  return {
    employerCents,
    employeeCents,
    ineligibleReason:
      problem ?? (limitReached ? 'daily_purchase_limit_reached' : employerCents === 0 ? 'daily_cap_used' : undefined),
  };
}

// --- Anonymous charity ------------------------------------------------------
// Donor-allowance evaluation, the EmployerMandate analog whose beneficiary
// is an attested class instead of a named beneficiaryRef. Records arrive
// already verified — signature, lookup binding, issuer trust and accepted
// revision are the caller's verified-read concern; what remains here is
// pure temporal/term eligibility and arithmetic.

export interface AllowanceInput {
  totalCents: Cents;
  merchantId: string;
  // Whose purchase this is; must be the attestation's subject, and never
  // the donor — a donor cannot sponsor its own purchase.
  buyerId: string;
  // The beneficiary class the request asks to match against.
  beneficiaryClass: string;
  // The verified allowance record under evaluation.
  allowance: AllowanceMandate;
  // The verified attestation published for (buyerId, beneficiaryClass).
  attestation: EligibilityAttestation;
  // Injectable clock so every evaluation is deterministic and replayable.
  now: number;
  // What the allowance already committed: the booking day's and all-days
  // usage, from the ledger.
  usage: AllowanceUsage;
}

export interface AllowanceResult {
  donorCents: Cents;
  // The buyer always covers the remainder — a zero-cents buyer share is
  // legal (fully sponsored).
  buyerCents: Cents;
  // Why the allowance contributes nothing, if it does not.
  ineligibleReason?: string;
}

// The outcome of selecting among candidate allowances. allowanceRef is
// absent when no candidate contributed — zero donor contribution, never an
// implicit authorization of the buyer's full price.
export interface AllowanceSelection {
  allowanceRef?: string;
  donorCents: Cents;
  ineligibleReason?: string;
}

// Why this attestation cannot establish the buyer's class right now, or
// undefined when it can. The stored record must still name the exact
// subject and class it was looked up for — a record passed for the wrong
// pair is a mismatch, not a miss.
export function attestationProblem(
  a: EligibilityAttestation,
  subjectId: string,
  classId: string,
  now: number,
): string | undefined {
  if (a.subjectId !== subjectId) return 'attestation_subject_mismatch';
  if (a.classId !== classId) return 'attestation_class_mismatch';
  if (a.revoked) return 'attestation_revoked';
  if (now < a.validFrom || now > a.validUntil) return 'attestation_expired';
  return undefined;
}

// Why this allowance cannot fund the purchase right now, or undefined when
// it can. Checked both at proposal selection and again at fixed-reference
// rechecks.
export function allowanceProblem(
  a: AllowanceMandate,
  merchantId: string,
  buyerId: string,
  beneficiaryClass: string,
  now: number,
): string | undefined {
  if (a.privacyProfile !== 'anonymous_donation_v1') return 'allowance_privacy_profile_invalid';
  if (a.revoked) return 'allowance_revoked';
  if (now < a.validFrom || now > a.validUntil) return 'allowance_expired';
  if (a.beneficiaryClass !== beneficiaryClass) return 'beneficiary_class_mismatch';
  if (a.donorId === buyerId) return 'donor_is_buyer';
  if (!a.eligibleMerchants.includes(merchantId)) return 'merchant_not_eligible';
  return undefined;
}

// The donor's contribution for one candidate allowance — the same
// calculation the coordinator uses for a fixed-reference admission
// recheck. The buyer's remainder is total minus donor; nothing about the
// donor's answer changes the total owed or silently authorizes the buyer.
export function evaluateAllowance(input: AllowanceInput): AllowanceResult {
  const problem =
    attestationProblem(input.attestation, input.buyerId, input.beneficiaryClass, input.now) ??
    allowanceProblem(input.allowance, input.merchantId, input.buyerId, input.beneficiaryClass, input.now);
  // A missing or malformed daily purchase limit fails closed, as if the
  // allowance permitted no sponsored purchases at all.
  const maxPurchases = Number.isInteger(input.allowance.maxPurchasesPerDay) ? input.allowance.maxPurchasesPerDay : 0;
  const limitReached = input.usage.daily.purchases >= maxPurchases;
  const daily = Math.max(0, input.allowance.maxPerDayCents - input.usage.daily.cents);
  const lifetime =
    input.allowance.totalEndowmentCents === undefined
      ? input.totalCents
      : Math.max(0, input.allowance.totalEndowmentCents - input.usage.lifetime.cents);
  // The donor share is the tightest of the per-purchase cap, the remaining
  // daily budget, the remaining endowment and the purchase total. A term
  // problem or a used-up daily purchase count zeroes it rather than
  // falling back to a partial contribution.
  const donorCents =
    problem || limitReached
      ? 0
      : Math.min(input.totalCents, input.allowance.maxPerPurchaseCents, daily, lifetime);
  const buyerCents = input.totalCents - donorCents;
  return {
    donorCents,
    buyerCents,
    ineligibleReason:
      problem ??
      (limitReached
        ? 'daily_purchase_limit_reached'
        : donorCents === 0
          ? daily === 0
            ? 'daily_cap_used'
            : lifetime === 0
              ? 'lifetime_cap_used'
              : 'allowance_cap_used'
          : undefined),
  };
}

// Among candidate inputs, pick the one giving the greatest positive donor
// contribution; equal contributions resolve to the smallest reference in
// code-unit order, so the answer does not depend on input order. No
// positive candidate means zero donor contribution — the purchase falls
// back to buyer-only terms, never an implicit buyer authorization.
export function selectAllowance(inputs: readonly AllowanceInput[]): AllowanceSelection {
  let best: AllowanceSelection | undefined;
  for (const input of inputs) {
    const r = evaluateAllowance(input);
    if (r.donorCents <= 0) continue;
    if (
      best === undefined ||
      r.donorCents > best.donorCents ||
      (r.donorCents === best.donorCents && input.allowance.allowanceRef < best.allowanceRef!)
    ) {
      best = { allowanceRef: input.allowance.allowanceRef, donorCents: r.donorCents };
    }
  }
  return best ?? { donorCents: 0, ineligibleReason: 'no_eligible_allowance' };
}
