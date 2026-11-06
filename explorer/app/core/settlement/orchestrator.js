// GENERATED from src/settlement/orchestrator.ts — type-stripped build artifact; never hand-edit.
// The settlement orchestrator (spec §4.5, §6, §7, §7.1): the one deep
// module owning execution ordering, reconciliation and compensation
// behind three public operations — submit, reconcile, returnSettled.
// It freezes an admitted intent, reserves every leg through its payer
// provider with the coordinator's first-handoff authority recheck
// immediately before each first handoff, commits bank legs in frozen
// proposal order and then the digital-euro atomic group through the
// provider-owned helper, and on conclusive failure stops dependent work,
// releases uncommitted holds and compensates confirmed settlements —
// always under the original operation keys, never by minting fresh
// idempotency.
//
// A timeout or a lost response is never a failure: open operations stay
// unresolved in the snapshot until authoritative status resolves them,
// and reconcile() resumes every open operation of the same intent by its
// original key. Known pre-handoff input conflicts — malformed intents,
// changed terms under a recorded purchaseRef, unroutable payers — throw
// conclusive refusals; uncertainty after a handoff is recorded in the
// snapshot, never thrown. All events are LOCAL and carry the
// 'orchestrator' actor.

                                              
import { RAILS } from '../core/types.js';
import { canonicalJson } from '../core/signing.js';
                                                  
import { RequestLog } from '../evidence/trace.js';
import { operationKey } from './operations.js';
                                                                  
import { ProviderUnavailableError } from './provider.js';
                                                                   
             
               
                    
                    
               
             
                  
                  
                  
                 
               
               
              
                   
                
                        
                          
                  
                     
                    

// 'unwinding' releases holds and restores funding with nothing committed;
// 'compensating' returns confirmed payments. Both keep unresolved work
// visible rather than asserting a terminal outcome.

const OPEN                             = ['not_started', 'pending', 'unknown'];
const isOpen = (status                             )          => status !== undefined && OPEN.includes(status);

// The same leg-operation identity the providers key on — known before
// dispatch so total response loss stays reconcilable.
const legOpKey = (leg               , op        )         =>
  operationKey(['leg', leg.purchaseId, leg.proposalVersion, leg.role, op]);

// One stable return identity per leg per reason — a replay under the same
// scope resumes the same operation, and the provider refuses a second
// return across reasons/scopes (decision 9).
const returnKeyFor = (leg               , reason              )         =>
  operationKey(['return', leg.purchaseId, leg.proposalVersion, leg.role, reason]);

const RETURN_REASONS                          = ['compensation', 'recovery', 'refund', 'dispute'];

// The orchestrator's retained record for one frozen leg: the frozen leg
// itself, the latest outcome per operation and the references they
// produced. Outcomes are detached copies — this record is the working
// truth, snapshots are its projection.
                   
                     
                          
                                                                          
                   
                           
                           
                            
                             
                                                                  
                                                          
                              
                   
                              
                        
                                                                      
                                                                       
                                               
                                  
 

                       
                                                                    
                           
                    
                  
                                                                        
                                              
                   
                       
                                                                    
                                                                         
                                             
                   
 

// The result of a provider status query: the outcome, nothing recorded
// under the key, or a call that itself could not complete.
                                                                                       

export class SettlementOrchestrator {
           origin = 'LOCAL'         ;
           name = 'settlement-orchestrator';
           specVersion = 'settlement-ledgers-1';
                   providers                                    ;
                   owners                ;
                   commitDeGroup   
                                   
                           
                         
                            ;
  // Read-only access for hold lifecycle audits; the orchestrator never
  // moves holdings itself (decision 11).
                   de                    ;
                   now              ;
                   trace       ;
                   requests            ;
  // The coordinator-owned synchronous recheck, run immediately before
  // each leg's first provider handoff — its decision is never retained
  // across an await (decision 7).
                   authorizeFirstHandoff                                           ;
                   worlds = new Map                     ();
  // Leg identity is (purchaseId, proposalVersion, role) — the tuple every
  // provider operation key binds. purchaseRef is the orchestrator's own
  // intake identity and is not part of that key, so two admitted intents
  // sharing a leg identity would adopt each other's recorded provider
  // outcomes; the collision is a conclusive pre-handoff refusal.
                   legOwners = new Map                ();

  constructor(opts   
                                                  
                           
                                                                                                                           
                                    
                      
                 
                                                                     
   ) {
    this.providers = opts.providers;
    this.owners = opts.owners;
    this.commitDeGroup = opts.commitDeGroup;
    this.de = opts.digitalEuro;
    this.now = opts.now;
    this.trace = opts.trace;
    this.authorizeFirstHandoff = opts.authorizeFirstHandoff;
    this.requests = new RequestLog(opts.trace, 'orchestrator');
  }

          log(event        , detail                          )       {
    this.trace.add('LOCAL', 'orchestrator', event, detail);
  }

  // ---- public interface (decision 6) -------------------------------------

  // Freeze the intent and drive it as far as evidence allows: reserve
  // every leg, commit bank legs in order, then the DE atomic group — or
  // unwind and compensate after a conclusive failure. A replay under the
  // same purchaseRef resumes the recorded intent; changed terms are a
  // conclusive refusal.
  async submit(intent                  )                              {
    let w             ;
    try {
      w = this.admit(intent);
    } catch (err) {
      // A conclusive pre-handoff refusal still answers the coordinator's
      // request: the rejected admission pairs with submit_requested by
      // purchaseRef rather than leaving the request open.
      this.log('settlement_intent_rejected', {
        key: typeof intent?.purchaseRef === 'string' && intent.purchaseRef.length > 0 ? intent.purchaseRef : undefined,
        reason: message(err),
      });
      throw err;
    }
    return this.exclusive(w, async () => {
      await this.resumeReturns(w);
      await this.drive(w);
      return this.snapshot(w);
    });
  }

