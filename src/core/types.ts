// Shared types for the multi-payer mock. All amounts are integer euro cents.

import type { PrivacyProfileId } from './privacy.ts';
import type { Signed } from './signing.ts';
import type { SettlementSnapshot } from '../settlement/types.ts';

export type Cents = number;

// LOCAL = produced by this mock or the coordinator. ECB_API is reserved for
// events observed through the ECB test environment once access exists.
export type Origin = 'LOCAL' | 'ECB_API';

// Lifecycle: draft → awaiting_approvals → ready → pending → completed.
// 'failed' = nothing was committed; 'cancelled' = every obligation resolved;
// 'compensated' = automatic compensation and all cleanup confirmed, charged
// fees included; 'recovery_required' = money committed but the purchase
// incomplete, with the outstanding amount kept visible until returned.
export type PurchaseState =
  | 'draft'
  | 'awaiting_approvals'
  | 'ready'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'compensated'
  | 'recovery_required';

// Per-contribution outcome. 'unknown' means the submission response was lost:
// a timeout is not evidence of failure. 'returned' means settled then
// refunded; a return never erases the original settlement record.
export type LegStatus = 'planned' | 'unknown' | 'settled' | 'rejected' | 'returned';

// Whether returns were attempted on this purchase and how they ended. Tracked
// separately from the purchase state because a return is a new operation on an
// old settlement, not a rewrite of it. 'partial' means at least one leg is
// confirmed returned while others remain outstanding — it releases nothing:
// only 'completed' gives the purchase's holds back.
// 'unresolved' records an uncertain return with no confirmed returned leg;
// 'partial' records confirmed returned principal with other legs outstanding.
export type ReturnStatus = 'none' | 'unresolved' | 'partial' | 'completed' | 'unsupported';

// 'atomic' reserves every leg before any commit and compensates committed
// payments on conclusive failure — reserve-all with compensation across the
// two ledgers, not a single cross-ledger transaction. 'independent' is the
// two-payment baseline where each leg settles on its own, a failed leg is
// cleaned up and committed legs are returned only by explicit recovery.
export type SettlementMode = 'atomic' | 'independent';

// The rail a share pays on. Digital-euro holdings and bank balances live on
// different ledgers, so a share's rail is part of its signed terms — like
// settlementMode — and can never be silently substituted.
export type Rail = 'digital_euro' | 'bank';

// The recognized rails; a value outside this union is refused, never
// reinterpreted.
export const RAILS: readonly Rail[] = ['digital_euro', 'bank'];

// How a 'ready' purchase reaches submission. 'on_request': a payer's signed
// submit request starts settlement — the coordinator submits only on that
// caller's instruction. 'on_ready': the coordinator fires its own
// submission the moment the purchase becomes ready; no request exists, and
// the coordinator's own path is the only request-less submission — a
// caller's submit() still needs a signed request.
export type SubmitPolicy = 'on_request' | 'on_ready';

// Where a split proposal's share amounts came from. 'proposer': the shares
// carry explicit amounts and the proposer's signature over them doubles as
// their approval of their own shares. 'equal_split': the request carries a
// total and amount-less shares; the coordinator computes the split with the
// fixed remainder rule and every payer still approves separately.
export type AmountsFrom = 'proposer' | 'equal_split';

// Every call that starts or ends a purchase names its caller. The payload
// the caller signs binds the operation to one purchase and one committed
// proposal version, so a replayed or retargeted request can never act on
// terms the signer did not see. 'open_fund' is the payee's one request that
// opens a conditional-fund campaign — the mandate-publication analog, not a
// negotiated proposal.
export type RequestKind = 'propose' | 'propose_split' | 'change_offer' | 'cancel' | 'refund' | 'submit' | 'open_fund';

// The binding every lifecycle request payload carries: which operation,
// which purchase, which committed proposal version the signer saw, and who
// the signer claims to be. proposalVersion is 1 for a proposal creating a
// purchase (no committed version exists yet) and the current version for
// change/cancel/refund/submit.
export interface SignedRequest {
  kind: RequestKind;
  purchaseId: string;
  proposalVersion: number;
  by: string;
}

// An employee's delegation of proposal work to an agent, signed under the
// employee's registered key and scoped to one purchase and session. The
// coordinator verifies the grant end to end — signature, agent, principal,
// purchase, capability, expiry — because the session's claim alone is not
// authority. The presenter's AgentGrant structurally satisfies this shape.
export interface DelegationGrant {
  grantRef: string;
  agentId: string;
  principalId: string;
  sessionId: string;
  purchaseId: string;
  capabilities: string[];
  expiresAt: number;
}

