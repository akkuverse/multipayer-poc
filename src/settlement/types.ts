// Settlement domain types: the keyed-operation records every settlement
// module keeps for idempotent replay and status, plus the hold lifecycle
// reported separately from operation status. Records crossing a module
// boundary are detached plain data — no mutable Map, module instance or
// callback travels in them. All amounts are integer euro cents.
//
// Owned here so ledger, provider and orchestrator modules share one
// vocabulary; later tasks extend this file with frozen intents, provider
// outcomes and settlement snapshots (contract decisions 5–8).

import type { AuthorityKind, Cents, Rail } from '../core/types.ts';

// The authoritative status of a recorded operation under its original key.
// 'not_started' is an intent recorded before any attempt — it permits a
// replay under the same key and terms and is never a final rejection.
// 'pending' and 'unknown' are both open: a handed-off operation awaiting its
// outcome, or a lost response — neither proves failure. 'succeeded' and
// 'rejected' are terminal and immutable.
export type OperationStatus = 'not_started' | 'pending' | 'succeeded' | 'rejected' | 'unknown';

// The lifecycle of a ledger hold, reported separately from the operation
// that created it: an operation may be resolved while its hold lives on.
export type HoldStatus = 'active' | 'committed' | 'released' | 'expired';

// What resolving an operation reports. 'pending' and 'unknown' keep the
// operation open; a 'not_started' outcome is not a resolution at all and is
// refused by the store. The reference, when known, is the module's own
// handle for the attempt (a hold, an execution, a transfer) — the handle
// later status queries and returns key on. reason names a conclusive
// refusal; effects records structured knowledge about what may have moved.
export interface OperationOutcome {
  status: Exclude<OperationStatus, 'not_started'>;
  reference?: string;
  reason?: string;
  effects?: unknown;
}

// One keyed operation as the store retains it: the immutable copied terms
// the identity dedupes on, the key itself, the current status, and the
// reference/reason/effects evidence accumulated so far. Callers always
// receive detached copies — the retained record is never a mutable handle.
export interface OperationRecord {
  // The tuple-encoded identity produced by operationKey().
  key: string;
  // The canonical copy of the terms begin() recorded; a replay under
  // canonically different terms is refused.
  terms: unknown;
  status: OperationStatus;
  // The module's handle for the attempt, once known.
  reference?: string;
  reason?: string;
  // Structured knowledge about the attempt's effects, opaque to the store.
  effects?: unknown;
}

// ---------------------------------------------------------------------------
// Simulation fault controls (decision 12): concrete modules accept a fault
// per operation key and named stage. 'reject_before_effect' is a conclusive
// refusal before anything moves; 'lose_response_after_effect' applies and
// records the effect but the caller's response is lost — it sees 'unknown'
// and must reconcile by the original key; 'defer' accepts the work as
// 'pending' and parks it until the simulation resolves it explicitly —
// never via a fresh operation key.
export type SimulationFault = 'reject_before_effect' | 'lose_response_after_effect' | 'defer';

// How the simulation resolves parked work.
export type DeferredOutcome = 'succeed' | 'reject';

// The stages a fault can name are the module's actual operations, not an
// abstraction (decision 12).
export type DigitalEuroStage = 'hold' | 'commit' | 'release' | 'fund' | 'defund' | 'transfer';
export type BankTransferStage = 'debit' | 'credit';

// ---------------------------------------------------------------------------
// Digital-euro ledger requests (spec §4.3). Every request carries a stable
// operation key, the caller's provider identity and immutable pseudonymous
// terms: the ledger knows pseudonyms only, never payer ids. The recorded
// terms exclude the key, which is the record's identity.

// Frozen group membership recorded on a hold at reserve time: the stable
// group key, this hold's own member identity and the frozen ordered member
// list the key binds (decision 2; spec §7). Member identities are opaque
// strings to the ledger — the caller encodes leg identity into them.
export interface DeGroupMembership {
  key: string;
  self: string;
  members: readonly string[];
}

// Reserve amountCents on a pseudonymous holding for a payment to the
// destination pseudonym. The destination is frozen at reserve: a commit
// cannot redirect the payment.
export interface DeHoldRequest {
  key: string;
  provider: string;
  pseudonym: string;
  amountCents: Cents;
  destination: string;
  group?: DeGroupMembership;
}

// Commit one active hold individually. A hold with frozen group membership
// can only move through commitGroup — committing it alone would break the
// group's all-or-nothing guarantee.
export interface DeCommitRequest {
  key: string;
  provider: string;
  holdRef: string;
}

// One member of an atomic group commit: the frozen member identity, the
// hold realising it, and the provider authorised for that hold's holding —
// the ledger checks each member against its holding's owning provider.
export interface DeGroupCommitMember {
  leg: string;
  holdRef: string;
  provider: string;
}

// Commit every listed hold atomically: the ledger validates all members —
// active, unexpired, frozen membership matching this group key and order —
// before changing any holding (decision 2; spec §4.3).
export interface DeGroupCommitRequest {
  key: string;
  members: readonly DeGroupCommitMember[];
}

