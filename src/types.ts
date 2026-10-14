// Shared types for the multi-payer mock. All amounts are integer euro cents.

export type Cents = number;

// LOCAL = produced by this mock or the coordinator. ECB_API is reserved for
// events observed through the ECB test environment once access exists.
export type Origin = 'LOCAL' | 'ECB_API';

// Lifecycle: draft → awaiting_approvals → ready → pending → completed.
// 'failed' = nothing was committed; 'cancelled' = every obligation resolved;
// 'recovery_required' = money committed but the purchase incomplete, with the
// outstanding amount kept visible until returned.
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

// Per-contribution outcome. 'unknown' means the submission response was lost:
// a timeout is not evidence of failure. 'returned' means settled then
// refunded; a return never erases the original settlement record.
export type LegStatus = 'planned' | 'unknown' | 'settled' | 'rejected' | 'returned';

// Whether returns were attempted on this purchase and how they ended. Tracked
// separately from the purchase state because a return is a new operation on an
// old settlement, not a rewrite of it.
export type ReturnStatus = 'none' | 'completed' | 'unsupported';

// 'atomic' models a backend that settles all contributions as one transaction.
// 'independent' is the two-payment baseline where each leg settles on its own.
export type SettlementMode = 'atomic' | 'independent';

// The merchant's current offer, split into the two shares. The version bumps
// on every reprice and is what approvals bind to, so a changed offer can never
// be executed under a stale approval.
// feesCents is the payer fee the employee pays their own PSP, on top of their
// share: never part of the merchant total, never moved onto another payer.
// Zero in every fixture (basic digital euro payments are free for individuals).
export interface Proposal {
  version: number;
  merchantId: string;
  totalCents: Cents;
  feesCents: Cents;
  employeeCents: Cents;
  employerCents: Cents;
  // Both the offer and any approval of it die here (coordinator clock).
  expiresAt: number;
}

// The employee's approval is bound to one proposal version and its exact
// terms: every field below is part of the binding checked in approve().
export interface EmployeeApproval {
  approvalRef: string;
  purchaseId: string;
  proposalVersion: number;
  merchantId: string;
  totalCents: Cents;
  feesCents: Cents;
  // The employee's own share — the figure that must never silently grow when
  // the employer's contribution fails or shrinks.
  employeeCents: Cents;
  expiresAt: number;
}

// Bounded employer authority, granted independently of any single purchase.
// A policy match alone is not spending authority; this object is.
export interface EmployerMandate {
  mandateRef: string;
  employerId: string;
  // Who may benefit from the mandate; checked against the purchase's employee.
  beneficiaryRef: string;
  maxPerPurchaseCents: Cents;
  maxPerDayCents: Cents;
  // Subsidised purchases allowed per day. The German meal benefit allows one
  // meal per working day (pending tax/legal confirmation, see backlog).
  maxPurchasesPerDay: number;
  eligibleMerchants: string[];
  validFrom: number;
  validUntil: number;
  revoked: boolean;
}

// One contribution attempt. Which authority paid for it is recorded in
// authorityRef (the approvalRef for the employee, the mandateRef for the
// employer), so every euro traces back to a specific grant of authority.
export interface Leg {
  leg: LegName;
  payerId: string;
  amountCents: Cents;
  // Payer fee on top of amountCents, paid to the payer's PSP.
  feeCents: Cents;
  authorityRef: string;
  // Stable across retries of the same proposal version: the backend dedupes
  // on it, so a retransmission can never execute twice.
  idempotencyKey: string;
  status: LegStatus;
  // Assigned by the backend on submission; the handle for later status
  // queries and returns.
  executionRef?: string;
  rejectReason?: string;
}

export interface Purchase {
  purchaseId: string;
  // Derived, never asserted: recomputed from leg statuses after every backend
  // interaction (see Coordinator.derive).
  state: PurchaseState;
  // Why the purchase sits in 'draft' or 'failed', for display.
  reason?: string;
  employeeId: string;
  // The employee's standing instruction: the most they will personally pay.
  // A person sets it, deterministic code enforces it; no AI may raise it.
  employeeMaxCents: Cents;
  mandate: EmployerMandate;
  proposal: Proposal;
  // Present only while its binding terms still match the current proposal.
  approval?: EmployeeApproval;
  legs: Leg[];
  returnStatus: ReturnStatus;
}

// One line of the audit log shared by the coordinator and the backend.
export interface TraceEvent {
  // Global sequence number: the single ordering across all actors.
  seq: number;
  // Evidence origin. 'LOCAL' for this code; 'ECB_API' is reserved for events
  // observed in the real test environment — a local pass is never reported as
  // an ECB capability.
  origin: Origin;
  actor: string;
  event: string;
  // Machine-checkable payload; tests assert on these fields.
  detail?: Record<string, unknown>;
}