// A signed employer-benefit proposal. by === employeeId suffices; any other
// signer must be an agent carrying grant — the employee's DelegationGrant
// for this purchase, verified at proposal time.
export interface BenefitProposeRequest extends SignedRequest {
  kind: 'propose';
  employeeId: string;
  merchantId: string;
  totalCents: Cents;
  feesCents?: Cents;
  mandateRef: string;
  expiresAt: number;
  submitPolicy: SubmitPolicy;
  settlementMode: SettlementMode;
  // The disclosure profile the signer requests for this purchase: required
  // and must be 'employer_benefit_v1' — a benefit request can never select
  // split disclosure, and a verified mandate must agree with the choice.
  privacyProfile: 'employer_benefit_v1';
  grant?: Signed<DelegationGrant>;
}

// A signed anonymous-charity proposal (spec §3.2): the attested buyer asks
// the coordinator to find a matching donor allowance for its beneficiary
// class — there is no mandateRef to name, and the signer can supply no
// grant, fees, shares, rails or allocation override: the coordinator
// derives every share term itself rather than honoring unsigned donor
// debit terms. Only the buyer may sign this variant — an agent's
// delegation cannot stand in for the beneficiary's own request.
export interface CharityProposeRequest extends SignedRequest {
  kind: 'propose';
  // The buyer: the attested beneficiary and the share's payer.
  employeeId: string;
  merchantId: string;
  totalCents: Cents;
  expiresAt: number;
  submitPolicy: SubmitPolicy;
  settlementMode: SettlementMode;
  // Required and always 'anonymous_donation_v1'.
  privacyProfile: 'anonymous_donation_v1';
  // The beneficiary class the buyer asks to match against (fixture:
  // 'in_need').
  benefitClass: string;
}

// A signed benefit or charity proposal, discriminated on its disclosure
// profile — the 'propose' kind's own SplitRequest-style union. An agent
// delegation exists only on the benefit member.
export type ProposeRequest = BenefitProposeRequest | CharityProposeRequest;

// The fields every signed split request carries; the amounts rule then
// discriminates it into the two shapes below, so an ambiguous payload —
// amounts on 'equal_split' shares, or a total contradicting 'proposer'
// shares — is unrepresentable to typed callers and refused outright to
// signers.
interface SplitRequestBase extends SignedRequest {
  kind: 'propose_split';
  merchantId: string;
  expiresAt: number;
  submitPolicy: SubmitPolicy;
  settlementMode: SettlementMode;
  // The disclosure profile the split creator selects: required and must be
  // 'split_bill_v1', paired with a nonempty reference to an existing,
  // trusted known-group disclosure agreement — configuration the
  // coordinator already holds, never a group the request itself defines.
  privacyProfile: 'split_bill_v1';
  disclosureGroupRef: string;
}

// 'proposer' amounts: every share carries its explicit amount and the
// proposer's signature over them doubles as their approval of their own
// shares. totalCents is redundant — allowed only equal to the share sum,
// never a second source of amounts.
export interface ProposerSplitRequest extends SplitRequestBase {
  amountsFrom: 'proposer';
  shares: { role: string; payerId: string; payeeId?: string; amountCents: Cents; feeCents?: Cents; rail: Rail }[];
  totalCents?: Cents;
}

// 'equal_split' amounts: the request carries a total and amount-less
// shares; the coordinator computes the split with the fixed remainder rule
// and every payer still approves separately.
export interface EqualSplitRequest extends SplitRequestBase {
  amountsFrom: 'equal_split';
  shares: { role: string; payerId: string; payeeId?: string; amountCents?: never; feeCents?: Cents; rail: Rail }[];
  totalCents: Cents;
}

// A signed split proposal, discriminated on where its amounts come from.
// The signer must be one of the shares' payers.
export type SplitRequest = ProposerSplitRequest | EqualSplitRequest;

// A signed offer change, bound to the version it replaces. Signers: the
// merchant of record, the current proposal's proposer, or the employee.
export interface ChangeOfferRequest extends SignedRequest {
  kind: 'change_offer';
  merchantId: string;
  totalCents: Cents;
  expiresAt: number;
}

// A signed pre-submission cancellation; any payer of the purchase may sign.
export interface CancelRequest extends SignedRequest {
  kind: 'cancel';
}