export interface DeReleaseRequest {
  key: string;
  provider: string;
  holdRef: string;
}

// Credit a holding from its owner's bank account (reverse waterfall in).
export interface DeFundRequest {
  key: string;
  provider: string;
  pseudonym: string;
  amountCents: Cents;
}

// Move digital euro back to the owner's bank account. With transitRef it
// confirms an in-transit excess credit instead of debiting the holding —
// the paired conversion entry for a holding-limited credit (decision 10).
export interface DeDefundRequest {
  key: string;
  provider: string;
  pseudonym: string;
  amountCents: Cents;
  transitRef?: string;
}

// A direct spendable-to-destination move outside the hold flow.
export interface DeTransferRequest {
  key: string;
  provider: string;
  from: string;
  to: string;
  amountCents: Cents;
}

// ---------------------------------------------------------------------------
// Digital-euro ledger result evidence, carried in OperationRecord.effects.

export interface DeHoldEffects {
  holdRef: string;
  reservedAt: number;
  expiresAt: number;
}

// What a destination credit did: the part that became spendable holdings
// and the excess routed into tracked defunding transit (decision 10).
export interface DeCreditEffects {
  creditedCents: Cents;
  defundedCents: Cents;
  transitRef?: string;
}

export type DeCommitEffects = DeCreditEffects & { holdRef: string };

export interface DeGroupCommitEffects {
  members: readonly ({ leg: string; holdRef: string } & DeCreditEffects)[];
}

export interface DeReleaseEffects {
  holdRef: string;
  // The lifecycle state the release observed — 'released' for an active
  // hold, or 'expired' when expiry already freed the reservation.
  holdStatus: HoldStatus;
}

export type DeFundEffects = DeCreditEffects;

export interface DeDefundEffects {
  debitedCents: Cents;
  transitRef?: string;
}

export type DeTransferEffects = DeCreditEffects & { debitedCents: Cents };

// ---------------------------------------------------------------------------
// Detached audit views for scenario evidence: balances, holds and transit.

export interface DeHoldingAudit {
  pseudonym: string;
  provider: string;
  deCents: Cents;
  holdingLimitCents: Cents;
  // Sum of amounts reserved by currently active holds.
  heldCents: Cents;
  // deCents minus heldCents — what a new hold/defund/transfer can use.
  spendableCents: Cents;
}

export interface DeHoldAudit {
  holdRef: string;
  key: string;
  pseudonym: string;
  amountCents: Cents;
  destination: string;
  status: HoldStatus;
  reservedAt: number;
  expiresAt: number;
  // A commit was accepted but its outcome is still deferred: the hold
  // stays locked past its deadline — neither expiry nor release may
  // preempt it — until the parked operation resolves (spec §6 race rule).
  commitPending: boolean;
  group?: DeGroupMembership;
}

