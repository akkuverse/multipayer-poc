// Deterministic benefit evaluation. No AI and no payment side effects: it only
// decides eligibility and amounts. Conditions live here, in the application,
// never in the money itself.

import type { Cents, EmployerMandate } from './types.ts';

export interface BenefitInput {
  totalCents: Cents;
  merchantId: string;
  mandate: EmployerMandate;
  // Injectable clock so every evaluation is deterministic and replayable.
  now: number;
  // Employer benefit already consumed today. Caller-supplied and never updated
  // by this module (backlog B2: needs a per-mandate usage ledger).
  usedTodayCents: Cents;
  // The employee's standing instruction; their share may not exceed it.
  employeeMaxCents: Cents;
}

export interface BenefitResult {
  employerCents: Cents;
  employeeCents: Cents;
  // False when the employee's share would exceed their own instruction.
  withinInstruction: boolean;
  // Why the employer contributes nothing, if it does not.
  ineligibleReason?: string;
}

// Why the mandate cannot fund this merchant right now, or undefined when it
// can. Checked both at proposal time and again at initiation.
// (Backlog B3: beneficiaryRef is not checked.)
export function mandateProblem(m: EmployerMandate, merchantId: string, now: number): string | undefined {
  if (m.revoked) return 'mandate_revoked';
  if (now < m.validFrom || now > m.validUntil) return 'mandate_expired';
  if (!m.eligibleMerchants.includes(merchantId)) return 'merchant_not_eligible';
  return undefined;
}

export function evaluateBenefit(input: BenefitInput): BenefitResult {
  const problem = mandateProblem(input.mandate, input.merchantId, input.now);
  const remainingToday = Math.max(0, input.mandate.maxPerDayCents - input.usedTodayCents);
  // The employer share is the tightest of the per-purchase cap, the remaining
  // daily budget and the purchase total. A mandate problem zeroes it entirely
  // rather than falling back to a partial contribution.
  const employerCents = problem
    ? 0
    : Math.min(input.mandate.maxPerPurchaseCents, remainingToday, input.totalCents);
  // The employee always covers the remainder; nothing about the employer's
  // answer changes the total owed.
  const employeeCents = input.totalCents - employerCents;
  return {
    employerCents,
    employeeCents,
    // False leaves the purchase in draft: the decision to pay more belongs to
    // the employee, not to this function.
    withinInstruction: employeeCents <= input.employeeMaxCents,
    // Distinguish "mandate unusable" from "mandate fine but budget spent".
    ineligibleReason: problem ?? (employerCents === 0 ? 'daily_cap_used' : undefined),
  };
}