// A signed post-completion return request; only a payee of the purchase may
// sign — a payer's return path is dispute(), never refund().
export interface RefundRequest extends SignedRequest {
  kind: 'refund';
}

// A signed submission request; any payer may sign. A caller's submit()
// requires one under either policy — under 'on_ready' the coordinator's
// own submission is the only request-less path. Named to stay distinct
// from the frozen SettlementLeg terms handed to the orchestrator.
export interface SubmitRequestPayload extends SignedRequest {
  kind: 'submit';
}

// --- Conditional funds -----------------------------------------------------
// A fund is a purchase whose share set grows through individually signed
// pledges under immutable campaign terms. The payee opens it with one
// signed request; pledgers join it; the coordinator resolves it
// deterministically on its simulated clock.

// Every signed campaign term an open_fund request fixes, purchaseId
// included. Campaign terms comprise exactly this table — envelope metadata
// (kind, by, proposalVersion) is never part of them — and campaignDigestOf
// commits to all of it, so a pledge signature binds the cutoff, settlement
// deadline, closing rule, submission policy, mode and profile it was made
// under, with no omitted defaults.
export interface CampaignTerms {
  purchaseId: string;
  payeeId: string;
  // The funding condition: at least one clause, each a positive safe
  // integer; when both are present EITHER suffices (OR). minPayers counts
  // distinct live payers with positive principal; fees never count toward
  // minTotalCents.
  condition: { minPayers?: number; minTotalCents?: Cents };
  // Collection cutoff in simulated minutes, strictly after opening time.
  fundingEndsAt: number;
  // Latest time for admission or an unstarted first handoff; strictly
  // after fundingEndsAt. Not a deadline for already-forwarded payments.
  settleBy: number;
  // 'condition_met' closes the roster at the pledge that tips the
  // condition; 'deadline' keeps accepting while now < fundingEndsAt — the
  // overfunding option.
  acceptPledgesUntil: 'condition_met' | 'deadline';
  submitPolicy: SubmitPolicy;
  // Funds require atomic settlement: every pledge leg or none.
  settlementMode: 'atomic';
  privacyProfile: 'public_good_pledge_v1';
}

// The campaign payee's one signed request that opens a fund: the signer is
// the public-good recipient and the purchase's merchant of record. After
// open, the terms never change; a second open_fund for the same purchaseId
// is refused as duplicate_purchase.
export interface OpenFundRequest extends SignedRequest, CampaignTerms {
  kind: 'open_fund';
  proposalVersion: 1;
}

// One contributor's signed pledge — its own approval of its complete share
// under the campaign it names. Deliberately NOT a SignedRequest variant: it
// carries no proposalVersion (the roster version is irrelevant to its
// binding) and binds the campaign digest, its own pledge identity and
// expiry instead — never the complete roster.
export interface PledgeRequest {
  kind: 'pledge';
  purchaseId: string;
  // The pledger; must equal share.payerId.
  by: string;
  // Nonempty and unique within the campaign; at most one pledge is ever
  // accepted from a payer, so each settlement leg gets a unique role.
  pledgeRef: string;
  // campaignDigestOf over the campaign terms the pledger saw.
  campaignDigest: string;
  // The complete share the pledge funds: the role is derived as
  // `pledge:${pledgeRef}`; arbitrary roles are refused.
  share: {
    role: string;
    payerId: string;
    payeeId: string;
    amountCents: Cents;
    feeCents: Cents;
    rail: Rail;
  };
  // The pledge's only personal expiry: covers both participation and
  // spending authority — live through equality, expired when now >
  // expiresAt, and never past settleBy.
  expiresAt: number;
  privacyProfile: 'public_good_pledge_v1';
}

// The detached acknowledgment a returned pledge earns: acceptance time and
// the proposal version the pledge was recorded under. It never changes when
// the pledge later lapses — current outcome lives in the acceptance history.
export interface PledgeAcceptance {
  purchaseId: string;
  pledgeRef: string;
  acceptedAt: number;
  proposalVersion: number;
}

// One accepted pledge's retained evidence: the signed request, the exact
// canonical payload it was accepted under (replay compares bytes), the
// detached acknowledgment and its current outcome. History is retained
// after lapse — lapsed pledges never count toward the condition but their
// acceptance is never erased.
export interface AcceptedPledge {
  signed: Signed<PledgeRequest>;
  canonicalPayload: string;
  acknowledgment: PledgeAcceptance;
  outcome: 'active' | 'lapsed';
}

