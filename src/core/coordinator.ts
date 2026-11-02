// Deterministic multi-payer coordinator. It records each payer's authority
// (an approval of one exact proposal, or an employer mandate for a bounded
// contribution), submits contributions, and derives the purchase state only
// from authoritative backend status. It never retries with new keys, never
// shifts a failed share onto another payer, and never reports completion
// from a partial result.

import type { Authorization, BenefitTerms, Cents, DisputeOutcome, EmployeeAssessment, EmployeeMandate, Leg, PayerApproval, Proposal, Purchase, PurchaseState, PurchaseView, SettlementMode, Share, SubmissionLeg } from './types.ts';
import { readonlyView } from './live-view.ts';
import { ADOPTABLE, canTransition } from './states.ts';
import type { BenefitResult } from './policy.ts';
import { evaluateBenefit } from './policy.ts';
import { BenefitLedger, dayOf } from './ledger.ts';
import { AutoPayLedger, DEFAULT_CALENDAR_EPOCH, DEFAULT_DISPUTE_WINDOW_MINUTES, monthOf, validateCalendarSettings } from './autopay-ledger.ts';
import type { AutoPayBooking, AutoPayDelta } from './autopay-ledger.ts';
import type { ExecutionStatus, LegRequest, LegResponse, SettlementBackend, SubmitRequest } from '../settlement/backend.ts';
import { RequestRefusedError } from '../settlement/backend.ts';
import { PspUnavailableError } from '../settlement/psp.ts';
import type { KeyRegistry, Signed } from './signing.ts';
import type { AuthorityRegistry } from './authority.ts';
import { VerifiedAuthority } from './verified-authority.ts';
import { assessEmployeeAuthorization } from './employee-authority.ts';
import type { Trace } from '../evidence/trace.ts';

export interface ProposeInput {
  purchaseId: string;
  employeeId: string;
  merchantId: string;
  totalCents: Cents;
  // Payer fee the employee pays their PSP on top of their share; zero for
  // basic digital euro payments.
  feesCents?: Cents;
  // Reference to the employer mandate in the authority registry; the latest
  // published version is resolved and verified at proposal and initiation.
  mandateRef: string;
  expiresAt: number;
}

export interface QuoteInput {
  merchantId: string;
  totalCents: Cents;
  employeeId: string;
  // Payer fee the employee would pay their PSP on top of their share.
  feesCents?: Cents;
  // Reference to the employer mandate in the authority registry; the latest
  // published version is resolved and verified, as at proposal time.
  mandateRef: string;
}

// What a fresh purchase under these terms would draw today plus the current
// employee assessment: which authority the projected debit would need right
// now. A point-in-time answer, not a promise that budget or authority will
// still hold at proposal or initiation.
export interface QuoteResult extends BenefitResult {
  assessment: EmployeeAssessment;
}

// Rejection may stop the retained purchase without replacing its terms.
// Callers only update associated offer identity on 'replaced'.
export type OfferChange = { outcome: 'replaced' } | { outcome: 'failed'; reason: string };

export interface CoordinatorOptions {
  // Public keys of payers and employers, bound to their holders.
  keys: KeyRegistry;
  // The one authority registry: every employer allowance and every
  // employee's standing terms is published through it and read back from it.
  // The coordinator publishes and stores no authority itself — it reads the
  // registry and checks signatures again at every use.
  authority: AuthorityRegistry;
  now?: number;
  ledger?: BenefitLedger;
  // Fixture epoch the simulated-minute clock maps onto for calendar months;
  // default is the spec epoch 2026-01-01T00:00:00Z.
  calendarEpoch?: string;
  // Minutes after an Auto receipt during which a dispute may be opened.
  disputeWindowMinutes?: number;
  // Trusted routing data: which payers' PSP can carry mandate-initiated
  // payments. Absent means no payer is capable — automatic submission stays
  // off; it is not a SettlementBackend flag, so existing adapters are untouched.
  supportsMandatePaymentsFor?: (payerId: string) => boolean;
  // Per-payer initiation: each payer's PSP submits that payer's legs, and
  // status queries and returns go through the same PSP. Without it the
  // coordinator submits every leg to the backend in one call.
  initiation?: { pspFor: (payerId: string) => SettlementBackend; assemblyWindow: number };
}

export interface SplitInput {
  purchaseId: string;
  // Merchant of record: eligibility and display. Each share may pay a
  // different payee (multi-payee).
  merchantId: string;
  // feeCents: payer fee on top of the share, default 0.
  shares: { role: string; payerId: string; payeeId?: string; amountCents: Cents; feeCents?: Cents }[];
  expiresAt: number;
}

// Cents one role holds in a proposal.
export const shareCents = (q: Proposal, role: string): Cents =>
  q.shares.filter((s) => s.role === role).reduce((t, s) => t + s.amountCents, 0);

// What one payer's shares come to, whatever authorization basis covers them.
export const approvalCents = (q: Proposal, payerId: string): Cents =>
  q.shares.filter((s) => s.payerId === payerId && s.authority === 'payer').reduce((t, s) => t + s.amountCents, 0);

// The fees that payer owes alongside their amount.
export const approvalFeeCents = (q: Proposal, payerId: string): Cents =>
  q.shares.filter((s) => s.payerId === payerId && s.authority === 'payer').reduce((t, s) => t + s.feeCents, 0);

// Payers whose authorization the proposal needs, once each, in share order.
const approvers = (q: Proposal): string[] => [
  ...new Set(q.shares.filter((s) => s.authority === 'payer').map((s) => s.payerId)),
];

// Which payer an authorization record belongs to.
const authorizationPayer = (a: Authorization): string => (a.basis === 'mandate' ? a.payerId : a.approval.payload.payerId);

// Terms can change, and the purchase can be cancelled, only before submission.
const OPEN: PurchaseState[] = ['draft', 'awaiting_approvals', 'ready'];

const validateBenefitAmounts = (totalCents: Cents, feeCents: Cents): void => {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new Error('total must be positive integer cents within the safe range');
  if (!Number.isSafeInteger(feeCents) || feeCents < 0) throw new Error('fees must be non-negative integer cents within the safe range');
};

// A submission outcome. executionRef is absent when a PSP refused the leg
// before it reached the backend.
type Outcome = Omit<LegResponse, 'executionRef'> & { executionRef?: string };

export class Coordinator {
  private readonly backend: SettlementBackend;
  // Shared with the backend by caller convention: both write to it in call
  // order, so one trace tells the whole story of a run.
  private readonly trace: Trace;
  // Shared across purchases: the per-mandate record of benefit already drawn.
  readonly ledger: BenefitLedger;
  private readonly initiation?: CoordinatorOptions['initiation'];
  private readonly keys: KeyRegistry;
  // The shared authority registry. Publication is the trust decision — only
  // signed next-version records enter, and the registry audits them — but
  // every use still re-verifies the retained record and fails closed.
  private readonly authority: AuthorityRegistry;
  // The employee's monthly automatic-payment budget, shared by pending and
  // consumed purchases. Admission happens in submit(), consumption and
  // release in derive()/refund(); nothing outside the coordinator reads it.
  private readonly autopay: AutoPayLedger = new AutoPayLedger();
  // Calendar settings for the simulated-minute clock; see monthOf().
  readonly calendarEpoch: string;
  readonly disputeWindowMinutes: number;
  // Which payers' PSP can carry mandate-initiated payments (fixture routing
  // assumption, not provider evidence). Default: none.
  readonly supportsMandatePaymentsFor: (payerId: string) => boolean;
  // Every purchase this coordinator accepted, by purchaseId. Records are
  // internal to the coordinator; callers only ever see the view() facet.
  private readonly purchases = new Map<string, Purchase>();
  // One live view per record, so view(id) is identity-stable.
  private readonly viewCache = new WeakMap<Purchase, PurchaseView>();
  // Every payer of every open purchase: payerId → its open purchaseIds.
  // Written at exactly two points — commitProposal rebuilds the purchase's
  // entries from its current share payerIds, and transition removes them all
  // when the purchase leaves the open states. Entries therefore exist
  // exactly while a purchase is open.
  private readonly byPayer = new Map<string, Set<string>>();
  // Which purchase owns each execution reference the backend has returned.
  // A retry dedupes to the same purchase's execution; a response arriving
  // under another purchase means two purchases reused one purchaseId — a
  // caller bug the coordinator must not let arm a cross-purchase refund.
  private readonly execOwners = new Map<string, Purchase>();
  // A settlement call can yield while the purchase still has its previous
  // state. Own the whole operation, not just a state transition: concurrent
  // mutators must not release its benefit, replace its legs or apply stale
  // responses. Other purchases remain independent on this coordinator.
  private readonly inFlight = new Set<string>();
  // Purchases whose refresh was deferred while a settlement operation held
  // their guard; applied once the operation releases it.
  private readonly deferredRefresh = new Set<string>();
  // One diagnostic per unchanged failure streak. Deferred retries continue
  // so repaired authority heals; they do not append identical errors forever.
  private readonly refreshFailures = new Map<string, string>();
  // Revisions whose expiry was already logged once — the event fires at the
  // first mutating observation past the deadline, never from a quote.
  private readonly mandateExpiryLogged = new Set<string>();
  now: number;

  constructor(backend: SettlementBackend, trace: Trace, opts: CoordinatorOptions) {
    this.backend = backend;
    this.trace = trace;
    this.now = opts.now ?? 0;
    if (!Number.isFinite(this.now) || this.now < 0) {
      throw new Error('coordinator clock must start at finite nonnegative minutes');
    }
    this.ledger = opts.ledger ?? new BenefitLedger();
    this.initiation = opts.initiation;
    this.keys = opts.keys;
    this.authority = opts.authority;
    // Standing terms changed: refresh every open purchase of the publishing
    // employee. The subscription delivers the acceptance itself — no polling.
    opts.authority.subscribe((accepted) => {
      if (accepted.kind === 'employee') this.onStandingTermsAccepted(accepted.mandate.employeeId);
    });
    this.calendarEpoch = opts.calendarEpoch ?? DEFAULT_CALENDAR_EPOCH;
    this.disputeWindowMinutes = opts.disputeWindowMinutes ?? DEFAULT_DISPUTE_WINDOW_MINUTES;
    validateCalendarSettings(this.calendarEpoch, this.disputeWindowMinutes);
    // The starting instant must land on the calendar too.
    monthOf(this.now, this.calendarEpoch);
    this.supportsMandatePaymentsFor = opts.supportsMandatePaymentsFor ?? (() => false);
  }

  // Move the simulated clock forward. Time is monotonic within a world: to
  // replay earlier, start a fresh world rather than rewinding reservations
  // and deadlines. This is fixture time — no wall-clock or persistence
  // guarantee is implied.
  advance(t: number): void {
    if (!Number.isFinite(t) || t < this.now) throw new Error('the simulated clock can only advance');
    // Reject a target whose epoch-plus-minutes cannot be represented.
    monthOf(t, this.calendarEpoch);
    this.now = t;
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.trace.add('LOCAL', 'coordinator', event, detail);
  }

