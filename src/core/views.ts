// What each party may see of a purchase: projections, not copies. Every field
// here is one its recipient needs (docs/field-map.md). The employer sees its
// own contribution and the merchant it went to, never the purchase total or
// the employee's share; a payee sees what it received, not who paid it.

import type { AuthZone, Authorization, AutoPayBlockedReason, Cents, DeepReadonly, DisputeOutcome, LegStatus, PurchaseState, PurchaseView, ReturnStatus } from './types.ts';

// Which payer an authorization record belongs to.
const authorizationPayer = (a: DeepReadonly<Authorization>): string => (a.basis === 'mandate' ? a.payerId : a.approval.payload.payerId);

export interface PayerView {
  purchaseId: string;
  state: PurchaseState;
  merchantId: string;
  totalCents: Cents;
  ownCents: Cents;
  // Payer fees on top of the own share.
  ownFeeCents: Cents;
  // Everyone else's contributions combined, so the payer can check the total.
  othersCents: Cents;
  ownLegs: { executionRef?: string; payeeId: string; amountCents: Cents; status: LegStatus }[];
  // The purchase's last recorded employee assessment — present eligibility
  // as of the last mutation (benefit purchases only). Kept strictly
  // separate from the frozen authority below that funded the shares. The
  // observed mandate version and maximum are safe; the mandate reference
  // itself stays out of the payer column.
  assessment?: {
    authZone: AuthZone;
    employeeDebitCents: Cents;
    autoPayBlockedReason?: AutoPayBlockedReason;
    mandateVersion?: number;
    employeeMaxCents?: Cents;
  };
  // The basis of the authorization record funding this payer's shares: a
  // device signature, a signed one-off exception or standing mandate
  // evidence — the authority that paid, not today's eligibility answer.
  authorizationBasis?: 'device' | 'exception' | 'mandate';
  // The signed record's own approvalRef. Mandate evidence names no
  // reference here: docs/field-map.md keeps mandate references out of the
  // payer column.
  authorizationRef?: string;
  // Whether returns were attempted on this purchase and how they ended.
  returnStatus: ReturnStatus;
  // Confirmed returned principal on this payer's own legs.
  returnedCents: Cents;
  // The charged fee principal-returns never give back — reported separately
  // so "principal returned; fee retained" is not folded into returnedCents.
  unreturnedFeeCents: Cents;
  // The Auto receipt's observation time and fixed dispute deadline —
  // present only on a mandate-authorized purchase once completed. The
  // observed mandate version is safe; the mandate reference stays out of
  // the payer column (docs/field-map.md).
  receipt?: { receiptAt: number; disputeUntil: number; mandateVersion: number };
  // This payer's own dispute case and the latest outcome of its return
  // request — absent when none was ever accepted.
  dispute?: { openedAt: number; outcome: DisputeOutcome };
}

export interface PayeeView {
  purchaseId: string;
  state: PurchaseState;
  // Settled legs paid to this payee and not returned.
  receivedCents: Cents;
  contributions: { executionRef?: string; amountCents: Cents; status: LegStatus }[];
}

export interface SponsorView {
  mandateRef: string;
  purchaseId: string;
  // Eligibility evidence: the employer can check it against its own list.
  merchantId: string;
  contributionCents: Cents;
  status: LegStatus | 'not_submitted';
}

export function payerView(p: PurchaseView, payerId: string): PayerView {
  // Payer participants only. A sponsor holds a mandate-backed share and sees
  // sponsorView — through this view it would learn the purchase total and the
  // employee's share, which docs/field-map.md says it must not. The payer's
  // authorization basis (device, exception or standing terms) does not
  // change their visibility.
  const own = p.proposal.shares.filter((s) => s.payerId === payerId);
  if (!own.some((s) => s.authority === 'payer')) throw new Error(`no payer share for ${payerId}`);
  const ownCents = own.reduce((t, s) => t + s.amountCents, 0);
  const auth = p.authorizations.find((a) => authorizationPayer(a) === payerId);
  const ownLegs = p.legs.filter((l) => l.payerId === payerId);
  return {
    purchaseId: p.purchaseId,
    state: p.state,
    merchantId: p.proposal.merchantId,
    totalCents: p.proposal.totalCents,
    ownCents,
    ownFeeCents: own.reduce((t, s) => t + s.feeCents, 0),
    othersCents: p.proposal.totalCents - ownCents,
    ownLegs: ownLegs.map((l) => ({ executionRef: l.executionRef, payeeId: l.payeeId, amountCents: l.amountCents, status: l.status })),
    assessment:
      p.employeeAssessment === undefined
        ? undefined
        : {
            authZone: p.employeeAssessment.authZone,
            employeeDebitCents: p.employeeAssessment.employeeDebitCents,
            autoPayBlockedReason: p.employeeAssessment.autoPayBlockedReason,
            mandateVersion: p.employeeAssessment.mandate?.version,
            employeeMaxCents: p.employeeAssessment.mandate?.maxCents,
          },
    authorizationBasis: auth?.basis,
    authorizationRef: auth === undefined || auth.basis === 'mandate' ? undefined : auth.approval.payload.approvalRef,
    returnStatus: p.returnStatus,
    returnedCents: ownLegs.filter((l) => l.status === 'returned').reduce((t, l) => t + l.amountCents, 0),
    unreturnedFeeCents: ownLegs.filter((l) => l.status === 'returned').reduce((t, l) => t + l.feeCents, 0),
    receipt:
      p.receipt && p.receipt.employeeId === payerId
        ? { receiptAt: p.receipt.receiptAt, disputeUntil: p.receipt.disputeUntil, mandateVersion: p.receipt.mandateVersion }
        : undefined,
    dispute:
      p.dispute && p.dispute.employeeId === payerId
        ? { openedAt: p.dispute.openedAt, outcome: p.dispute.outcome }
        : undefined,
  };
}

export function payeeView(p: PurchaseView, payeeId: string): PayeeView {
  const legs = p.legs.filter((l) => l.payeeId === payeeId);
  return {
    purchaseId: p.purchaseId,
    state: p.state,
    receivedCents: legs.filter((l) => l.status === 'settled').reduce((t, l) => t + l.amountCents, 0),
    contributions: legs.map((l) => ({ executionRef: l.executionRef, amountCents: l.amountCents, status: l.status })),
  };
}

export function sponsorView(p: PurchaseView): SponsorView {
  if (!p.benefit) throw new Error('only benefit purchases have a sponsor');
  // 'employer' is the fixed role the benefit split gives the mandate-backed share;
  // the contribution is the approved proposal amount, the status the leg's.
  const leg = p.legs.find((l) => l.leg === 'employer');
  return {
    mandateRef: p.benefit.mandateRef,
    purchaseId: p.purchaseId,
    merchantId: p.proposal.merchantId,
    contributionCents: p.proposal.shares.find((s) => s.role === 'employer')?.amountCents ?? 0,
    status: leg?.status ?? 'not_submitted',
  };
}
