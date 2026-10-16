// Synthetic fixtures and the scenario set. Every actor, account and amount is
// synthetic. Reference purchase: EUR 13 lunch = EUR 8 employee + EUR 5 employer.

import type { Account } from './settlement/mock-backend.ts';
import { FEE_COLLECTOR, MockBackend } from './settlement/mock-backend.ts';
import { Coordinator, approvalCents, approvalFeeCents, shareCents } from './core/coordinator.ts';
import { equalShares } from './core/policy.ts';
import { SimulatedPsp } from './settlement/psp.ts';
import { keyPairFromSeed, signPayload } from './core/signing.ts';
import type { KeyPair, Signed } from './core/signing.ts';
import { MandateRegistry } from './core/authority.ts';
import { Trace } from './evidence/trace.ts';
import type { EmployerMandate, PayerApproval, Purchase, PurchaseState } from './core/types.ts';

export const EMPLOYEE = 'employee-1';
export const EMPLOYER = 'employer-1';
export const MERCHANT_A = 'merchant-a';
export const MERCHANT_B = 'merchant-b';
export const MERCHANT_C = 'merchant-c';
export const COLLEAGUE_1 = 'colleague-1';
export const COLLEAGUE_2 = 'colleague-2';
// Delivery platform: the second payee in the multi-payee scenario.
export const PLATFORM = 'platform-1';

// Bump whenever a fixture value below changes, so recorded runs say which
// fixtures produced them.
export const FIXTURE_VERSION = '2026.10-3';

// Illustrative only: the ECB has not fixed an individual holding limit.
export const HOLDING_LIMIT = 300_000;

// 2026 German ceiling per subsidised meal (Sachbezugswert EUR 4.57 + EUR 3.10),
// one meal per working day. Pending tax/legal confirmation (see backlog).
export const MEAL_BENEFIT_CAP = 767;

// Minutes the backend waits for every PSP's leg of an atomic group.
export const ASSEMBLY_WINDOW = 5;

export interface WorldOptions {
  // 'coordinator' (default): one call with every leg. 'per_payer_psp': each
  // payer's PSP submits its own leg.
  initiation?: 'coordinator' | 'per_payer_psp';
}

export interface World {
  trace: Trace;
  backend: MockBackend;
  coordinator: Coordinator;
  mandate: EmployerMandate;
  psps: Map<string, SimulatedPsp>;
  // Public keys as the coordinator's registry sees them, bound to holders.
  keys: Map<string, { publicKey: KeyPair['publicKey']; holder: string }>;
  // Private keys stay with their holders: one signer per payer and employer.
  signers: Map<string, KeyPair>;
  mandates: MandateRegistry;
}