// The fund's retained lifecycle state on its purchase: the verified opening
// request and the terms it committed, the phase the funding decision owns
// (collecting under 'awaiting_approvals'; closed under 'ready' before any
// admitted intent; admitted once settlement owns the outcome), the full
// acceptance history, and the live progress counters the last decision
// computed. Active shares and authorizations are coordinator-applied
// materializations of the 'active' history entries.
export interface FundingState {
  campaign: Signed<OpenFundRequest>;
  campaignDigest: string;
  terms: CampaignTerms;
  phase: 'collecting' | 'closed' | 'admitted';
  history: AcceptedPledge[];
  progress: { livePayers: number; liveTotalCents: Cents; met: boolean };
}

// Who a share's funding authority belongs to. 'payer': the named payer
// authorises their own shares — by a device signature, a signed one-off
// exception, or employee standing terms. 'employer_mandate': funded under
// the employer's standing, bounded mandate, rechecked at initiation.
// 'sponsor_mandate': funded under a donor's standing allowance for an
// attested beneficiary class, rechecked at initiation the same way.
export type AuthorityKind = 'payer' | 'employer_mandate' | 'sponsor_mandate';

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
  // The rail this share settles on — part of the signed terms. Benefit
  // proposals derive it: employee 'digital_euro', employer 'bank'
  // (businesses hold no digital euro). Split requests carry it per share.
  rail: Rail;
  authority: AuthorityKind;
  // The specific grant a mandate-backed share draws on: the selected
  // allowance reference on a 'sponsor_mandate' donor share. Payer and
  // employer shares name their authority elsewhere — a payer's approvalRef
  // lands on the leg, the employer's mandateRef lives on BenefitTerms — so
  // the field stays absent for them.
  authorityRef?: string;
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
  // Who signed the request that committed this proposal version — the
  // caller the coordinator verified, never a session claim.
  proposedBy: string;
  // How this proposal reaches submission: a payer's signed request, or the
  // coordinator's own submission fired at the ready transition.
  submitPolicy: SubmitPolicy;
  // The settlement mode the submission runs under — carried on the
  // proposal itself so a submit request cannot choose a different group.
  settlementMode: SettlementMode;
  // Splits only: which amounts the proposal carries and whether the
  // proposer's signature doubles as their own approval.
  amountsFrom?: AmountsFrom;
  // The disclosure terms this proposal committed to, resolved from the
  // signed source at admission and frozen for the version's whole life: an
  // offer change preserves them, a fresh purchase resolves a fresh source.
  privacy: PrivacyTerms;
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
  // SHA-256 hex over canonicalJson(proposal.shares): the approval binds the
  // complete ordered share terms — role, payer, payee, rail, principal, fee
  // and authority — recomputed from the retained shares at verification.
  // An approval without it carries no binding.
  sharesDigest: string;
  // The disclosure profile the signer approves under: required, and checked
  // against the proposal's frozen terms at acceptance and revalidation. A
  // split approval additionally carries the frozen group reference; a
  // benefit approval carries none.
  privacyProfile: PrivacyProfileId;
  disclosureGroupRef?: string;
  // May be earlier than the proposal's expiry, never later.
  expiresAt: number;
  // The authorization basis this signature represents. 'device' is the
  // ordinary confirmation; 'exception' additionally acknowledges paying above
  // the standing maximum — the acknowledgment fields below are part of the
  // signed payload, so an unsigned option can never upgrade a signature.
  basis: ApprovalBasis;
  // Signed on 'exception' basis only: acknowledges this one payment exceeds
  // the named revision's maximum, by exactly overByCents. The coordinator
  // recomputes every value from the verified mandate and the retained
  // proposal; a copied or stale acknowledgment fails the check.
  exception?: true;
  mandateRef?: string;
  mandateVersion?: number;
  maxCents?: Cents;
  overByCents?: Cents;
}

export type ApprovalBasis = 'device' | 'exception';

