// Shared types for the multi-payer mock. All amounts are integer euro cents.

import type { Signed } from './signing.ts';

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

// 'approval': the payer approves this exact share. 'mandate': funded under a
// standing, bounded authority that is rechecked at initiation.
export type AuthorityKind = 'approval' | 'mandate';

// One payer's part of a proposal.
export interface Share {
  // Unique within the proposal: 'employee', 'employer', 'diner-1', ...
  role: string;
  payerId: string;
  // Usually the merchant; differs in multi-payee purchases.
  payeeId: string;
  amountCents: Cents;
  // Payer fee on top of amountCents, paid to the payer's PSP; zero in every fixture.
  feeCents: Cents;
  authority: AuthorityKind;
}

// The current offer and how it is funded. The version bumps on every change
// and is what approvals bind to, so a changed offer can never be executed
// under a stale approval.
export interface Proposal {
  version: number;
  // Merchant of record: eligibility and display.
  merchantId: string;
  totalCents: Cents;
  shares: Share[];
  // Both the offer and any approval of it die here (coordinator clock).
  expiresAt: number;
}

// One payer's approval, bound to one proposal version and its exact terms:
// every field is part of the binding checked in approve().
export interface PayerApproval {
  approvalRef: string;
  purchaseId: string;
  payerId: string;
  proposalVersion: number;
  merchantId: string;
  totalCents: Cents;
  // The payer's own amount: the sum of their approval-backed shares. It must
  // never silently grow when another contribution fails or shrinks.
  amountCents: Cents;
  // The payer's own fee, bound like the amount.
  feeCents: Cents;
  // May be earlier than the proposal's expiry, never later.
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

// The employee's signed standing payment terms. One record per employee,
// replaced only by the employee signing the next version: revocation and
// expiry disable automatic authority but keep the maximum and the blocked
// list in force until the terms are explicitly replaced. A mandate reference
// stays bound to the employee that first published it.
export interface EmployeeMandate {
  // Stable nonempty reference for this employee's standing terms; distinct
  // from the employer's mandate reference.
  mandateRef: string;
  // Owner and signer; must match the purchase employee.
  employeeId: string;
  // Initial publication is 1; each replacement or revocation is the prior
  // version plus 1.
  version: number;
  // Largest employee debit (fee included) payable without a tap; 0 disables
  // automatic payment. At most maxCents.
  autoPayMaxCents: Cents;
  // Ordinary-confirmation maximum, fee included. Not an absolute ceiling:
  // exceeding it needs a separately signed one-off exception.
  maxCents: Cents;
  // Monthly cap on net automatic employee debits; 0 permits none.
  autoPayMonthlyCents: Cents;
  // Merchant IDs eligible for automatic payment.
  trustedMerchants: string[];
  // Merchant IDs that cannot be paid through this flow; a block beats trust.
  blockedMerchants: string[];
  // Automatic authority is live through this simulated minute; expired when
  // now > validUntil.
  validUntil: number;
  // true disables automatic authority while the restrictions remain in force.
  revoked: boolean;
}

// Whether a leg's request may have reached its settlement route, tracked on
// the frozen submission independently of any returned execution reference.
// 'forwarded': a route call ran — its response may have been lost, so the leg
// stays potentially submitted and a replay uses its frozen authorization.
// 'refused': conclusively refused before forwarding — a replay is again a
// first handoff and is revalidated under current authority.
export type LegDispatch = 'forwarded' | 'refused';

// A request leg frozen at admission: the exact terms the settlement route
// dedupes on, the kind of authority that funds it (approval recheck vs mandate
// recheck — never inferred from the authorityRef string), and its dispatch
// knowledge. Absent dispatch means never attempted.
export interface SubmissionLeg {
  payerId: string;
  payeeId: string;
  amountCents: Cents;
  feeCents: Cents;
  idempotencyKey: string;
  authority: AuthorityKind;
  dispatch?: LegDispatch;
}

// The submission as admitted, frozen for the purchase's whole settlement
// life: a replay sends these exact values — group, mode, request legs,
// authority evidence and the original assembly size/deadline — never fresh
// terms, fresh keys or a new assembly window.
export interface Submission {
  groupRef: string;
  mode: SettlementMode;
  legs: SubmissionLeg[];
  // Atomic group assembly under per-payer initiation, fixed at admission:
  // a late first handoff joins the original group, never opens a new window.
  assembly?: { size: number; assembleBy: number };
}

// One contribution attempt. Which authority paid for it is recorded in
// authorityRef (the payer's approvalRef, or the employer's mandateRef), so
// every euro traces back to a specific grant of authority.
export interface Leg {
  // The share's role this leg pays for.
  leg: string;
  payerId: string;
  payeeId: string;
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

// Present on employer-benefit purchases only.
export interface BenefitTerms {
  employeeId: string;
  // The employee's standing instruction: the most they will personally pay.
  // A person sets it, deterministic code enforces it; no AI may raise it.
  employeeMaxCents: Cents;
  // Fee the employee pays their PSP on top of their share (zero in fixtures).
  employeeFeeCents: Cents;
  // Resolved through the MandateRegistry, so a re-published (changed or
  // revoked) mandate takes effect at initiation.
  mandateRef: string;
}

export interface Purchase {
  purchaseId: string;
  // Derived, never asserted: recomputed from leg statuses after every backend
  // interaction (see Coordinator.derive).
  state: PurchaseState;
  // Why the purchase sits in 'draft' or 'failed', for display.
  reason?: string;
  benefit?: BenefitTerms;
  proposal: Proposal;
  // Approvals that still bind the current proposal version, one per payer.
  // Each is signed by the payer it names and verified at recording and again
  // at initiation.
  approvals: Signed<PayerApproval>[];
  legs: Leg[];
  // Settlement mode of the submission. Retries reuse it, so a retried leg can
  // never settle outside its atomic group.
  mode?: SettlementMode;
  // The submission intent frozen at admission: replayed with the same keys,
  // terms and assembly deadline, and carrying per-leg dispatch knowledge
  // independent of returned execution references. Absent before submission or
  // after a conclusive pre-dispatch refusal rolled the intent back.
  submission?: Submission;
  // True while this purchase owns the ledger reservation under its
  // purchaseId: set when reserve() succeeds, cleared when released. A second
  // purchase reusing the same purchaseId must not touch this one's entry.
  benefitHeld?: boolean;
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