// Build an isolated fixture: a fresh trace, backend and coordinator per call.
// Defaults are the reference lunch world; each scenario overrides one account
// field or mandate term to create its failure condition.
export function world(employee: Partial<Account> = {}, mandate: Partial<EmployerMandate> = {}, opts: WorldOptions = {}): World {
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
  // Colleagues for split purchases: same funding as the default employee.
  for (const id of [COLLEAGUE_1, COLLEAGUE_2]) {
    backend.addAccount({ id, kind: 'individual', deCents: 2_000, holdingLimitCents: HOLDING_LIMIT, linkedBankCents: 50_000, reverseWaterfall: true });
  }
  // Businesses hold no digital euro: zero holding limit, mandatory reverse waterfall.
  for (const id of [EMPLOYER, MERCHANT_A, MERCHANT_B, MERCHANT_C, PLATFORM, FEE_COLLECTOR]) {
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
  // Default mandate: up to EUR 5 per purchase, one subsidised meal per day, at
  // any of the three merchants, valid for the whole scenario clock.
  const m: EmployerMandate = {
    mandateRef: 'mandate-1',
    employerId: EMPLOYER,
    beneficiaryRef: EMPLOYEE,
    maxPerPurchaseCents: 500,
    maxPerDayCents: MEAL_BENEFIT_CAP,
    maxPurchasesPerDay: 1,
    eligibleMerchants: [MERCHANT_A, MERCHANT_B, MERCHANT_C],
    validFrom: 0,
    validUntil: 1_000,
    revoked: false,
    ...mandate,
  };
  // Synthetic signing keys from fixed seeds, one per payer and the employer.
  // Private keys stay with their holder (the device); the coordinator only
  // sees the public half, bound to its holder in the key registry.
  const signers = new Map<string, KeyPair>();
  const keys = new Map<string, { publicKey: KeyPair['publicKey']; holder: string }>();
  for (const id of [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2, EMPLOYER]) {
    const k = keyPairFromSeed(`key-${id}`, `synthetic-seed-${id}`);
    signers.set(id, k);
    keys.set(k.keyId, { publicKey: k.publicKey, holder: id });
  }
  const mandates = new MandateRegistry();
  mandates.publish(signPayload(m, signers.get(EMPLOYER)!));
  const psps = new Map<string, SimulatedPsp>();
  if (opts.initiation === 'per_payer_psp') {
    for (const id of [EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2]) psps.set(id, new SimulatedPsp(`psp-${id}`, backend, trace));
  }
  // The coordinator and backend clocks start at t=10 so scenarios can expire
  // authority or assembly deadlines by advancing them (see S06, S17).
  backend.now = 10;
  const coordinator = new Coordinator(backend, trace, {
    now: 10,
    keys,
    mandates,
    initiation: psps.size > 0
      ? {
          // A payer with no simulated PSP is a fixture bug; fail loudly.
          pspFor: (id) => {
            const psp = psps.get(id);
            if (!psp) throw new Error(`no PSP for payer ${id}`);
            return psp;
          },
          assemblyWindow: ASSEMBLY_WINDOW,
        }
      : undefined,
  });
  return { trace, backend, coordinator, mandate: m, psps, keys, signers, mandates };
}

// The employer changes its mandate terms (cap, beneficiary, revocation) by
// signing and publishing a new version.
export function updateMandate(w: World, changes: Partial<EmployerMandate>): void {
  w.mandate = { ...w.mandate, ...changes };
  w.mandates.publish(signPayload(w.mandate, w.signers.get(EMPLOYER)!));
}

// The payer approves exactly the terms shown to them and signs on their own
// device. A payer without a registered key signs with an unregistered one,
// which the coordinator rejects.
export function approveAs(w: Pick<World, 'coordinator' | 'signers'>, p: Purchase, payerId = EMPLOYEE): Signed<PayerApproval> {
  const q = p.proposal;
  const a: PayerApproval = {
    approvalRef: `appr-${p.purchaseId}-v${q.version}-${payerId}`,
    purchaseId: p.purchaseId,
    payerId,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, payerId),
    feeCents: approvalFeeCents(q, payerId),
    expiresAt: q.expiresAt,
  };
  const key = w.signers.get(payerId) ?? keyPairFromSeed(`unregistered-${payerId}`, payerId);
  const signed = signPayload(a, key);
  w.coordinator.approve(p, signed);
  return signed;
}

// Move both clocks together.
export function advance(w: World, t: number): void {
  w.coordinator.now = t;
  w.backend.now = t;
}

// The reference purchase: a EUR 13 lunch at merchant-a with the employee's
// standing instruction capped at EUR 8 — which is what makes the split
// EUR 8 employee + EUR 5 employer.
export function lunch(
  w: World,
  total = 1_300,
  merchantId = MERCHANT_A,
  opts: { purchaseId?: string; expiresAt?: number; feesCents?: number } = {},
): Purchase {
  return w.coordinator.propose({
    purchaseId: opts.purchaseId ?? 'purchase-1',
    employeeId: EMPLOYEE,
    employeeMaxCents: 800,
    merchantId,
    totalCents: total,
    feesCents: opts.feesCents,
    mandateRef: w.mandate.mandateRef,
    expiresAt: opts.expiresAt ?? 100,
  });
}

// The research questions of docs/experiment-protocol.md.
export const QUESTIONS = {
  Q1: 'Unambiguous completion state',
  Q2: 'One contribution fails, expires or loses authority',
  Q3: 'References for reconciliation and returns',
} as const;
export type QuestionId = keyof typeof QUESTIONS;

// Each run() builds a fresh world, drives one purchase through its success or
// failure path, and returns both so the CLI can print the trace and tests can
// assert on final balances. check() states the observation the scenario must
// show; the findings table reports it as observed/pass or observed/fail.
export interface Scenario {
  id: string;
  title: string;
  question: QuestionId;
  // What application code had to do, as shown by the local run.
  responsibility: string;
  check: (r: { w: World; p: Purchase }) => string | undefined;
  run: () => Promise<{ w: World; p: Purchase }>;
}

export const expectState = (p: Purchase, state: PurchaseState): string | undefined =>
  p.state === state ? undefined : `state ${p.state}, expected ${state}`;