// Employee authorization as a discriminated record (spec §5): a
// coordinator-generated mandate authorization is not Signed<PayerApproval>
// and is never passed off as one.
export type Authorization =
  | {
      // Verified employee-signed payment terms binding this exact proposal.
      basis: 'device';
      approval: Signed<PayerApproval>;
    }
  | {
      // Verified employee-signed payment terms plus the signed one-off
      // exception acknowledgment (payload.basis === 'exception').
      basis: 'exception';
      approval: Signed<PayerApproval>;
    }
  | {
      // Coordinator-recorded evidence under the employee's signed standing
      // terms: the verified mandate snapshot and the exact proposal/debit it
      // authorized. No device or agent signature over this purchase exists.
      basis: 'mandate';
      payerId: string;
      mandate: Signed<EmployeeMandate>;
      proposalVersion: number;
      employeeDebitCents: Cents;
    }
  | {
      // A contributor's signed pledge to a conditional fund: the signed
      // PledgeRequest IS the payer's approval of its own complete share —
      // verified at recording and again at initiation, and never a
      // PayerApproval. The record's payer is a.pledge.payload.by and its
      // authority reference a.pledge.payload.pledgeRef.
      basis: 'pledge';
      pledge: Signed<PledgeRequest>;
    };

// The disclosure terms a proposal froze at commit: which versioned profile
// governs its recipient projections and which verified source it was
// resolved from. 'request_only' is the conservative form when no usable
// employer mandate — or, under 'anonymous_donation_v1', no positive donor
// allowance — exists: the signed restrictive request stands, but it
// authorizes no sponsor share and entitles no sponsor. 'known_group'
// records the trusted group agreement a split was admitted under and the
// actual purchase audience — the distinct payers the shares name.
// 'allowance' records the selected donor allowance a charity proposal was
// matched under: the reference, the accepted revision and the donor the
// coordinator verified — internal provenance, never copied into a
// recipient view.
export type PrivacyTerms =
  | {
      profile: 'employer_benefit_v1';
      source: {
        kind: 'employer_mandate';
        mandateRef: string;
        mandateVersion: number;
        employerId: string;
      };
    }
  | { profile: 'employer_benefit_v1'; source: { kind: 'request_only' } }
  | {
      profile: 'split_bill_v1';
      source: {
        kind: 'known_group';
        groupRef: string;
        participantIds: string[];
      };
    }
  | {
      profile: 'public_good_pledge_v1';
      // The verified open_fund request's commitment: the digest pledges
      // bind, plus the complete signed campaign table frozen at open —
      // never re-derived from a later request.
      source: {
        kind: 'campaign';
        campaignDigest: string;
        terms: CampaignTerms;
      };
    }
  | {
      profile: 'anonymous_donation_v1';
      source: {
        kind: 'allowance';
        allowanceRef: string;
        // The accepted allowance revision the match committed to.
        version: number;
        donorId: string;
      };
    }
  | { profile: 'anonymous_donation_v1'; source: { kind: 'request_only' } };

// Bounded employer authority, granted independently of any single purchase.
// A policy match alone is not spending authority; this object is.
export interface EmployerMandate {
  mandateRef: string;
  employerId: string;
  // Initial publication under a reference is 1; each replacement or
  // revocation is the prior version plus 1, so a stale signed revision can
  // never roll the allowance back.
  version: number;
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
  // The disclosure profile the employer signs into its mandate: required
  // and always 'employer_benefit_v1'. A signed record without it — or
  // naming another profile — cannot authorize new work.
  privacyProfile: 'employer_benefit_v1';
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
  // The rails the standing terms may fund an employee debit on: a nonempty,
  // duplicate-free list of recognized rails validated at publication. A
  // debit riding any other rail is outside the terms — missing permission
  // does not silently authorize a different rail.
  allowedRails: Rail[];
  // Automatic authority is live through this simulated minute; expired when
  // now > validUntil.
  validUntil: number;
  // true disables automatic authority while the restrictions remain in force.
  revoked: boolean;
}

// --- Anonymous charity ------------------------------------------------------
// A donor's standing allowance for an attested beneficiary class — the
// EmployerMandate analog whose beneficiary is a class instead of a named
// beneficiaryRef. Published through the same registry under the same
// verify-at-publish-and-use discipline: the first donor permanently owns
// the reference, class and donor identity are immutable, other terms
// (caps, window, revocation) revise only through the next version, and
// budget usage survives revisions and revocation.
export interface AllowanceMandate {
  // Stable nonempty reference; shares the registry's exclusive
  // authority-reference namespace with employer and employee references.
  allowanceRef: string;
  // Owner and signer: the donor funding the allowance. Fixtures use opaque
  // donor identifiers so the allocation digest cannot trivialize to a
  // lookup.
  donorId: string;
  // Initial publication under a reference is 1; each replacement or
  // revocation is the prior version plus 1, so a stale signed revision can
  // never roll the allowance back.
  version: number;
  // The attested beneficiary class this allowance funds (fixture:
  // 'in_need'). Immutable for a reference.
  beneficiaryClass: string;
  maxPerPurchaseCents: Cents;
  maxPerDayCents: Cents;
  // Sponsored purchases allowed per day; same semantics as the employer cap.
  maxPurchasesPerDay: number;
  // Optional lifetime cap; absent means no lifetime limit.
  totalEndowmentCents?: Cents;
  eligibleMerchants: string[];
  validFrom: number;
  validUntil: number;
  revoked: boolean;
  // The disclosure profile the donor signs into its allowance: required
  // and always 'anonymous_donation_v1'. A signed record without it — or
  // naming another profile — cannot authorize new work.
  privacyProfile: 'anonymous_donation_v1';
}

