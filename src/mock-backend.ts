// A mock of what a simulated PSP might see from a digital euro backend.
// It is NOT the ECB API: the real multi-payer semantics are unknown until the
// test environment is available. It encodes publicly described design features
// (holding limits, waterfall / reverse waterfall, zero holding for businesses)
// plus fault injection, so coordinator behaviour can be exercised end to end.

import type { Cents } from './types.ts';
import type { ExecutionStatus, LegRequest, LegResponse, SettlementBackend, SubmitRequest } from './backend.ts';
import { RequestRefusedError } from './backend.ts';
import { Trace } from './trace.ts';

// Stands in for the payers' PSPs as receivers of payer fees.
export const FEE_COLLECTOR = 'psp-fees';

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

// The backend's record of one contribution attempt; the coordinator only ever
// sees the LegResponse projection of it.
interface Execution {
  executionRef: string;
  idempotencyKey: string;
  // Links all legs submitted in one call, i.e. one purchase.
  groupRef: string;
  // Who receives this leg.
  payeeId: string;
  payerId: string;
  amountCents: Cents;
  feeCents: Cents;
  status: ExecutionStatus;
  reason?: string;
  // Hidden outcome of a simulated lost response, applied by status() on first
  // query; until then the leg sits at 'unknown' — a timeout is not failure.
  deferred?: 'settle' | 'reject';
}