  // Resume every unresolved operation of the recorded intent by its
  // original key — never a fresh operation, never a new key.
  async reconcile(purchaseRef        )                              {
    const w = this.worlds.get(purchaseRef);
    if (w === undefined) throw new Error('unknown_purchase');
    return this.exclusive(w, async () => {
      await this.resumeReturns(w);
      await this.drive(w);
      return this.snapshot(w);
    });
  }

  // Issue returns for the frozen legs the scope selects, under the
  // scope's stable keys and policy: 'compensation' restores principal
  // and charged fees; ordinary reasons restore principal only
  // (decision 9). The original operation is always resolved first —
  // a return never races an unresolved commit.
  async returnSettled(purchaseRef        , scope             )                              {
    const w = this.worlds.get(purchaseRef);
    if (w === undefined) throw new Error('unknown_purchase');
    if (
      scope === null ||
      typeof scope !== 'object' ||
      !RETURN_REASONS.includes(scope.reason) ||
      !Array.isArray(scope.legs)
    ) {
      throw new Error('return_scope_invalid');
    }
    const roles = new Set(w.legs.map((l) => l.leg.role));
    for (const role of scope.legs) {
      if (!roles.has(role)) throw new Error('unknown_leg');
    }
    return this.exclusive(w, async () => {
      for (const l of w.legs) {
        if (!scope.legs.includes(l.leg.role)) continue;
        await this.refreshLeg(w, l);
        if (!this.legCommitted(w, l)) continue;
        // An open return marker does not gate re-driving: returnLeg's own
        // status check adopts a recorded outcome or retries under the same
        // key — the provider dedupes, so a retry can never return twice.
        await this.returnLeg(w, l, scope.reason);
      }
      await this.drive(w);
      return this.snapshot(w);
    });
  }

  // One caller at a time per recorded world: provider bodies are
  // synchronous today, but every await is an interleaving point and a
  // second operation joining mid-drive could double-dispatch or read
  // half-updated records — refused outright rather than queued.
          async exclusive   (w             , fn                  )             {
    if (w.driving) throw new Error('drive_in_progress');
    w.driving = true;
    try {
      return await fn();
    } finally {
      w.driving = false;
    }
  }

  // ---- intent admission ---------------------------------------------------

  // Register the frozen intent, or return the recorded world for an
  // identical replay. Known pre-handoff conflicts — malformed intents,
  // duplicate roles, unroutable payers, changed terms — throw.
          admit(intent                  )              {
    const frozen = this.freeze(intent);
    const existing = this.worlds.get(frozen.purchaseRef);
    if (existing !== undefined) {
      if (existing.canonical !== canonicalJson(frozen)) throw new Error('settlement_intent_conflict');
      return existing;
    }
    for (const leg of frozen.legs) {
      const idKey = operationKey(['leg', leg.purchaseId, leg.proposalVersion, leg.role]);
      const owner = this.legOwners.get(idKey);
      if (owner !== undefined && owner !== frozen.purchaseRef) throw new Error('leg_identity_conflict');
    }
    const w              = {
      intent: frozen,
      canonical: canonicalJson(frozen),
      legs: frozen.legs.map((leg) => ({ leg, provider: this.providers.get(leg.payerId) , lost: [] })),
      aborted: false,
      driving: false,
    };
    for (const leg of frozen.legs) {
      this.legOwners.set(operationKey(['leg', leg.purchaseId, leg.proposalVersion, leg.role]), frozen.purchaseRef);
    }
    this.worlds.set(frozen.purchaseRef, w);
    this.log('settlement_intent', {
      key: frozen.purchaseRef,
      purchaseRef: frozen.purchaseRef,
      mode: frozen.mode,
      legs: frozen.legs.map((l) => l.role),
      at: this.now(),
    });
    return w;
  }

