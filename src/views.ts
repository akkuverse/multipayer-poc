// What each party may see of a purchase: projections, not copies. Every field
// here is one its recipient needs (docs/field-map.md). The employer sees its
// own contribution and the merchant it went to, never the purchase total or
// the employee's share; a payee sees what it received, not who paid it.

import type { Cents, LegStatus, Purchase, PurchaseState } from './types.ts';

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

export function payerView(p: Purchase, payerId: string): PayerView {
  // Approval payers only. A sponsor holds a mandate-backed share and sees
  // sponsorView — through this view it would learn the purchase total and the
  // employee's share, which docs/field-map.md says it must not.
  const own = p.proposal.shares.filter((s) => s.payerId === payerId);
  if (!own.some((s) => s.authority === 'approval')) throw new Error(`no approval share for ${payerId}`);
  const ownCents = own.reduce((t, s) => t + s.amountCents, 0);
  return {
    purchaseId: p.purchaseId,
    state: p.state,
    merchantId: p.proposal.merchantId,
    totalCents: p.proposal.totalCents,
    ownCents,
    ownFeeCents: own.reduce((t, s) => t + s.feeCents, 0),
    othersCents: p.proposal.totalCents - ownCents,
    ownLegs: p.legs
      .filter((l) => l.payerId === payerId)
      .map((l) => ({ executionRef: l.executionRef, payeeId: l.payeeId, amountCents: l.amountCents, status: l.status })),
  };
}

export function payeeView(p: Purchase, payeeId: string): PayeeView {
  const legs = p.legs.filter((l) => l.payeeId === payeeId);
  return {
    purchaseId: p.purchaseId,
    state: p.state,
    receivedCents: legs.filter((l) => l.status === 'settled').reduce((t, l) => t + l.amountCents, 0),
    contributions: legs.map((l) => ({ executionRef: l.executionRef, amountCents: l.amountCents, status: l.status })),
  };
}

export function sponsorView(p: Purchase): SponsorView {
  if (!p.benefit) throw new Error('only benefit purchases have a sponsor');
  const leg = p.legs.find((l) => l.leg === 'employer');
  return {
    mandateRef: p.benefit.mandate.mandateRef,
    purchaseId: p.purchaseId,
    merchantId: p.proposal.merchantId,
    contributionCents: p.proposal.shares.find((s) => s.role === 'employer')?.amountCents ?? 0,
    status: leg?.status ?? 'not_submitted',
  };
}