export class MockBackend implements SettlementBackend {
  readonly name = 'mock-backend';
  readonly origin = 'LOCAL' as const;
  // Names the assumption set this mock encodes. Bump it when backend semantics
  // change, so recorded runs say which assumptions they ran against.
  readonly specVersion = 'mock-2';
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
  // Backend clock, for group assembly deadlines. Scenarios move it with advance().
  now = 0;
  // Atomic groups being assembled from per-PSP submissions, keyed by groupRef.
  private readonly assembling = new Map<string, { size: number; assembleBy: number; legs: LegRequest[]; execs: Execution[] }>();
  // Groups whose deadline passed. Kept as tombstones so a leg arriving for a
  // dead group is rejected instead of opening a fresh assembly window.
  private readonly expiredGroups = new Set<string>();

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
    // Resolve every account the transfer touches before moving money, so a
    // missing account throws before the first debit rather than leaving the
    // leg half-settled.
    const payer = this.account(e.payerId);
    const merchant = this.account(e.payeeId);
    const collector = e.feeCents > 0 ? this.account(FEE_COLLECTOR) : undefined;
    this.debit(payer, e.amountCents + e.feeCents);
    this.credit(merchant, e.amountCents);
    if (collector) this.credit(collector, e.feeCents);
    e.status = 'settled';
  }

  private reject(e: Execution, reason: string): void {
    e.status = 'rejected';
    e.reason = reason;
  }

  // Why would this leg be rejected right now, if at all? Faults simulate the
  // payer's PSP; funding is checked against holdings plus reverse waterfall,
  // on top of what the same payer already commits in this group.
  private rejection(req: LegRequest, alreadyCommitted: Cents = 0): string | undefined {
    if (this.faults.get(req.payerId) === 'decline') return 'declined_by_payer_psp';
    if (!this.canFund(this.account(req.payerId), alreadyCommitted + req.amountCents + req.feeCents)) return 'insufficient_funds';
    return undefined;
  }

  // One payer may hold several legs in a group (multi-payee): check their
  // running total, not each leg alone.
  private groupRejections(legs: LegRequest[]): string[] {
    const committed = new Map<string, Cents>();
    const reasons: string[] = [];
    for (const l of legs) {
      const before = committed.get(l.payerId) ?? 0;
      const reason = this.rejection(l, before);
      if (reason) reasons.push(reason);
      committed.set(l.payerId, before + l.amountCents + l.feeCents);
    }
    return reasons;
  }

  async submit(req: SubmitRequest): Promise<LegResponse[]> {
    const { groupRef, mode, legs } = req;
    // Two legs in one request may not share a key: each key owns exactly one
    // execution, so a repeated key here is a caller bug, not a retry. Checked
    // before the dedupe branch so an all-repeat request cannot bypass it.
    if (new Set(legs.map((l) => l.idempotencyKey)).size !== legs.length) {
      throw new RequestRefusedError('duplicate idempotency key within one request');
    }
    // Idempotency: a repeated key returns the original execution and never re-executes.
    const repeats = legs.filter((l) => this.executions.has(l.idempotencyKey));
    if (repeats.length > 0) {
      // A submission is either a full retry or entirely new; mixing seen and
      // unseen keys is a caller bug and fails loudly rather than half-applying.
      if (repeats.length !== legs.length) throw new RequestRefusedError('request mixes new and previously used idempotency keys');
      // Idempotent dedupe requires an identical retry: the same key carrying
      // different terms is a caller bug (or a purchaseId collision), not a
      // retry — fail loudly rather than settle the wrong payee.
      for (const l of repeats) {
        const e = this.executions.get(l.idempotencyKey)!;
        if (e.payerId !== l.payerId || e.payeeId !== l.payeeId || e.amountCents !== l.amountCents || e.feeCents !== l.feeCents || e.groupRef !== groupRef) {
          throw new RequestRefusedError('idempotency key reused with different terms');
        }
      }
      this.trace.add('LOCAL', 'backend', 'duplicate_request_ignored', { keys: repeats.map((l) => l.idempotencyKey) });
      return legs.map((l) => this.respond(this.executions.get(l.idempotencyKey)!));
    }

    // Resolve every account every leg touches before registering executions:
    // a missing account throws before any money moves and before any key is
    // recorded, never between legs.
    this.resolveAccounts(legs);

    const execs = legs.map((l) => {
      const e: Execution = {
        executionRef: `exec-${this.nextRef++}`,
        idempotencyKey: l.idempotencyKey,
        groupRef,
        payeeId: l.payeeId,
        payerId: l.payerId,
        amountCents: l.amountCents,
        feeCents: l.feeCents,
        status: 'unknown',
      };
      this.executions.set(l.idempotencyKey, e);
      this.byRef.set(e.executionRef, e);
      return e;
    });

    // Under per-payer initiation each leg arrives in its own request carrying
    // the assembly descriptor; a one-call atomic submission already holds
    // every leg and settles straight away.
    if (mode === 'atomic' && req.assembly) this.assemble(groupRef, req.assembly, legs, execs);
    else if (mode === 'atomic') this.submitAtomic(legs, execs);
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
    const timeouts = legs.map((l) => this.faults.get(l.payerId)).filter((f) => f?.startsWith('timeout'));
    const reasons = this.groupRejections(legs);
    if (timeouts.length > 0) {
      // The deferred group settles only if every leg would have settled:
      // one leg's reject fault or rejection reason rejects them all.
      const outcome = !timeouts.includes('timeout_then_reject') && reasons.length === 0 ? 'settle' : 'reject';
      for (const e of execs) e.deferred = outcome;
      return;
    }
    if (reasons.length > 0) {
      // The 'group_rejected:' prefix marks an atomic refusal, not a leg-level
      // decline, so tests can tell the two apart.
      for (const e of execs) this.reject(e, `group_rejected:${reasons[0]}`);
      return;
    }
    // Accounts were resolved when each leg arrived, but one may have been
    // deleted while the group assembled: resolve again before the first
    // debit so the group still settles all-or-nothing.
    this.resolveAccounts(execs);
    for (const e of execs) this.settle(e);
  }

  // Resolve every account a set of transfers touches, so a missing account
  // throws before the first debit rather than between legs.
  private resolveAccounts(legs: { payerId: string; payeeId: string; feeCents: Cents }[]): void {
    for (const l of legs) {
      this.account(l.payerId);
      this.account(l.payeeId);
      if (l.feeCents > 0) this.account(FEE_COLLECTOR);
    }
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

  // Collect one PSP's legs into its group. Once every leg has arrived, settle
  // the group atomically. Earlier submitters see 'unknown' and learn the
  // outcome by status query. A leg arriving after the deadline fails the group.
  private assemble(groupRef: string, assembly: { size: number; assembleBy: number }, legs: LegRequest[], execs: Execution[]): void {
    if (this.expiredGroups.has(groupRef)) {
      for (const e of execs) this.reject(e, 'group_expired');
      return;
    }
    const g = this.assembling.get(groupRef) ?? { size: assembly.size, assembleBy: assembly.assembleBy, legs: [], execs: [] };
    this.assembling.set(groupRef, g);
    g.legs.push(...legs);
    g.execs.push(...execs);
    if (this.now > g.assembleBy) {
      this.expire(groupRef);
      return;
    }
    if (g.execs.length < g.size) return;
    // Resolve before removing the group: a missing account fails the
    // completion atomically and leaves the group able to expire, rather
    // than vanishing with committed legs still 'unknown'.
    this.resolveAccounts(g.execs);
    this.assembling.delete(groupRef);
    this.trace.add('LOCAL', 'backend', 'group_assembled', { groupRef, legs: g.execs.length });
    this.submitAtomic(g.legs, g.execs);
  }

  // An incomplete group past its deadline: every leg that arrived is rejected,
  // so nothing settles without the rest of the group.
  private expire(groupRef: string): void {
    const g = this.assembling.get(groupRef)!;
    this.assembling.delete(groupRef);
    this.expiredGroups.add(groupRef);
    for (const e of g.execs) this.reject(e, 'group_incomplete');
    this.trace.add('LOCAL', 'backend', 'group_expired', { groupRef, arrived: g.execs.length, size: g.size });
  }

  private respond(e: Execution): LegResponse {
    // A submission retried after a return still reports the original outcome:
    // 'settled'. The return is a separate event, not a rewrite of history.
    const status = e.status === 'returned' ? 'settled' : e.status;
    return { idempotencyKey: e.idempotencyKey, executionRef: e.executionRef, status, reason: e.reason };
  }

  // Authoritative status query. Resolves operations whose response was lost.
  async status(executionRef: string): Promise<ExecutionStatus> {
    const e = this.byRef.get(executionRef);
    if (!e) throw new Error(`unknown execution ${executionRef}`);
    const g = this.assembling.get(e.groupRef);
    if (e.status === 'unknown' && g && this.now > g.assembleBy) this.expire(e.groupRef);
    if (e.status === 'unknown' && e.deferred) {
      // A timeout fault resolves here, on first query, as if the backend had
      // known the outcome all along. Legs of the same group deferred to the
      // same outcome resolve together — an atomic group stays all-or-nothing
      // across separate status queries.
      const outcome = e.deferred;
      const pending = [...this.executions.values()].filter(
        (x) => x.groupRef === e.groupRef && x.deferred === outcome,
      );
      if (outcome === 'settle') {
        this.resolveAccounts(pending);
        for (const x of pending) this.settle(x);
      } else {
        for (const x of pending) this.reject(x, 'resolved_rejected_after_timeout');
      }
      for (const x of pending) x.deferred = undefined;
      this.trace.add('LOCAL', 'backend', 'status_resolved', { executionRef, status: e.status });
    }
    return e.status;
  }

  // Return a settled contribution to its original payer.
  // Returns the amount, not the payer fee: whether fees are refunded is open (see backlog).
  async refund(executionRef: string): Promise<'returned' | 'unsupported'> {
    if (!this.refundsSupported) return 'unsupported';
    const e = this.byRef.get(executionRef);
    if (!e || e.status !== 'settled') throw new Error(`cannot refund ${executionRef}`);
    // Money goes back the way it came: the merchant is debited (its reverse
    // waterfall pulls from its bank account) and the original payer credited,
    // subject to their holding limit.
    this.debit(this.account(e.payeeId), e.amountCents);
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