// An oracle's signed statement that one subject belongs to a beneficiary
// class for a validity window. Stored by (subjectId, classId); replaced or
// revoked only by the next version from the class's configured attestor —
// holding a registered signing key grants no attestation privilege on its
// own.
export interface EligibilityAttestation {
  // The issuer; must be the attestor trusted for classId.
  attestorId: string;
  // The beneficiary the statement is about.
  subjectId: string;
  // The class the subject is attested into (fixture: 'in_need').
  classId: string;
  validFrom: number;
  validUntil: number;
  // Initial publication for a (subject, class) pair is 1; each replacement
  // or revocation is the prior version plus 1.
  version: number;
  revoked: boolean;
}

// Where a proposal stands relative to the employee's standing terms (spec
// §4). 'Blocked' cannot be paid through this flow at all; 'Exception' needs a
// device signature that explicitly acknowledges exceeding the maximum;
// 'Auto' may pay without a tap under the signed terms; 'Confirm' is every
// other payable proposal, including never having a mandate.
export type AuthZone = 'Blocked' | 'Auto' | 'Confirm' | 'Exception';

// The first applicable reason a proposal is not Auto, in spec §4 precedence
// order — extended with 'rail_not_permitted' for a debit whose rail the
// standing terms never allowed. Blocked proposals always carry
// 'blocked_merchant'; Auto carries none.
export type AutoPayBlockedReason =
  | 'blocked_merchant'
  | 'no_employee_mandate'
  | 'exceeds_mandate'
  | 'rail_not_permitted'
  | 'mandate_revoked'
  | 'mandate_expired'
  | 'auto_off'
  | 'over_auto_limit'
  | 'untrusted_merchant'
  | 'monthly_cap'
  | 'psp_unsupported';

// A point-in-time answer to "which authority does this employee debit need
// right now". Stored on a benefit purchase as employeeAssessment and exposed
// alongside the proposal version; a projection, never authority itself.
export interface EmployeeAssessment {
  authZone: AuthZone;
  // The employee's own share plus their PSP fee — the amount every threshold
  // is compared against.
  employeeDebitCents: Cents;
  // The verified standing terms this assessment was made under, or absent
  // when the employee never published — never an infinite maximum.
  mandate?: { mandateRef: string; version: number; maxCents: Cents };
  autoPayBlockedReason?: AutoPayBlockedReason;
}

// Whether a leg's request may have reached its settlement route, tracked on
// the frozen submission independently of any returned execution reference.
// 'forwarded': a route call ran — its response may have been lost, so the leg
// stays potentially submitted and a replay uses its frozen authorization.
// 'planned': a handoff was attempted but its reserve never reported reaching
// the provider — the leg is not known to be forwarded, so a replay resumes
// the frozen first handoff under the same key.
// 'refused': conclusively refused before forwarding — a replay is again a
// first handoff and is revalidated under current authority.
export type LegDispatch = 'forwarded' | 'planned' | 'refused';

// A request leg frozen at admission: the exact terms the settlement route
// dedupes on, the kind of authority that funds it (approval recheck vs mandate
// recheck — never inferred from the authorityRef string), and its dispatch
// knowledge. Absent dispatch means never attempted.
export interface SubmissionLeg {
  payerId: string;
  payeeId: string;
  amountCents: Cents;
  feeCents: Cents;
  // The share's frozen rail: part of the terms a replay reproduces, never a
  // fresh choice at retry time.
  rail: Rail;
  idempotencyKey: string;
  authority: AuthorityKind;
  // Detached signed employer terms verified at admission, refreshed before
  // a deferred first handoff, then preserved on every replay. Together with
  // dispatch this records the grant actually used to initiate the debit.
  employerMandate?: Signed<EmployerMandate>;
  // Detached signed pledge funding this leg (conditional-fund purchases
  // only): retained at admission and preserved on every replay — parallel
  // to employerMandate on a mandate-funded leg, but never refreshed.
  pledge?: Signed<PledgeRequest>;
  dispatch?: LegDispatch;
}

