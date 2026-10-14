// Deterministic multi-payer coordinator. It records two distinct authorities
// (employee approval of one purchase, employer mandate for a bounded
// contribution), submits contributions, and derives the purchase state only
// from authoritative backend status. It never retries with new keys, never
// shifts a failed employer share onto the employee, and never reports
// completion from a partial result.

import type { Cents, EmployeeApproval, EmployerMandate, Leg, Purchase, SettlementMode } from './types.ts';
import { evaluateBenefit, mandateProblem } from './policy.ts';
import type { LegResponse, MockBackend } from './mock-backend.ts';
import type { Trace } from './trace.ts';

export interface ProposeInput {
  purchaseId: string;
  employeeId: string;
  // The employee's standing instruction: the most they will personally pay.
  employeeMaxCents: Cents;
  merchantId: string;
  totalCents: Cents;
  feesCents?: Cents;
  mandate: EmployerMandate;
  // How much of the employer's daily cap is already consumed (backlog B2).
  usedTodayCents?: Cents;
  expiresAt: number;
}

export class Coordinator {
  private readonly backend: MockBackend;
  private readonly trace: Trace;
  now: number;

  constructor(backend: MockBackend, now = 0) {
    this.backend = backend;
    this.trace = backend.trace;
    this.now = now;
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.trace.add('LOCAL', 'coordinator', event, detail);
  }

  propose(input: ProposeInput): Purchase {
    const p: Purchase = {
      purchaseId: input.purchaseId,
      state: 'draft',
      employeeId: input.employeeId,
      employeeMaxCents: input.employeeMaxCents,
      mandate: input.mandate,
      usedTodayCents: input.usedTodayCents ?? 0,
      proposal: {
        version: 0,
        merchantId: input.merchantId,
        totalCents: input.totalCents,
        feesCents: input.feesCents ?? 0,
        employeeCents: 0,
        employerCents: 0,
        expiresAt: input.expiresAt,
      },
      legs: [],
      returnStatus: 'none',
    };
    // The first reprice turns the skeleton into proposal version 1 — the
    // version counter, not object identity, is what approvals bind to.
    this.reprice(p, input.merchantId, input.totalCents, input.expiresAt);
    return p;
  }

