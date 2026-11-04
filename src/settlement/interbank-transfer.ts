// Individual interbank transfers between provider books (spec §4.4). The
// module holds nothing per customer: money moves through the BankBook seam
// each provider owns. A debit alone is not settlement — the amount stays in
// tracked transit until the destination credit is confirmed, an uncredited
// debit can be cancelled back to its source, and a lost response stays
// 'unknown' for the caller while never creating a second debit (decision
// 10). Each transfer settles on its own: there are no groups on this rail.

import type { Cents } from '../core/types.ts';
import type { Trace } from '../evidence/trace.ts';
import { OperationStore } from './operations.ts';
import type {
  BankBook,
  BankTransferAudit,
  BankTransferEffects,
  BankTransferRequest,
  BankTransferStage,
  DeferredOutcome,
  OperationRecord,
  SimulationFault,
} from './types.ts';

const STAGES: readonly BankTransferStage[] = ['debit', 'credit'];

interface Transfer {
  transferRef: string;
  key: string;
  from: string;
  to: string;
  amountCents: Cents;
  debited: boolean;
  credited: boolean;
  // An uncredited debit returned to its source book by cancelUncredited.
  cancelled: boolean;
}

export class InterbankTransfer {
  readonly name = 'interbank-transfer';
  readonly origin = 'LOCAL' as const;
  readonly specVersion = 'settlement-ledgers-1';

  private readonly store = new OperationStore();
  private readonly books = new Map<string, BankBook>();
  private readonly transferByKey = new Map<string, Transfer>();
  private readonly transferByRef = new Map<string, Transfer>();
  // Faults are consulted once: injecting a fault arms exactly one attempt.
  private readonly faults = new Map<string, Map<BankTransferStage, SimulationFault>>();
  private readonly deferred = new Map<string, Transfer>();
  private nextRef = 1;
  private readonly now: () => number;
  private readonly trace: Trace;

  constructor(now: () => number, trace: Trace) {
    this.now = now;
    this.trace = trace;
  }

  // Fixture/provider registration: the provider's bank book is the seam
  // the transfer module asks to move money (spec §3 — the book owns it).
  registerBook(provider: string, book: BankBook): void {
    if (provider.length === 0) throw new Error('book_terms_invalid');
    const existing = this.books.get(provider);
    if (existing !== undefined && existing !== book) throw new Error('book_terms_conflict');
    this.books.set(provider, book);
  }

  // Submit one transfer under its stable operation key. The reference is
  // minted before handoff so even a lost response stays reconcilable under
  // the original key; a replay returns the original transfer and never
  // debits twice.
  transfer(req: BankTransferRequest): OperationRecord {
    const { key: _key, ...terms } = req;
    requireAmount(req.amountCents);
    if (req.from === req.to) throw new Error('same_book');
    const rec = this.store.begin(req.key, terms);
    if (rec.status !== 'not_started') return rec;
    this.bookAt(req.from);
    this.bookAt(req.to);
    // Only the book's owner may move money out of it.
    if (req.initiator !== req.from) return this.reject(req.key, undefined, 'foreign_provider');
    const t: Transfer = {
      transferRef: `xfr-${this.nextRef++}`,
      key: req.key,
      from: req.from,
      to: req.to,
      amountCents: req.amountCents,
      debited: false,
      credited: false,
      cancelled: false,
    };
    this.transferByKey.set(req.key, t);
    this.transferByRef.set(t.transferRef, t);
    return this.progress(t);
  }

  // The retained operation record under its original key, detached, or
  // undefined when the key was never begun.
  status(key: string): OperationRecord | undefined {
    return this.store.status(key);
  }

  // Arm a one-shot fault on an operation's named stage (decision 12).
  setFault(operationKey: string, stage: BankTransferStage, fault: SimulationFault): void {
    if (!STAGES.includes(stage)) throw new Error('unknown_stage');
    let byStage = this.faults.get(operationKey);
    if (byStage === undefined) {
      byStage = new Map();
      this.faults.set(operationKey, byStage);
    }
    byStage.set(stage, fault);
  }

  // Explicit simulation resolution of parked work — the only way a
  // deferred debit or credit progresses; a replay only sees the pending
  // record.
  resolveDeferred(operationKey: string, outcome: DeferredOutcome, reason?: string): OperationRecord {
    const t = this.deferred.get(operationKey);
    const rec = this.store.status(operationKey);
    if (t === undefined || rec === undefined || rec.status !== 'pending') {
      throw new Error('no_deferred_operation');
    }
    this.deferred.delete(operationKey);
    if (outcome === 'reject') return this.reject(operationKey, t.transferRef, reason ?? 'deferred_rejected');
    return this.progress(t);
  }