// The sponsor admission evidence a charity submission froze: the selected
// allowance reference and its donor, the booking day the allowance
// reservation was filed under (a still-unsent donor leg's recheck counts
// THAT day's usage even after the clock crosses midnight, excluding only
// this purchase's own booking), and the detached signed records the
// admission verified — the allowance revision, the buyer's attestation and
// the buyer's consent. The allowance and attestation snapshots refresh to
// the exact current revisions at an unstarted donor first handoff, then
// stay frozen through forwarding and replay — parallel to employerMandate
// on a mandate-funded leg, but never a fresh arrangement: the reference,
// donor and amount are the same ones the proposal committed.
export interface CharityAdmission {
  allowanceRef: string;
  donorId: string;
  bookingDay: number;
  allowance: Signed<AllowanceMandate>;
  attestation: Signed<EligibilityAttestation>;
  buyerApproval: Signed<PayerApproval>;
}

// The submission as admitted, frozen for the purchase's whole settlement
// life: a replay hands the orchestrator these exact values — group, mode,
// request legs and authority evidence — never fresh terms or fresh keys.
export interface Submission {
  groupRef: string;
  mode: SettlementMode;
  legs: SubmissionLeg[];
  // The UTC booking month the automatic-budget reservation was filed under
  // (mandate-funded employee shares only), preserved across retries and
  // month boundaries: a still-unsent leg's eligibility recheck counts usage
  // in the month that was admitted, never the retry's own month.
  bookingMonth?: string;
  // Charity purchases with a donor share only: the sponsor admission
  // evidence above. A buyer-only fallback never carries it — it holds no
  // sponsor authority and books no allowance budget.
  charity?: CharityAdmission;
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
  // The rail this leg settles on, frozen from its share.
  rail: Rail;
  authorityRef: string;
  // Stable across retries of the same proposal version: the settlement
  // layer dedupes on it, so a retransmission can never execute twice.
  idempotencyKey: string;
  status: LegStatus;
  // Minted by the committing provider; the handle for later status queries
  // and returns.
  executionRef?: string;
  rejectReason?: string;
  // Return-attempt knowledge, distinct from the settlement status: a refund
  // call for this leg's execution may have reached the provider without a
  // conclusive outcome — a lost response is indistinguishable from a
  // mid-call failure, and a blind retry is not idempotent there. The next
  // return attempt must first query status() for the same execution
  // reference.
  returnForwarded?: boolean;
}

// Present on employer-benefit purchases only.
export interface BenefitTerms {
  employeeId: string;
  // Fee the employee pays their PSP on top of their share (zero in fixtures).
  employeeFeeCents: Cents;
  // Resolved through the AuthorityRegistry, so a re-published (changed or
  // revoked) mandate takes effect at initiation.
  mandateRef: string;
}

// Present on anonymous-charity purchases only: the attested buyer and the
// beneficiary class the signed request asked to match, plus — on an
// accepted match — the selected allowance reference and the opaque donor
// identity it funds under. A buyer-only proposal records why no allowance
// contributed instead: the absent/not-live attestation reads
// 'no_live_attestation', an exhausted or ineligible candidate set carries
// the evaluation's own reason. Trusted coordinator evidence — never a
// recipient projection, and never conflated with benefit terms or the
// employee assessment.
export interface CharityTerms {
  buyerId: string;
  benefitClass: string;
  allowanceRef?: string;
  donorId?: string;
  unmatchedReason?: string;
}

// The one receipt an automatically authorized purchase earns (spec §9),
// retained at the first observation of full completion: the standing-terms
// revision that authorized the payment, the original amounts, the funding
// breakdown and the fixed dispute deadline. Observation time is used
// because the settlement evidence exposes no commit timestamp; replayed or
// late duplicate outcomes never reissue the receipt or extend the deadline.
export interface AutopayReceipt {
  purchaseId: string;
  proposalVersion: number;
  merchantId: string;
  employeeId: string;
  // Simulated minute of the first completed observation.
  receiptAt: number;
  // receiptAt + disputeWindowMinutes — fixed at retention, never extended.
  disputeUntil: number;
  // The employee's original principal, PSP fee and total debit.
  amountCents: Cents;
  feeCents: Cents;
  debitCents: Cents;
  // Funding breakdown of the completed proposal.
  totalCents: Cents;
  employerCents: Cents;
  // The standing terms revision the payment was authorized under.
  mandateRef: string;
  mandateVersion: number;
}

