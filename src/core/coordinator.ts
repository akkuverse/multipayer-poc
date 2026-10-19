// Deterministic multi-payer coordinator. It records each payer's authority
// (an approval of one exact proposal, or an employer mandate for a bounded
// contribution), submits contributions, and derives the purchase state only
// from authoritative backend status. It never retries with new keys, never
// shifts a failed share onto another payer, and never reports completion
// from a partial result.

import type { BenefitTerms, Cents, EmployerMandate, Leg, PayerApproval, Proposal, Purchase, PurchaseState, SettlementMode, Share } from './types.ts';
import type { BenefitResult } from './policy.ts';
import { evaluateBenefit } from './policy.ts';
import { BenefitLedger, dayOf } from './ledger.ts';
import type { LegResponse, SettlementBackend } from '../settlement/backend.ts';
import { RequestRefusedError } from '../settlement/backend.ts';
import { PspUnavailableError } from '../settlement/psp.ts';
import { verifyPayload } from './signing.ts';
import type { KeyRegistry, Signed } from './signing.ts';
import type { MandateRegistry } from './authority.ts';
import type { Trace } from '../evidence/trace.ts';

export interface ProposeInput {
  purchaseId: string;
  employeeId: string;
  // The employee's standing instruction: the most they will personally pay.
  employeeMaxCents: Cents;
  merchantId: string;
  totalCents: Cents;
  // Payer fee the employee pays their PSP on top of their share; zero for
  // basic digital euro payments.
  feesCents?: Cents;
  // Reference to the employer mandate in the mandate registry; the latest
  // published version is resolved and verified at proposal and initiation.
  mandateRef: string;
  expiresAt: number;
}

export interface QuoteInput {
  merchantId: string;
  totalCents: Cents;
  employeeId: string;
  // The employee's standing instruction: the most they will personally pay,
  // fee included.
  employeeMaxCents: Cents;
  // Payer fee the employee would pay their PSP on top of their share.
  feesCents?: Cents;
  // Reference to the employer mandate in the mandate registry; the latest
  // published version is resolved and verified, as at proposal time.
  mandateRef: string;
}

export interface CoordinatorOptions {
  // Public keys of payers and employers, bound to their holders.
  keys: KeyRegistry;
  mandates: MandateRegistry;
  now?: number;
  ledger?: BenefitLedger;
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

// What one payer approves: the sum of their approval-backed shares.
export const approvalCents = (q: Proposal, payerId: string): Cents =>
  q.shares.filter((s) => s.payerId === payerId && s.authority === 'approval').reduce((t, s) => t + s.amountCents, 0);

// The fees that payer approves alongside their amount.
export const approvalFeeCents = (q: Proposal, payerId: string): Cents =>
  q.shares.filter((s) => s.payerId === payerId && s.authority === 'approval').reduce((t, s) => t + s.feeCents, 0);

// Payers whose approval the proposal needs, once each, in share order.
const approvers = (q: Proposal): string[] => [
  ...new Set(q.shares.filter((s) => s.authority === 'approval').map((s) => s.payerId)),
];

// Terms can change, and the purchase can be cancelled, only before submission.
const OPEN: PurchaseState[] = ['draft', 'awaiting_approvals', 'ready'];

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
  private readonly mandates: MandateRegistry;
  // Which purchase owns each execution reference the backend has returned.
  // A retry dedupes to the same purchase's execution; a response arriving
  // under another purchase means two purchases reused one purchaseId — a
  // caller bug the coordinator must not let arm a cross-purchase refund.
  private readonly execOwners = new Map<string, Purchase>();
  // A settlement call can yield while the purchase still has its previous
  // state. Own the whole operation, not just a state transition: concurrent
  // mutators must not release its benefit, replace its legs or apply stale
  // responses. Other purchases remain independent on this coordinator.
  private readonly inFlight = new WeakSet<Purchase>();
  now: number;

  constructor(backend: SettlementBackend, trace: Trace, opts: CoordinatorOptions) {
    this.backend = backend;
    this.trace = trace;
    this.now = opts.now ?? 0;
    this.ledger = opts.ledger ?? new BenefitLedger();
    this.initiation = opts.initiation;
    this.keys = opts.keys;
    this.mandates = opts.mandates;
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.trace.add('LOCAL', 'coordinator', event, detail);
  }

  // Which backend handles a payer's leg: their PSP, or the backend directly.
  private route(payerId: string): SettlementBackend {
    return this.initiation ? this.initiation.pspFor(payerId) : this.backend;
  }

