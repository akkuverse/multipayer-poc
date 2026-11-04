// The pseudonymous digital-euro holding ledger (spec §4.3). It knows
// holdings by pseudonym only — the owning provider maps pseudonym ↔
// customer, and only that provider may act on a holding. Holds reserve
// spendable funds until reserveAt + 0.5 injected-clock minutes; a replay
// never extends the deadline and expiry tombstones are kept. A same-ledger
// group commit validates every member's hold, provider, frozen membership
// and deadline before changing any holding — a LOCAL simulation
// assumption, never an ECB capability claim. A destination credit above
// its holding limit routes the excess into tracked defunding transit
// (decision 10): it is never a spendable digital-euro balance.

import type { Cents } from '../core/types.ts';
import type { Trace } from '../evidence/trace.ts';
import { OperationStore } from './operations.ts';
import type {
  DeCommitEffects,
  DeCommitRequest,
  DeCreditEffects,
  DeDefundEffects,
  DeDefundRequest,
  DeFundRequest,
  DeGroupCommitEffects,
  DeGroupCommitRequest,
  DeGroupMembership,
  DeHoldAudit,
  DeHoldEffects,
  DeHoldRequest,
  DeHoldingAudit,
  DeReleaseEffects,
  DeReleaseRequest,
  DeTransferEffects,
  DeTransferRequest,
  DeTransitAudit,
  DeferredOutcome,
  DigitalEuroStage,
  HoldStatus,
  OperationRecord,
  SimulationFault,
} from './types.ts';

// Spec §6: every hold expires 30 simulated seconds after reserve — 0.5 on
// the injected minute clock, shared with the scenario world.
export const HOLD_TTL_MINUTES = 0.5;

const STAGES: readonly DigitalEuroStage[] = ['hold', 'commit', 'release', 'fund', 'defund', 'transfer'];

interface Holding {
  pseudonym: string;
  provider: string;
  deCents: Cents;
  holdingLimitCents: Cents;
}

interface Hold {
  holdRef: string;
  key: string;
  pseudonym: string;
  amountCents: Cents;
  destination: string;
  status: HoldStatus;
  reservedAt: number;
  expiresAt: number;
  group?: DeGroupMembership;
  // A commit was accepted but is deferred: neither expiry nor release may
  // preempt it — the authoritative operation outcome decides whether
  // commit or expiry won (spec §6 race rule).
  commitPending: boolean;
}

interface TransitEntry {
  transitRef: string;
  parentKey: string;
  pseudonym: string;
  amountCents: Cents;
  status: 'in_transit' | 'defunded';
  createdAt: number;
}

interface StageResult {
  reference?: string;
  effects?: unknown;
}

interface DeferredWork {
  apply: () => StageResult;
  // Restores whatever the park marker set (e.g. commitPending on a hold)
  // when the deferred operation resolves to rejection.
  unmark?: () => void;
  // True when apply was fully pre-validated before the stage parked: it
  // either applies in full or a broken invariant made it throw. A thrown
  // apply can then mean partially applied effects, which a recorded
  // 'rejected' would hide — resolveDeferred surfaces the throw instead.
  atomic?: boolean;
}

export class DigitalEuroLedger {
  readonly name = 'digital-euro-ledger';
  readonly origin = 'LOCAL' as const;
  readonly specVersion = 'settlement-ledgers-1';

  private readonly store = new OperationStore();
  private readonly holdingByPseudonym = new Map<string, Holding>();
  private readonly holdByRef = new Map<string, Hold>();
  private readonly transitByRef = new Map<string, TransitEntry>();
  // Faults are consulted once: injecting a fault arms exactly one attempt.
  private readonly faults = new Map<string, Map<DigitalEuroStage, SimulationFault>>();
  private readonly deferred = new Map<string, DeferredWork>();
  private nextHold = 1;
  private nextTransit = 1;
  private readonly now: () => number;
  private readonly trace: Trace;

