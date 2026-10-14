// A mock of what a simulated PSP might see from a digital euro backend.
// It is NOT the ECB API: the real multi-payer semantics are unknown until the
// test environment is available. It encodes publicly described design features
// (holding limits, waterfall / reverse waterfall, zero holding for businesses)
// plus fault injection, so coordinator behaviour can be exercised end to end.

import type { Cents, SettlementMode } from './types.ts';
import { Trace } from './trace.ts';

export interface Account {
  id: string;
  kind: 'individual' | 'business';
  deCents: Cents; // digital euro holdings
  holdingLimitCents: Cents; // businesses: 0
  linkedBankCents: Cents; // linked commercial bank account
  reverseWaterfall: boolean; // optional for individuals, mandatory for businesses
}

// Per-payer fault injection. The 'timeout_*' faults model a request the
// backend accepted but whose response was lost: the leg is left 'unknown' and
// the deferred outcome is applied lazily by the first status() query.
export type Fault =
  | 'none'
  | 'decline' // payer's PSP declines the leg
  | 'timeout_then_settle' // response lost; status query later shows settled
  | 'timeout_then_reject'; // response lost; status query later shows rejected

export interface LegRequest {
  payerId: string;
  amountCents: Cents;
  idempotencyKey: string;
}

export interface LegResponse {
  idempotencyKey: string;
  executionRef: string;
  status: 'settled' | 'rejected' | 'unknown';
  reason?: string;
}

// The backend's record of one contribution attempt; the coordinator only ever
// sees the LegResponse projection of it.
interface Execution {
  executionRef: string;
  idempotencyKey: string;
  // Links all legs submitted in one call, i.e. one purchase.
  groupRef: string;
  merchantId: string;
  payerId: string;
  amountCents: Cents;
  status: 'settled' | 'rejected' | 'unknown' | 'returned';
  reason?: string;
  // Hidden outcome of a simulated lost response, applied by status() on first
  // query; until then the leg sits at 'unknown' — a timeout is not failure.
  deferred?: 'settle' | 'reject';
}

export class MockBackend {
  readonly accounts = new Map<string, Account>();
  readonly faults = new Map<string, Fault>(); // keyed by payerId
  readonly trace: Trace;
  // Idempotency store: a key, once seen, always maps to its first execution.
  private readonly executions = new Map<string, Execution>(); // keyed by idempotencyKey
  // Secondary index for status queries and returns.
  private readonly byRef = new Map<string, Execution>();
  private nextRef = 1;
  // Toggled off by scenarios that model a backend with no return operation.
  refundsSupported = true;

  constructor(trace: Trace) {
    this.trace = trace;
  }

  addAccount(a: Account): void {
    // Businesses hold no digital euro; enforce it at fixture-build time so no
    // scenario can accidentally give a merchant or employer holdings.
    if (a.kind === 'business' && (a.holdingLimitCents !== 0 || !a.reverseWaterfall)) {
      throw new Error(`business account ${a.id} must have zero holding limit and reverse waterfall`);
    }
    this.accounts.set(a.id, { ...a });
  }