  private requireIdle(p: Purchase): void {
    if (this.inFlight.has(p)) throw new Error('operation_in_progress');
  }

  // Acquire before the operation does any work, and release after its final
  // state/ledger updates, including errors and early returns. Refusals occur
  // outside the operation's catch blocks so they cannot undo its reservation.
  private async withOperation(p: Purchase, action: () => Promise<void>): Promise<void> {
    this.requireIdle(p);
    this.inFlight.add(p);
    try {
      await action();
    } finally {
      this.inFlight.delete(p);
    }
  }

  // An employer-benefit purchase: the policy splits the total between the
  // employee and the employer's mandate.
  propose(input: ProposeInput): Purchase {
    if (!input.merchantId) throw new Error('proposal needs a merchant of record');
    const p: Purchase = {
      purchaseId: input.purchaseId,
      state: 'draft',
      benefit: {
        employeeId: input.employeeId,
        employeeMaxCents: input.employeeMaxCents,
        employeeFeeCents: input.feesCents ?? 0,
        mandateRef: input.mandateRef,
      },
      proposal: { version: 0, merchantId: input.merchantId, totalCents: input.totalCents, shares: [], expiresAt: input.expiresAt },
      approvals: [],
      legs: [],
      returnStatus: 'none',
    };
    // The first reprice turns the skeleton into proposal version 1: the
    // version counter, not object identity, is what approvals bind to.
    this.reprice(p, input.merchantId, input.totalCents, input.expiresAt);
    return p;
  }

