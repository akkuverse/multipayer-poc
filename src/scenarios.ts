// Synthetic fixtures and the scenario set. Every actor, account and amount is
// synthetic. Reference purchase: EUR 13 lunch = EUR 8 employee + EUR 5 employer.

import type { Account } from './mock-backend.ts';
import { FEE_COLLECTOR, MockBackend } from './mock-backend.ts';
import { Coordinator } from './coordinator.ts';
import { Trace } from './trace.ts';
import type { EmployerMandate, Purchase } from './types.ts';

export const EMPLOYEE = 'employee-1';
export const EMPLOYER = 'employer-1';
export const MERCHANT_A = 'merchant-a';
export const MERCHANT_B = 'merchant-b';
export const MERCHANT_C = 'merchant-c';

// Illustrative only: the ECB has not fixed an individual holding limit.
export const HOLDING_LIMIT = 300_000;

// 2026 German lunch benefit ceiling: Sachbezugswert EUR 4.57 + EUR 3.10.
export const DAILY_BENEFIT_CAP = 767;

export interface World {
  trace: Trace;
  backend: MockBackend;
  coordinator: Coordinator;
  mandate: EmployerMandate;
}

// Build an isolated fixture: a fresh trace, backend and coordinator per call.
// Defaults are the reference lunch world; each scenario overrides one account
// field or mandate term to create its failure condition.
export function world(employee: Partial<Account> = {}, mandate: Partial<EmployerMandate> = {}): World {
  const trace = new Trace();
  const backend = new MockBackend(trace);
  // Employee: EUR 20 in digital euro and EUR 500 in the linked bank account,
  // with reverse waterfall so a share larger than holdings can still be funded.
  backend.addAccount({
    id: EMPLOYEE,
    kind: 'individual',
    deCents: 2_000,
    holdingLimitCents: HOLDING_LIMIT,
    linkedBankCents: 50_000,
    reverseWaterfall: true,
    ...employee,
  });
  // Businesses hold no digital euro: zero holding limit, mandatory reverse waterfall.
  for (const id of [EMPLOYER, MERCHANT_A, MERCHANT_B, MERCHANT_C, FEE_COLLECTOR]) {
    backend.addAccount({
      id,
      kind: 'business',
      deCents: 0,
      holdingLimitCents: 0,
      // The employer funds its EUR 5 share entirely from its bank account via
      // reverse waterfall; merchants start empty and receive straight to bank.
      linkedBankCents: id === EMPLOYER ? 100_000 : 0,
      reverseWaterfall: true,
    });
  }
  // Default mandate: up to EUR 5 per purchase within the EUR 7.67 daily cap,
  // at any of the three merchants, valid for the whole scenario clock.
  const m: EmployerMandate = {
    mandateRef: 'mandate-1',
    employerId: EMPLOYER,
    beneficiaryRef: EMPLOYEE,
    maxPerPurchaseCents: 500,
    maxPerDayCents: DAILY_BENEFIT_CAP,
    eligibleMerchants: [MERCHANT_A, MERCHANT_B, MERCHANT_C],
    validFrom: 0,
    validUntil: 1_000,
    revoked: false,
    ...mandate,
  };
  // The coordinator clock starts at t=10 so scenarios can expire authority by
  // advancing it (see S06).
  return { trace, backend, coordinator: new Coordinator(backend, 10), mandate: m };
}

// The employer changes its mandate terms (cap, beneficiary, revocation). Tests
// and scenarios go through this helper so that how mandates are issued can
// change in one place. Works by shared identity: Purchase.mandate holds the
// same object as w.mandate.
export function updateMandate(w: World, changes: Partial<EmployerMandate>): void {
  Object.assign(w.mandate, changes);
}

// The reference purchase: a EUR 13 lunch at merchant-a with the employee's
// standing instruction capped at EUR 8 — which is what makes the split
// EUR 8 employee + EUR 5 employer.
export function lunch(w: World, total = 1_300, merchantId = MERCHANT_A, extra: { usedTodayCents?: number; feesCents?: number } = {}): Purchase {
  return w.coordinator.propose({
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    employeeMaxCents: 800,
    merchantId,
    totalCents: total,
    mandate: w.mandate,
    expiresAt: 100,
    ...extra,
  });
}

// Each run() builds a fresh world, drives one purchase through its success or
// failure path, and returns both so the CLI can print the trace and tests can
// assert on final balances.
export interface Scenario {
  id: string;
  title: string;
  run: () => { w: World; p: Purchase };
}