  // Detach and validate the intent: purchase identity consistent across
  // legs, roles unique, every payer routable, rails recognized. In atomic
  // mode the DE legs join one frozen same-ledger group whose key binds
  // the ordered member list (decision 2); a caller-supplied membership
  // must match the minted binding exactly.
          freeze(intent                  )                   {
    if (intent === null || typeof intent !== 'object') throw new Error('intent_invalid');
    if (typeof intent.purchaseRef !== 'string' || intent.purchaseRef.length === 0) {
      throw new Error('intent_invalid');
    }
    if (typeof intent.purchaseId !== 'string' || intent.purchaseId.length === 0) {
      throw new Error('intent_invalid');
    }
    if (!Number.isInteger(intent.proposalVersion) || intent.proposalVersion <= 0) {
      throw new Error('intent_invalid');
    }
    if (intent.mode !== 'atomic' && intent.mode !== 'independent') throw new Error('intent_invalid');
    if (!Array.isArray(intent.legs) || intent.legs.length === 0) throw new Error('intent_invalid');
    const frozen                   = structuredClone(intent);
    const roles = new Set        ();
    for (const leg of frozen.legs) {
      if (leg.purchaseId !== frozen.purchaseId || leg.proposalVersion !== frozen.proposalVersion) {
        throw new Error('leg_terms_conflict');
      }
      if (roles.has(leg.role)) throw new Error('leg_role_duplicate');
      roles.add(leg.role);
      if (!RAILS.includes(leg.rail)) throw new Error('leg_terms_conflict');
      if (!this.providers.has(leg.payerId)) throw new Error('unknown_provider');
    }
    if (frozen.mode === 'independent') {
      // Per-leg reserve/commit admits no atomic group (spec §6 rules).
      if (frozen.legs.some((l) => l.deGroup !== undefined)) throw new Error('group_on_independent_leg');
      return frozen;
    }
    // A group descriptor belongs to a same-ledger DE leg only: minted or
    // supplied on any other rail it is a conclusive terms refusal here,
    // pre-handoff — not a provider rejection mid-drive.
    if (frozen.legs.some((l) => l.deGroup !== undefined && l.rail !== 'digital_euro')) {
      throw new Error('group_on_bank_rail');
    }
    if (frozen.legs.some((l) => l.deGroup !== undefined && l.principalCents === 0)) {
      throw new Error('group_on_fee_only_leg');
    }
    const deLegs = frozen.legs.filter((l) => l.rail === 'digital_euro' && l.principalCents > 0);
    if (deLegs.length === 0) return frozen;
    const members = deLegs.map((l) => l.role);
    const key = operationKey(['de-group', frozen.purchaseId, frozen.proposalVersion, 'commit', ...members]);
    for (const leg of deLegs) {
      const minted                    = { key, self: leg.role, members };
      if (leg.deGroup === undefined) {
        leg.deGroup = minted;
      } else if (canonicalJson(leg.deGroup) !== canonicalJson(minted)) {
        throw new Error('group_terms_invalid');
      }
    }
    return frozen;
  }

  // ---- driving --------------------------------------------------------------

          async drive(w             )                {
    if (w.intent.mode === 'atomic') {
      await this.driveAtomic(w);
    } else {
      await this.driveIndependent(w);
    }
  }

  // Spec §6: reserve every leg, then commit bank legs in frozen order and
  // the DE atomic group; a conclusive refusal stops new work and releases
  // accepted holds; a conclusive commit failure stops commits, releases
  // uncommitted holds and compensates confirmed settlements.
          async driveAtomic(w             )                {
    if (!w.aborted) {
      for (const l of w.legs) {
        await this.reserveLeg(w, l);
        if (l.refusal !== undefined || l.reserve?.status === 'rejected') {
          w.aborted = true;
          break;
        }
      }
    }
    // An intent already aborted — by this pass or a previous one — never
    // starts new work: only the unwind path runs.
    if (w.aborted) {
      await this.unwind(w);
      return;
    }
    if (w.legs.some((l) => l.reserve?.status !== 'succeeded')) return;

    for (const l of w.legs) {
      if (l.leg.rail !== 'bank' && l.leg.principalCents !== 0) continue;
      await this.commitLeg(w, l);
      if (l.commit?.status === 'rejected') {
        w.aborted = true;
        break;
      }
      // Dependent work stops while a required operation is unresolved.
      if (l.commit?.status !== 'succeeded') return;
    }
    if (w.aborted) {
      await this.unwind(w);
      return;
    }

    const deLegs = w.legs.filter((l) => l.leg.deGroup !== undefined);
    if (deLegs.length > 0) {
      if (w.group === undefined || isOpen(w.group.status)) {
        await this.commitGroup(w, deLegs);
      }
      if (w.group?.status === 'rejected') {
        w.aborted = true;
        await this.unwind(w);
        return;
      }
      if (w.group === undefined || isOpen(w.group.status)) return;
      // The group committed: each owning provider finishes its
      // fee/waterfall bookkeeping through commit(holdRef) (decision 11).
      for (const l of deLegs) {
        await this.commitLeg(w, l);
        if (l.commit?.status === 'rejected') {
          w.aborted = true;
          break;
        }
        if (l.commit?.status !== 'succeeded') return;
      }
      if (w.aborted) await this.unwind(w);
    }
  }

  // 'independent' reserves and commits each leg separately, cleans up
  // failed legs and keeps successful ones — no automatic compensation.
          async driveIndependent(w             )                {
    for (const l of w.legs) {
      if (l.refusal === undefined && (l.reserve === undefined || isOpen(l.reserve.status))) {
        // An open reserve re-attempts under its original key: reserveLeg
        // re-queries authoritative status first, and a conclusively
        // unstarted reserve — for example one parked while its provider
        // was unreachable — rechecks live authority before first handoff.
        await this.reserveLeg(w, l);
      }
      await this.refreshLeg(w, l);
      if (l.refusal !== undefined || l.reserve?.status === 'rejected') {
        await this.tidyLeg(w, l);
        continue;
      }
      if (l.reserve?.status !== 'succeeded') continue;
      await this.commitLeg(w, l);
      if (l.commit?.status === 'rejected') await this.tidyLeg(w, l);
    }
  }

  // Release the uncommitted hold and unwind funding effects of a failed
  // leg — a leg still blocked keeps its open operations unresolved.
          async tidyLeg(w             , l         )                {
    await this.refreshLeg(w, l);
    if (this.holdOutstanding(w, l)) await this.releaseLeg(w, l);
  }

  // ---- per-leg operations -------------------------------------------------