  // A purchase every payer approves for their own share: a bill split, a group
  // purchase, or one payer paying several payees. No benefit policy applies,
  // so the shares are taken as given and change only by proposing again.
  proposeSplit(input: SplitInput): Purchase {
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
      authority: 'approval',
    }));
    const totalCents = shares.reduce((t, s) => t + s.amountCents, 0);
    const p: Purchase = {
      purchaseId: input.purchaseId,
      state: 'awaiting_approvals',
      proposal: { version: 1, merchantId: input.merchantId, totalCents, shares, expiresAt: input.expiresAt },
      approvals: [],
      legs: [],
      returnStatus: 'none',
    };
    this.log('proposal', {
      version: 1,
      merchantId: input.merchantId,
      totalCents,
      shares: shares.map((s) => `${s.role}:${s.amountCents}`),
      state: p.state,
    });
    return p;
  }

  // What a fresh purchase under these terms would draw today, resolved and
  // verified against the latest mandate exactly as proposal and initiation
  // do. A projection, not a purchase: it reserves nothing, creates nothing
  // and appends nothing to the trace, so quoting twice shows the same answer.
  // Unlike benefitNow there is no purchase to exclude, so the quote counts
  // benefit other purchases already hold — including a pending reservation.
  quote(input: QuoteInput): BenefitResult {
    if (!input.merchantId) throw new Error('quote needs a merchant of record');
    if (!input.employeeId) throw new Error('quote needs an employee');
    if (!input.mandateRef) throw new Error('quote needs a mandate reference');
    if (!Number.isInteger(input.totalCents) || input.totalCents <= 0) throw new Error('quote total must be positive integer cents');
    if (!Number.isInteger(input.employeeMaxCents) || input.employeeMaxCents < 0) {
      throw new Error('quote instruction must be non-negative integer cents');
    }
    if (input.feesCents !== undefined && (!Number.isInteger(input.feesCents) || input.feesCents < 0)) {
      throw new Error('quote fees must be non-negative integer cents');
    }
    return this.resolveBenefit(
      {
        employeeId: input.employeeId,
        employeeMaxCents: input.employeeMaxCents,
        employeeFeeCents: input.feesCents ?? 0,
        mandateRef: input.mandateRef,
      },
      input.merchantId,
      input.totalCents,
    );
  }

  private benefitTerms(p: Purchase): BenefitTerms {
    if (!p.benefit) throw new Error('split purchases cannot be repriced; propose again');
    return p.benefit;
  }

  // The latest published mandate, if its signature verifies against the key
  // registered to the employer it names.
  private mandate(ref: string): { mandate?: EmployerMandate; problem?: string } {
    const s = this.mandates.current(ref);
    if (!s) return { problem: 'mandate_unknown' };
    if (!verifyPayload(s, this.keys, s.payload.employerId)) return { problem: 'mandate_signature_invalid' };
    return { mandate: s.payload };
  }

  // Deterministic split as of now for these terms, merchant and total,
  // counting benefit other purchases already hold today. One resolution for
  // every evaluation — proposal, initiation, resubmit and quote — so they
  // can never disagree about what the authority funds. excludePurchaseId
  // lets the purchase being re-evaluated ignore its own reservation; a
  // fresh-purchase projection excludes nothing.
  private resolveBenefit(t: BenefitTerms, merchantId: string, totalCents: Cents, excludePurchaseId?: string): BenefitResult {
    const { mandate, problem } = this.mandate(t.mandateRef);
    if (!mandate) {
      // No usable authority: the employer contributes nothing, and the
      // employee decides whether to pay it all. The fee counts against their
      // instruction here just as it does on the evaluateBenefit path (B13).
      return {
        employerCents: 0,
        employeeCents: totalCents,
        withinInstruction: totalCents + t.employeeFeeCents <= t.employeeMaxCents,
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
      employeeMaxCents: t.employeeMaxCents,
      employeeFeeCents: t.employeeFeeCents,
    });
  }

  // The split for a real purchase, which never counts its own reservation
  // against itself: initiation and resubmit re-evaluate while the purchase
  // still holds the benefit it reserved. Used at proposal time, initiation
  // and resubmit.
  private benefitNow(p: Purchase, merchantId: string, totalCents: Cents): BenefitResult {
    return this.resolveBenefit(this.benefitTerms(p), merchantId, totalCents, p.purchaseId);
  }

  // Bumps the proposal version and invalidates every earlier approval.
  private reprice(p: Purchase, merchantId: string, totalCents: Cents, expiresAt: number): void {
    // A non-positive or fractional total would produce no payable legs, and a
    // vacuous all-settled check would mark it completed (vacuous-truth family
    // of B6): refuse at the proposal boundary.
    if (!Number.isInteger(totalCents) || totalCents <= 0) throw new Error('total must be positive integer cents');
    // A changed offer must still name a merchant of record: eligibility and
    // the payee of every share are derived from it, so an empty id is refused
    // here just as propose() and proposeSplit() refuse it.
    if (!merchantId) throw new Error('proposal needs a merchant of record');
    const t = this.benefitTerms(p);
    const b = this.benefitNow(p, merchantId, totalCents);
    // The employee share is listed even at zero: the employee still approves
    // the purchase. Zero shares never become legs. Without a usable mandate
    // there is no employer share at all.
    const shares: Share[] = [
      { role: 'employee', payerId: t.employeeId, payeeId: merchantId, amountCents: b.employeeCents, feeCents: t.employeeFeeCents, authority: 'approval' },
    ];
    const employer = this.mandate(t.mandateRef).mandate;
    if (employer) {
      shares.push({ role: 'employer', payerId: employer.employerId, payeeId: merchantId, amountCents: b.employerCents, feeCents: 0, authority: 'mandate' });
    }
    p.proposal = { version: p.proposal.version + 1, merchantId, totalCents, shares, expiresAt };
    // Approvals bind to the old version's exact terms, so none can authorise
    // this new offer.
    for (const a of p.approvals) this.log('approval_invalidated', { approvalRef: a.payload.approvalRef });
    p.approvals = [];
    // A share above the employee's instruction keeps the purchase in draft
    // rather than charging them more than they allowed.
    if (b.withinInstruction) {
      p.state = 'awaiting_approvals';
      p.reason = undefined;
    } else {
      p.state = 'draft';
      p.reason = 'employee_share_exceeds_instruction';
    }
    this.log('proposal', {
      version: p.proposal.version,
      merchantId,
      totalCents,
      shares: shares.map((s) => `${s.role}:${s.amountCents}`),
      ineligibleReason: b.ineligibleReason,
      state: p.state,
    });
  }

  // The offer changed before submission (expired, new price, new merchant).
  changeOffer(p: Purchase, offer: { merchantId: string; totalCents: Cents; expiresAt: number }): void {
    this.requireIdle(p);
    // Terms are locked once money may have moved; after submission the only
    // paths are reconcile, recover or refund.
    if (!OPEN.includes(p.state)) throw new Error(`cannot change offer in state ${p.state}; reconcile or recover first`);
    this.reprice(p, offer.merchantId, offer.totalCents, offer.expiresAt);
  }

  // The employee raises their own limit. This is a new instruction, not an AI decision.
  reviseInstruction(p: Purchase, employeeMaxCents: Cents): void {
    this.requireIdle(p);
    if (!OPEN.includes(p.state)) throw new Error(`cannot revise instruction in state ${p.state}`);
    this.benefitTerms(p).employeeMaxCents = employeeMaxCents;
    this.reprice(p, p.proposal.merchantId, p.proposal.totalCents, p.proposal.expiresAt);
  }

  approve(p: Purchase, signed: Signed<PayerApproval>): void {
    this.requireIdle(p);
    const q = p.proposal;
    const a = signed.payload;
    // The approval must be signed by the payer it names, come from a payer
    // with an approval share, and echo every term of the current proposal. A
    // stale approval, bound to an earlier version, fails the version
    // comparison and is rejected here rather than silently applied.
    const sigOk = verifyPayload(signed, this.keys, a.payerId);
    const binds =
      approvers(q).includes(a.payerId) &&
      a.purchaseId === p.purchaseId &&
      a.proposalVersion === q.version &&
      a.merchantId === q.merchantId &&
      a.totalCents === q.totalCents &&
      a.amountCents === approvalCents(q, a.payerId) &&
      a.feeCents === approvalFeeCents(q, a.payerId) &&
      // An approval may expire before the offer does, never after it.
      a.expiresAt <= q.expiresAt;
    const live = this.now <= a.expiresAt;
    if (p.state !== 'awaiting_approvals' || !sigOk || !binds || !live) {
      const reason = p.state !== 'awaiting_approvals' ? 'wrong_state' : !sigOk ? 'signature_invalid' : !binds ? 'terms_mismatch' : 'expired';
      this.log('approval_rejected', { approvalRef: a.approvalRef, payerId: a.payerId, state: p.state, reason });
      throw new Error('approval does not match the current proposal');
    }
    // A payer may approve again; the newer approval replaces theirs.
    p.approvals = [...p.approvals.filter((x) => x.payload.payerId !== a.payerId), signed];
    this.log('approval_recorded', { approvalRef: a.approvalRef, payerId: a.payerId, keyId: signed.keyId, version: q.version });
    if (approvers(q).every((id) => p.approvals.some((x) => x.payload.payerId === id))) p.state = 'ready';
  }

  async submit(p: Purchase, mode: SettlementMode): Promise<void> {
    return this.withOperation(p, async () => {
      if (p.state !== 'ready') throw new Error(`cannot submit in state ${p.state}`);
      const q = p.proposal;

      // Authority is evaluated at the moment money would move: every approval
      // must still verify and still be within its expiry.
      const unverified = p.approvals.find((s) => !verifyPayload(s, this.keys, s.payload.payerId));
      if (unverified) {
        this.fail(p, `approval_signature_invalid:${unverified.payload.payerId}`);
        return;
      }
      const expired = p.approvals.find((s) => this.now > s.payload.expiresAt);
      if (expired) {
        this.fail(p, `approval_expired:${expired.payload.payerId}`);
        return;
      }
      // Recheck employer authority at initiation: validity, revocation,
      // beneficiary, merchant and both caps, against today's usage. If the
      // employer can no longer fund its full approved share, stop: the gap must
      // never move onto the employee.
      // Assumes the only mandate-backed share is named 'employer' — reprice is
      // the only share producer. Revisit if a mandate share gets another role.
      const employerCents = shareCents(q, 'employer');
      if (p.benefit && employerCents > 0) {
        const b = this.benefitNow(p, q.merchantId, q.totalCents);
        if (b.employerCents < employerCents) {
          this.fail(p, `employer_authority_invalid:${b.ineligibleReason ?? 'cap_exceeded'}`);
          return;
        }
      }

      // Only shares with something to pay (amount or fee) become legs; each
      // carries the reference of the authority that funds it.
      p.legs = q.shares.filter((s) => s.amountCents + s.feeCents > 0).map((s) => this.leg(p, s));
      // The legs must add up to exactly what the merchant was promised.
      const sum = p.legs.reduce((s, l) => s + l.amountCents, 0);
      if (sum !== q.totalCents) throw new Error('contributions do not reconcile to merchant total');

      try {
        // Hold the employer's benefit before any money moves, so a concurrent
        // purchase cannot draw the same benefit. A throw here (a conflicting
        // reservation under a reused purchaseId) also clears the just-built
        // legs in the catch below.
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
          mode,
          legs: p.legs.map((l) => `${l.leg}→${l.payeeId}:${l.amountCents}${l.feeCents > 0 ? `+fee${l.feeCents}` : ''}`),
        });
        this.apply(p, await this.send(p, mode));
      } catch (err) {
        // A submission that throws returns nothing to derive a state from, so
        // release the reservation rather than hold the benefit forever — but
        // only one this purchase holds: a reusing purchaseId must not free
        // another purchase's benefit. Clear the legs too: resubmit() must not
        // be able to execute them while the benefit is unheld — the only way
        // forward is submit() again, which re-runs the full authority recheck.
        this.releaseBenefit(p);
        p.legs = [];
        throw err;
      }
    });
  }

  // Simulates a network retry of the same submission: same idempotency keys,
  // same settlement mode. It retries an in-flight submission ('pending') or
  // re-delivers a finished one ('completed', where the backend dedupes).
  // Every other state is terminal, pre-submission, or 'recovery_required',
  // whose only exit is recover() — reopening any of them could commit money
  // after the purchase was already accounted for.
  async resubmit(p: Purchase): Promise<void> {
    return this.withOperation(p, async () => {
      if (p.legs.length === 0 || !p.mode) throw new Error('nothing to resubmit');
      if (p.state !== 'pending' && p.state !== 'completed') {
        throw new Error(`cannot resubmit in state ${p.state}`);
      }
      // A leg with no executionRef was refused before reaching the backend, so
      // this resubmit is its first initiation: the authority funding it must
      // still hold now — the same recheck submit() runs at initiation. The
      // benefit reservation stays held while the purchase is pending, so the
      // usage check already excludes this purchase.
      for (const l of p.legs) {
        if (l.executionRef !== undefined) continue;
        // Discriminate by the share's authority kind, not the stored ref: a
        // payer chooses their own approvalRef, so matching on the string could
        // route a leg to the wrong recheck.
        const share = p.proposal.shares.find((s) => s.role === l.leg);
        if (share?.authority === 'mandate') {
          const b = this.benefitNow(p, p.proposal.merchantId, p.proposal.totalCents);
          if (b.employerCents < shareCents(p.proposal, 'employer')) {
            throw new Error(`cannot resubmit: employer_authority_invalid:${b.ineligibleReason ?? 'cap_exceeded'}`);
          }
        } else {
          const a = p.approvals.find((x) => x.payload.payerId === l.payerId);
          if (!a || !verifyPayload(a, this.keys, l.payerId)) {
            throw new Error(`cannot resubmit: approval_signature_invalid:${l.payerId}`);
          }
          if (this.now > a.payload.expiresAt) {
            throw new Error(`cannot resubmit: approval_expired:${a.payload.payerId}`);
          }
        }
      }
      this.log('resubmit_same_keys');
      this.apply(p, await this.send(p, p.mode));
    });
  }

  private async send(p: Purchase, mode: SettlementMode): Promise<Outcome[]> {
    const legs = p.legs.map((l) => ({ payerId: l.payerId, payeeId: l.payeeId, amountCents: l.amountCents, feeCents: l.feeCents, idempotencyKey: l.idempotencyKey }));
    if (!this.initiation) return this.backend.submit({ groupRef: p.purchaseId, mode, legs });
    // Resolve every route before the first send: an unroutable payer is a
    // fixture error and must fail loudly before anything is forwarded, not
    // surface as an 'unknown' leg that can never resolve.
    const targets = new Map(legs.map((l) => [l.payerId, this.route(l.payerId)] as const));
    // Each PSP submits only its own payer's leg. In atomic mode the backend
    // assembles the group by a deadline; independent legs are separate payments.
    const assembly = mode === 'atomic' ? { size: legs.length, assembleBy: this.now + this.initiation.assemblyWindow } : undefined;
    const out: Outcome[] = [];
    for (const leg of legs) {
      try {
        out.push(...(await targets.get(leg.payerId)!.submit({ groupRef: p.purchaseId, mode, legs: [leg], assembly })));
      } catch (err) {
        const prior = p.legs.find((l) => l.idempotencyKey === leg.idempotencyKey);
        // A send failure says nothing new about a leg that already reached
        // the backend — it carries an executionRef, or sits 'unknown' in an
        // assembling group — so that leg keeps its last known status.
        // Reporting 'rejected' would fabricate a terminal status over money
        // that may still settle; downgrading a conclusive 'rejected' or
        // 'settled' to 'unknown' would hide it.
        const submitted = prior?.executionRef !== undefined || prior?.status === 'unknown';
        if (err instanceof PspUnavailableError) {
          // The PSP refused before forwarding: conclusively not submitted.
          if (!submitted) {
            out.push({ idempotencyKey: leg.idempotencyKey, status: 'rejected', reason: 'psp_unavailable' });
          }
        } else if (err instanceof RequestRefusedError) {
          // The backend conclusively refused the request: the leg can never
          // be submitted, so 'rejected' is honest — 'unknown' would leave a
          // dead end no status query can resolve.
          if (!submitted) out.push({ idempotencyKey: leg.idempotencyKey, status: 'rejected', reason: err.message });
        } else {
          // Any other failure mid-forward is indistinguishable from a lost
          // response: the leg may have reached the backend, so the leg is
          // 'unknown', never a fabricated terminal status. A resubmit with
          // the same key resolves it.
          this.log('submit_leg_error', {
            payerId: leg.payerId,
            message: err instanceof Error ? err.message : String(err),
          });
          if (!submitted) out.push({ idempotencyKey: leg.idempotencyKey, status: 'unknown' });
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
    if (s.authority === 'mandate') return this.benefitTerms(p).mandateRef;
    return p.approvals.find((a) => a.payload.payerId === s.payerId)!.payload.approvalRef;
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
      const l = p.legs.find((x) => x.idempotencyKey === r.idempotencyKey)!;
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
    if (st.some((s) => s === 'unknown')) p.state = 'pending';
    else if (st.every((s) => s === 'settled')) p.state = 'completed';
    else if (st.every((s) => s === 'rejected')) p.state = 'failed';
    else if (st.some((s) => s === 'settled')) p.state = 'recovery_required';
    else if (st.every((s) => s === 'rejected' || s === 'returned')) p.state = 'cancelled';
    // The benefit is used once the purchase completes and handed back once
    // nothing is committed; pending and recovering purchases keep it
    // reserved. Only the purchase holding the reservation may consume or
    // release it — under a reused purchaseId the entry could be another
    // purchase's benefit.
    if (p.state === 'completed' && p.benefitHeld) this.ledger.consume(p.purchaseId);
    else if (p.state === 'failed' || p.state === 'cancelled') this.releaseBenefit(p);
    // Log every transition, and keep re-logging the outstanding amount while
    // in recovery so money at risk stays visible in the trace.
    if (p.state !== before || p.state === 'recovery_required') {
      this.log('state', { from: before, to: p.state, outstandingCents: this.outstandingCents(p) });
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
      await this.returnSettledLegs(p);
      if (p.returnStatus === 'completed') {
        // A returned purchase gives the benefit back.
        this.releaseBenefit(p);
        this.log('refund_completed', { legs: p.legs.map((l) => `${l.leg}:${l.status}`) });
      }
    });
  }

  private async returnSettledLegs(p: Purchase): Promise<void> {
    for (const l of p.legs) {
      if (l.status !== 'settled' || !l.executionRef) continue;
      // Bail on the first unsupported return: legs already returned keep their
      // 'returned' status, so the operation is safe to attempt again.
      if ((await this.route(l.payerId).refund(l.executionRef)) === 'unsupported') {
        p.returnStatus = 'unsupported';
        return;
      }
      l.status = 'returned';
    }
    p.returnStatus = 'completed';
  }

  cancel(p: Purchase): void {
    this.requireIdle(p);
    // Cancellation is only meaningful before money moves; afterwards the path
    // is reconcile → recover (or refund after completion).
    if (!OPEN.includes(p.state)) throw new Error(`cannot cancel in state ${p.state}; reconcile, recover or refund instead`);
    p.state = 'cancelled';
    // Nothing stays committed; a held reservation goes back (a safe no-op
    // when the purchase never reached submission, or when the entry under
    // this purchaseId belongs to a different purchase).
    this.releaseBenefit(p);
    this.log('cancelled_before_submission');
  }

  // Terminal failure before submission: nothing was committed, so there is
  // nothing to recover. The shares are logged to show none of them grew.
  private fail(p: Purchase, reason: string): void {
    p.state = 'failed';
    p.reason = reason;
    // Nothing was committed, so any held reservation goes back (a safe no-op
    // when fail() runs before the benefit was reserved, or when the entry
    // under this purchaseId belongs to a different purchase).
    this.releaseBenefit(p);
    this.log('state', { to: 'failed', reason, shares: p.proposal.shares.map((s) => `${s.role}:${s.amountCents}`) });
  }
}