export const scenarios: Scenario[] = [
  {
    id: 'S01-both-approve',
    title: 'Both authorities hold: EUR 8 + EUR 5 settle as one transaction',
    run: () => {
      const w = world();
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S02-employee-reverse-waterfall',
    title: 'Employee holds EUR 3; reverse waterfall funds the rest of the EUR 8 share',
    run: () => {
      // EUR 3 in holdings: the remaining EUR 5 of the employee share is pulled
      // from the linked bank account by the reverse waterfall.
      const w = world({ deCents: 300 });
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S03-partial-failure-independent',
    title: 'Two-payment baseline: employer leg settles, employee leg fails, recovery returns EUR 5',
    run: () => {
      // EUR 3 in holdings and no reverse waterfall: the employee leg cannot
      // fund its EUR 8 share, but the employer leg still settles.
      const w = world({ deCents: 300, reverseWaterfall: false });
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      w.coordinator.submit(p, 'independent');
      w.coordinator.recover(p);
      return { w, p };
    },
  },
  {
    id: 'S04-partial-failure-atomic',
    title: 'Same failure with atomic multi-payer settlement: nothing moves, no recovery needed',
    run: () => {
      // Same funding hole as S03; the settlement mode is the only difference.
      const w = world({ deCents: 300, reverseWaterfall: false });
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S05-recovery-unsupported',
    title: 'Partial failure where returns are unsupported: outstanding EUR 5 stays visible',
    run: () => {
      // Same failure as S03, on a backend that has no return operation.
      const w = world({ deCents: 300, reverseWaterfall: false });
      w.backend.refundsSupported = false;
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      w.coordinator.submit(p, 'independent');
      w.coordinator.recover(p);
      return { w, p };
    },
  },
  {
    id: 'S06-employer-authority-expired',
    title: 'Employer mandate expires between approval and initiation: no leg executes, EUR 8 share unchanged',
    run: () => {
      // The mandate is valid only until t=15.
      const w = world({}, { validUntil: 15 });
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      // t=20: authority expired between approval and initiation.
      w.coordinator.now = 20;
      w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S07-offer-changed',
    title: 'Offer A expires; B costs EUR 14 (EUR 9 personal) so approval lapses; employee picks C at EUR 13',
    run: () => {
      const w = world();
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      // Offer B costs EUR 14: the employer still contributes EUR 5, so EUR 9
      // would fall to the employee — above their EUR 8 instruction. Repricing
      // invalidates the v1 approval and the purchase stays in draft.
      w.coordinator.changeOffer(p, { merchantId: MERCHANT_B, totalCents: 1_400, expiresAt: 100 });
      // The employee picks offer C at EUR 13 instead and re-approves v3.
      w.coordinator.changeOffer(p, { merchantId: MERCHANT_C, totalCents: 1_300, expiresAt: 100 });
      w.coordinator.approveCurrent(p);
      w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S08-duplicate-request',
    title: 'Submission retried with the same keys: no duplicate execution',
    run: () => {
      const w = world();
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      w.coordinator.submit(p, 'atomic');
      // Same idempotency keys: the backend dedupes and still runs exactly one
      // execution per leg.
      w.coordinator.resubmit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S09-timeout-unknown',
    title: 'Response lost: purchase stays pending, retry is deduplicated, status query resolves it',
    run: () => {
      const w = world();
      // The employer leg's response is lost; the submission returns 'unknown'.
      w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      w.coordinator.submit(p, 'atomic');
      w.coordinator.resubmit(p, 'atomic');
      w.coordinator.reconcile(p);
      return { w, p };
    },
  },
  {
    id: 'S10-refund-holding-limit',
    title: 'Full refund: EUR 8 to employee (excess over holding limit waterfalls to bank), EUR 5 to employer',
    run: () => {
      const w = world({ deCents: 299_800 });
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      w.coordinator.submit(p, 'atomic');
      // Other payments leave the employee at EUR 2,999 of the EUR 3,000
      // holding limit: of the EUR 8 refund only EUR 1 fits in holdings and
      // EUR 7 waterfalls to the bank.
      w.backend.account(EMPLOYEE).deCents = 299_900;
      w.coordinator.refund(p);
      return { w, p };
    },
  },
  {
    id: 'S11-daily-cap',
    title: 'Benefit already partly used today: employer share falls to EUR 2.67, employee share exceeds instruction',
    run: () => {
      const w = world();
      // EUR 5 of the EUR 7.67 daily cap is already spent, leaving EUR 2.67 for
      // the employer; the employee share becomes EUR 10.33, above the EUR 8
      // instruction, so the purchase cannot leave draft.
      const p = lunch(w, 1_300, MERCHANT_A, { usedTodayCents: 500 });
      return { w, p };
    },
  },
  {
    id: 'S12-employer-declines',
    title: "Employer's PSP declines its leg: atomic group rejected, employee is not charged EUR 13",
    run: () => {
      const w = world();
      // The employer's PSP declines its leg; atomic mode must reject both legs
      // together rather than charge the employee alone.
      w.backend.faults.set(EMPLOYER, 'decline');
      const p = lunch(w);
      w.coordinator.approveCurrent(p);
      w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
];