  // Reserve one leg: a leg already handed off resumes by status under its
  // original key with the retained acceptance evidence; a conclusively
  // unstarted reserve rechecks live authority immediately before the
  // first handoff (decision 7).
          async reserveLeg(w             , l         )                {
    if (l.refusal !== undefined) return;
    if (l.reserve !== undefined && !isOpen(l.reserve.status)) return;
    const key = legOpKey(l.leg, 'reserve');
    const st = await this.providerStatus(l.provider, key);
    if (st.failed === 'unavailable') {
      // The provider cannot be reached at all: never proof of failure,
      // before or after a handoff (spec §7) — keep the operation open and
      // retry under the same key on the next pass.
      l.reserve ??= { key, status: 'pending', reason: 'provider_unavailable', unresolved: [] };
      return;
    }
    if (st.failed === 'uncertain') {
      l.reserve ??= { key, status: 'unknown', unresolved: [] };
      this.lose(l, key);
      return;
    }
    if (st.outcome !== undefined) {
      l.reserve = st.outcome                  ;
      this.clearLost(l, key);
      if (l.reserve.status === 'succeeded') this.captureReserve(l);
      return;
    }
    // Conclusively unstarted: the coordinator's synchronous recheck runs
    // now, in this same synchronous stretch as the handoff that follows.
    let decision                   ;
    try {
      decision = this.authorizeFirstHandoff(l.leg);
    } catch (err) {
      decision = { accepted: false, reason: `authority_recheck_failed:${message(err)}` };
    }
    if (!decision.accepted) {
      l.refusal = decision.reason;
      this.log('leg_authority_refused', { role: l.leg.role, payerId: l.leg.payerId, reason: decision.reason });
      return;
    }
    this.requests.add('reserve_requested', key, l.provider.provider, w.intent.purchaseRef, {
      role: l.leg.role,
      payerId: l.leg.payerId,
      rail: l.leg.rail,
      principalCents: l.leg.principalCents,
      feeCents: l.leg.feeCents,
    });
    const out = await this.attempt(() => l.provider.reserve(l.leg, decision.evidence));
    if (out === 'unavailable') {
      // The provider refused before acting: conclusively unstarted —
      // open and retryable, never a refusal.
      l.reserve ??= { key, status: 'pending', reason: 'provider_unavailable', unresolved: [] };
      return;
    }
    if (out === 'uncertain') {
      l.reserve = { key, status: 'unknown', unresolved: [] };
      this.lose(l, key);
      return;
    }
    l.reserve = out;
    this.clearLost(l, key);
    if (out.status === 'succeeded') this.captureReserve(l);
    this.log('leg_reserve', { key, role: l.leg.role, status: out.status, reason: out.reason });
  }

          captureReserve(l         )       {
    l.holdRef = l.reserve?.holdRef ?? l.holdRef;
    l.acceptedHold = l.reserve?.acceptedHold ?? l.acceptedHold;
  }

  // Commit one leg through its provider under the original commit key:
  // the bank rail's individual transfer, or the DE member's post-group
  // bookkeeping.
          async commitLeg(w             , l         )                {
    l.holdRef ??= l.reserve?.holdRef;
    if (l.holdRef === undefined) return;
    if (l.commit !== undefined && !isOpen(l.commit.status)) return;
    const key = legOpKey(l.leg, 'commit');
    const st = await this.providerStatus(l.provider, key);
    if (st.failed === 'unavailable') {
      l.commit ??= { key, status: 'pending', reason: 'provider_unavailable', unresolved: [] };
      return;
    }
    if (st.failed === 'uncertain') {
      l.commit ??= { key, status: 'unknown', unresolved: [] };
      this.lose(l, key);
      return;
    }
    if (st.outcome !== undefined) {
      l.commit = st.outcome;
      this.clearLost(l, key);
      this.captureCommit(l);
      return;
    }
    this.requests.add('commit_requested', key, l.provider.provider, w.intent.purchaseRef, {
      role: l.leg.role,
      payerId: l.leg.payerId,
      rail: l.leg.rail,
      holdRef: l.holdRef,
      // A group member's money already moved under the group commit: this
      // call is the provider's own fee/waterfall bookkeeping, marked so it
      // is never read as a commit that moves money.
      ...(l.leg.deGroup !== undefined ? { bookkeeping: true } : {}),
    });
    const out = await this.attempt(() => l.provider.commit(l.holdRef ));
    if (out === 'unavailable') {
      l.commit ??= { key, status: 'pending', reason: 'provider_unavailable', unresolved: [] };
      return;
    }
    if (out === 'uncertain') {
      l.commit = { key, status: 'unknown', unresolved: [] };
      this.lose(l, key);
      return;
    }
    l.commit = out;
    this.clearLost(l, key);
    this.captureCommit(l);
    this.log('leg_commit', { key, role: l.leg.role, status: out.status, reason: out.reason });
  }

          captureCommit(l         )       {
    if (l.commit?.reference !== undefined && l.commit.committedCents !== undefined) {
      l.executionRef ??= l.commit.reference;
    }
  }