  constructor(now: () => number, trace: Trace) {
    this.now = now;
    this.trace = trace;
  }

  // Fixture setup: register a pseudonymous holding under its owning
  // provider. Conflicting re-registration is a caller bug; an identical
  // repeat is a no-op.
  registerHolding(h: { pseudonym: string; provider: string; holdingLimitCents: Cents; deCents?: Cents }): void {
    if (h.pseudonym.length === 0 || h.provider.length === 0) throw new Error('holding_terms_invalid');
    if (!Number.isInteger(h.holdingLimitCents) || h.holdingLimitCents < 0) throw new Error('holding_terms_invalid');
    const deCents = h.deCents ?? 0;
    if (!Number.isInteger(deCents) || deCents < 0) throw new Error('holding_terms_invalid');
    if (deCents > h.holdingLimitCents) throw new Error('holding_limit_exceeded');
    const existing = this.holdingByPseudonym.get(h.pseudonym);
    if (existing !== undefined) {
      if (existing.provider !== h.provider || existing.holdingLimitCents !== h.holdingLimitCents || existing.deCents !== deCents) {
        throw new Error('holding_terms_conflict');
      }
      return;
    }
    this.holdingByPseudonym.set(h.pseudonym, { pseudonym: h.pseudonym, provider: h.provider, deCents, holdingLimitCents: h.holdingLimitCents });
    this.trace.add('LOCAL', 'de-ledger', 'de_holding_registered', {
      pseudonym: h.pseudonym,
      provider: h.provider,
      holdingLimitCents: h.holdingLimitCents,
      deCents,
    });
  }

  // ---- mutating operations ---------------------------------------------

  hold(req: DeHoldRequest): OperationRecord {
    const { key: _key, ...terms } = req;
    requireAmount(req.amountCents);
    if (req.group !== undefined) checkMembership(req.group);
    const rec = this.store.begin(req.key, terms);
    if (rec.status !== 'not_started') return rec;
    const holding = this.holdingAt(req.pseudonym);
    this.holdingAt(req.destination);
    if (holding.provider !== req.provider) return this.reject(req.key, 'foreign_provider');
    if (this.spendable(holding) < req.amountCents) return this.reject(req.key, 'insufficient_funds');
    // The hold — and therefore its reference — comes into existence inside
    // the apply: a deferred or refused attempt records no handle to a hold
    // that was never reserved, so a reference on the record always names a
    // hold audit can resolve. Reconciliation before that runs on the key.
    return this.runStage(req.key, 'hold', () => {
      // Re-checked at apply time: a deferred hold parks unreserved, and
      // balances may have moved while it waited.
      if (this.spendable(holding) < req.amountCents) throw new Error('insufficient_funds');
      const holdRef = `hold-${this.nextHold++}`;
      const reservedAt = this.now();
      const hold: Hold = {
        holdRef,
        key: req.key,
        pseudonym: req.pseudonym,
        amountCents: req.amountCents,
        destination: req.destination,
        status: 'active',
        reservedAt,
        expiresAt: reservedAt + HOLD_TTL_MINUTES,
        group: req.group === undefined ? undefined : { key: req.group.key, self: req.group.self, members: [...req.group.members] },
        commitPending: false,
      };
      this.holdByRef.set(holdRef, hold);
      this.trace.add('LOCAL', 'de-ledger', 'de_hold_reserved', {
        key: req.key,
        provider: req.provider,
        pseudonym: req.pseudonym,
        holdRef,
        amountCents: req.amountCents,
        expiresAt: hold.expiresAt,
      });
      const effects: DeHoldEffects = { holdRef, reservedAt, expiresAt: hold.expiresAt };
      return { reference: holdRef, effects };
    });
  }