// The current outcome of an accepted dispute's return request, derived
// from the purchase return state and per-leg attempt knowledge — never
// inferred from errors alone.
//   opened       — case recorded; no confirmed progress and nothing uncertain
//   unresolved   — a return is in progress or its outcome is uncertain
//   unsupported  — the settlement route reports returns unsupported
//   returned     — every settled share is confirmed returned
export type DisputeOutcome = 'opened' | 'unresolved' | 'unsupported' | 'returned';

// The employee's accepted dispute case on an Auto purchase: a request for
// the full-purchase return, not proof of one. openedAt records the first
// eligible request; the deadline itself lives on the receipt, so an
// accepted case may finish after the window closes.
export interface DisputeCase {
  employeeId: string;
  openedAt: number;
  outcome: DisputeOutcome;
}

// The internal coordinator record; never returned across the public seam —
// callers receive PurchaseView.
export interface Purchase {
  purchaseId: string;
  // Derived, never asserted: recomputed from the settlement snapshot after
  // every orchestrator call (see Coordinator.applySettlement).
  state: PurchaseState;
  // Why the purchase sits in 'draft' or 'failed', for display.
  reason?: string;
  benefit?: BenefitTerms;
  // Present on anonymous-charity purchases only: the matched donor
  // allowance's selected reference and donor (or the unmatched reason on a
  // buyer-only proposal) — coordinator evidence, separate from benefit
  // terms and never shown to recipients.
  charity?: CharityTerms;
  // Present on conditional-fund purchases only: the verified campaign and
  // the pledge history the funding decision owns, while the active shares
  // and authorizations below remain the coordinator-applied
  // materializations of it.
  funding?: FundingState;
  proposal: Proposal;
  // Authorizations that still bind the current proposal version, one per
  // payer: signed device/exception approvals, coordinator-recorded
  // evidence under the employee's signed standing terms, or — on a fund —
  // the signed pledge covering one contributor's share. Signed records are
  // verified at recording and again at initiation.
  authorizations: Authorization[];
  // The assessment this proposal was last evaluated under (benefit purchases
  // only): which zone the employee debit sits in, the standing terms that
  // produced it, and why it is not Auto. Refreshed on every mutation that
  // could change the answer; a point-in-time record, not authority itself.
  employeeAssessment?: EmployeeAssessment;
  legs: Leg[];
  // The submission intent frozen at admission: replayed with the same keys
  // and terms, and carrying per-leg dispatch knowledge independent of
  // returned execution references. Absent before submission or after a
  // conclusive pre-dispatch refusal rolled the intent back.
  submission?: Submission;
  // True while this purchase owns the ledger reservation under its
  // purchaseId: set when reserve() succeeds, cleared when released. A second
  // purchase reusing the same purchaseId must not touch this one's entry.
  benefitHeld?: boolean;
  // True while this purchase owns the ledger allowance reservation under
  // its purchaseId (charity purchases only): set when reserveAllowance()
  // succeeds, cleared when released. Same ownership discipline as
  // benefitHeld — a colliding purchaseId names another purchase's booking.
  charityHeld?: boolean;
  returnStatus: ReturnStatus;
  // The Auto receipt retained at the first completed observation of a
  // mandate-authorized purchase; absent on device/exception/split purchases.
  receipt?: AutopayReceipt;
  // The employee's dispute case, recorded once the first eligible request
  // is accepted; repeated requests resume the same case.
  dispute?: DisputeCase;
  // The latest settlement snapshot the orchestrator reported for the
  // admitted intent: detached evidence the purchase state, leg statuses,
  // receipts, disputes and budget effects are derived from — never the
  // coordinator's own guess (spec §7.1). Absent before the first submit.
  settlement?: SettlementSnapshot;
}

// Every field read-only, recursively: nested objects and arrays cannot be
// written through this type. Structural only — the live proxy behind
// Coordinator.view() is what enforces it.
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

// The caller-facing facet of a purchase: the record's live data, read-only.
export type PurchaseView = DeepReadonly<Purchase>;

// One line of the audit log shared by the coordinator and the settlement
// modules.
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
