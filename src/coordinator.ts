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
  employeeMaxCents: Cents;
  merchantId: string;
  totalCents: Cents;
  feesCents?: Cents;
  mandate: EmployerMandate;
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
    if (p.approval) this.log('approval_invalidated', { approvalRef: p.approval.approvalRef });
    p.approval = undefined;
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

    if (this.now > p.approval.expiresAt) {
      this.fail(p, 'employee_approval_expired');
      return;
    }
    // Recheck employer authority at initiation. If it no longer holds, the
    // employee share must not silently grow: stop and require a new proposal.
    if (q.employerCents > 0) {
      const problem = mandateProblem(p.mandate, q.merchantId, this.now);
      if (problem) {
        this.fail(p, `employer_authority_invalid:${problem}`);
        return;
      }
    }

    p.legs = [];
    if (q.employeeCents > 0) p.legs.push(this.leg(p, 'employee', p.employeeId, q.employeeCents, p.approval.approvalRef));
    if (q.employerCents > 0) {
      p.legs.push(this.leg(p, 'employer', p.mandate.employerId, q.employerCents, p.mandate.mandateRef));
    }
    const sum = p.legs.reduce((s, l) => s + l.amountCents, 0);
    if (sum !== q.totalCents + q.feesCents) throw new Error('contributions do not reconcile to merchant total');

    this.log('submit', { mode, legs: p.legs.map((l) => `${l.leg}:${l.amountCents}`) });
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
      p.legs.map((l) => ({ payerId: l.payerId, amountCents: l.amountCents, idempotencyKey: l.idempotencyKey })),
      mode,
    );
  }

  private leg(p: Purchase, leg: Leg['leg'], payerId: string, amountCents: Cents, authorityRef: string): Leg {
    return {
      leg,
      payerId,
      amountCents,
      authorityRef,
      idempotencyKey: `${p.purchaseId}:v${p.proposal.version}:${leg}`,
      status: 'planned',
    };
  }

  private apply(p: Purchase, responses: LegResponse[]): void {
    for (const r of responses) {
      const l = p.legs.find((x) => x.idempotencyKey === r.idempotencyKey)!;
      if (l.status === 'returned') continue;
      l.executionRef = r.executionRef;
      l.status = r.status;
      l.rejectReason = r.reason;
    }
    this.derive(p);
  }

  // Ask the backend for authoritative status of every unresolved leg.
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

  private derive(p: Purchase): void {
    const st = p.legs.map((l) => l.status);
    const before = p.state;
    if (st.some((s) => s === 'unknown')) p.state = 'pending';
    else if (st.every((s) => s === 'settled')) p.state = 'completed';
    else if (st.every((s) => s === 'rejected')) p.state = 'failed';
    else if (st.some((s) => s === 'settled')) p.state = 'recovery_required';
    else if (st.every((s) => s === 'rejected' || s === 'returned')) p.state = 'cancelled';
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
  recover(p: Purchase): void {
    if (p.state !== 'recovery_required') throw new Error(`nothing to recover in state ${p.state}`);
    this.returnSettledLegs(p);
    if (p.returnStatus === 'unsupported') {
      this.log('recovery_unsupported', { outstandingCents: this.outstandingCents(p) });
      return;
    }
    this.derive(p);
  }

  // Full refund after completion, each share back to whoever paid it.
  refund(p: Purchase): void {
    if (p.state !== 'completed') throw new Error(`cannot refund in state ${p.state}`);
    this.returnSettledLegs(p);
    if (p.returnStatus === 'completed') this.log('refund_completed', { legs: p.legs.map((l) => `${l.leg}:${l.status}`) });
  }

  private returnSettledLegs(p: Purchase): void {
    for (const l of p.legs) {
      if (l.status !== 'settled' || !l.executionRef) continue;
      if (this.backend.refund(l.executionRef) === 'unsupported') {
        p.returnStatus = 'unsupported';
        return;
      }
      l.status = 'returned';
    }
    p.returnStatus = 'completed';
  }

  cancel(p: Purchase): void {
    if (!['draft', 'awaiting_approvals', 'ready'].includes(p.state)) {
      throw new Error(`cannot cancel in state ${p.state}; reconcile, recover or refund instead`);
    }
    p.state = 'cancelled';
    this.log('cancelled_before_submission');
  }

  private fail(p: Purchase, reason: string): void {
    p.state = 'failed';
    p.reason = reason;
    this.log('state', { to: 'failed', reason, employeeCents: p.proposal.employeeCents });
  }
}