  // Which backend handles a payer's leg: their PSP, or the backend directly.
  private route(payerId: string): SettlementBackend {
    return this.initiation ? this.initiation.pspFor(payerId) : this.backend;
  }

  private requireIdle(p: Purchase): void {
    if (this.inFlight.has(p.purchaseId)) throw new Error('operation_in_progress');
  }

  // Acquire before the operation does any work, and release after its final
  // state/ledger updates, including errors and early returns. Refusals occur
  // outside the operation's catch blocks so they cannot undo its reservation.
  private async withOperation<T>(p: Purchase, action: () => Promise<T>): Promise<T> {
    this.requireIdle(p);
    this.inFlight.add(p.purchaseId);
    try {
      return await action();
    } finally {
      this.inFlight.delete(p.purchaseId);
      // Publication during this operation deferred its open-purchase refresh;
      // apply it now that the guard is released (spec §7).
      this.drainDeferredRefresh();
    }
  }

  private drainDeferredRefresh(): void {
    for (const id of [...this.deferredRefresh]) {
      if (this.inFlight.has(id)) continue;
      // A refresh that fails stays deferred — retried at the next drain —
      // rather than being dropped silently or masking the just-released
      // operation's outcome; one failing purchase must not starve the rest.
      if (this.tryRefreshAuth(this.get(id), 'deferred')) this.deferredRefresh.delete(id);
    }
  }