  commitHold(req: DeCommitRequest): OperationRecord {
    const { key: _key, ...terms } = req;
    const rec = this.store.begin(req.key, terms);
    if (rec.status !== 'not_started') return rec;
    const hold = this.holdAt(req.holdRef);
    this.expireDue(hold);
    const holding = this.holdingAt(hold.pseudonym);
    if (holding.provider !== req.provider) return this.reject(req.key, 'foreign_provider');
    // A commit already handed off must resolve first — dependent work
    // stops while an operation is unresolved.
    if (hold.commitPending) throw new Error('hold_commit_pending');
    if (hold.status === 'expired') return this.reject(req.key, 'hold_expired');
    if (hold.status !== 'active') return this.reject(req.key, 'hold_not_active');
    // A group member moves only through its group's atomic commit.
    if (hold.group !== undefined) return this.reject(req.key, 'group_hold');
    return this.runStage(
      req.key,
      'commit',
      () => {
        const credit = this.settleHold(hold, req.key);
        this.trace.add('LOCAL', 'de-ledger', 'de_hold_committed', {
          key: req.key,
          provider: req.provider,
          holdRef: hold.holdRef,
          pseudonym: hold.pseudonym,
          amountCents: hold.amountCents,
        });
        const effects: DeCommitEffects = { ...credit, holdRef: hold.holdRef };
        return { reference: hold.holdRef, effects };
      },
      { reference: hold.holdRef, park: markCommitPending(hold), atomic: true },
    );
  }

  commitGroup(req: DeGroupCommitRequest): OperationRecord {
    const { key: _key, ...terms } = req;
    if (req.members.length === 0) throw new Error('group_members_empty');
    if (new Set(req.members.map((m) => m.holdRef)).size !== req.members.length) {
      throw new Error('group_members_duplicate');
    }
    const rec = this.store.begin(req.key, terms);
    if (rec.status !== 'not_started') return rec;
    const legs = req.members.map((m) => m.leg);
    // Validate every member before any holding changes: known hold,
    // owning provider, no in-flight commit, active, unexpired and frozen
    // membership matching this group key, order and pairing.
    const resolved = req.members.map((member) => {
      const hold = this.holdAt(member.holdRef);
      this.expireDue(hold);
      return { member, hold, holding: this.holdingAt(hold.pseudonym) };
    });
    for (const { member, hold, holding } of resolved) {
      if (holding.provider !== member.provider) return this.reject(req.key, 'foreign_provider');
      if (hold.commitPending) throw new Error('hold_commit_pending');
      if (hold.status === 'expired') return this.reject(req.key, 'hold_expired');
      if (hold.status !== 'active') return this.reject(req.key, 'hold_not_active');
      const g = hold.group;
      const frozen =
        g !== undefined &&
        g.key === req.key &&
        g.self === member.leg &&
        g.members.length === legs.length &&
        g.members.every((leg, i) => leg === legs[i]);
      if (!frozen) return this.reject(req.key, 'group_membership_invalid');
    }
    return this.runStage(
      req.key,
      'commit',
      () => {
        const members = resolved.map(({ member, hold }) => {
          const credit = this.settleHold(hold, req.key);
          return { leg: member.leg, holdRef: hold.holdRef, ...credit };
        });
        this.trace.add('LOCAL', 'de-ledger', 'de_group_committed', {
          key: req.key,
          members: resolved.map((r) => r.hold.holdRef),
        });
        const effects: DeGroupCommitEffects = { members };
        return { reference: req.key, effects };
      },
      {
        reference: req.key,
        atomic: true,
        park: {
          mark: () => {
            for (const r of resolved) r.hold.commitPending = true;
          },
          unmark: () => {
            for (const r of resolved) r.hold.commitPending = false;
          },
        },
      },
    );
  }