const stateHistory = (w: World): unknown[] => w.trace.events.filter((e) => e.event === 'state').map((e) => e.detail?.to);

export const scenarios: Scenario[] = [
  {
    id: 'S01-both-approve',
    title: 'Both authorities hold: EUR 8 + EUR 5 settle as one transaction',
    question: 'Q1',
    responsibility: 'Bind the approval to the proposal version; derive completion only from every leg settled',
    check: ({ p }) => expectState(p, 'completed'),
    run: async () => {
      const w = world();
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S02-employee-reverse-waterfall',
    title: 'Employee holds EUR 3; reverse waterfall funds the rest of the EUR 8 share',
    question: 'Q1',
    responsibility: 'None beyond S01: the reverse waterfall is a backend funding feature',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (w.trace.events.some((e) => e.event === 'reverse_waterfall' && e.detail?.account === EMPLOYEE) ? undefined : 'no reverse waterfall'),
    run: async () => {
      // EUR 3 in holdings: the remaining EUR 5 of the employee share is pulled
      // from the linked bank account by the reverse waterfall.
      const w = world({ deCents: 300 });
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S03-partial-failure-independent',
    title: 'Two-payment baseline: employer leg settles, employee leg fails, recovery returns EUR 5',
    question: 'Q2',
    responsibility: 'Detect partial success, keep the EUR 5 outstanding visible, return it to the employer before cancelling',
    check: ({ w, p }) => expectState(p, 'cancelled') ?? (stateHistory(w).includes('recovery_required') ? undefined : 'never entered recovery'),
    run: async () => {
      // EUR 3 in holdings and no reverse waterfall: the employee leg cannot
      // fund its EUR 8 share, but the employer leg still settles.
      const w = world({ deCents: 300, reverseWaterfall: false });
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'independent');
      await w.coordinator.recover(p);
      return { w, p };
    },
  },
  {
    id: 'S04-partial-failure-atomic',
    title: 'Same failure with atomic multi-payer settlement: nothing moves, no recovery needed',
    question: 'Q2',
    responsibility: 'None: atomic settlement leaves nothing committed to recover',
    check: ({ w, p }) => expectState(p, 'failed') ?? (w.coordinator.outstandingCents(p) === 0 ? undefined : 'money outstanding'),
    run: async () => {
      // Same funding hole as S03; the settlement mode is the only difference.
      const w = world({ deCents: 300, reverseWaterfall: false });
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S05-recovery-unsupported',
    title: 'Partial failure where returns are unsupported: outstanding EUR 5 stays visible',
    question: 'Q2',
    responsibility: 'Keep the purchase in recovery with the outstanding amount visible when no return operation exists',
    check: ({ w, p }) => expectState(p, 'recovery_required') ?? (w.coordinator.outstandingCents(p) === 500 ? undefined : 'outstanding is not EUR 5'),
    run: async () => {
      // Same failure as S03, on a backend that has no return operation.
      const w = world({ deCents: 300, reverseWaterfall: false });
      w.backend.refundsSupported = false;
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'independent');
      await w.coordinator.recover(p);
      return { w, p };
    },
  },
  {
    id: 'S06-employer-authority-expired',
    title: 'Employer mandate expires between approval and initiation: no leg executes, EUR 8 share unchanged',
    question: 'Q2',
    responsibility: 'Recheck employer authority at initiation and stop without raising the employee share',
    check: ({ w, p }) =>
      expectState(p, 'failed') ??
      (w.backend.executionCount() === 0 && shareCents(p.proposal, 'employee') === 800 ? undefined : 'executed or share changed'),
    run: async () => {
      // The mandate is valid only until t=15.
      const w = world({}, { validUntil: 15 });
      const p = lunch(w);
      approveAs(w, p);
      // t=20: authority expired between approval and initiation.
      w.coordinator.now = 20;
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S07-offer-changed',
    title: 'Offer A expires; B costs EUR 14 (EUR 9 personal) so approval lapses; employee picks C at EUR 13',
    question: 'Q2',
    responsibility: 'Version proposals, invalidate approvals on any change, require renewed approval',
    check: ({ p }) => expectState(p, 'completed') ?? (p.proposal.version === 3 ? undefined : `version ${p.proposal.version}`),
    run: async () => {
      const w = world();
      const p = lunch(w);
      approveAs(w, p);
      // Offer B costs EUR 14: the employer still contributes EUR 5, so EUR 9
      // would fall to the employee — above their EUR 8 instruction. Repricing
      // invalidates the v1 approval and the purchase stays in draft.
      w.coordinator.changeOffer(p, { merchantId: MERCHANT_B, totalCents: 1_400, expiresAt: 100 });
      // The employee picks offer C at EUR 13 instead and re-approves v3.
      w.coordinator.changeOffer(p, { merchantId: MERCHANT_C, totalCents: 1_300, expiresAt: 100 });
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S08-duplicate-request',
    title: 'Submission retried with the same keys: no duplicate execution',
    question: 'Q3',
    responsibility: 'Keep idempotency keys stable across retries; never mint new keys to retry',
    check: ({ w, p }) => expectState(p, 'completed') ?? (w.backend.executionCount() === 2 ? undefined : 'duplicate execution'),
    run: async () => {
      const w = world();
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      // Same idempotency keys: the backend dedupes and still runs exactly one
      // execution per leg.
      await w.coordinator.resubmit(p);
      return { w, p };
    },
  },
  {
    id: 'S09-timeout-unknown',
    title: 'Response lost: purchase stays pending, retry is deduplicated, status query resolves it',
    question: 'Q3',
    responsibility: 'Treat a lost response as pending; resolve it only through status queries',
    check: ({ w, p }) => expectState(p, 'completed') ?? (stateHistory(w)[0] === 'pending' ? undefined : 'not pending first'),
    run: async () => {
      const w = world();
      // The employer leg's response is lost; the submission returns 'unknown'.
      w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      await w.coordinator.resubmit(p);
      await w.coordinator.reconcile(p);
      return { w, p };
    },
  },
  {
    id: 'S10-refund-holding-limit',
    title: 'Full refund: EUR 8 to employee (excess over holding limit waterfalls to bank), EUR 5 to employer',
    question: 'Q3',
    responsibility: 'Keep one execution reference per contribution to return each share to its own payer',
    check: ({ p }) => (p.returnStatus === 'completed' ? undefined : `returns ${p.returnStatus}`),
    run: async () => {
      const w = world({ deCents: 299_800 });
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      // Other payments leave the employee at EUR 2,999 of the EUR 3,000
      // holding limit: of the EUR 8 refund only EUR 1 fits in holdings and
      // EUR 7 waterfalls to the bank.
      w.backend.account(EMPLOYEE).deCents = 299_900;
      await w.coordinator.refund(p);
      return { w, p };
    },
  },
  {
    id: 'S11-second-meal-same-day',
    title: 'Second lunch on the same working day: no employer share, employee share exceeds instruction',
    question: 'Q2',
    responsibility: 'Track benefit use per mandate and day; leave the decision to pay more with the employee',
    check: ({ p }) => expectState(p, 'draft') ?? (shareCents(p.proposal, 'employer') === 0 ? undefined : 'employer still contributes'),
    run: async () => {
      const w = world();
      // The first lunch completes and uses the day's subsidised meal.
      const first = lunch(w);
      approveAs(w, first);
      await w.coordinator.submit(first, 'atomic');
      // A second lunch the same day gets no employer share; EUR 13 is above
      // the EUR 8 instruction, so it stays in draft.
      const p = lunch(w, 1_300, MERCHANT_A, { purchaseId: 'purchase-2' });
      return { w, p };
    },
  },
  {
    id: 'S12-employer-declines',
    title: "Employer's PSP declines its leg: atomic group rejected, employee is not charged EUR 13",
    question: 'Q2',
    responsibility: 'Never re-split a declined employer share onto the employee',
    check: ({ w, p }) => expectState(p, 'failed') ?? (w.backend.account(EMPLOYEE).deCents === 2_000 ? undefined : 'employee charged'),
    run: async () => {
      const w = world();
      // The employer's PSP declines its leg; atomic mode must reject both legs
      // together rather than charge the employee alone.
      w.backend.faults.set(EMPLOYER, 'decline');
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S13-bill-split',
    title: 'Three colleagues split a EUR 40 dinner: EUR 13.34 + 13.33 + 13.33 settle as one transaction',
    question: 'Q1',
    responsibility: 'Split in integer cents with a fixed remainder rule; complete only when every payer approved and every leg settled',
    check: ({ p }) => expectState(p, 'completed'),
    run: async () => {
      const w = world();
      const payers = [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2];
      const amounts = equalShares(4_000, payers.length);
      const p = w.coordinator.proposeSplit({
        purchaseId: 'purchase-1',
        merchantId: MERCHANT_B,
        expiresAt: 100,
        shares: payers.map((payerId, i) => ({ role: `diner-${i + 1}`, payerId, amountCents: amounts[i] })),
      });
      for (const id of payers) approveAs(w, p, id);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S14-group-gift-decline',
    title: "Group gift EUR 25: one colleague's PSP declines; the atomic group is rejected and nobody covers the missing EUR 5",
    question: 'Q2',
    responsibility: 'Never re-split a declined share across the remaining payers; a new split needs a new proposal and approvals',
    check: ({ w, p }) =>
      expectState(p, 'failed') ??
      (w.backend.account(EMPLOYEE).deCents === 2_000 && w.backend.account(COLLEAGUE_1).deCents === 2_000 ? undefined : 'a remaining payer was charged'),
    run: async () => {
      const w = world();
      w.backend.faults.set(COLLEAGUE_2, 'decline');
      const givers = [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2];
      const p = w.coordinator.proposeSplit({
        purchaseId: 'purchase-1',
        merchantId: MERCHANT_C,
        expiresAt: 100,
        shares: [
          { role: 'giver-1', payerId: EMPLOYEE, amountCents: 1_000 },
          { role: 'giver-2', payerId: COLLEAGUE_1, amountCents: 1_000 },
          { role: 'giver-3', payerId: COLLEAGUE_2, amountCents: 500 },
        ],
      });
      for (const id of givers) approveAs(w, p, id);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S15-multi-payee',
    title: 'One payer, two payees: a EUR 15 order pays EUR 12.50 to the restaurant and EUR 2.50 to the delivery platform',
    question: 'Q3',
    responsibility: 'Approve one total; keep one execution reference per payee leg so each can be reconciled and returned on its own',
    check: ({ w, p }) => expectState(p, 'completed') ?? (w.backend.account(PLATFORM).linkedBankCents === 250 ? undefined : 'platform not paid'),
    run: async () => {
      const w = world();
      const p = w.coordinator.proposeSplit({
        purchaseId: 'purchase-1',
        merchantId: MERCHANT_A,
        expiresAt: 100,
        shares: [
          { role: 'restaurant', payerId: EMPLOYEE, payeeId: MERCHANT_A, amountCents: 1_250 },
          { role: 'delivery', payerId: EMPLOYEE, payeeId: PLATFORM, amountCents: 250 },
        ],
      });
      approveAs(w, p, EMPLOYEE);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S16-per-psp-atomic',
    title: "Each payer's PSP submits its own leg; the backend assembles the atomic group; the first PSP learns completion by status query",
    question: 'Q1',
    responsibility: 'Expect early submitters to see an unknown outcome; reconcile every leg through its own PSP before reporting completion',
    check: ({ w, p }) => expectState(p, 'completed') ?? (stateHistory(w)[0] === 'pending' ? undefined : 'not pending first'),
    run: async () => {
      const w = world({}, {}, { initiation: 'per_payer_psp' });
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      await w.coordinator.reconcile(p);
      return { w, p };
    },
  },
  {
    id: 'S17-per-psp-employer-psp-down',
    title: "Employer's PSP is unavailable: the employee leg waits in the group, the deadline passes, nothing settles",
    question: 'Q2',
    responsibility: 'Wait for the assembly deadline instead of charging the employee alone; treat the expired group as failed with nothing committed',
    check: ({ w, p }) => expectState(p, 'failed') ?? (w.backend.account(EMPLOYEE).deCents === 2_000 ? undefined : 'employee charged'),
    run: async () => {
      const w = world({}, {}, { initiation: 'per_payer_psp' });
      w.psps.get(EMPLOYER)!.available = false;
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      advance(w, 10 + ASSEMBLY_WINDOW + 1);
      await w.coordinator.reconcile(p);
      return { w, p };
    },
  },
  {
    id: 'S18-per-psp-independent-down',
    title: "Two-payment baseline with the employer's PSP unavailable: the employee's EUR 8 settles alone and is returned",
    question: 'Q2',
    responsibility: 'Return the settled employee leg; never ask the employee to cover the employer share',
    check: ({ w, p }) =>
      expectState(p, 'cancelled') ??
      (stateHistory(w).includes('recovery_required') && w.backend.account(EMPLOYEE).deCents === 2_000 ? undefined : 'employee not made whole'),
    run: async () => {
      const w = world({}, {}, { initiation: 'per_payer_psp' });
      w.psps.get(EMPLOYER)!.available = false;
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'independent');
      await w.coordinator.recover(p);
      return { w, p };
    },
  },
];