  // A refresh whose failure must not escape: the deferred drain calls it so
  // one purchase cannot abort the remaining refreshes or shadow the
  // operation result its finally is releasing, and submit's pre-dispatch
  // rollback calls it so a failing refresh cannot mask the refusal already
  // being reported. The failure is logged, never propagated — corrupted
  // retained authority still fails closed at every mutating path's own
  // refresh. Returns whether the refresh ran.
  private tryRefreshAuth(p: Purchase, during: 'rollback' | 'deferred' | 'publication'): boolean {
    try {
      this.refreshAuth(p);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.refreshFailures.get(p.purchaseId) === message) return false;
      this.refreshFailures.set(p.purchaseId, message);
      this.log('auth_refresh_failed', {
        purchaseId: p.purchaseId,
        during,
        message,
        now: this.now,
      });
      return false;
    }
  }

  // The record behind a purchaseId — private: a record never crosses the
  // public seam. Read access goes through view().
  private get(id: string): Purchase {
    const p = this.purchases.get(id);
    if (!p) throw new Error('unknown_purchase');
    return p;
  }

  // The caller-facing facet of a purchase: a live deep read-only view of the
  // record — reads always reflect it, every write throws.
  view(id: string): PurchaseView {
    const p = this.get(id);
    let v = this.viewCache.get(p);
    if (v === undefined) {
      v = readonlyView(p);
      this.viewCache.set(p, v);
    }
    return v;
  }

  // The open purchases this payer holds a share in, benefit and split
  // alike, in the order they were adopted. The byPayer index is eager —
  // entries exist exactly while a purchase is open — so an id here always
  // resolves through get().
  openFor(payerId: string): string[] {
    return [...(this.byPayer.get(payerId) ?? [])];
  }

  // The single write path for rec.state: a move to the current state is a
  // silent no-op, an unreachable pair throws illegal_transition, and every
  // real move assigns and logs in the same step, so the trace can never
  // drift from the record. Leaving the open states also drops every
  // byPayer entry — the index's second and only other write point, so
  // entries exist exactly while a purchase is open.
  private transition(rec: Purchase, to: PurchaseState, detail?: Record<string, unknown>): void {
    if (rec.state === to) return;
    if (!canTransition(rec.state, to)) throw new Error(`illegal_transition:${rec.state}→${to}`);
    const from = rec.state;
    rec.state = to;
    if (!OPEN.includes(to)) {
      for (const ids of this.byPayer.values()) ids.delete(rec.purchaseId);
    }
    this.log('state', { purchaseId: rec.purchaseId, from, to, ...detail, now: this.now });
  }

  // The insertion path — the only place a record enters the store. Adoption
  // asserts the id is free and the target ADOPTABLE: a purchase always enters
  // with its proposal already committed, never in 'draft'. The insertion
  // state event carries { to, reason } — no 'from'.
  private adopt(rec: Purchase, to: PurchaseState, reason: string): void {
    if (this.purchases.has(rec.purchaseId)) throw new Error('duplicate_purchase');
    if (!ADOPTABLE.includes(to)) throw new Error(`illegal_transition:adopt→${to}`);
    rec.state = to;
    this.purchases.set(rec.purchaseId, rec);
    this.log('state', { purchaseId: rec.purchaseId, to, reason, now: this.now });
  }

  // The single write path for rec.proposal and the whole per-commit tail:
  // validation, the version bump (versions start at 1 and move by exactly
  // 1), authorization invalidation, the benefit-side assessment evidence,
  // the open-state move — adoption for a seed, a transition for a live
  // record — and the proposal event, which always reports the post-commit
  // state and its cause. benefitCtx is computed by the caller BEFORE the
  // commit, because the blocked check must throw before any mutation:
  // a rejection preserves the prior proposal, or creates no record at all.
  // Splits carry no benefit terms and pass no benefitCtx.
  private commitProposal(
    seedOrRec: Purchase | { purchaseId: string; benefit?: BenefitTerms },
    next: Omit<Proposal, 'version'>,
    cause: 'proposed' | 'split' | 'offer_changed',
    benefitCtx?: {
      scope: VerifiedAuthority;
      record: Signed<EmployeeMandate> | undefined;
      assessment: EmployeeAssessment;
      ineligibleReason?: string;
    },
  ): Purchase {
    // For a seed the record literal is materialised here — proposal and
    // state are written only below, inside this function and adopt().
    const created = !('state' in seedOrRec);
    const rec: Purchase = created
      ? ({ ...seedOrRec, authorizations: [], legs: [], returnStatus: 'none' } as unknown as Purchase)
      : seedOrRec;
    // A payable proposal at the write-path boundary: a real merchant of
    // record, a positive safe-integer total, at least one share with
    // non-negative integer amounts and fees, and share amounts summing to
    // exactly the total. Nothing below a failed check may have mutated.
    if (!next.merchantId) throw new Error('proposal needs a merchant of record');
    if (!Number.isSafeInteger(next.totalCents) || next.totalCents <= 0) {
      throw new Error('total must be positive integer cents within the safe range');
    }
    if (next.shares.length === 0) throw new Error('proposal needs at least one share');
    for (const s of next.shares) {
      if (!Number.isInteger(s.amountCents) || s.amountCents < 0) {
        throw new Error('share amounts must be non-negative integer cents');
      }
      if (!Number.isInteger(s.feeCents) || s.feeCents < 0) {
        throw new Error('share fees must be non-negative integer cents');
      }
    }
    if (next.shares.reduce((t, s) => t + s.amountCents, 0) !== next.totalCents) {
      throw new Error('share amounts must sum to the proposal total');
    }
    rec.proposal = {
      ...next,
      shares: next.shares.map((s) => ({ ...s })),
      version: (rec.proposal?.version ?? 0) + 1,
    };
    // Authorizations bind to the previous version's exact terms, so none can
    // authorise this new offer.
    for (const a of rec.authorizations) {
      this.log(
        'approval_invalidated',
        a.basis === 'mandate'
          ? { payerId: a.payerId, basis: 'mandate', mandateRef: a.mandate.payload.mandateRef, mandateVersion: a.mandate.payload.version, now: this.now }
          : { approvalRef: a.approval.payload.approvalRef, payerId: a.approval.payload.payerId, basis: a.basis, now: this.now },
      );
    }
    rec.authorizations = [];
    if (benefitCtx !== undefined) {
      const t = rec.benefit!;
      const { assessment, record } = benefitCtx;
      rec.employeeAssessment = assessment;
      // Every proposal commit records the zone it was evaluated in.
      this.log('auth_zone', {
        purchaseId: rec.purchaseId,
        proposalVersion: rec.proposal.version,
        authZone: assessment.authZone,
        reason: assessment.autoPayBlockedReason,
        employeeDebitCents: assessment.employeeDebitCents,
        mandateRef: assessment.mandate?.mandateRef,
        mandateVersion: assessment.mandate?.version,
        now: this.now,
      });
      this.noteMandateExpiry(t.employeeId, record?.payload);
      // An Auto proposal acquires standing authorization immediately: the
      // recorded mandate evidence makes it ready without a per-purchase tap —
      // only while the employee holds no other live authority.
      if (
        assessment.authZone === 'Auto' &&
        record !== undefined &&
        !rec.authorizations.some((a) => authorizationPayer(a) === t.employeeId)
      ) {
        this.recordMandateAuthorization(rec, record);
      }
    }
    // The open state: 'ready' once every approver holds authority for their
    // shares, else 'awaiting_approvals'. A seed enters the store adopted
    // directly in that state; a live record moves by an ordinary transition.
    const to: PurchaseState = approvers(rec.proposal).every((id) => rec.authorizations.some((a) => authorizationPayer(a) === id))
      ? 'ready'
      : 'awaiting_approvals';
    if (created) this.adopt(rec, to, cause);
    else this.transition(rec, to);
    // A committed proposal clears any stale display reason (e.g. a former
    // blocked-merchant draft) — deleting keeps the record's own-property
    // set honest rather than carrying an undefined field.
    delete rec.reason;
    this.log('proposal', {
      purchaseId: rec.purchaseId,
      version: rec.proposal.version,
      merchantId: next.merchantId,
      totalCents: next.totalCents,
      shares: rec.proposal.shares.map((s) => `${s.role}:${s.amountCents}`),
      ...(benefitCtx !== undefined ? { ineligibleReason: benefitCtx.ineligibleReason } : {}),
      state: rec.state,
      cause,
    });
    // byPayer step 7: rebuild this purchase's index entries from the
    // committed shares, so an employer payer appearing or disappearing on a
    // re-price is reflected exactly. Entries live only while the purchase
    // is open — the post-commit state is always open (awaiting_approvals or
    // ready), and transition() removes them on the way out.
    const payers = new Set(rec.proposal.shares.map((s) => s.payerId));
    for (const [payerId, ids] of this.byPayer) {
      if (!payers.has(payerId)) ids.delete(rec.purchaseId);
    }
    for (const payerId of payers) {
      let ids = this.byPayer.get(payerId);
      if (ids === undefined) this.byPayer.set(payerId, (ids = new Set()));
      ids.add(rec.purchaseId);
    }
    return rec;
  }

  // An employer-benefit purchase: the policy splits the total between the
  // employee and the employer's mandate.
  propose(input: ProposeInput): Purchase {
    // A reused id is refused before any state or trace change.
    if (this.purchases.has(input.purchaseId)) throw new Error('duplicate_purchase');
    const terms: BenefitTerms = {
      employeeId: input.employeeId,
      employeeFeeCents: input.feesCents ?? 0,
      mandateRef: input.mandateRef,
    };
    const scope = this.decisionAuthority();
    // The benefit split resolves before any record exists: a fresh purchase
    // holds no reservation or booking, so nothing is excluded.
    const prepared = this.prepareBenefitProposal(terms, scope, input.merchantId, input.totalCents);
    // A blocked proposal is rejected before a purchase is created — the
    // rejection itself stays evidence, but no record is left behind.
    if (prepared.assessment.authZone === 'Blocked') {
      this.log('proposal_rejected', { purchaseId: input.purchaseId, merchantId: input.merchantId, reason: 'blocked_merchant', now: this.now });
      throw new Error('proposal rejected: merchant blocked by employee terms');
    }
    return this.commitProposal(
      { purchaseId: input.purchaseId, benefit: terms },
      { merchantId: input.merchantId, totalCents: input.totalCents, shares: prepared.shares, expiresAt: input.expiresAt },
      'proposed',
      { scope, record: prepared.record, assessment: prepared.assessment, ineligibleReason: prepared.ineligibleReason },
    );
  }

  // A purchase every payer approves for their own share: a bill split, a group
  // purchase, or one payer paying several payees. No benefit policy applies,
  // so the shares are taken as given and change only by proposing again.
  proposeSplit(input: SplitInput): Purchase {
    // A reused id is refused before any state or trace change.
    if (this.purchases.has(input.purchaseId)) throw new Error('duplicate_purchase');
    // The merchant of record is the default payee for shares that name none,
    // so it must be a real account id — refuse before any approval exists.
    if (!input.merchantId) throw new Error('split needs a merchant of record');
    if (input.shares.length === 0 || new Set(input.shares.map((s) => s.role)).size !== input.shares.length) {
      throw new Error('split shares need distinct roles');
    }
    if (input.shares.some((s) => !s.role || !s.payerId || s.payeeId === '')) {
      throw new Error('split shares need non-empty role, payer and payee');
    }
    if (input.shares.some((s) => !Number.isInteger(s.amountCents) || s.amountCents <= 0)) {
      throw new Error('split shares must be positive integer cents');
    }
    if (input.shares.some((s) => s.feeCents !== undefined && (!Number.isInteger(s.feeCents) || s.feeCents < 0))) {
      throw new Error('split fees must be non-negative integer cents');
    }
    const shares: Share[] = input.shares.map((s) => ({
      role: s.role,
      payerId: s.payerId,
      payeeId: s.payeeId ?? input.merchantId,
      amountCents: s.amountCents,
      feeCents: s.feeCents ?? 0,
      authority: 'payer',
    }));
    const totalCents = shares.reduce((t, s) => t + s.amountCents, 0);
    return this.commitProposal(
      { purchaseId: input.purchaseId },
      { merchantId: input.merchantId, totalCents, shares, expiresAt: input.expiresAt },
      'split',
    );
  }

  // What a fresh purchase under these terms would draw today, resolved and
  // verified against the latest mandate exactly as proposal and initiation
  // do. A projection, not a purchase: it reserves nothing, creates nothing
  // and appends nothing to the trace, so quoting twice shows the same answer.
  // Unlike benefitNow there is no purchase to exclude, so the quote counts
  // benefit other purchases already hold — including a pending reservation.
  quote(input: QuoteInput): QuoteResult {
    if (!input.merchantId) throw new Error('quote needs a merchant of record');
    if (!input.employeeId) throw new Error('quote needs an employee');
    if (!input.mandateRef) throw new Error('quote needs a mandate reference');
    const fee = input.feesCents ?? 0;
    validateBenefitAmounts(input.totalCents, fee);
    const scope = this.decisionAuthority();
    const b = this.resolveBenefit(
      {
        employeeId: input.employeeId,
        employeeFeeCents: fee,
        mandateRef: input.mandateRef,
      },
      scope,
      input.merchantId,
      input.totalCents,
    );
    // Read-only: assessment under current terms, usage and capability — a
    // point-in-time answer, never an authorization, reservation or trace.
    const record = scope.employee(input.employeeId);
    return {
      ...b,
      assessment: this.assessEmployee(input.employeeId, record, input.merchantId, b.employeeCents + fee),
    };
  }

  private benefitTerms(p: Purchase): BenefitTerms {
    if (!p.benefit) throw new Error('split purchases cannot be repriced; propose again');
    return p.benefit;
  }

  // The verified-authority scope for one synchronous decision: every
  // registry read and signature check the stretch needs, each computed on
  // first access and shared by every helper the decision composes. Never
  // carried across an await or into another operation.
  private decisionAuthority(): VerifiedAuthority {
    return new VerifiedAuthority(this.authority, this.keys);
  }

  // Deterministic split as of now for these terms, merchant and total,
  // counting benefit other purchases already hold today. One resolution for
  // every evaluation — proposal, initiation, resubmit and quote — so they
  // can never disagree about what the authority funds. excludePurchaseId
  // lets the purchase being re-evaluated ignore its own reservation; a
  // fresh-purchase projection excludes nothing.
  private resolveBenefit(t: BenefitTerms, scope: VerifiedAuthority, merchantId: string, totalCents: Cents, excludePurchaseId?: string): BenefitResult {
    const { mandate, problem } = scope.employer(t.mandateRef);
    if (!mandate) {
      // No usable authority: the employer contributes nothing, and the
      // employee decides whether to pay it all.
      return {
        employerCents: 0,
        employeeCents: totalCents,
        ineligibleReason: problem,
      };
    }
    return evaluateBenefit({
      totalCents,
      merchantId,
      beneficiaryId: t.employeeId,
      mandate,
      now: this.now,
      usedToday: this.ledger.usage(t.mandateRef, dayOf(this.now), excludePurchaseId),
    });
  }

  // The split for a real purchase, which never counts its own reservation
  // against itself: initiation and resubmit re-evaluate while the purchase
  // still holds the benefit it reserved. Used at proposal time, initiation
  // and resubmit.
  private benefitNow(p: Purchase, scope: VerifiedAuthority, merchantId: string, totalCents: Cents): BenefitResult {
    return this.resolveBenefit(this.benefitTerms(p), scope, merchantId, totalCents, p.purchaseId);
  }

  // The benefit-side half of a proposal commit, computed before
  // commitProposal may mutate anything: amounts validated, the split
  // resolved against current usage, the shares built, and the employee
  // assessment the caller needs for its blocked check — which must throw
  // before any mutation so a rejection preserves the prior proposal (or
  // creates no record at all). `exclude` lets a re-priced purchase ignore
  // its own ledger reservation and automatic booking; a fresh-purchase
  // proposal holds neither and excludes nothing.
  private prepareBenefitProposal(
    t: BenefitTerms,
    scope: VerifiedAuthority,
    merchantId: string,
    totalCents: Cents,
    exclude?: Purchase,
  ): { shares: Share[]; ineligibleReason?: string; assessment: EmployeeAssessment; record: Signed<EmployeeMandate> | undefined } {
    // A non-positive or fractional total would produce no payable legs, and
    // a vacuous all-settled check would mark it completed (vacuous-truth
    // family of B6): refuse at the proposal boundary.
    validateBenefitAmounts(totalCents, t.employeeFeeCents);
    // A proposal must name a merchant of record: eligibility and the payee
    // of every share are derived from it, so an empty id is refused here
    // just as proposeSplit() refuses it.
    if (!merchantId) throw new Error('proposal needs a merchant of record');
    const b = this.resolveBenefit(t, scope, merchantId, totalCents, exclude?.purchaseId);
    const record = scope.employee(t.employeeId);
    const assessment = this.assessEmployee(t.employeeId, record, merchantId, b.employeeCents + t.employeeFeeCents, exclude);
    // The employee share is listed even at zero: the employee still approves
    // the purchase. Zero shares never become legs. Without a usable mandate
    // there is no employer share at all.
    const shares: Share[] = [
      { role: 'employee', payerId: t.employeeId, payeeId: merchantId, amountCents: b.employeeCents, feeCents: t.employeeFeeCents, authority: 'payer' },
    ];
    const employer = scope.employer(t.mandateRef).mandate;
    if (employer) {
      shares.push({ role: 'employer', payerId: employer.employerId, payeeId: merchantId, amountCents: b.employerCents, feeCents: 0, authority: 'employer_mandate' });
    }
    return { shares, ineligibleReason: b.ineligibleReason, assessment, record };
  }

  // The employee's debit on the current proposal: their own shares plus the
  // fee they pay their PSP — the amount every employee threshold compares
  // against.
  private employeeDebitCents(p: Purchase): Cents {
    const t = this.benefitTerms(p);
    return p.proposal.shares
      .filter((s) => s.payerId === t.employeeId && s.authority === 'payer')
      .reduce((sum, s) => sum + s.amountCents + s.feeCents, 0);
  }

  // Whether the payer's settlement route can carry mandate-initiated
  // payments: the routed PSP's own flag when it exposes one (per-payer
  // initiation), otherwise the trusted direct-route lookup. Both read the
  // same fixture configuration; absent capability means false.
  private mandateCapable(payerId: string): boolean {
    const flag = (this.route(payerId) as { supportsMandatePayments?: unknown }).supportsMandatePayments;
    return typeof flag === 'boolean' ? flag : this.supportsMandatePaymentsFor(payerId);
  }

  // The deterministic zone/reason answer for this employee, merchant and
  // debit, under the verified standing record (or its absence), monthly
  // usage, the clock and the routed capability. The caller performs the
  // verified read once per decision and passes the same record through
  // assessment, expiry noting, refusal checks and evidence recording, so
  // they can never disagree about which terms are current. A later
  // decision point — submit's per-leg first-handoff recheck — reads fresh
  // rather than reusing the admission record. Invalid stored terms
  // propagate from that read as employee_mandate_invalid — never silently
  // absent. month overrides the usage month — a still-unsent leg's recheck
  // counts its admission month's budget, never the retry's own month.
  private assessEmployee(employeeId: string, record: Signed<EmployeeMandate> | undefined, merchantId: string, debitCents: Cents, excludeOwner?: Purchase, month?: string): EmployeeAssessment {
    // employeeId keys the monthly-usage lookup; a record belonging to
    // anyone else would pair one employee's usage with another's terms.
    if (record && record.payload.employeeId !== employeeId) throw new Error('assessment record does not belong to this employee');
    return assessEmployeeAuthorization({
      mandate: record?.payload,
      employeeDebitCents: debitCents,
      merchantId,
      monthlyUsageCents: this.autopay.usage(employeeId, month ?? monthOf(this.now, this.calendarEpoch), excludeOwner),
      now: this.now,
      mandateCapable: this.mandateCapable(employeeId),
    });
  }

  // The purchase's current assessment as a detached copy: no mutation, no
  // trace. Benefit purchases only — a split has no employee terms to assess.
  assess(p: Purchase): EmployeeAssessment {
    const employeeId = this.benefitTerms(p).employeeId;
    const record = this.decisionAuthority().employee(employeeId);
    return structuredClone(this.assessEmployee(employeeId, record, p.proposal.merchantId, this.employeeDebitCents(p), p));
  }

  // Read-only liveness of one recorded authorization: the same survival rule
  // refreshAuth applies, recomputed against the current verified standing
  // terms, so a projection never shows evidence superseded after recording
  // (a revoked or replaced mandate, lost Auto eligibility) as still valid.
  // Admitted authority uses its frozen booking month, as its first handoff
  // does; fresh assess()/quote() eligibility still uses the current month.
  // A projection looping over authorizations passes its own verified read as
  // `record` so the list shares one read instead of one per entry — the way
  // every internal decision already does. No mutation, no trace.
  authorizationCurrentlyValid(p: Purchase, a: Authorization, record?: Signed<EmployeeMandate>): boolean {
    const scope = this.decisionAuthority();
    const current = p.benefit ? (record ?? scope.employee(p.benefit.employeeId)) : undefined;
    return this.authorizationRefusal(
      p,
      a,
      p.benefit ? this.assessEmployee(p.benefit.employeeId, current, p.proposal.merchantId, this.employeeDebitCents(p), p, p.submission?.bookingMonth) : undefined,
      current,
      scope,
    ) === undefined;
  }

  // Whether the signed exception acknowledgment still matches the verified
  // standing terms and the independently computed debit: the mandate
  // reference and revision, the acknowledged maximum, and the exact overage.
  private exceptionAcknowledgmentValid(a: PayerApproval, assessment: EmployeeAssessment): boolean {
    const m = assessment.mandate;
    return (
      a.basis === 'exception' &&
      a.exception === true &&
      m !== undefined &&
      a.mandateRef === m.mandateRef &&
      a.mandateVersion === m.version &&
      a.maxCents === m.maxCents &&
      a.overByCents === assessment.employeeDebitCents - m.maxCents &&
      assessment.employeeDebitCents > m.maxCents
    );
  }

  // What the spec §5 invalidation table leaves of this authorization under
  // the current assessment and verified standing record: device approvals
  // survive while their exact signed terms are live, the merchant is
  // unblocked and the maximum still permits ordinary confirmation; an
  // exception survives only while its signed acknowledgment still matches
  // the current standing terms and the proposal is still Exception;
  // mandate evidence is re-evaluated, never carried forward. Both open-state
  // refreshes and deferred first handoffs use this decision, so revision
  // binding cannot differ between an observation and an actual initiation.
  private authorizationRefusal(
    p: Purchase,
    a: Authorization,
    assessment: EmployeeAssessment | undefined,
    record: Signed<EmployeeMandate> | undefined,
    scope: VerifiedAuthority,
  ): string | undefined {
    if (a.basis === 'mandate') {
      if (!scope.verify(a.mandate, a.payerId)) return `approval_signature_invalid:${a.payerId}`;
      if (assessment?.authZone === 'Blocked') return 'blocked_merchant';
      if (assessment?.authZone !== 'Auto' || !record) return 'not_auto_zone';
      if (a.mandate.payload.mandateRef !== record.payload.mandateRef || a.mandate.payload.version !== record.payload.version) {
        return 'employee_mandate_superseded';
      }
      if (a.payerId !== record.payload.employeeId || a.proposalVersion !== p.proposal.version || a.employeeDebitCents !== assessment.employeeDebitCents) {
        return 'terms_mismatch';
      }
      return undefined;
    }
    const s = a.approval;
    if (!scope.verify(s, s.payload.payerId)) return `approval_signature_invalid:${s.payload.payerId}`;
    if (s.payload.proposalVersion !== p.proposal.version) return 'terms_mismatch';
    if (this.now > s.payload.expiresAt) return `approval_expired:${s.payload.payerId}`;
    if (assessment?.authZone === 'Blocked') return 'blocked_merchant';
    if (a.basis === 'device') return assessment?.authZone === 'Exception' ? 'exceeds_mandate' : undefined;
    return assessment?.authZone === 'Exception' && this.exceptionAcknowledgmentValid(s.payload, assessment) ? undefined : 'exception_superseded';
  }

  // Log the expiry of standing automatic permission once per accepted
  // revision, at the first mutating observation past its deadline. A revoked
  // revision has no permission left to expire. Quotes never reach here.
  private noteMandateExpiry(employeeId: string, mandate: EmployeeMandate | undefined): void {
    if (!mandate || mandate.revoked || this.now <= mandate.validUntil) return;
    const key = `${employeeId}:${mandate.mandateRef}:${mandate.version}`;
    if (this.mandateExpiryLogged.has(key)) return;
    this.mandateExpiryLogged.add(key);
    this.log('employee_mandate_expired', { employeeId, mandateRef: mandate.mandateRef, version: mandate.version, now: this.now });
  }

  // The refresh every mutating path shares: recompute the purchase's
  // assessment under current standing terms, drop evidence the invalidation
  // table does not preserve, record fresh mandate evidence while the zone
  // stays Auto, and re-derive the open state. A blocked merchant leaves the
  // open purchase 'draft' with no authorizations. What must never happen
  // here is the budget reservation: evidence alone spends nothing — the
  // monthly budget is admitted atomically in submit().
  private refreshAuth(p: Purchase, scope: VerifiedAuthority = this.decisionAuthority()): void {
    if (!p.benefit || !OPEN.includes(p.state)) {
      this.refreshFailures.delete(p.purchaseId);
      return;
    }
    const t = p.benefit;
    const record = scope.employee(t.employeeId);
    const assessment = this.assessEmployee(t.employeeId, record, p.proposal.merchantId, this.employeeDebitCents(p), p);
    this.noteMandateExpiry(t.employeeId, record?.payload);
    const prev = p.employeeAssessment;
    p.employeeAssessment = assessment;
    const changed =
      !prev ||
      prev.authZone !== assessment.authZone ||
      prev.employeeDebitCents !== assessment.employeeDebitCents ||
      prev.autoPayBlockedReason !== assessment.autoPayBlockedReason ||
      prev.mandate?.version !== assessment.mandate?.version ||
      prev.mandate?.mandateRef !== assessment.mandate?.mandateRef;
    if (changed) {
      this.log('auth_zone', {
        purchaseId: p.purchaseId,
        proposalVersion: p.proposal.version,
        authZone: assessment.authZone,
        reason: assessment.autoPayBlockedReason,
        employeeDebitCents: assessment.employeeDebitCents,
        mandateRef: assessment.mandate?.mandateRef,
        mandateVersion: assessment.mandate?.version,
        now: this.now,
      });
    }
    const kept: Authorization[] = [];
    for (const a of p.authorizations) {
      if (this.authorizationRefusal(p, a, assessment, record, scope) === undefined) {
        kept.push(a);
        continue;
      }
      this.log(
        'approval_invalidated',
        a.basis === 'mandate'
          ? { payerId: a.payerId, basis: 'mandate', mandateRef: a.mandate.payload.mandateRef, mandateVersion: a.mandate.payload.version, now: this.now }
          : { approvalRef: a.approval.payload.approvalRef, payerId: a.approval.payload.payerId, basis: a.basis, now: this.now },
      );
    }
    p.authorizations = kept;
    this.refreshFailures.delete(p.purchaseId);
    if (assessment.authZone === 'Blocked') {
      // A later block makes the open purchase unpayable; unblocking requires
      // a fresh assessment and new authorization.
      this.transition(p, 'draft', { reason: 'blocked_merchant' });
      p.reason = 'blocked_merchant';
      return;
    }
    // An Auto proposal acquires standing authorization as coordinator-
    // recorded mandate evidence — only while the employee holds no other
    // live authority: a valid device signature is never converted into
    // mandate evidence nor silently replaced.
    if (
      assessment.authZone === 'Auto' &&
      record !== undefined &&
      !p.authorizations.some((a) => authorizationPayer(a) === t.employeeId)
    ) {
      this.recordMandateAuthorization(p, record);
    }
    p.reason = p.reason === 'blocked_merchant' ? undefined : p.reason;
    this.transition(
      p,
      approvers(p.proposal).every((id) => p.authorizations.some((a) => authorizationPayer(a) === id)) ? 'ready' : 'awaiting_approvals',
    );
  }

  // Standing authorization for an Auto proposal: the verified signed
  // mandate snapshot, bound to this proposal version and the exact debit.
  // No device or agent signature is fabricated for the purchase — the
  // record is evidence that current standing terms permit it; the monthly
  // budget it may spend is admitted atomically at submission.
  private recordMandateAuthorization(p: Purchase, record: Signed<EmployeeMandate>): void {
    // current() already returned a detached copy; it can be retained as-is.
    p.authorizations.push({
      basis: 'mandate',
      payerId: record.payload.employeeId,
      mandate: record,
      proposalVersion: p.proposal.version,
      employeeDebitCents: this.employeeDebitCents(p),
    });
    this.log('approval_recorded', {
      purchaseId: p.purchaseId,
      payerId: record.payload.employeeId,
      basis: 'mandate',
      mandateRef: record.payload.mandateRef,
      mandateVersion: record.payload.version,
      version: p.proposal.version,
      employeeDebitCents: this.employeeDebitCents(p),
      now: this.now,
    });
  }

  // The public refresh of Contract choice 3: refreshes an idle open purchase
  // under current standing terms — invalidates stale evidence. Submission
  // calls the same internal logic under its operation guard.
  refreshAuthorization(p: Purchase): void {
    this.requireIdle(p);
    this.refreshAuth(p);
  }

  // The offer changed before submission (expired, new price, new merchant).
  changeOffer(p: Purchase, offer: { merchantId: string; totalCents: Cents; expiresAt: number }): OfferChange {
    this.requireIdle(p);
    // Terms are locked once money may have moved; after submission the only
    // paths are reconcile, recover or refund.
    if (!OPEN.includes(p.state)) throw new Error(`cannot change offer in state ${p.state}; reconcile or recover first`);
    // Before replacing the offer, prove the employer can still fund the
    // retained promised contribution against the ORIGINAL proposal's
    // merchant and total. If it cannot, the purchase stops as 'failed' with
    // its original shares — the gap never moves onto the employee. A cheaper
    // replacement is not rejected merely because its total is below the old
    // employer contribution: the check runs on the old terms, and a proposal
    // that promised no employer share has nothing to check.
    const scope = this.decisionAuthority();
    const employerCents = shareCents(p.proposal, 'employer');
    if (p.benefit && employerCents > 0) {
      const b = this.benefitNow(p, scope, p.proposal.merchantId, p.proposal.totalCents);
      if (b.employerCents < employerCents) {
        const reason = `employer_authority_invalid:${b.ineligibleReason ?? 'cap_exceeded'}`;
        this.fail(p, reason);
        return { outcome: 'failed', reason };
      }
    }
    const prepared = this.prepareBenefitProposal(this.benefitTerms(p), scope, offer.merchantId, offer.totalCents, p);
    // A blocked proposal is rejected before anything mutates: the prior
    // valid proposal, its record and its authorizations stay as they were.
    if (prepared.assessment.authZone === 'Blocked') {
      this.log('proposal_rejected', { purchaseId: p.purchaseId, merchantId: offer.merchantId, reason: 'blocked_merchant', now: this.now });
      throw new Error('proposal rejected: merchant blocked by employee terms');
    }
    this.commitProposal(
      p,
      { merchantId: offer.merchantId, totalCents: offer.totalCents, shares: prepared.shares, expiresAt: offer.expiresAt },
      'offer_changed',
      { scope, record: prepared.record, assessment: prepared.assessment, ineligibleReason: prepared.ineligibleReason },
    );
    return { outcome: 'replaced' };
  }

  approve(p: Purchase, signed: Signed<PayerApproval>): void {
    this.requireIdle(p);
    // Every mutation refreshes first: standing terms, the clock and usage may
    // have moved since the last observation. One decision scope covers the
    // refresh and the incoming signature alike.
    const scope = this.decisionAuthority();
    this.refreshAuth(p, scope);
    const q = p.proposal;
    const a = signed.payload;
    // The approval must be signed by the payer it names, come from a payer
    // with an approval share, and echo every term of the current proposal. A
    // stale approval, bound to an earlier version, fails the version
    // comparison and is rejected here rather than silently applied.
    const sigOk = scope.verify(signed, a.payerId);
    const binds =
      approvers(q).includes(a.payerId) &&
      a.purchaseId === p.purchaseId &&
      a.proposalVersion === q.version &&
      a.merchantId === q.merchantId &&
      a.totalCents === q.totalCents &&
      a.amountCents === approvalCents(q, a.payerId) &&
      a.feeCents === approvalFeeCents(q, a.payerId) &&
      (a.basis === 'device' || a.basis === 'exception') &&
      // An approval may expire before the offer does, never after it.
      a.expiresAt <= q.expiresAt;
    const live = this.now <= a.expiresAt;
    let reason: string | undefined;
    if (p.state !== 'awaiting_approvals') reason = 'wrong_state';
    else if (!sigOk) reason = 'signature_invalid';
    else if (!binds) reason = 'terms_mismatch';
    else if (!live) reason = 'expired';
    // The exception basis is honored only where the current assessment is
    // Exception and the signed acknowledgment matches the verified standing
    // terms and the independently computed overage. A plain signature in
    // Exception is not authority at all.
    if (!reason && a.basis === 'exception') {
      if (p.employeeAssessment?.authZone !== 'Exception' || !this.exceptionAcknowledgmentValid(a, p.employeeAssessment)) {
        reason = 'terms_mismatch';
      }
    } else if (!reason && p.employeeAssessment?.authZone === 'Exception') {
      reason = 'exceeds_mandate';
    }
    if (reason) {
      this.log('approval_rejected', {
        approvalRef: a.approvalRef,
        payerId: a.payerId,
        state: p.state,
        reason,
        now: this.now,
      });
      throw new Error('approval does not match the current proposal');
    }
    // A payer may approve again; the newer approval replaces theirs.
    const auth: Authorization = { basis: a.basis, approval: signed };
    p.authorizations = [...p.authorizations.filter((x) => authorizationPayer(x) !== a.payerId), auth];
    this.log('approval_recorded', {
      purchaseId: p.purchaseId,
      approvalRef: a.approvalRef,
      payerId: a.payerId,
      keyId: signed.keyId,
      version: q.version,
      basis: a.basis,
      ...(a.basis === 'exception'
        ? { exception: true, mandateRef: a.mandateRef, mandateVersion: a.mandateVersion, overByCents: a.overByCents }
        : {}),
      now: this.now,
    });
    if (approvers(q).every((id) => p.authorizations.some((x) => authorizationPayer(x) === id))) this.transition(p, 'ready');
  }

  // New standing terms for an employee were accepted by the authority
  // registry: refresh every open purchase of that employee without bumping
  // its proposal — a mandate-only change must not touch signed payment
  // terms. The sweep visits every purchase the employee pays a share of,
  // benefit and split alike; a split's refresh is a no-op. A purchase whose
  // operation is in flight keeps its terms; its refresh is deferred until
  // the guard is released. Called through the registry subscription on
  // every accepted employee record.
  private onStandingTermsAccepted(employeeId: string): void {
    for (const id of this.openFor(employeeId)) {
      const q = this.get(id);
      if (this.inFlight.has(q.purchaseId)) {
        this.deferredRefresh.add(q.purchaseId);
        continue;
      }
      this.tryRefreshAuth(q, 'publication');
    }
  }

  // The employee's current verified standing terms as a detached record, or
  // undefined when they never published. Retained data whose signature no
  // longer verifies is invalid — reported as employee_mandate_invalid, never
  // silently treated as absence.
  employeeMandate(employeeId: string): Signed<EmployeeMandate> | undefined {
    return this.authority.employeeMandate(employeeId);
  }

  async submit(p: Purchase, mode: SettlementMode): Promise<void> {
    return this.withOperation(p, async () => {
      // Submission runs the same internal refresh as the public path, under
      // its operation guard: standing terms may have changed since approval.
      // One decision scope covers the whole admission stretch — refresh, the
      // evidence loops and the employer recheck share its verified reads.
      const scope = this.decisionAuthority();
      this.refreshAuth(p, scope);
      if (p.state !== 'ready') throw new Error(`cannot submit in state ${p.state}`);
      const q = p.proposal;

      // Authority is evaluated at the moment money would move: every signed
      // approval must still verify and still be within its expiry. The
      // verdicts themselves are this decision's — the refresh already
      // computed each of them, so the checks below consult the scope.
      for (const a of p.authorizations) {
        if (a.basis === 'mandate') continue;
        if (!scope.verify(a.approval, a.approval.payload.payerId)) {
          this.fail(p, `approval_signature_invalid:${a.approval.payload.payerId}`);
          return;
        }
        if (this.now > a.approval.payload.expiresAt) {
          this.fail(p, `approval_expired:${a.approval.payload.payerId}`);
          return;
        }
      }
      // Mandate evidence: the retained signed snapshot is verified again at
      // initiation. Defense-in-depth — the refresh above already dropped any
      // record whose signature, revision, proposal binding or Auto
      // eligibility went stale, so this loop is unreachable in practice.
      for (const a of p.authorizations) {
        if (a.basis !== 'mandate') continue;
        if (!scope.verify(a.mandate, a.payerId)) {
          this.fail(p, `employee_mandate_invalid:${a.payerId}`);
          return;
        }
      }
      // An offer that expired while the purchase waited fails initiation
      // without a send. Signed approvals can never outlive their proposal —
      // approve() binds expiresAt <= proposal.expiresAt — so reaching here
      // already proves their liveness; this check is for mandate evidence,
      // which carries no expiry of its own.
      if (this.now > q.expiresAt) {
        this.fail(p, 'offer_expired');
        return;
      }
      // Recheck employer authority at initiation: validity, revocation,
      // beneficiary, merchant and both caps, against today's usage. If the
      // employer can no longer fund its full approved share, stop: the gap must
      // never move onto the employee.
      // Assumes the only mandate-backed share is named 'employer' —
      // prepareBenefitProposal is the only share producer here. Revisit if a
      // mandate share gets another role.
      const employerCents = shareCents(q, 'employer');
      if (p.benefit && employerCents > 0) {
        const b = this.benefitNow(p, scope, q.merchantId, q.totalCents);
        if (b.employerCents < employerCents) {
          this.fail(p, `employer_authority_invalid:${b.ineligibleReason ?? 'cap_exceeded'}`);
          return;
        }
      }

      // Only shares with something to pay (amount or fee) become legs; each
      // carries the reference of the authority that funds it.
      const payable = q.shares.filter((s) => s.amountCents + s.feeCents > 0);
      p.legs = payable.map((s) => this.leg(p, s));

      // Freeze the exact submission at admission: a replay sends these values
      // — group, mode, request legs, the authority kind funding each leg and
      // the original assembly membership and deadline — never fresh terms,
      // fresh keys or a new assembly window.
      const submission = (p.submission = {
        groupRef: p.purchaseId,
        mode,
        legs: payable.map((s, i) => ({
          payerId: s.payerId,
          payeeId: s.payeeId,
          amountCents: s.amountCents,
          feeCents: s.feeCents,
          idempotencyKey: p.legs[i].idempotencyKey,
          authority: s.authority,
          ...(s.authority === 'employer_mandate'
            ? { employerMandate: structuredClone(scope.employer(this.benefitTerms(p).mandateRef).signed!) }
            : {}),
        })),
        assembly:
          this.initiation && mode === 'atomic'
            ? { size: p.legs.length, assembleBy: this.now + this.initiation.assemblyWindow }
            : undefined,
      });

      // Set only by this attempt's automatic-budget admission; the catch
      // emits its release when a later step of this same attempt refuses.
      let autoReserved:
        | { employeeId: string; mandateRef: string; mandateVersion: number; month: string; cents: Cents }
        | undefined;
      try {
        // The legs must add up to exactly what the merchant was promised. The
        // check is defensive — legs are built from the proposal's own shares —
        // but it sits inside the guarded section so a throw cannot leave legs
        // and intent populated on a repairable 'ready' purchase.
        if (p.legs.reduce((s, l) => s + l.amountCents, 0) !== q.totalCents) {
          throw new Error('contributions do not reconcile to merchant total');
        }
        // Atomic admission: the employee's monthly automatic budget (only
        // when mandate evidence funds the employee shares — a device or
        // exception payment never touches it) and the employer's benefit are
        // acquired in one synchronous stretch before the first send, with no
        // asynchronous gap in which another purchase could draw either
        // budget. A throw in either reservation is a pre-dispatch refusal
        // the catch below undoes.
        const mandateAuth = p.authorizations.find((a): a is Extract<Authorization, { basis: 'mandate' }> => a.basis === 'mandate');
        if (mandateAuth) {
          const own = q.shares.filter((s) => s.payerId === mandateAuth.payerId && s.authority === 'payer');
          const booking: AutoPayBooking = {
            purchaseId: p.purchaseId,
            proposalVersion: q.version,
            mandateRef: mandateAuth.mandate.payload.mandateRef,
            mandateVersion: mandateAuth.mandate.payload.version,
            employeeId: mandateAuth.payerId,
            month: monthOf(this.now, this.calendarEpoch),
            amountCents: own.reduce((t, s) => t + s.amountCents, 0),
            feeCents: own.reduce((t, s) => t + s.feeCents, 0),
            capCents: mandateAuth.mandate.payload.autoPayMonthlyCents,
          };
          this.autopay.reserve(p, booking);
          autoReserved = {
            employeeId: mandateAuth.payerId,
            mandateRef: booking.mandateRef,
            mandateVersion: booking.mandateVersion,
            month: booking.month,
            cents: booking.amountCents + booking.feeCents,
          };
          submission.bookingMonth = booking.month;
          this.log('autopay_reserved', { purchaseId: p.purchaseId, ...autoReserved, now: this.now });
        }
        // Hold the employer's benefit before any money moves, so a concurrent
        // purchase cannot draw the same benefit. A throw here (a conflicting
        // reservation under a reused purchaseId) is a pre-dispatch refusal:
        // no leg was handed off, so the catch below clears the just-built legs.
        if (p.benefit && employerCents > 0) {
          const ref = p.benefit.mandateRef;
          this.ledger.reserve(p.purchaseId, ref, dayOf(this.now), employerCents);
          p.benefitHeld = true;
          this.log('benefit_reserved', { mandateRef: ref, cents: employerCents });
        }
        // Record the mode before sending: resubmit() reuses it, so a retried
        // leg can never settle outside its atomic group (D7).
        p.mode = mode;
        this.log('submit', {
          purchaseId: p.purchaseId,
          mode,
          legs: p.legs.map((l) => `${l.leg}→${l.payeeId}:${l.amountCents}${l.feeCents > 0 ? `+fee${l.feeCents}` : ''}`),
        });
        this.apply(p, await this.send(p));
      } catch (err) {
        // send() normalizes post-handoff route errors into recorded outcomes
        // and rethrows only conclusive pre-forward refusals, so a throw
        // reaching here is presumed pre-dispatch: a conclusive
        // RequestRefusedError, an unroutable payer, a conflicting reservation,
        // a defensive inconsistency check. The dispatch flags are the real
        // gate: only when no leg may have been handed off does this attempt
        // roll back what it owns — the fresh reservations and the frozen
        // intent — leaving a repairable 'ready' purchase whose only way
        // forward is submit() and its full authority recheck. releaseBenefit
        // touches only this purchase's own entry: a reusing purchaseId must
        // not free another's benefit; autopay.rollback likewise removes only
        // this owner's unconsumed booking — never a terminal resolve. A leg
        // that may have moved retains everything instead.
        if (!submission.legs.some((l) => l.dispatch === 'forwarded')) {
          this.releaseBenefit(p);
          if (autoReserved) {
            this.autopay.rollback(p);
            this.log('autopay_released', {
              purchaseId: p.purchaseId,
              ...autoReserved,
              retainedCents: 0,
              // An admission-time undo, not a confirmed outcome: the attempt
              // proved nothing was handed off, so its hold is simply undone.
              reason: 'admission_rollback',
              now: this.now,
            });
          }
          p.legs = [];
          p.submission = undefined;
          p.mode = undefined;
          // Re-derive the open state honestly: an eligibility loss between
          // the last assessment and admission (another purchase took the
          // budget, a stale Auto decision) invalidates the evidence and
          // waits for the appropriate device action — no send, no reprice.
          // Guarded: a failing refresh (corrupted retained authority surfaces
          // as employee_mandate_invalid) is logged, never allowed to mask the
          // refusal this catch is already reporting.
          this.tryRefreshAuth(p, 'rollback');
        }
        throw err;
      }
    });
  }

  // Simulates a network retry of the same submission: same idempotency keys,
  // same settlement mode, same frozen request. It retries an in-flight
  // submission ('pending') or re-delivers a finished one ('completed', where
  // the backend dedupes). Every other state is terminal, pre-submission, or
  // 'recovery_required', whose only exit is recover() — reopening any of them
  // could commit money after the purchase was already accounted for.
  async resubmit(p: Purchase): Promise<void> {
    return this.withOperation(p, async () => {
      if (p.legs.length === 0 || !p.submission) throw new Error('nothing to resubmit');
      if (p.state !== 'pending' && p.state !== 'completed') {
        throw new Error(`cannot resubmit in state ${p.state}`);
      }
      // A leg already handed off replays under its frozen authorization —
      // absence of an executionRef is not absence of dispatch — while a leg
      // conclusively refused before forwarding is a first handoff and is
      // revalidated immediately before its route call (inside send()).
      this.log('resubmit_same_keys');
      this.apply(p, await this.send(p));
    });
  }

  // The request-leg projection of a frozen submission leg: the descriptor's
  // dispatch and authority fields never reach the settlement route.
  private static requestLeg(l: SubmissionLeg): LegRequest {
    return { payerId: l.payerId, payeeId: l.payeeId, amountCents: l.amountCents, feeCents: l.feeCents, idempotencyKey: l.idempotencyKey };
  }

  // The authority a still-unsent leg must hold immediately before its first
  // handoff: the payer's own live approval, or employer authority still able
  // to fund the promised share — the same recheck submit() runs at admission.
  // Returns the refusal reason, or undefined when the leg may be sent.
  private firstHandoffRefusal(p: Purchase, leg: SubmissionLeg): string | undefined {
    // A deferred first handoff is its own decision point, deliberately not
    // the admission's: it verifies against whatever the registry holds now.
    const scope = this.decisionAuthority();
    if (leg.authority === 'employer_mandate') {
      // The offer may have died while the leg waited for its route: an
      // approval can never outlive its proposal (approve() binds
      // expiresAt <= proposal.expiresAt), but a mandate can — so the offer
      // check is needed only here, before the authority recheck.
      if (this.now > p.proposal.expiresAt) return 'offer_expired';
      const b = this.benefitNow(p, scope, p.proposal.merchantId, p.proposal.totalCents);
      if (b.employerCents < shareCents(p.proposal, 'employer')) {
        return `employer_authority_invalid:${b.ineligibleReason ?? 'cap_exceeded'}`;
      }
      // benefitNow verified these exact current terms in this synchronous
      // stretch. A deferred first handoff may use newer employer terms than
      // admission did; once forwarded, send() never replaces this evidence.
      leg.employerMandate = structuredClone(scope.employer(this.benefitTerms(p).mandateRef).signed!);
      return undefined;
    }
    // A payer-funded leg dispatches under its current authorization record:
    // the signature still verifies, the approval is live, and the retained
    // restrictions still permit the basis it was recorded under.
    const a = p.authorizations.find((x) => authorizationPayer(x) === leg.payerId);
    if (!a) return `approval_signature_invalid:${leg.payerId}`;
    if (a.basis === 'mandate' && this.now > p.proposal.expiresAt) return 'offer_expired';
    // The same authorization decision used by refresh and read-only views,
    // evaluated against the admission month for an automatic first handoff.
    const record = p.benefit ? scope.employee(p.benefit.employeeId) : undefined;
    if (p.benefit) this.noteMandateExpiry(p.benefit.employeeId, record?.payload);
    return this.authorizationRefusal(
      p,
      a,
      p.benefit ? this.assessEmployee(p.benefit.employeeId, record, p.proposal.merchantId, this.employeeDebitCents(p), p, p.submission?.bookingMonth) : undefined,
      record,
      scope,
    );
  }

  // Forward the frozen submission through its route(s) and turn every route
  // error into a recorded outcome: a conclusive pre-forward refusal is a
  // 'rejected' leg (or, for the whole-request route, is rethrown so the
  // caller can roll back what the attempt newly owns); a generic error is
  // indistinguishable from a lost response and records 'unknown'. A failed
  // replay never overwrites an earlier settled/rejected/returned result —
  // the refusal of a retry says nothing new about money already handed off.
  private async send(p: Purchase): Promise<Outcome[]> {
    const sub = p.submission!;
    // Resolve every route before the first send: an unroutable payer is a
    // fixture error and must fail loudly before anything is forwarded, not
    // surface as an 'unknown' leg that can never resolve.
    const targets = new Map(sub.legs.map((l) => [l.payerId, this.route(l.payerId)] as const));
    const out: Outcome[] = [];

    if (!this.initiation) {
      // The request is the unit of dispatch: all legs forward in one call, so
      // the admission-time authority check already ran immediately before it.
      try {
        const responses = await this.backend.submit({ groupRef: sub.groupRef, mode: sub.mode, legs: sub.legs.map(Coordinator.requestLeg) });
        for (const l of sub.legs) l.dispatch = 'forwarded';
        return responses;
      } catch (err) {
        // A conclusive refusal proves the request never moved: surface it so
        // the caller can roll back only what this attempt owns.
        if (err instanceof RequestRefusedError) throw err;
        // Any other failure is indistinguishable from a lost response: every
        // leg may have been handed off — 'unknown', never a fabricated
        // terminal status. Legs already forwarded keep their outcomes.
        this.log('submit_leg_error', { message: err instanceof Error ? err.message : String(err) });
        for (const l of sub.legs) {
          if (l.dispatch === 'forwarded') continue;
          l.dispatch = 'forwarded';
          out.push({ idempotencyKey: l.idempotencyKey, status: 'unknown' });
        }
        return out;
      }
    }

    // Each PSP submits only its own payer's leg. In atomic mode the backend
    // assembles the group by the admission deadline; independent legs are
    // separate payments.
    for (const leg of sub.legs) {
      // Validation is conclusively before the route call. A throwing check
      // must not manufacture a handoff that lets the next retry bypass it.
      // Keep outcomes already collected for other legs; derive them together.
      if (leg.dispatch !== 'forwarded') {
        let refusal: string | undefined;
        try {
          refusal = this.firstHandoffRefusal(p, leg);
        } catch (err) {
          refusal = 'auth_recheck_failed';
          this.log('auth_recheck_failed', {
            purchaseId: p.purchaseId, payerId: leg.payerId,
            message: err instanceof Error ? err.message : String(err), now: this.now,
          });
        }
        if (refusal) {
          leg.dispatch = 'refused';
          out.push({ idempotencyKey: leg.idempotencyKey, status: 'rejected', reason: refusal });
          continue;
        }
      }
      try {
        const req: SubmitRequest = { groupRef: sub.groupRef, mode: sub.mode, legs: [Coordinator.requestLeg(leg)] };
        if (sub.assembly) req.assembly = sub.assembly;
        const wasRefused = leg.dispatch === 'refused';
        const responses = await targets.get(leg.payerId)!.submit(req);
        leg.dispatch = 'forwarded';
        out.push(...responses);
        // A leg refused before reaching its route was just handed off: when
        // the response names no outcome for it, it may still have been
        // processed — record 'unknown' so reconcile() and later replays see it,
        // rather than leaving committed money on a leg recorded as rejected. A
        // leg already forwarded keeps its recorded outcome; a never-sent leg's
        // missing outcome is promoted by apply().
        if (wasRefused && !responses.some((r) => r.idempotencyKey === leg.idempotencyKey)) {
          this.log('submit_leg_error', { payerId: leg.payerId, message: 'no outcome returned for leg' });
          out.push({ idempotencyKey: leg.idempotencyKey, status: 'unknown' });
        }
      } catch (err) {
        // A failed replay says nothing new about a leg that already reached
        // the route — it keeps its last known outcome. Reporting 'rejected'
        // would fabricate a terminal status over money that may still settle;
        // downgrading a conclusive 'rejected' or 'settled' would hide it. The
        // error still reaches the trace: a silent retry failure over a
        // handed-off leg is evidence.
        if (leg.dispatch === 'forwarded') {
          this.log('submit_leg_error', {
            payerId: leg.payerId,
            message: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (err instanceof PspUnavailableError) {
          // The PSP refused before forwarding: conclusively not submitted —
          // a replay of this leg is again a first handoff.
          leg.dispatch = 'refused';
          out.push({ idempotencyKey: leg.idempotencyKey, status: 'rejected', reason: 'psp_unavailable' });
        } else if (err instanceof RequestRefusedError) {
          // The backend conclusively refused the request: the leg can never
          // be submitted, so 'rejected' is honest — 'unknown' would leave a
          // dead end no status query can resolve.
          leg.dispatch = 'refused';
          out.push({ idempotencyKey: leg.idempotencyKey, status: 'rejected', reason: err.message });
        } else {
          // Any other failure mid-forward is indistinguishable from a lost
          // response: the leg may have reached the backend — 'unknown',
          // never a fabricated terminal status.
          leg.dispatch = 'forwarded';
          this.log('submit_leg_error', {
            payerId: leg.payerId,
            message: err instanceof Error ? err.message : String(err),
          });
          out.push({ idempotencyKey: leg.idempotencyKey, status: 'unknown' });
        }
      }
    }
    return out;
  }

  // The reference of the authority funding this share, recorded on the leg so
  // every euro traces back to a specific grant. '!' holds because legs are
  // built only in submit() from 'ready' — a state entered only once every
  // approval-backed share's payer has a recorded approval.
  private authorityRef(p: Purchase, s: Share): string {
    if (s.authority === 'employer_mandate') return this.benefitTerms(p).mandateRef;
    const a = p.authorizations.find((x) => authorizationPayer(x) === s.payerId)!;
    return a.basis === 'mandate' ? a.mandate.payload.mandateRef : a.approval.payload.approvalRef;
  }

  private leg(p: Purchase, s: Share): Leg {
    return {
      leg: s.role,
      payerId: s.payerId,
      payeeId: s.payeeId,
      amountCents: s.amountCents,
      feeCents: s.feeCents,
      authorityRef: this.authorityRef(p, s),
      // Keyed by purchase, proposal version and role: a retry of the same
      // submission reuses the key and is deduped by the backend, while a
      // changed proposal produces new keys only after renewed approval. The
      // coordinator never mints a fresh key just to retry.
      idempotencyKey: `${p.purchaseId}:v${p.proposal.version}:${s.role}`,
      status: 'planned',
    };
  }

  private apply(p: Purchase, responses: Outcome[]): void {
    for (const r of responses) {
      const l = p.legs.find((x) => x.idempotencyKey === r.idempotencyKey);
      // An outcome naming a key this submission never sent is a backend
      // contract violation: record it and ignore it — the real legs may still
      // have moved, so crashing here would strand their accounting.
      if (!l) {
        this.log('submit_leg_error', { message: `outcome for unknown key ${r.idempotencyKey}` });
        continue;
      }
      // A leg already returned keeps that record: a late duplicate response
      // must not overwrite the return with the original settlement.
      if (l.status === 'returned') continue;
      if (r.executionRef !== undefined) {
        const owner = this.execOwners.get(r.executionRef);
        if (owner === undefined) this.execOwners.set(r.executionRef, p);
        else if (owner !== p) {
          // The key deduped into another purchase's execution: this leg did
          // not pay for this purchase. Marking it 'rejected' fails a partial
          // collision loudly — recording the reference would let recover()
          // or reconcile() act on money that belongs to the other purchase.
          this.log('foreign_execution_refused', { executionRef: r.executionRef, owner: owner.purchaseId });
          l.status = 'rejected';
          l.rejectReason = 'execution_owned_by_another_purchase';
          continue;
        }
      }
      // executionRef is kept for later status queries and returns. A PSP that
      // refused to forward produced no reference; keep any earlier one.
      l.executionRef = r.executionRef ?? l.executionRef;
      l.status = r.status;
      l.rejectReason = r.reason;
    }
    // A leg with no outcome at all may still have been processed by the
    // backend — 'unknown', never left 'planned' where derive() ignores it.
    for (const l of p.legs) {
      if (l.status === 'planned') {
        this.log('submit_leg_error', { payerId: l.payerId, message: 'no outcome returned for leg' });
        l.status = 'unknown';
      }
    }
    this.derive(p);
  }

  // Ask the backend for authoritative status of every unresolved leg. Only
  // 'unknown' legs are queried — settled and rejected are final — and the
  // backend's answer is taken as truth.
  async reconcile(p: Purchase): Promise<void> {
    return this.withOperation(p, async () => {
      // With nothing submitted there is nothing to query — and deriving a state
      // from zero legs would report 'completed' on a vacuous all-settled check.
      if (p.legs.length === 0) throw new Error('nothing to reconcile');
      for (const l of p.legs) {
        if (l.status !== 'unknown' || !l.executionRef) continue;
        try {
          l.status = await this.route(l.payerId).status(l.executionRef);
        } catch (err) {
          // An unreachable PSP says nothing about the leg: it stays 'unknown'
          // and the remaining legs are still queried.
          if (!(err instanceof PspUnavailableError)) throw err;
        }
      }
      this.log('reconciled', { legs: p.legs.map((l) => `${l.leg}:${l.status}`) });
      this.derive(p);
    });
  }

  // Only the purchase that made a reservation may consume or release it:
  // keyed by purchaseId, the ledger entry could belong to a different
  // purchase that reused the id.
  private releaseBenefit(p: Purchase): void {
    if (!p.benefitHeld) return;
    this.ledger.release(p.purchaseId);
    p.benefitHeld = false;
  }

  // The purchase state is derived from leg statuses alone — it cannot be
  // asserted by a caller, and there is no path to 'completed' that skips a leg.
  //   any unknown                → pending (a timeout is not a failure)
  //   all settled                → completed
  //   all rejected               → failed (nothing committed, nothing to undo)
  //   some settled, some not     → recovery_required (committed money visible)
  //   only rejected and returned → cancelled (every obligation resolved)
  private derive(p: Purchase): void {
    // A returned leg of a completed purchase still counts as settled: refund()
    // keeps the purchase 'completed' and records the return separately, so a
    // later derive pass must not relabel it 'cancelled' or 'recovery_required'.
    const st = p.legs.map((l) => (p.state === 'completed' && l.status === 'returned' ? 'settled' : l.status));
    const before = p.state;
    const next: PurchaseState = st.some((s) => s === 'unknown')
      ? 'pending'
      : st.every((s) => s === 'settled')
        ? 'completed'
        : st.every((s) => s === 'rejected')
          ? 'failed'
          : st.some((s) => s === 'settled')
            ? 'recovery_required'
            : st.every((s) => s === 'rejected' || s === 'returned')
              ? 'cancelled'
              : p.state;
    // Every derive move carries the committed amount, as the state log always
    // did: money at risk stays visible in the trace. A completed purchase has
    // nothing outstanding by definition.
    this.transition(p, next, { outstandingCents: next === 'completed' ? 0 : this.outstandingCents(p) });
    // The benefit is used once the purchase completes and handed back once
    // nothing is committed; pending and recovering purchases keep it
    // reserved. Only the purchase holding the reservation may consume or
    // release it — under a reused purchaseId the entry could be another
    // purchase's benefit.
    if (p.state === 'completed' && p.benefitHeld) this.ledger.consume(p.purchaseId);
    else if (p.state === 'failed' || p.state === 'cancelled') this.releaseBenefit(p);
    // Automatic-budget accounting follows the authoritative outcome: a
    // completed purchase consumes its reservation once; a conclusive
    // no-debit failure or a fully resolved recovery releases it, retaining
    // only an actually charged fee. Pending and recovery hold — a timeout
    // or a generic error never releases the booking.
    if (p.state === 'completed') {
      this.logAutoPayDelta(this.autopay.consume(p));
    } else if (p.state === 'failed' || p.state === 'cancelled') {
      this.logAutoPayDelta(this.autopay.resolve(p, this.retainedAutoFeeCents(p)));
    }
    this.noteAutopayReceipt(p);
    // Staying in recovery is not a transition; re-report the outstanding
    // amount on every derive pass so money at risk stays visible.
    if (before === 'recovery_required' && p.state === 'recovery_required') {
      this.log('state', { purchaseId: p.purchaseId, from: before, to: p.state, outstandingCents: this.outstandingCents(p), now: this.now });
    }
  }

  // The one Auto receipt a purchase earns (spec §9): retained at the first
  // observation of full completion under mandate authorization, with the
  // standing-terms revision that funded the payment, the original amounts
  // and a dispute deadline fixed at receiptAt + the configured window.
  // Observation time is used because the backend exposes no settlement
  // timestamp. A device or exception payment earns none, and a replayed or
  // late duplicate outcome never reissues or extends it.
  private noteAutopayReceipt(p: Purchase): void {
    if (p.state !== 'completed' || p.receipt !== undefined || !p.benefit) return;
    const auth = p.authorizations.find((a): a is Extract<Authorization, { basis: 'mandate' }> => a.basis === 'mandate');
    if (!auth) return;
    const t = p.benefit;
    const own = p.proposal.shares.filter((s) => s.payerId === t.employeeId && s.authority === 'payer');
    const amountCents = own.reduce((sum, s) => sum + s.amountCents, 0);
    const feeCents = own.reduce((sum, s) => sum + s.feeCents, 0);
    p.receipt = {
      purchaseId: p.purchaseId,
      proposalVersion: p.proposal.version,
      merchantId: p.proposal.merchantId,
      employeeId: t.employeeId,
      receiptAt: this.now,
      disputeUntil: this.now + this.disputeWindowMinutes,
      amountCents,
      feeCents,
      debitCents: amountCents + feeCents,
      totalCents: p.proposal.totalCents,
      employerCents: shareCents(p.proposal, 'employer'),
      mandateRef: auth.mandate.payload.mandateRef,
      mandateVersion: auth.mandate.payload.version,
    };
    this.log('autopay_receipt', { ...p.receipt });
  }

  // The employee fee actually charged and never returned, as far as leg
  // statuses prove it: a returned leg was settled first, so its fee was
  // charged and — with principal-only returns — never came back.
  private retainedAutoFeeCents(p: Purchase): Cents {
    const employeeLeg = p.legs.find((l) => l.leg === 'employee');
    return employeeLeg?.status === 'returned' ? employeeLeg.feeCents : 0;
  }

  // One trace event per real accounting change; the ledger reports
  // undefined for a repeat or an owner that never reserved, so nothing is
  // logged twice or for purchases that never held automatic budget.
  private logAutoPayDelta(d: AutoPayDelta | undefined): void {
    if (!d) return;
    if (d.kind === 'consumed') {
      this.log('autopay_consumed', {
        purchaseId: d.purchaseId,
        employeeId: d.employeeId,
        mandateRef: d.mandateRef,
        mandateVersion: d.mandateVersion,
        month: d.month,
        cents: d.cents,
        now: this.now,
      });
    } else {
      this.log('autopay_released', {
        purchaseId: d.purchaseId,
        employeeId: d.employeeId,
        mandateRef: d.mandateRef,
        mandateVersion: d.mandateVersion,
        month: d.month,
        cents: d.cents,
        retainedCents: d.retainedCents,
        // A confirmed rejection or return restored the budget — the terminal
        // counterpart of the 'admission_rollback' undo in submit().
        reason: 'resolved',
        now: this.now,
      });
    }
  }

  // Money committed by a payer that is neither part of a completed purchase nor returned.
  outstandingCents(p: Purchase): Cents {
    if (p.state === 'completed') return 0;
    return p.legs.filter((l) => l.status === 'settled').reduce((s, l) => s + l.amountCents, 0);
  }

  // Return every settled leg of an incomplete purchase to its original payer.
  // This is the only way out of 'recovery_required': never a speculative
  // second payment, and never shifting the failed share onto another payer.
  async recover(p: Purchase): Promise<void> {
    return this.withOperation(p, async () => {
      if (p.state !== 'recovery_required') throw new Error(`nothing to recover in state ${p.state}`);
      await this.returnSettledLegs(p);
      // A backend without returns is a finding, not a dead end: the purchase
      // stays 'recovery_required' and the outstanding amount stays visible.
      if (p.returnStatus === 'unsupported') {
        this.log('recovery_unsupported', { outstandingCents: this.outstandingCents(p) });
        return;
      }
      this.derive(p);
    });
  }

  // Full refund after completion, each share back to whoever paid it. The
  // purchase stays 'completed' — the return is recorded separately in
  // returnStatus and the legs' 'returned' status.
  async refund(p: Purchase): Promise<void> {
    return this.withOperation(p, async () => {
      if (p.state !== 'completed') throw new Error(`cannot refund in state ${p.state}`);
      const wasCompleted = p.returnStatus === 'completed';
      await this.returnSettledLegs(p);
      if (p.returnStatus === 'completed') {
        // A returned purchase gives the benefit back, and its automatic
        // booking resolves to the confirmed retained fee — an unreturned
        // or uncertain return holds the reservation instead.
        this.releaseBenefit(p);
        this.logAutoPayDelta(this.autopay.resolve(p, this.retainedAutoFeeCents(p)));
        // The event marks the return this call confirmed; a repeat after
        // completion changed nothing and must not re-report it.
        if (!wasCompleted) this.log('refund_completed', { legs: p.legs.map((l) => `${l.leg}:${l.status}`) });
      }
    });
  }

  // The employee's dispute on a completed Auto purchase (spec §9): a trusted
  // request for the existing full-purchase return — every settled share
  // back to its original payer, including the employer — not a unilateral
  // employee-only refund and never proof a return happened. employeeId is
  // the session's authenticated principal, never a raw agent parameter. A
  // first request must land by the receipt's fixed deadline; an accepted
  // case may resume an incomplete return after the window closes.
  async dispute(p: Purchase, employeeId: string): Promise<DisputeOutcome> {
    return this.withOperation(p, async () => {
      const reject = (reason: string): never => {
        this.log('dispute_rejected', {
          purchaseId: p.purchaseId,
          proposalVersion: p.proposal.version,
          employeeId,
          reason,
          // Carried only once a receipt exists: earlier rejections have no
          // mandate revision to report.
          mandateRef: p.receipt?.mandateRef,
          mandateVersion: p.receipt?.mandateVersion,
          now: this.now,
        });
        throw new Error(`dispute rejected: ${reason}`);
      };
      // The caller must be the purchase's own employee: nobody else may ask
      // for its return, and a purchase with no employee owner is ineligible.
      if (p.benefit?.employeeId !== employeeId) reject('wrong_employee');
      // Only a mandate-authorized completed purchase carries a receipt; a
      // device or exception payment keeps the plain refund route.
      if (!p.receipt) reject('no_receipt');
      if (p.state !== 'completed') reject('not_completed');
      // The window gates opening a new case only: a case already accepted
      // may finish after the deadline, which itself never moves.
      if (p.dispute === undefined && this.now > p.receipt.disputeUntil) reject('dispute_window_expired');
      if (p.dispute === undefined) {
        p.dispute = { employeeId, openedAt: this.now, outcome: 'opened' };
        this.log('dispute_opened', {
          purchaseId: p.purchaseId,
          proposalVersion: p.proposal.version,
          employeeId,
          openedAt: this.now,
          disputeUntil: p.receipt.disputeUntil,
          mandateRef: p.receipt.mandateRef,
          mandateVersion: p.receipt.mandateVersion,
        });
      }
      // The shared private return implementation under this operation's own
      // guard — never the public refund(), which would deadlock on it.
      const wasCompleted = p.returnStatus === 'completed';
      await this.returnSettledLegs(p);
      if (p.returnStatus === 'completed') {
        // Opening a dispute alone releases nothing: only the confirmed
        // full return resolves the benefit and the automatic booking.
        this.releaseBenefit(p);
        this.logAutoPayDelta(this.autopay.resolve(p, this.retainedAutoFeeCents(p)));
        // The event marks the return this call confirmed; a repeat after
        // completion changed nothing and must not re-report it.
        if (!wasCompleted) this.log('refund_completed', { legs: p.legs.map((l) => `${l.leg}:${l.status}`) });
      }
      return p.dispute.outcome;
    });
  }

  // Recompute the accepted case's request outcome from what is actually
  // known and log dispute_updated for every later change — including the
  // changes out-of-band refund()/recover() calls make to the same case.
  // A request that stays 'unresolved' is logged on each call: the case is
  // still open and its return remains outstanding.
  private noteDisputeOutcome(p: Purchase): void {
    if (p.dispute === undefined) return;
    // returnSettledLegs owns the summary of current per-leg facts, including
    // progress made before an error. An error alone is never 'unsupported'.
    const outcome: DisputeOutcome = p.returnStatus === 'completed' ? 'returned'
      : p.returnStatus === 'partial' || p.returnStatus === 'unresolved' ? 'unresolved'
      : p.returnStatus === 'unsupported' ? 'unsupported' : 'opened';
    if (outcome !== p.dispute.outcome || outcome === 'unresolved') {
      p.dispute.outcome = outcome;
      this.log('dispute_updated', {
        purchaseId: p.purchaseId,
        proposalVersion: p.receipt?.proposalVersion,
        employeeId: p.dispute.employeeId,
        outcome,
        mandateRef: p.receipt?.mandateRef,
        mandateVersion: p.receipt?.mandateVersion,
        now: this.now,
      });
    }
  }

  // Return every settled leg of a purchase to its original payer, preserving
  // per-leg return-attempt knowledge independently of the settlement status.
  // A refund call that throws after it may have been handed off is recorded
  // as 'forwarded' on the leg — the mock's refund is not idempotent after a
  // completed return, so before another refund call the same execution
  // reference is queried through status(): 'returned' confirms the return,
  // 'settled' permits a fresh attempt, and 'unknown' or an unavailable route
  // keeps the request unresolved. Shared by refund(), recover() and
  // dispute(): callers run it under their own operation guard, and it must
  // never become a guarded public method of its own.
  private async returnSettledLegs(p: Purchase): Promise<void> {
    // Keep a previous support refusal until a later response or uncertain
    // attempt supersedes it. A pre-forward PSP refusal alone says nothing
    // about support; any unresolved attempt takes precedence in the summary.
    let unsupported = p.returnStatus === 'unsupported';
    try {
      for (const l of p.legs) {
        // A settled leg is assumed to always carry the executionRef its return
        // keys on — the SettlementBackend contract pins it on every 'settled'
        // outcome, so a reference-less settled leg is unreachable here (and a
        // hypothetical adapter that produced one could never return it).
        if (l.status !== 'settled' || !l.executionRef) continue;
        if (l.returnForwarded) {
          // A previous attempt may have completed at the backend: query its
          // same execution reference before another refund call.
          let s: ExecutionStatus | undefined;
          try {
            s = await this.route(l.payerId).status(l.executionRef);
          } catch (err) {
            // An unreachable route says nothing about the attempt — the leg
            // stays preserved and unresolved; any other error surfaces the
            // same way reconcile() reports it.
            if (!(err instanceof PspUnavailableError)) throw err;
            s = undefined;
          }
          if (s === 'returned') {
            // The lost response hid a real return: confirm it without a
            // second refund call that could debit the payee again.
            l.status = 'returned';
            l.returnForwarded = undefined;
            unsupported = false;
            continue;
          }
          if (s === 'settled') {
            // The attempt conclusively did not land: a new refund call is safe.
            l.returnForwarded = undefined;
          } else {
            // 'unknown', an unresolved assembly or an unreachable route: the
            // attempt stays preserved and the request stays unresolved.
            continue;
          }
        }
        let outcome: 'returned' | 'unsupported';
        try {
          outcome = await this.route(l.payerId).refund(l.executionRef);
        } catch (err) {
          // A conclusive pre-forward refusal proves no return was attempted:
          // the leg stays settled and the caller learns the route refused —
          // the same refusal refund() has always surfaced. Any other failure
          // after the call may have been handed off is indistinguishable from
          // a lost response: preserve the attempt so the next reconciliation
          // queries this execution reference first.
          if (err instanceof PspUnavailableError) throw err;
          l.returnForwarded = true;
          unsupported = false;
          this.log('return_leg_uncertain', {
            purchaseId: p.purchaseId,
            leg: l.leg,
            payerId: l.payerId,
            executionRef: l.executionRef,
            message: err instanceof Error ? err.message : String(err),
            now: this.now,
          });
          continue;
        }
        // Bail on the first unsupported return: legs already returned keep their
        // 'returned' status, so the operation is safe to attempt again.
        if (outcome === 'unsupported') {
          unsupported = true;
          return;
        }
        l.status = 'returned';
        unsupported = false;
      }
    } finally {
      // Publish progress even when a later route throws. Preserve the error
      // and all holds: callers release accounting only after full completion.
      const returned = p.legs.some((l) => l.status === 'returned');
      if (p.legs.every((l) => l.status !== 'settled')) p.returnStatus = 'completed';
      else if (p.legs.some((l) => l.returnForwarded)) p.returnStatus = returned ? 'partial' : 'unresolved';
      else if (unsupported) p.returnStatus = 'unsupported';
      else p.returnStatus = returned ? 'partial' : 'none';
      this.noteDisputeOutcome(p);
    }
  }

  cancel(p: Purchase): void {
    this.requireIdle(p);
    // Cancellation is only meaningful before money moves; afterwards the path
    // is reconcile → recover (or refund after completion).
    if (!OPEN.includes(p.state)) throw new Error(`cannot cancel in state ${p.state}; reconcile, recover or refund instead`);
    this.transition(p, 'cancelled', { reason: 'cancelled_before_submission' });
    // Nothing stays committed; a held reservation goes back (a safe no-op
    // when the purchase never reached submission, or when the entry under
    // this purchaseId belongs to a different purchase).
    this.releaseBenefit(p);
  }

  // Terminal failure before submission: nothing was committed, so there is
  // nothing to recover. The shares are logged to show none of them grew.
  private fail(p: Purchase, reason: string): void {
    this.transition(p, 'failed', { reason, shares: p.proposal.shares.map((s) => `${s.role}:${s.amountCents}`) });
    p.reason = reason;
    // Nothing was committed, so any held reservation goes back (a safe no-op
    // when fail() runs before the benefit was reserved, or when the entry
    // under this purchaseId belongs to a different purchase).
    this.releaseBenefit(p);
  }
}