  releaseHold(req: DeReleaseRequest): OperationRecord {
    const { key: _key, ...terms } = req;
    const rec = this.store.begin(req.key, terms);
    if (rec.status !== 'not_started') return rec;
    const hold = this.holdAt(req.holdRef);
    this.expireDue(hold);
    const holding = this.holdingAt(hold.pseudonym);
    if (holding.provider !== req.provider) return this.reject(req.key, 'foreign_provider');
    if (hold.commitPending) throw new Error('hold_commit_pending');
    // A committed hold's funds have left — there is nothing to release.
    if (hold.status === 'committed') return this.reject(req.key, 'hold_committed');
    return this.runStage(
      req.key,
      'release',
      () => {
        // An already released or expired hold is confirmed unencumbered:
        // release is a conclusive cleanup success, not a new effect.
        if (hold.status === 'active') {
          hold.status = 'released';
          this.trace.add('LOCAL', 'de-ledger', 'de_hold_released', {
            key: req.key,
            provider: req.provider,
            holdRef: hold.holdRef,
            pseudonym: hold.pseudonym,
          });
        }
        const effects: DeReleaseEffects = { holdRef: hold.holdRef, holdStatus: hold.status };
        return { reference: hold.holdRef, effects };
      },
      { reference: hold.holdRef },
    );
  }

  fund(req: DeFundRequest): OperationRecord {
    const { key: _key, ...terms } = req;
    requireAmount(req.amountCents);
    const rec = this.store.begin(req.key, terms);
    if (rec.status !== 'not_started') return rec;
    const holding = this.holdingAt(req.pseudonym);
    if (holding.provider !== req.provider) return this.reject(req.key, 'foreign_provider');
    return this.runStage(req.key, 'fund', () => {
      const effects = this.credit(req.pseudonym, req.amountCents, req.key);
      this.trace.add('LOCAL', 'de-ledger', 'de_funded', {
        key: req.key,
        provider: req.provider,
        pseudonym: req.pseudonym,
        amountCents: req.amountCents,
      });
      return { effects };
    });
  }

  defund(req: DeDefundRequest): OperationRecord {
    const { key: _key, ...terms } = req;
    requireAmount(req.amountCents);
    const rec = this.store.begin(req.key, terms);
    if (rec.status !== 'not_started') return rec;
    const holding = this.holdingAt(req.pseudonym);
    if (holding.provider !== req.provider) return this.reject(req.key, 'foreign_provider');
    if (req.transitRef !== undefined) {
      // Confirm an in-transit excess credit: the paired conversion entry —
      // the amount never was a spendable holding balance.
      const t = this.transitByRef.get(req.transitRef);
      if (t === undefined || t.pseudonym !== req.pseudonym) throw new Error('unknown_transit');
      if (t.amountCents !== req.amountCents) throw new Error('transit_amount_mismatch');
      if (t.status !== 'in_transit') return this.reject(req.key, 'transit_not_pending');
      return this.runStage(
        req.key,
        'defund',
        () => {
          if (t.status !== 'in_transit') throw new Error('transit_not_pending');
          t.status = 'defunded';
          this.trace.add('LOCAL', 'de-ledger', 'de_transit_defunded', {
            key: req.key,
            provider: req.provider,
            transitRef: t.transitRef,
            pseudonym: t.pseudonym,
            amountCents: t.amountCents,
          });
          const effects: DeDefundEffects = { debitedCents: t.amountCents, transitRef: t.transitRef };
          return { reference: t.transitRef, effects };
        },
        { reference: t.transitRef },
      );
    }
    if (this.spendable(holding) < req.amountCents) return this.reject(req.key, 'insufficient_funds');
    return this.runStage(req.key, 'defund', () => {
      if (this.spendable(holding) < req.amountCents) throw new Error('insufficient_funds');
      holding.deCents -= req.amountCents;
      this.trace.add('LOCAL', 'de-ledger', 'de_defunded', {
        key: req.key,
        provider: req.provider,
        pseudonym: req.pseudonym,
        amountCents: req.amountCents,
      });
      const effects: DeDefundEffects = { debitedCents: req.amountCents };
      return { effects };
    });
  }