// Excess digital euro routed out of a holding-limited credit, awaiting its
// paired bank credit at the owning provider (decision 10; spec §6.1). It
// is never a spendable balance: 'in_transit' until 'defunded'.
export interface DeTransitAudit {
  transitRef: string;
  parentKey: string;
  pseudonym: string;
  amountCents: Cents;
  status: 'in_transit' | 'defunded';
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Interbank transfers (spec §4.4). The module holds nothing per customer:
// it moves bank money between provider books through the BankBook seam the
// provider modules own. A debit alone is transit, not settlement.

// The seam a provider's bank book exposes to the transfer module: debit
// throws with a reason message when the book refuses the amount.
export interface BankBook {
  debit(amountCents: Cents): void;
  credit(amountCents: Cents): void;
}

export interface BankTransferRequest {
  key: string;
  // The provider initiating the transfer; it must name the debited book —
  // no party may move money out of a book it does not own.
  initiator: string;
  from: string;
  to: string;
  amountCents: Cents;
}

export interface BankTransferEffects {
  transferRef: string;
  debited: boolean;
  credited: boolean;
}

// Detached audit view: which stages are confirmed, and whether an
// uncredited debit has been cancelled back to its source (decision 10).
export interface BankTransferAudit {
  transferRef: string;
  key: string;
  from: string;
  to: string;
  amountCents: Cents;
  debited: boolean;
  credited: boolean;
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Provider-level records (decisions 7–9, 11; spec §4.1, §6.1, §7). The
// orchestrator hands the provider a frozen leg plus the coordinator's
// accepted authority evidence; the provider answers with detached outcomes
// that carry money truth — committed principal, destination-credit
// confirmation, charged/returned fees, returned principal — and the child
// operations whose effects remain unresolved.

// The frozen leg record (decision 8): its identity is the existing
// (purchaseId, proposalVersion, role) triple, extended with the payer/payee,
// signed rail, principal, fee and authority kind, plus the destination
// routing the payment must follow and — for a leg inside a same-ledger
// digital-euro group — the frozen group membership minted with the intent.
export interface SettlementLeg {
  purchaseId: string;
  proposalVersion: number;
  role: string;
  payerId: string;
  payeeId: string;
  rail: Rail;
  principalCents: Cents;
  feeCents: Cents;
  // Which authority basis funds this leg — carried so evidence and terms
  // can never be conflated across bases.
  authority: AuthorityKind;
  // Frozen destination routing. The DE rail names the payee's pseudonymous
  // holding; the bank rail names the destination provider's book. Part of
  // the recorded terms — a replay can never reroute a leg.
  destination: { dePseudonym?: string; bankProvider?: string };
  // For a DE leg committed inside a same-ledger atomic group: the frozen
  // group key, this leg's member identity and the ordered member list the
  // key binds (decisions 2, 11). Absent on ungrouped and bank-rail legs.
  deGroup?: DeGroupMembership;
}

// The coordinator's synchronous first-handoff decision, recorded as
// evidence the provider validates against the leg it reserves (decision 7).
// The record echoes the leg identity and terms it authorizes — a provider
// refuses evidence that does not match the leg exactly — and names the
// authority basis and the specific verified grant behind the acceptance.
export interface AcceptedAuthority {
  purchaseId: string;
  proposalVersion: number;
  role: string;
  payerId: string;
  rail: Rail;
  principalCents: Cents;
  feeCents: Cents;
  authority: AuthorityKind;
  // The reference of the verified signed record that authorized this leg
  // (the payer's approvalRef or the employer mandateRef).
  authorityRef: string;
}

export type AuthorityDecision =
  | { accepted: false; reason: string }
  | { accepted: true; evidence: AcceptedAuthority };

// The explicit money semantics of a return (decision 9). Automatic
// compensation passes 'principal_and_fee' — principal and any charged fee
// are restored; ordinary refunds, disputes and independent explicit
// recovery pass 'principal_only', preserving the current fee policy.
// Semantics are never inferred by parsing an operation key.
export type ReturnPolicy = 'principal_only' | 'principal_and_fee';

// The provider's handle to one accepted digital-euro group member, returned
// with a group leg's reserve outcome and handed back to
// commitAcceptedDigitalEuroGroup (decision 11). It names the owning
// provider, the acceptance and the ledger hold, and carries the group key
// so the outcome stays recoverable under the original group identity.
export interface AcceptedHold {
  // Opaque token resolving the accepting provider instance for the
  // module-level group helper — provider ids alone are not unique across
  // composed worlds.
  owner: string;
  provider: string;
  // This hold's member identity inside the frozen group.
  leg: string;
  acceptanceRef: string;
  holdRef: string;
  groupKey: string;
  expiresAt: number;
}

// One member's commit outcome inside a group commit.
export interface GroupMemberOutcome {
  leg: string;
  holdRef: string;
  provider: string;
  status: OperationStatus;
  reason?: string;
  // The ledger-side destination credit evidence once committed.
  credit?: DeCreditEffects;
}

// The outcome of committing the accepted holds of a frozen digital-euro
// group (decision 11): keyed by the original group key so a lost response
// stays reconcilable, with per-member outcomes and the group operation
// record while it remains unresolved.
export interface GroupOutcome {
  key: string;
  status: OperationStatus;
  reason?: string;
  members: GroupMemberOutcome[];
  // The group's own operation record while pending or unknown.
  unresolved?: OperationRecord;
}

// What a provider-level operation reports (decision 8): the operation's
// key, status and reason, its handle, the money truth learned so far —
// committed principal, whether the destination credit is confirmed, fee
// charged/returned, principal returned — plus child operations whose
// effects remain unresolved, so callers never schedule deferred work
// themselves.
export interface ProviderOutcome {
  key: string;
  status: OperationStatus;
  reason?: string;
  // The module's handle for the operation: the hold on reserve, the
  // execution reference on commit, the return reference on refund.
  reference?: string;
  // Confirmed committed principal — set only once the ledger says so.
  committedCents?: Cents;
  // True once every part of the destination credit is confirmed, including
  // defunding transit into a zero-limit destination's bank account.
  destinationCreditConfirmed?: boolean;
  feeChargedCents?: Cents;
  feeReturnedCents?: Cents;
  principalReturnedCents?: Cents;
  // True when holds are released, funding effects restored and no transit
  // remains for this operation.
  cleanupConfirmed?: boolean;
  // Open child operations (pending or unknown) with their recorded
  // evidence; resolved or failed children do not appear here.
  unresolved: OperationRecord[];
}

// The reserve outcome adds the acceptance and hold references and the
// hold's expiry (decision 8), plus the group handle for group members.
export interface ReserveOutcome extends ProviderOutcome {
  acceptanceRef?: string;
  holdRef?: string;
  expiresAt?: number;
  acceptedHold?: AcceptedHold;
}

// The stages a provider-level fault can name (decision 12): the actual
// operations the provider runs — ledger stages forwarded to the digital-euro
// ledger or the interbank module under the same child key, plus the
// provider-internal bookkeeping stages: the linked-bank debit during
// funding ('bank_debit') and the bank credit restoring funded or returned
// money ('bank_restore'). 'hold' and 'release' also name the bank rail's
// internal hold bookkeeping under its own child keys. Return bookkeeping
// is not a keyed child stage and names no faultable stage.
export type ProviderStage =
  | DigitalEuroStage
  | BankTransferStage
  | 'bank_debit'
  | 'bank_restore';