  account(id: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`unknown account ${id}`);
    return a;
  }

  // Can this payer fund the amount, using reverse waterfall where enabled?
  private canFund(a: Account, amount: Cents): boolean {
    const available = a.deCents + (a.reverseWaterfall ? a.linkedBankCents : 0);
    return available >= amount;
  }

  // Take from digital euro holdings first; whatever holdings cannot cover is
  // pulled from the linked bank account (reverse waterfall).
  private debit(a: Account, amount: Cents): void {
    const fromDe = Math.min(a.deCents, amount);
    const fromBank = amount - fromDe;
    a.deCents -= fromDe;
    a.linkedBankCents -= fromBank;
    if (fromBank > 0) {
      this.trace.add('LOCAL', 'backend', 'reverse_waterfall', { account: a.id, fromBank: fromBank });
    }
  }

  // Credit a holder. Anything above the holding limit flows to the linked bank account.
  private credit(a: Account, amount: Cents): void {
    const room = Math.max(0, a.holdingLimitCents - a.deCents);
    const toDe = Math.min(room, amount);
    const toBank = amount - toDe;
    a.deCents += toDe;
    a.linkedBankCents += toBank;
    if (toBank > 0) {
      this.trace.add('LOCAL', 'backend', 'waterfall', { account: a.id, toBank: toBank });
    }
  }

  private settle(e: Execution): void {
    this.debit(this.account(e.payerId), e.amountCents);
    this.credit(this.account(e.merchantId), e.amountCents);
    e.status = 'settled';
  }

  private reject(e: Execution, reason: string): void {
    e.status = 'rejected';
    e.reason = reason;
  }

  // Why would this leg be rejected right now, if at all? Faults simulate the
  // payer's PSP; funding is checked against holdings plus reverse waterfall.
  private rejection(req: LegRequest): string | undefined {
    if (this.faults.get(req.payerId) === 'decline') return 'declined_by_payer_psp';
    if (!this.canFund(this.account(req.payerId), req.amountCents)) return 'insufficient_funds';
    return undefined;
  }

  submit(groupRef: string, merchantId: string, legs: LegRequest[], mode: SettlementMode): LegResponse[] {
    // Idempotency: a repeated key returns the original execution and never re-executes.
    const repeats = legs.filter((l) => this.executions.has(l.idempotencyKey));
    if (repeats.length > 0) {
      // A submission is either a full retry or entirely new; mixing seen and
      // unseen keys is a caller bug and fails loudly rather than half-applying.
      if (repeats.length !== legs.length) throw new Error('request mixes new and previously used idempotency keys');
      this.trace.add('LOCAL', 'backend', 'duplicate_request_ignored', { keys: repeats.map((l) => l.idempotencyKey) });
      return legs.map((l) => this.respond(this.executions.get(l.idempotencyKey)!));
    }

    const execs = legs.map((l) => {
      const e: Execution = {
        executionRef: `exec-${this.nextRef++}`,
        idempotencyKey: l.idempotencyKey,
        groupRef,
        merchantId,
        payerId: l.payerId,
        amountCents: l.amountCents,
        status: 'unknown',
      };
      this.executions.set(l.idempotencyKey, e);
      this.byRef.set(e.executionRef, e);
      return e;
    });

    if (mode === 'atomic') this.submitAtomic(legs, execs);
    else this.submitIndependent(legs, execs);

    this.trace.add('LOCAL', 'backend', 'submit', {
      mode,
      groupRef,
      results: execs.map((e) => `${e.payerId}:${e.status}`),
    });
    return execs.map((e) => this.respond(e));
  }

  // All legs settle together or none do — including a lost response: one
  // timeout fault defers the whole group, and one rejection rejects it all.
  private submitAtomic(legs: LegRequest[], execs: Execution[]): void {
    const timeout = legs.map((l) => this.faults.get(l.payerId)).find((f) => f?.startsWith('timeout'));
    const reasons = legs.map((l) => this.rejection(l)).filter((r) => r !== undefined);
    if (timeout) {
      // The deferred group settles only if no leg would have failed anyway.
      const outcome = timeout === 'timeout_then_settle' && reasons.length === 0 ? 'settle' : 'reject';
      for (const e of execs) e.deferred = outcome;
      return;
    }
    if (reasons.length > 0) {
      // The 'group_rejected:' prefix marks an atomic refusal, not a leg-level
      // decline, so tests can tell the two apart.
      for (const e of execs) this.reject(e, `group_rejected:${reasons[0]}`);
      return;
    }
    for (const e of execs) this.settle(e);
  }

  // Each leg is a separate payment: one can settle while the other fails.
  private submitIndependent(legs: LegRequest[], execs: Execution[]): void {
    legs.forEach((l, i) => {
      const e = execs[i];
      const fault = this.faults.get(l.payerId);
      const reason = this.rejection(l);
      if (fault === 'timeout_then_settle' || fault === 'timeout_then_reject') {
        e.deferred = fault === 'timeout_then_settle' && !reason ? 'settle' : 'reject';
      } else if (reason) {
        this.reject(e, reason);
      } else {
        this.settle(e);
      }
    });
  }

  private respond(e: Execution): LegResponse {
    // A submission retried after a return still reports the original outcome:
    // 'settled'. The return is a separate event, not a rewrite of history.
    const status = e.status === 'returned' ? 'settled' : e.status;
    return { idempotencyKey: e.idempotencyKey, executionRef: e.executionRef, status, reason: e.reason };
  }

  // Authoritative status query. Resolves operations whose response was lost.
  status(executionRef: string): Execution['status'] {
    const e = this.byRef.get(executionRef);
    if (!e) throw new Error(`unknown execution ${executionRef}`);
    if (e.status === 'unknown' && e.deferred) {
      // A timeout fault resolves here, on first query, as if the backend had
      // known the outcome all along.
      if (e.deferred === 'settle') this.settle(e);
      else this.reject(e, 'resolved_rejected_after_timeout');
      e.deferred = undefined;
      this.trace.add('LOCAL', 'backend', 'status_resolved', { executionRef, status: e.status });
    }
    return e.status;
  }

  // Return a settled contribution to its original payer.
  refund(executionRef: string): 'returned' | 'unsupported' {
    if (!this.refundsSupported) return 'unsupported';
    const e = this.byRef.get(executionRef);
    if (!e || e.status !== 'settled') throw new Error(`cannot refund ${executionRef}`);
    // Money goes back the way it came: the merchant is debited (its reverse
    // waterfall pulls from its bank account) and the original payer credited,
    // subject to their holding limit.
    this.debit(this.account(e.merchantId), e.amountCents);
    this.credit(this.account(e.payerId), e.amountCents);
    e.status = 'returned';
    this.trace.add('LOCAL', 'backend', 'refund', { executionRef, to: e.payerId, amountCents: e.amountCents });
    return 'returned';
  }

  // Distinct executions ever run — the hook tests use to prove dedupe.
  executionCount(): number {
    return this.byRef.size;
  }
}