  transfer(req: DeTransferRequest): OperationRecord {
    const { key: _key, ...terms } = req;
    requireAmount(req.amountCents);
    if (req.from === req.to) throw new Error('same_holding');
    const rec = this.store.begin(req.key, terms);
    if (rec.status !== 'not_started') return rec;
    const source = this.holdingAt(req.from);
    this.holdingAt(req.to);
    if (source.provider !== req.provider) return this.reject(req.key, 'foreign_provider');
    if (this.spendable(source) < req.amountCents) return this.reject(req.key, 'insufficient_funds');
    return this.runStage(req.key, 'transfer', () => {
      if (this.spendable(source) < req.amountCents) throw new Error('insufficient_funds');
      source.deCents -= req.amountCents;
      const credit = this.credit(req.to, req.amountCents, req.key);
      this.trace.add('LOCAL', 'de-ledger', 'de_transferred', {
        key: req.key,
        provider: req.provider,
        from: req.from,
        to: req.to,
        amountCents: req.amountCents,
      });
      const effects: DeTransferEffects = { ...credit, debitedCents: req.amountCents };
      return { effects };
    });
  }

  // ---- status and simulation controls ----------------------------------

  // The retained operation record under its original key, detached, or
  // undefined when the key was never begun.
  status(key: string): OperationRecord | undefined {
    return this.store.status(key);
  }

  // Arm a one-shot fault on an operation's named stage (decision 12).
  setFault(operationKey: string, stage: DigitalEuroStage, fault: SimulationFault): void {
    if (!STAGES.includes(stage)) throw new Error('unknown_stage');
    let byStage = this.faults.get(operationKey);
    if (byStage === undefined) {
      byStage = new Map();
      this.faults.set(operationKey, byStage);
    }
    byStage.set(stage, fault);
  }