  // Return an uncredited debit to its source book. Only a conclusively
  // rejected transfer may be cancelled: pending and unknown outcomes must
  // resolve first — never race a return against an unresolved operation.
  cancelUncredited(key: string): BankTransferAudit {
    const t = this.transferByKey.get(key);
    if (t === undefined) throw new Error('unknown_transfer');
    const rec = this.store.status(key);
    if (t.credited) throw new Error('transfer_already_credited');
    if (t.cancelled) throw new Error('transfer_already_cancelled');
    if (!t.debited) throw new Error('nothing_in_transit');
    if (rec === undefined || rec.status !== 'rejected') throw new Error('transfer_unresolved');
    this.bookAt(t.from).credit(t.amountCents);
    t.cancelled = true;
    this.trace.add('LOCAL', 'bank-transfer', 'bank_transit_cancelled', {
      key,
      transferRef: t.transferRef,
      to: t.from,
      amountCents: t.amountCents,
      at: this.now(),
    });
    return this.audit(t);
  }

  // ---- detached audit reads ---------------------------------------------

  transferAudit(key: string): BankTransferAudit | undefined {
    const t = this.transferByKey.get(key);
    return t === undefined ? undefined : this.audit(t);
  }

  transfers(): BankTransferAudit[] {
    return [...this.transferByKey.values()].map((t) => this.audit(t));
  }

  // Transfers whose debit is applied but whose destination credit is
  // neither confirmed nor cancelled: the explicit in-transit amounts.
  transit(): BankTransferAudit[] {
    return [...this.transferByKey.values()].filter((t) => t.debited && !t.credited && !t.cancelled).map((t) => this.audit(t));
  }

  // ---- internals ---------------------------------------------------------

  private bookAt(provider: string): BankBook {
    const book = this.books.get(provider);
    if (book === undefined) throw new Error('unknown_book');
    return book;
  }

  private faultAt(key: string, stage: BankTransferStage): SimulationFault | undefined {
    const byStage = this.faults.get(key);
    const fault = byStage?.get(stage);
    // One-shot: consulting a fault disarms it, so an explicit resolution
    // of deferred work cannot trip over the same injected fault twice.
    if (fault !== undefined) byStage!.delete(stage);
    return fault;
  }

  private reject(key: string, reference: string | undefined, reason: string): OperationRecord {
    const rec = this.store.resolve(key, { status: 'rejected', reason, reference });
    this.trace.add('LOCAL', 'bank-transfer', 'bank_transfer_rejected', { key, transferRef: reference, reason, at: this.now() });
    return rec;
  }

  private audit(t: Transfer): BankTransferAudit {
    return {
      transferRef: t.transferRef,
      key: t.key,
      from: t.from,
      to: t.to,
      amountCents: t.amountCents,
      debited: t.debited,
      credited: t.credited,
      cancelled: t.cancelled,
    };
  }

  // Drive the transfer through its two stages under each stage's fault.
  // 'reject_before_effect' refuses before that stage's effect (a refused
  // destination credit leaves the debit in tracked transit); 'defer'
  // parks the remaining work as 'pending'; 'lose_response_after_effect'
  // lets the stages complete and only hides the response — the caller
  // sees 'unknown' while the recorded truth stays authoritative.
  private progress(t: Transfer): OperationRecord {
    let lost = false;
    if (!t.debited) {
      const fault = this.faultAt(t.key, 'debit');
      if (fault === 'reject_before_effect') return this.reject(t.key, t.transferRef, 'debit_rejected');
      if (fault === 'defer') return this.park(t);
      try {
        this.bookAt(t.from).debit(t.amountCents);
      } catch (err) {
        return this.reject(t.key, t.transferRef, message(err));
      }
      t.debited = true;
      this.trace.add('LOCAL', 'bank-transfer', 'bank_transfer_debited', {
        key: t.key,
        transferRef: t.transferRef,
        from: t.from,
        amountCents: t.amountCents,
        at: this.now(),
      });
      if (fault === 'lose_response_after_effect') lost = true;
    }
    if (!t.credited) {
      const fault = this.faultAt(t.key, 'credit');
      if (fault === 'reject_before_effect') return this.reject(t.key, t.transferRef, 'credit_rejected');
      if (fault === 'defer') return this.park(t);
      try {
        this.bookAt(t.to).credit(t.amountCents);
      } catch (err) {
        return this.reject(t.key, t.transferRef, message(err));
      }
      t.credited = true;
      this.trace.add('LOCAL', 'bank-transfer', 'bank_transfer_credited', {
        key: t.key,
        transferRef: t.transferRef,
        to: t.to,
        amountCents: t.amountCents,
        at: this.now(),
      });
      if (fault === 'lose_response_after_effect') lost = true;
      const effects: BankTransferEffects = { transferRef: t.transferRef, debited: t.debited, credited: t.credited };
      const rec = this.store.resolve(t.key, { status: 'succeeded', reference: t.transferRef, effects });
      return lost ? { key: rec.key, terms: rec.terms, status: 'unknown' } : rec;
    }
    // Both stages already applied — a resumed resolution replays the
    // terminal record, never a second effect.
    return this.store.resolve(t.key, { status: 'succeeded', reference: t.transferRef });
  }

  private park(t: Transfer): OperationRecord {
    this.deferred.set(t.key, t);
    return this.store.resolve(t.key, { status: 'pending', reference: t.transferRef });
  }
}

// Strictly positive integer cents: zero-cent money operations are refused
// outright, not rounded into a no-op.
function requireAmount(amountCents: Cents): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amount_invalid');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