  // Deterministic split for the current offer. Bumps the proposal version and
  // invalidates any earlier approval.
  private reprice(p: Purchase, merchantId: string, totalCents: Cents, expiresAt: number): void {
    const b = evaluateBenefit({
      totalCents,
      merchantId,
      mandate: p.mandate,
      now: this.now,
      usedTodayCents: p.usedTodayCents,
      employeeMaxCents: p.employeeMaxCents,
      employeeFeeCents: p.proposal.feesCents,
    });
    p.proposal = {
      version: p.proposal.version + 1,
      merchantId,
      totalCents,
      feesCents: p.proposal.feesCents,
      employeeCents: b.employeeCents,
      employerCents: b.employerCents,
      expiresAt,
    };
    // Any earlier approval binds to the old version's exact terms, so it can
    // never authorise this new offer.
    if (p.approval) this.log('approval_invalidated', { approvalRef: p.approval.approvalRef });
    p.approval = undefined;
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
      employeeCents: b.employeeCents,
      employerCents: b.employerCents,
      ineligibleReason: b.ineligibleReason,
      state: p.state,
    });
  }

  // The offer changed before submission (expired, new price, new merchant).
  changeOffer(p: Purchase, offer: { merchantId: string; totalCents: Cents; expiresAt: number }): void {
    // Terms are locked once money may have moved; after submission the only
    // paths are reconcile, recover or refund.
    if (!['draft', 'awaiting_approvals', 'ready'].includes(p.state)) {
      throw new Error(`cannot change offer in state ${p.state}; reconcile or recover first`);
    }
    this.reprice(p, offer.merchantId, offer.totalCents, offer.expiresAt);
  }

  // The employee raises their own limit. This is a new instruction, not an AI decision.
  reviseInstruction(p: Purchase, employeeMaxCents: Cents): void {
    if (!['draft', 'awaiting_approvals', 'ready'].includes(p.state)) {
      throw new Error(`cannot revise instruction in state ${p.state}`);
    }
    p.employeeMaxCents = employeeMaxCents;
    this.reprice(p, p.proposal.merchantId, p.proposal.totalCents, p.proposal.expiresAt);
  }

  approve(p: Purchase, approval: EmployeeApproval): void {
    const q = p.proposal;
    // The approval must echo every term of the current proposal. A stale
    // approval — bound to an earlier version — fails the version comparison
    // and is rejected here rather than silently applied to changed terms.
    // (Backlog B4: the approval's own expiresAt is not yet part of the check.)
    const binds =
      approval.purchaseId === p.purchaseId &&
      approval.proposalVersion === q.version &&
      approval.merchantId === q.merchantId &&
      approval.totalCents === q.totalCents &&
      approval.feesCents === q.feesCents &&
      approval.employeeCents === q.employeeCents;
    if (p.state !== 'awaiting_approvals' || !binds) {
      this.log('approval_rejected', { approvalRef: approval.approvalRef, state: p.state });
      throw new Error('approval does not match the current proposal');
    }
    p.approval = approval;
    p.state = 'ready';
    this.log('approval_recorded', { approvalRef: approval.approvalRef, version: q.version });
  }

  // Convenience for scenarios: the employee approves exactly what is shown.
  approveCurrent(p: Purchase, approvalRef = `appr-${p.purchaseId}-v${p.proposal.version}`): EmployeeApproval {
    const q = p.proposal;
    const a: EmployeeApproval = {
      approvalRef,
      purchaseId: p.purchaseId,
      proposalVersion: q.version,
      merchantId: q.merchantId,
      totalCents: q.totalCents,
      feesCents: q.feesCents,
      employeeCents: q.employeeCents,
      expiresAt: q.expiresAt,
    };
    this.approve(p, a);
    return a;
  }

  submit(p: Purchase, mode: SettlementMode): void {
    if (p.state !== 'ready' || !p.approval) throw new Error(`cannot submit in state ${p.state}`);
    const q = p.proposal;

    // Expiry is rechecked at initiation, not only when the approval was
    // recorded: authority is evaluated at the moment money would move.
    if (this.now > p.approval.expiresAt) {
      this.fail(p, 'employee_approval_expired');
      return;
    }
    // Recheck employer authority at initiation. If it no longer holds, the
    // employee share must not silently grow: stop and require a new proposal.
    // (Backlog B5: covers validity, revocation and merchant eligibility, but
    // not the per-purchase or daily caps.)
    if (q.employerCents > 0) {
      const problem = mandateProblem(p.mandate, q.merchantId, this.now);
      if (problem) {
        this.fail(p, `employer_authority_invalid:${problem}`);
        return;
      }
    }

    // Only non-zero shares become legs; each leg carries the reference of the
    // authority that funds it.
    p.legs = [];
    // The employee leg exists if they pay anything, share or fee.
    if (q.employeeCents > 0 || q.feesCents > 0) {
      p.legs.push(this.leg(p, 'employee', p.employeeId, q.employeeCents, q.feesCents, p.approval.approvalRef));
    }
    if (q.employerCents > 0) {
      p.legs.push(this.leg(p, 'employer', p.mandate.employerId, q.employerCents, 0, p.mandate.mandateRef));
    }
    // The merchant receives exactly the total; fees travel separately to the
    // payers' PSPs and must match what was approved.
    const sum = p.legs.reduce((s, l) => s + l.amountCents, 0);
    const fees = p.legs.reduce((s, l) => s + l.feeCents, 0);
    if (sum !== q.totalCents || fees !== q.feesCents) throw new Error('contributions do not reconcile to merchant total and fees');

    this.log('submit', { mode, legs: p.legs.map((l) => `${l.leg}:${l.amountCents}${l.feeCents > 0 ? `+fee${l.feeCents}` : ''}`) });
    this.apply(p, this.send(p, mode));
  }

  // Simulates a network retry of the same submission (same idempotency keys).
  resubmit(p: Purchase, mode: SettlementMode): void {
    if (p.legs.length === 0) throw new Error('nothing to resubmit');
    this.log('resubmit_same_keys');
    this.apply(p, this.send(p, mode));
  }

  private send(p: Purchase, mode: SettlementMode): LegResponse[] {
    return this.backend.submit(
      p.purchaseId,
      p.proposal.merchantId,
      p.legs.map((l) => ({ payerId: l.payerId, amountCents: l.amountCents, feeCents: l.feeCents, idempotencyKey: l.idempotencyKey })),
      mode,
    );
  }

  private leg(p: Purchase, leg: Leg['leg'], payerId: string, amountCents: Cents, feeCents: Cents, authorityRef: string): Leg {
    return {
      leg,
      payerId,
      amountCents,
      feeCents,
      authorityRef,
      // Keyed by purchase, proposal version and leg name: a retry of the same
      // submission reuses the key and is deduped by the backend, while a
      // repriced offer produces new keys only after renewed approval. The
      // coordinator never mints a fresh key just to retry.
      idempotencyKey: `${p.purchaseId}:v${p.proposal.version}:${leg}`,
      status: 'planned',
    };
  }

  private apply(p: Purchase, responses: LegResponse[]): void {
    for (const r of responses) {
      const l = p.legs.find((x) => x.idempotencyKey === r.idempotencyKey)!;
      // A leg already returned keeps that record: a late duplicate response
      // must not overwrite the return with the original settlement.
      if (l.status === 'returned') continue;
      // executionRef is kept for later status queries and returns.
      l.executionRef = r.executionRef;
      l.status = r.status;
      l.rejectReason = r.reason;
    }
    this.derive(p);
  }

  // Ask the backend for authoritative status of every unresolved leg. Only
  // 'unknown' legs are queried — settled and rejected are final — and the
  // backend's answer is taken as truth.
  reconcile(p: Purchase): void {
    for (const l of p.legs) {
      if (l.status === 'unknown' && l.executionRef) {
        const s = this.backend.status(l.executionRef);
        l.status = s === 'returned' ? 'returned' : s;
      }
    }
    this.log('reconciled', { legs: p.legs.map((l) => `${l.leg}:${l.status}`) });
    this.derive(p);
  }

  // The purchase state is derived from leg statuses alone — it cannot be
  // asserted by a caller, and there is no path to 'completed' that skips a leg.
  //   any unknown                → pending (a timeout is not a failure)
  //   all settled                → completed
  //   all rejected               → failed (nothing committed, nothing to undo)
  //   some settled, some not     → recovery_required (committed money visible)
  //   only rejected and returned → cancelled (every obligation resolved)
  private derive(p: Purchase): void {
    const st = p.legs.map((l) => l.status);
    const before = p.state;
    if (st.some((s) => s === 'unknown')) p.state = 'pending';
    else if (st.every((s) => s === 'settled')) p.state = 'completed';
    else if (st.every((s) => s === 'rejected')) p.state = 'failed';
    else if (st.some((s) => s === 'settled')) p.state = 'recovery_required';
    else if (st.every((s) => s === 'rejected' || s === 'returned')) p.state = 'cancelled';
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
  // second payment, and never shifting the failed share onto the employee.
  recover(p: Purchase): void {
    if (p.state !== 'recovery_required') throw new Error(`nothing to recover in state ${p.state}`);
    this.returnSettledLegs(p);
    // A backend without returns is a finding, not a dead end: the purchase
    // stays 'recovery_required' and the outstanding amount stays visible.
    if (p.returnStatus === 'unsupported') {
      this.log('recovery_unsupported', { outstandingCents: this.outstandingCents(p) });
      return;
    }
    this.derive(p);
  }

  // Full refund after completion, each share back to whoever paid it. The
  // purchase stays 'completed' — the return is recorded separately in
  // returnStatus and the legs' 'returned' status.
  refund(p: Purchase): void {
    if (p.state !== 'completed') throw new Error(`cannot refund in state ${p.state}`);
    this.returnSettledLegs(p);
    if (p.returnStatus === 'completed') this.log('refund_completed', { legs: p.legs.map((l) => `${l.leg}:${l.status}`) });
  }

  private returnSettledLegs(p: Purchase): void {
    for (const l of p.legs) {
      if (l.status !== 'settled' || !l.executionRef) continue;
      // Bail on the first unsupported return: legs already returned keep their
      // 'returned' status, so the operation is safe to attempt again.
      if (this.backend.refund(l.executionRef) === 'unsupported') {
        p.returnStatus = 'unsupported';
        return;
      }
      l.status = 'returned';
    }
    p.returnStatus = 'completed';
  }

  cancel(p: Purchase): void {
    // Cancellation is only meaningful before money moves; afterwards the path
    // is reconcile → recover (or refund after completion).
    if (!['draft', 'awaiting_approvals', 'ready'].includes(p.state)) {
      throw new Error(`cannot cancel in state ${p.state}; reconcile, recover or refund instead`);
    }
    p.state = 'cancelled';
    this.log('cancelled_before_submission');
  }

  // Terminal failure before submission: nothing was committed, so there is
  // nothing to recover. The employee share is logged to show it did not grow.
  private fail(p: Purchase, reason: string): void {
    p.state = 'failed';
    p.reason = reason;
    this.log('state', { to: 'failed', reason, employeeCents: p.proposal.employeeCents });
  }
}