  // Explicit simulation resolution of parked work — the only way a
  // deferred operation progresses; a replay under the same key only sees
  // the pending record.
  resolveDeferred(operationKey: string, outcome: DeferredOutcome, reason?: string): OperationRecord {
    const work = this.deferred.get(operationKey);
    const rec = this.store.status(operationKey);
    if (work === undefined || rec === undefined || rec.status !== 'pending') {
      throw new Error('no_deferred_operation');
    }
    this.deferred.delete(operationKey);
    if (outcome === 'reject') {
      work.unmark?.();
      const out = this.store.resolve(operationKey, { status: 'rejected', reason: reason ?? 'deferred_rejected' });
      this.trace.add('LOCAL', 'de-ledger', 'de_op_rejected', { key: operationKey, reason: out.reason });
      return out;
    }
    if (work.atomic) {
      // An atomic apply cannot legitimately throw once parked: a throw is
      // a broken pre-validation invariant, and it may have left partially
      // applied effects. Propagating keeps the failure loud; the parked
      // markers stay set so the state can be inspected as found.
      const applied = work.apply();
      return this.store.resolve(operationKey, {
        status: 'succeeded',
        reference: applied.reference ?? rec.reference,
        effects: applied.effects,
      });
    }
    try {
      const applied = work.apply();
      return this.store.resolve(operationKey, {
        status: 'succeeded',
        reference: applied.reference ?? rec.reference,
        effects: applied.effects,
      });
    } catch (err) {
      // State moved while the work was parked: the deferred attempt fails
      // conclusively under its original key, with the unmark restoring
      // whatever it had reserved. Non-atomic applies re-check moved state
      // only before their first mutation, so the rejection never covers
      // partial effects.
      work.unmark?.();
      return this.store.resolve(operationKey, { status: 'rejected', reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- detached audit reads ---------------------------------------------

  holding(pseudonym: string): DeHoldingAudit {
    const h = this.holdingAt(pseudonym);
    const heldCents = this.activeHeldCents(pseudonym);
    return {
      pseudonym: h.pseudonym,
      provider: h.provider,
      deCents: h.deCents,
      holdingLimitCents: h.holdingLimitCents,
      heldCents,
      spendableCents: h.deCents - heldCents,
    };
  }

  holdings(): DeHoldingAudit[] {
    return [...this.holdingByPseudonym.keys()].map((p) => this.holding(p));
  }

  holdAudit(holdRef: string): DeHoldAudit {
    const hold = this.holdAt(holdRef);
    this.expireDue(hold);
    return auditHold(hold);
  }

  holds(): DeHoldAudit[] {
    for (const hold of this.holdByRef.values()) this.expireDue(hold);
    return [...this.holdByRef.values()].map(auditHold);
  }

  // Defunding transit entries — the excess of holding-limited credits
  // awaiting their paired bank credit, never spendable balances.
  transit(): DeTransitAudit[] {
    return [...this.transitByRef.values()].map((t) => ({ ...t }));
  }

  // ---- internals ---------------------------------------------------------

  private holdingAt(pseudonym: string): Holding {
    const h = this.holdingByPseudonym.get(pseudonym);
    if (h === undefined) throw new Error('unknown_holding');
    return h;
  }

  private holdAt(holdRef: string): Hold {
    const hold = this.holdByRef.get(holdRef);
    if (hold === undefined) throw new Error('unknown_hold');
    return hold;
  }

  private faultAt(key: string, stage: DigitalEuroStage): SimulationFault | undefined {
    const byStage = this.faults.get(key);
    const fault = byStage?.get(stage);
    // One-shot: consulting a fault disarms it, so a deferred operation's
    // explicit resolution cannot trip over the same injected fault twice.
    if (fault !== undefined) byStage!.delete(stage);
    return fault;
  }

  private reject(key: string, reason: string): OperationRecord {
    const rec = this.store.resolve(key, { status: 'rejected', reason });
    this.trace.add('LOCAL', 'de-ledger', 'de_op_rejected', { key, reason });
    return rec;
  }

  // Run an operation's effect under its stage fault (decision 12). The
  // effect applies and is recorded before 'lose_response_after_effect'
  // hides the response — the caller sees 'unknown' and must reconcile by
  // the original key; the ledger's own record stays truthful.
  private runStage(
    key: string,
    stage: DigitalEuroStage,
    apply: () => StageResult,
    opts?: { reference?: string; park?: { mark(): void; unmark(): void }; atomic?: boolean },
  ): OperationRecord {
    const fault = this.faultAt(key, stage);
    if (fault === 'reject_before_effect') {
      const rec = this.store.resolve(key, { status: 'rejected', reason: `${stage}_rejected`, reference: opts?.reference });
      this.trace.add('LOCAL', 'de-ledger', 'de_op_rejected', { key, stage, reason: rec.reason });
      return rec;
    }
    if (fault === 'defer') {
      opts?.park?.mark();
      this.deferred.set(key, { apply, unmark: opts?.park?.unmark, atomic: opts?.atomic });
      return this.store.resolve(key, { status: 'pending', reference: opts?.reference });
    }
    const out = apply();
    const rec = this.store.resolve(key, { status: 'succeeded', reference: out.reference ?? opts?.reference, effects: out.effects });
    if (fault === 'lose_response_after_effect') {
      return { key: rec.key, terms: rec.terms, status: 'unknown' };
    }
    return rec;
  }

  // Move a hold's reserved amount out of its holding and credit the frozen
  // destination — with the holding-limit waterfall into defunding transit.
  private settleHold(hold: Hold, parentKey: string): DeCreditEffects {
    const holding = this.holdingAt(hold.pseudonym);
    holding.deCents -= hold.amountCents;
    hold.status = 'committed';
    hold.commitPending = false;
    return this.credit(hold.destination, hold.amountCents, parentKey);
  }

  // Credit a holding up to its limit; the excess routes into tracked
  // defunding transit — never a spendable digital-euro balance (§4.3, §6.1).
  private credit(pseudonym: string, amountCents: Cents, parentKey: string): DeCreditEffects {
    const dest = this.holdingAt(pseudonym);
    const room = Math.max(0, dest.holdingLimitCents - dest.deCents);
    const creditedCents = Math.min(room, amountCents);
    const defundedCents = amountCents - creditedCents;
    dest.deCents += creditedCents;
    let transitRef: string | undefined;
    if (defundedCents > 0) {
      transitRef = `de-transit-${this.nextTransit++}`;
      this.transitByRef.set(transitRef, {
        transitRef,
        parentKey,
        pseudonym,
        amountCents: defundedCents,
        status: 'in_transit',
        createdAt: this.now(),
      });
      this.trace.add('LOCAL', 'de-ledger', 'de_transit_created', {
        parentKey,
        // The transit belongs to the destination holding's provider: it is
        // that book the defunding bank credit will restore.
        provider: this.holdingAt(pseudonym).provider,
        pseudonym,
        amountCents: defundedCents,
        transitRef,
      });
    }
    return { creditedCents, defundedCents, transitRef };
  }

  // An active hold past its deadline expires — unless a commit is already
  // handed off on it. The tombstone is preserved in the hold's lifecycle.
  // Expiry is lazy: audit reads (holding/holds/holdAudit and the spendable
  // computations behind them) run this on the holds they touch, so a read
  // may write the tombstone and emit de_hold_expired at read time — the
  // recorded expiresAt stays the injected clock's deadline, so the event
  // is late surfacing of a true expiry, never a moved one.
  private expireDue(hold: Hold): void {
    if (hold.status === 'active' && !hold.commitPending && this.now() >= hold.expiresAt) {
      hold.status = 'expired';
      this.trace.add('LOCAL', 'de-ledger', 'de_hold_expired', {
        holdRef: hold.holdRef,
        provider: this.holdingAt(hold.pseudonym).provider,
        pseudonym: hold.pseudonym,
        expiresAt: hold.expiresAt,
      });
    }
  }

  private activeHeldCents(pseudonym: string): Cents {
    let held = 0;
    for (const hold of this.holdByRef.values()) {
      if (hold.pseudonym !== pseudonym) continue;
      this.expireDue(hold);
      if (hold.status === 'active') held += hold.amountCents;
    }
    return held;
  }

  private spendable(holding: Holding): Cents {
    return holding.deCents - this.activeHeldCents(holding.pseudonym);
  }
}

// Strictly positive integer cents: zero-cent money operations are refused
// outright, not rounded into a no-op.
function requireAmount(amountCents: Cents): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amount_invalid');
}

// A group descriptor must at least name a nonempty duplicate-free member
// list containing the hold's own member identity — a repeated member would
// count one leg twice. The ledger cannot verify the key was derived from
// the list — that binding is the caller's responsibility — but it enforces
// that every member's hold agrees on key, order and self.
function checkMembership(group: DeGroupMembership): void {
  const members = new Set(group.members);
  if (group.key.length === 0 || group.self.length === 0 || !members.has(group.self) || members.size !== group.members.length) {
    throw new Error('group_membership_invalid');
  }
}

function markCommitPending(hold: Hold): { mark(): void; unmark(): void } {
  return {
    mark: () => {
      hold.commitPending = true;
    },
    unmark: () => {
      hold.commitPending = false;
    },
  };
}

function auditHold(hold: Hold): DeHoldAudit {
  return {
    holdRef: hold.holdRef,
    key: hold.key,
    pseudonym: hold.pseudonym,
    amountCents: hold.amountCents,
    destination: hold.destination,
    status: hold.status,
    reservedAt: hold.reservedAt,
    expiresAt: hold.expiresAt,
    commitPending: hold.commitPending,
    group: hold.group === undefined ? undefined : { key: hold.group.key, self: hold.group.self, members: [...hold.group.members] },
  };
}