  // Commit the frozen DE group's accepted holds atomically through the
  // provider-owned helper — never fabricated access, and recoverable
  // under the original group key on replay (decision 11).
          async commitGroup(w             , deLegs           )                {
    if (w.group !== undefined && !isOpen(w.group.status)) return;
    for (const l of deLegs) {
      if (l.acceptedHold !== undefined) continue;
      // Recover the group handle from the recorded reserve outcome.
      const st = await this.providerStatus(l.provider, legOpKey(l.leg, 'reserve'));
      if (st.outcome !== undefined) {
        l.reserve = st.outcome                  ;
        this.clearLost(l, legOpKey(l.leg, 'reserve'));
        l.acceptedHold = l.reserve.acceptedHold ?? l.acceptedHold;
      }
    }
    const blocked = deLegs.filter((l) => l.acceptedHold === undefined);
    if (blocked.length > 0) {
      // A member's acceptance could not be recovered under its original
      // reserve key: the group stays stalled — visible, never silent.
      this.log('de_group_blocked', {
        key: deLegs[0].leg.deGroup?.key,
        waiting: blocked.map((l) => l.leg.role),
      });
      return;
    }
    // The provider-owned helper commits every member's accepted hold in one
    // ledger operation, through the owning providers — never a ledger call
    // of the orchestrator's own. 'de-providers' names the owning providers
    // as one receiver so the group key keeps a single request per dispatch;
    // the member detail names each provider. The helper logs the vouch
    // requests and the providers' one ledger commit under this key.
    this.requests.add('de_group_commit_requested', deLegs[0].leg.deGroup .key, 'de-providers', w.intent.purchaseRef, {
      members: deLegs.map((l) => ({ role: l.leg.role, payerId: l.leg.payerId, provider: l.provider.provider })),
    });
    const out = await this.attempt(() =>
      this.commitDeGroup(
        deLegs.map((l) => l.acceptedHold ),
        this.owners,
        this.requests,
      ),
    );
    if (out === 'unavailable' || out === 'uncertain') {
      const key = deLegs[0].leg.deGroup .key;
      w.group ??= { key, status: 'unknown', members: [] };
      this.log('de_group_uncertain', { key });
      return;
    }
    w.group = out;
    this.log('de_group', {
      key: out.key,
      status: out.status,
      reason: out.reason,
      members: out.members.map((m) => ({ leg: m.leg, provider: m.provider, holdRef: m.holdRef, status: m.status, reason: m.reason })),
    });
  }

          async releaseLeg(w             , l         )                {
    if (l.holdRef === undefined) return;
    if (l.release !== undefined && !isOpen(l.release.status)) return;
    const key = legOpKey(l.leg, 'release');
    const st = await this.providerStatus(l.provider, key);
    if (st.failed !== undefined) {
      // Keep the lost/uncertain call attached to a recorded open outcome
      // so refreshLeg can converge it under the original key.
      if (st.failed === 'uncertain') {
        l.release ??= { key, status: 'unknown', unresolved: [] };
        this.lose(l, key);
      } else {
        l.release ??= { key, status: 'pending', reason: 'provider_unavailable', unresolved: [] };
      }
      return;
    }
    if (st.outcome !== undefined) {
      l.release = st.outcome;
      this.clearLost(l, key);
      return;
    }
    this.requests.add('release_requested', key, l.provider.provider, w.intent.purchaseRef, {
      role: l.leg.role,
      payerId: l.leg.payerId,
      rail: l.leg.rail,
      holdRef: l.holdRef,
    });
    const out = await this.attempt(() => l.provider.release(l.holdRef ));
    if (out === 'unavailable' || out === 'uncertain') {
      if (out === 'uncertain') {
        l.release = { key, status: 'unknown', unresolved: [] };
        this.lose(l, key);
      } else {
        l.release ??= { key, status: 'pending', reason: 'provider_unavailable', unresolved: [] };
      }
      return;
    }
    l.release = out;
    this.clearLost(l, key);
    this.log('leg_release', { key, role: l.leg.role, status: out.status, reason: out.reason });
  }

  // Issue a return under the scope's stable key and explicit policy —
  // 'compensation' restores principal and charged fee, ordinary reasons
  // principal only (decision 9). The same original execution is never
  // returned twice.
          async returnLeg(w             , l         , reason              )                {
    if (l.returned?.status === 'succeeded') return;
    // Another scope cannot replace an unresolved return's original key or
    // policy. A conclusively refused attempt may accept a later scope.
    if (l.returnReason !== undefined && isOpen(l.returned?.status)) reason = l.returnReason;
    l.returnReason = reason;
    // Recovery references may exist beside partial money movement, but
    // an open original commit must resolve before any return can start.
    if (l.commit === undefined || isOpen(l.commit.status)) await this.commitLeg(w, l);
    if (l.commit === undefined || isOpen(l.commit.status)) return;
    if (l.leg.deGroup !== undefined && (w.group === undefined || isOpen(w.group.status))) return;
    // The execution reference is minted by the commit bookkeeping: a
    // group-committed member finishes its own commit first.
    if (l.executionRef === undefined) {
      await this.commitLeg(w, l);
      if (l.executionRef === undefined) return;
    }
    const policy               = reason === 'compensation' ? 'principal_and_fee' : 'principal_only';
    const key = returnKeyFor(l.leg, reason);
    const st = await this.providerStatus(l.provider, key);
    if (st.failed !== undefined) {
      if (st.failed === 'uncertain') {
        l.returned ??= { key, status: 'unknown', unresolved: [] };
        this.lose(l, key);
      } else {
        l.returned ??= { key, status: 'pending', reason: 'provider_unavailable', unresolved: [] };
      }
      return;
    }
    if (st.outcome !== undefined) {
      // A recorded return outcome is evidence, but a succeeded return —
      // the money truth that clears exposure — is never overwritten by a
      // later refusal under another key.
      if (l.returned?.status !== 'succeeded') l.returned = st.outcome;
      this.clearLost(l, key);
      return;
    }
    this.requests.add('return_requested', key, l.provider.provider, w.intent.purchaseRef, {
      role: l.leg.role,
      payerId: l.leg.payerId,
      rail: l.leg.rail,
      reason,
      policy,
      executionRef: l.executionRef,
    });
    const out = await this.attempt(() => l.provider.refund(l.executionRef , key, policy));
    if (out === 'unavailable' || out === 'uncertain') {
      if (out === 'uncertain') {
        l.returned = { key, status: 'unknown', unresolved: [] };
        this.lose(l, key);
      } else {
        l.returned ??= { key, status: 'pending', reason: 'provider_unavailable', unresolved: [] };
      }
      return;
    }
    l.returned = out;
    this.clearLost(l, key);
    this.log('leg_return', { key, role: l.leg.role, reason, status: out.status, outcomeReason: out.reason });
  }

