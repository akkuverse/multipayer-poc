// Deterministic benefit evaluation. No AI and no payment side effects: it only
// decides eligibility and amounts. Conditions live here, in the application,
// never in the money itself.

import type { Cents, EmployerMandate } from './types.ts';

export interface BenefitInput {
  totalCents: Cents;
  merchantId: string;
  mandate: EmployerMandate;
  now: number;
  usedTodayCents: Cents;
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

export function mandateProblem(m: EmployerMandate, merchantId: string, now: number): string | undefined {
  if (m.revoked) return 'mandate_revoked';
  if (now < m.validFrom || now > m.validUntil) return 'mandate_expired';
  if (!m.eligibleMerchants.includes(merchantId)) return 'merchant_not_eligible';
  return undefined;
}

export function evaluateBenefit(input: BenefitInput): BenefitResult {
  const problem = mandateProblem(input.mandate, input.merchantId, input.now);
  const remainingToday = Math.max(0, input.mandate.maxPerDayCents - input.usedTodayCents);
  const employerCents = problem
    ? 0
    : Math.min(input.mandate.maxPerPurchaseCents, remainingToday, input.totalCents);
  const employeeCents = input.totalCents - employerCents;
  return {
    employerCents,
    employeeCents,
    withinInstruction: employeeCents <= input.employeeMaxCents,
    ineligibleReason: problem ?? (employerCents === 0 ? 'daily_cap_used' : undefined),
  };
}
