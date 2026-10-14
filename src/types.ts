// Shared types for the multi-payer mock. All amounts are integer euro cents.

export type Cents = number;

// LOCAL = produced by this mock or the coordinator. ECB_API is reserved for
// events observed through the ECB test environment once access exists.
export type Origin = 'LOCAL' | 'ECB_API';

export type PurchaseState =
  | 'draft'
  | 'awaiting_approvals'
  | 'ready'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recovery_required';

export type LegName = 'employee' | 'employer';

export type LegStatus = 'planned' | 'unknown' | 'settled' | 'rejected' | 'returned';

export type ReturnStatus = 'none' | 'completed' | 'unsupported';

// 'atomic' models a backend that settles all contributions as one transaction.
// 'independent' is the two-payment baseline where each leg settles on its own.
export type SettlementMode = 'atomic' | 'independent';

export interface Proposal {
  version: number;
  merchantId: string;
  totalCents: Cents;
  feesCents: Cents;
  employeeCents: Cents;
  employerCents: Cents;
  expiresAt: number;
}

// The employee's approval is bound to one proposal version and its exact terms.
export interface EmployeeApproval {
  approvalRef: string;
  purchaseId: string;
  proposalVersion: number;
  merchantId: string;
  totalCents: Cents;
  feesCents: Cents;
  employeeCents: Cents;
  expiresAt: number;
}

// Bounded employer authority, granted independently of any single purchase.
// A policy match alone is not spending authority; this object is.
export interface EmployerMandate {
  mandateRef: string;
  employerId: string;
  beneficiaryRef: string;
  maxPerPurchaseCents: Cents;
  maxPerDayCents: Cents;
  eligibleMerchants: string[];
  validFrom: number;
  validUntil: number;
  revoked: boolean;
}

export interface Leg {
  leg: LegName;
  payerId: string;
  amountCents: Cents;
  authorityRef: string;
  idempotencyKey: string;
  status: LegStatus;
  executionRef?: string;
  rejectReason?: string;
}

export interface Purchase {
  purchaseId: string;
  state: PurchaseState;
  reason?: string;
  employeeId: string;
  employeeMaxCents: Cents;
  mandate: EmployerMandate;
  usedTodayCents: Cents;
  proposal: Proposal;
  approval?: EmployeeApproval;
  legs: Leg[];
  returnStatus: ReturnStatus;
}

export interface TraceEvent {
  seq: number;
  origin: Origin;
  actor: string;
  event: string;
  detail?: Record<string, unknown>;
}