  // Submission replay and reconciliation resume only returns already
  // requested by an authorised caller or compensation. Preserve the
  // original reason even if the first call never reached the provider;
  // returnLeg queries status before retrying the same key and policy.
          async resumeReturns(w             )                {
    for (const l of w.legs) {
      if (l.returnReason !== undefined && (l.returned === undefined || isOpen(l.returned.status))) {
        await this.returnLeg(w, l, l.returnReason);
      }
    }
  }

  // The cleanup/compensation path after a conclusive failure (spec §6
  // steps 3 and 5): every open operation resolves by its original key
  // first — never racing a return or a release against an unresolved
  // original — then committed legs are compensated and uncommitted holds
  // released. Runs to a fixpoint or until unresolved work stops it.
          async unwind(w             )                {
    for (let round = 0; round < 8; round++) {
      const before = this.stateSignature(w);
      for (const l of w.legs) await this.refreshLeg(w, l);
      if (w.group !== undefined && isOpen(w.group.status)) {
        await this.commitGroup(w, w.legs.filter((l) => l.leg.deGroup !== undefined));
      }
      for (const l of w.legs) {
        if (this.legCommitted(w, l)) {
          await this.returnLeg(w, l, 'compensation');
        } else if (this.holdOutstanding(w, l)) {
          await this.releaseLeg(w, l);
        }
      }
      if (this.stateSignature(w) === before) return;
    }
  }

  // Refresh every retained open outcome of a leg through authoritative
  // status under the original keys — the status call itself converges
  // the provider's child work.
          async refreshLeg(w             , l         )                {
    // Any authoritative answer for a key — open or terminal — supersedes
    // a lost-call marker: the outcome itself now carries the truth.
    if (l.reserve !== undefined && isOpen(l.reserve.status)) {
      const key = l.reserve.key;
      const st = await this.providerStatus(l.provider, key);
      if (st.outcome !== undefined) {
        l.reserve = st.outcome                  ;
        this.clearLost(l, key);
        if (l.reserve.status === 'succeeded') this.captureReserve(l);
      }
    }
    if (l.commit !== undefined && isOpen(l.commit.status)) {
      const key = l.commit.key;
      const st = await this.providerStatus(l.provider, key);
      if (st.outcome !== undefined) {
        l.commit = st.outcome;
        this.clearLost(l, key);
        this.captureCommit(l);
      }
    }
    if (l.release !== undefined && isOpen(l.release.status)) {
      const key = l.release.key;
      const st = await this.providerStatus(l.provider, key);
      if (st.outcome !== undefined) {
        l.release = st.outcome;
        this.clearLost(l, key);
      }
    }
    if (l.returned !== undefined && isOpen(l.returned.status)) {
      const key = l.returned.key;
      const st = await this.providerStatus(l.provider, key);
      if (st.outcome !== undefined) {
        l.returned = st.outcome;
        this.clearLost(l, key);
      }
    }
  }

  // A compact signature of every tracked outcome — unwind loops until it
  // stops changing.
          stateSignature(w             )         {
    const legBits = w.legs
      .map((l) =>
        [l.refusal ?? '-', l.reserve?.status ?? '-', l.commit?.status ?? '-', l.release?.status ?? '-', l.returned?.status ?? '-'].join(
          ':',
        ),
      )
      .join('|');
    return `${legBits}#${w.group?.status ?? '-'}`;
  }

  // ---- provider-call plumbing ---------------------------------------------

  // Authoritative status under the original key. Nothing recorded means
  // the operation conclusively never started; a call that cannot complete
  // reports its own failure mode instead of guessing.
          async providerStatus(provider               , key        )                       {
    try {
      return { outcome: await provider.status(key) };
    } catch (err) {
      if (err instanceof Error && err.message === 'unknown_operation') return {};
      if (err instanceof ProviderUnavailableError) return { failed: 'unavailable' };
      this.log('provider_status_failed', { key, message: message(err) });
      return { failed: 'uncertain' };
    }
  }

  // Wrap a provider call: unavailability is conclusive for that call (the
  // provider refused before acting); any other throw after handoff is
  // indistinguishable from a lost response — uncertainty, not failure.
          async attempt                                                           (
    fn                  ,
  )                                           {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderUnavailableError) return 'unavailable';
      this.log('provider_call_uncertain', { message: message(err) });
      return 'uncertain';
    }
  }

          lose(l         , key        )       {
    if (!l.lost.some((x) => x.key === key)) l.lost.push({ key, status: 'unknown' });
  }

          clearLost(l         , key        )       {
    l.lost = l.lost.filter((x) => x.key !== key);
  }

  // ---- derived leg truth ---------------------------------------------------

          legCommitted(w             , l         )          {
    if (l.commit?.committedCents !== undefined) return true;
    return this.groupMemberCommitted(w, l);
  }

  // A group member's hold moved under the group operation even before
  // its own provider bookkeeping confirms — committed principal by the
  // ledger's atomic step.
          groupMemberCommitted(w             , l         )          {
    const g = l.leg.deGroup;
    if (g === undefined || w.group?.status !== 'succeeded') return false;
    return w.group.members.find((m) => m.leg === g.self)?.status === 'succeeded';
  }

          legSettled(l         )          {
    return l.commit?.status === 'succeeded' && l.commit.destinationCreditConfirmed === true;
  }

          legFailed(l         )          {
    return l.refusal !== undefined || l.reserve?.status === 'rejected' || l.commit?.status === 'rejected';
  }

          legOpen(l         )          {
    // A leg refused before its first handoff is conclusively done: the
    // stale open marker on its reserve is scheduling evidence, not work.
    if (l.refusal !== undefined) return false;
    if (l.lost.length > 0) return true;
    for (const o of [l.reserve, l.commit, l.release, l.returned]) {
      if (o !== undefined && isOpen(o.status)) return true;
    }
    return false;
  }

          hasOpen(w             )          {
    return w.legs.some((l) => this.legOpen(l)) || (w.group !== undefined && isOpen(w.group.status));
  }

  // An accepted hold that is neither committed nor blocked behind an
  // unresolved commit — releasable now.
          holdOutstanding(w             , l         )          {
    if (l.holdRef === undefined || l.reserve?.status !== 'succeeded') return false;
    if (this.legCommitted(w, l)) return false;
    if (l.commit !== undefined && isOpen(l.commit.status)) return false;
    return true;
  }

          committedCents(w             , l         )        {
    if (l.commit?.committedCents !== undefined) return l.commit.committedCents;
    if (this.groupMemberCommitted(w, l)) return l.leg.principalCents;
    return 0;
  }

  // Cleanup is confirmed for a leg when its most advanced operation
  // reports holds released, funding restored and no transit — and, once
  // the intent aborted, when a committed leg's required return is also
  // confirmed: 'compensated' is never asserted beside unrestored money.
          legClean(w             , l         )          {
    // A leg refused by authority before its first handoff has nothing
    // provider-side to clean — the refusal is recorded only when the
    // provider reports nothing under the reserve key, so any stale open
    // marker is scheduling evidence, not work to reconcile.
    if (l.refusal !== undefined && !this.legCommitted(w, l)) return true;
    const latest = l.returned ?? l.release ?? l.commit ?? l.reserve;
    if (latest !== undefined && latest.cleanupConfirmed !== true) return false;
    if (w.aborted && this.legCommitted(w, l) && l.returned?.status !== 'succeeded') return false;
    return true;
  }

          allClean(w             )          {
    return w.legs.every((l) => this.legClean(w, l));
  }

  // A committed leg's money is "known exposure" only once the purchase
  // cannot complete with it in the payee's hands — the intent aborted or
  // a sibling leg conclusively failed — or once a return was actually
  // issued on the leg. Money the payee rightfully holds in a completable
  // purchase is no exposure at all.
          legStranded(w             , l         )          {
    return w.aborted || w.legs.some((x) => this.legFailed(x)) || l.returned !== undefined;
  }

          exposureCents(w             )        {
    let total = 0;
    for (const l of w.legs) {
      if (!this.legStranded(w, l)) continue;
      total += Math.max(0, this.committedCents(w, l) - (l.returned?.principalReturnedCents ?? 0));
      total += Math.max(0, (l.commit?.feeChargedCents ?? 0) - (l.returned?.feeReturnedCents ?? 0));
    }
    return total;
  }

  // Fees a return was due but did not restore — the unreturned fees the
  // principal-only policy keeps visible (spec §7.1). A leg never
  // returned has nothing counted here.
          retainedFeeCents(w             )        {
    let total = 0;
    for (const l of w.legs) {
      if (l.returned === undefined) continue;
      total += Math.max(0, (l.commit?.feeChargedCents ?? 0) - (l.returned.feeReturnedCents ?? 0));
    }
    return total;
  }

  // Every committed leg's principal confirmed restored — the difference
  // between 'recovered' (principal back, fees possibly retained) and
  // 'recovery_required' (committed money still out).
          allPrincipalReturned(w             )          {
    return w.legs.every(
      (l) => !this.legCommitted(w, l) || (l.returned?.principalReturnedCents ?? 0) >= this.committedCents(w, l),
    );
  }

  // ---- snapshot -------------------------------------------------------------

          snapshot(w             )                     {
    const phase = this.phaseOf(w);
    const unresolved = this.unresolved(w);
    let committedCents = 0;
    let settledCents = 0;
    let principalReturnedCents = 0;
    let feeReturnedCents = 0;
    for (const l of w.legs) {
      committedCents += this.committedCents(w, l);
      if (this.legSettled(l)) settledCents += l.leg.principalCents;
      principalReturnedCents += l.returned?.principalReturnedCents ?? 0;
      feeReturnedCents += l.returned?.feeReturnedCents ?? 0;
    }
    return {
      purchaseRef: w.intent.purchaseRef,
      purchaseId: w.intent.purchaseId,
      proposalVersion: w.intent.proposalVersion,
      mode: w.intent.mode,
      phase,
      legs: w.legs.map((l) => this.legSnapshot(w, l)),
      group:
        w.group === undefined
          ? undefined
          : {
              key: w.group.key,
              status: w.group.status,
              reason: w.group.reason,
              members: w.group.members.map((m) => ({
                leg: m.leg,
                holdRef: m.holdRef,
                provider: m.provider,
                status: m.status,
                reason: m.reason,
              })),
            },
      committedCents,
      settledCents,
      principalReturnedCents,
      feeReturnedCents,
      retainedFeeCents: this.retainedFeeCents(w),
      exposureCents: this.exposureCents(w),
      unresolved,
      cleanupConfirmed: this.allClean(w) && unresolved.length === 0,
    };
  }

          phaseOf(w             )                  {
    const legs = w.legs;
    const allSettled = legs.every((l) => this.legSettled(l));
    // A settled intent keeps reporting 'settled' across ordinary returns;
    // an aborted one never does, even if every commit once succeeded.
    if (!w.aborted && allSettled) return 'settled';
    const anyCommitted = legs.some((l) => this.legCommitted(w, l));
    const anyOpen = this.hasOpen(w);
    const anyFailed = legs.some((l) => this.legFailed(l));
    const exposure = this.exposureCents(w);
    const clean = this.allClean(w) && !anyOpen;
    const incomplete = w.aborted || anyFailed;

    if (w.intent.mode === 'independent') {
      if (anyOpen) {
        if (legs.some((l) => isOpen(l.reserve?.status))) return 'reserving';
        if (legs.some((l) => isOpen(l.commit?.status) || isOpen(w.group?.status))) return 'committing';
        // An open return is a return in progress; an open release or any
        // other leftover is cleanup — a failed leg's release beside a
        // committed sibling is never 'compensating' in a mode that does
        // not compensate.
        if (legs.some((l) => isOpen(l.returned?.status))) return 'compensating';
        return 'unwinding';
      }
      if (anyCommitted) {
        // Principal restoration alone cannot resolve sibling funding or
        // hold cleanup. Retained fees keep recovery exposure visible; with
        // no exposure left, unfinished cleanup is still nonterminal.
        if (!this.allPrincipalReturned(w)) return 'recovery_required';
        return clean ? 'recovered' : exposure > 0 ? 'recovery_required' : 'unwinding';
      }
      if (anyFailed || exposure > 0) return clean ? 'failed' : 'unwinding';
      // Legs are still mid-flight with nothing recorded open — forward
      // work that has simply not produced an outcome yet.
      return 'committing';
    }

    // atomic
    if (incomplete) {
      if (anyOpen) return anyCommitted ? 'compensating' : 'unwinding';
      if (exposure > 0) return clean && this.allPrincipalReturned(w) ? 'recovered' : 'recovery_required';
      if (anyCommitted) return clean ? 'compensated' : 'compensating';
      return clean ? 'failed' : 'unwinding';
    }
    if (legs.every((l) => l.reserve?.status === 'succeeded')) {
      return legs.some((l) => l.commit !== undefined) || w.group !== undefined ? 'committing' : 'reserved';
    }
    return 'reserving';
  }

          legSnapshot(w             , l         )                        {
    const committed = this.committedCents(w, l);
    return {
      purchaseId: l.leg.purchaseId,
      proposalVersion: l.leg.proposalVersion,
      role: l.leg.role,
      payerId: l.leg.payerId,
      payeeId: l.leg.payeeId,
      rail: l.leg.rail,
      principalCents: l.leg.principalCents,
      feeCents: l.leg.feeCents,
      authority: l.leg.authority,
      reserve: viewOf(l.reserve),
      commit: viewOf(l.commit),
      release: viewOf(l.release),
      returned: viewOf(l.returned),
      hold:
        l.holdRef === undefined
          ? undefined
          : { holdRef: l.holdRef, status: this.holdStatus(l), expiresAt: l.reserve?.expiresAt },
      refusal: l.refusal,
      committedCents: committed > 0 || this.legCommitted(w, l) ? committed : undefined,
      destinationCreditConfirmed: l.commit?.destinationCreditConfirmed ?? false,
      settled: this.legSettled(l),
      feeChargedCents: l.commit?.feeChargedCents,
      feeReturnedCents: l.returned?.feeReturnedCents,
      principalReturnedCents: l.returned?.principalReturnedCents,
      cleanupConfirmed: this.legClean(w, l),
    };
  }

  // Hold lifecycle, separate from operation status: bank holds live in
  // the provider's own book, DE holds on the pseudonymous ledger.
          holdStatus(l         )                         {
    if (l.holdRef === undefined) return undefined;
    if (l.leg.rail === 'bank') {
      return l.provider.bankHolds().find((h) => h.holdRef === l.holdRef)?.status;
    }
    if (this.de === undefined) return undefined;
    try {
      return this.de.holdAudit(l.holdRef).status;
    } catch {
      return undefined;
    }
  }

          unresolved(w             )                    {
    const byKey = new Map                         ();
    // Snapshot records are detached like everything else that crosses the
    // boundary: a caller mutating reported terms must never reach the
    // retained working truth.
    const add = (key        , status                 , reason         , reference         , terms          ) => {
      if (byKey.has(key)) return;
      byKey.set(key, {
        key,
        terms: terms === undefined ? undefined : structuredClone(terms),
        status,
        reason,
        reference,
      });
    };
    for (const l of w.legs) {
      for (const o of [l.reserve, l.commit, l.release, l.returned]) {
        if (o === undefined) continue;
        if (isOpen(o.status)) add(o.key, o.status, o.reason, o.reference);
        for (const child of o.unresolved ?? []) add(child.key, child.status, child.reason, child.reference, child.terms);
      }
      for (const lost of l.lost) add(lost.key, 'unknown', lost.reason);
    }
    if (w.group !== undefined) {
      if (w.group.unresolved !== undefined) {
        add(w.group.unresolved.key, w.group.unresolved.status, w.group.unresolved.reason, w.group.unresolved.reference);
      } else if (isOpen(w.group.status)) {
        add(w.group.key, w.group.status, w.group.reason);
      }
    }
    return [...byKey.values()];
  }
}

function viewOf(o                                              )                                      {
  if (o === undefined) return undefined;
  return { key: o.key, status: o.status, reason: o.reason, reference: o.reference };
}

function message(err         )         {
  return err instanceof Error ? err.message : String(err);
}
