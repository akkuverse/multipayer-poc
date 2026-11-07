// GENERATED from src/core/ledger.ts — type-stripped build artifact; never hand-edit.
// Per-mandate record of employer benefit drawn per day, extended with typed
// authority identity so a donor's charity allowance books under the same
// reservation discipline. A purchase reserves its sponsor share at
// submission, consumes it on completion and releases it when nothing stays
// committed (failed, cancelled, fully returned). Pending and recovering
// purchases keep their reservation, so two purchases in flight can never
// both draw the same benefit.
//
// Employer bookings keep their original call shape; internally every entry
// carries { kind, ref } so an allowance reference that textually matches an
// employer reference can never adopt or release the other kind's booking.
// The authority registry already enforces one exclusive reference
// namespace; the ledger does not rely on that — identity is compared
// structurally, never by an unescaped string prefix.

                                        

// The coordinator clock counts minutes; a benefit day is 1,440 of them.
export const MINUTES_PER_DAY = 1_440;
export const dayOf = (now        )         => Math.floor(now / MINUTES_PER_DAY);

                             
               
                    
 

// Which authority a booking draws on: an employer mandate or a donor
// allowance, plus the reference it was accepted under. Revisions never
// enter this identity — usage survives revisions, so an entry names only
// the allowance reference it drew on, not the version it was checked
// against.
                                    
                                 
              
 

// The caps a new allowance reservation is rechecked against, supplied by
// the caller from the allowance's current accepted terms.
                                
                        
                                                                             
                             
                                                                      
                              
 

// One allowance's committed usage: the booking day's and all days'
// combined. Reserved and consumed entries both count.
                                 
                    
                       
 

// Detached all-days accounting for one allowance, split by state —
// what a sponsor report is built from. Covers only bookings still held:
// released reservations (nothing stayed committed) leave no trace.
                                   
                       
                       
                            
                       
                            
 

// Why an allowance reservation was refused. 'allowance_cap' is the
// deterministic capacity refusal (daily or lifetime); 'conflicting_
// purchase_id' is a caller bug — a second purchase reusing an id could
// otherwise adopt another purchase's booking.
export class AllowanceReservationError extends Error {
           reason                                             ;

  constructor(reason                                     , detail        ) {
    super(`allowance_reservation_refused:${reason}:${detail}`);
    this.name = 'AllowanceReservationError';
    this.reason = reason;
  }
}

                 
                              
                                                                     
                                                            
              
               
                                 
 

const sameIdentity = (a                   , b                   )          => a.kind === b.kind && a.ref === b.ref;

export class BenefitLedger {
                   entries = new Map               (); // keyed by purchaseId

  // Reserved and consumed entries both count. A purchase never counts
  // against itself, so it can be re-evaluated at initiation.
  usage(mandateRef        , day        , excludePurchaseId         )             {
    const id                    = { kind: 'employer', ref: mandateRef };
    let cents = 0;
    let purchases = 0;
    for (const [purchaseId, e] of this.entries) {
      if (purchaseId === excludePurchaseId || !sameIdentity(e.identity, id) || e.day !== day) continue;
      cents += e.cents;
      purchases += 1;
    }
    return { cents, purchases };
  }

  // An allowance's committed usage: entries booked on the given day count
  // in `daily`, every still-held booking across all days counts in
  // `lifetime`. Excluding a purchase removes only its own booking of THIS
  // allowance — a recheck may never hide another purchase's reservation,
  // and an employer booking under the excluded id is untouched either
  // way.
  allowanceUsage(ref        , day        , excludePurchaseId         )                 {
    const id                    = { kind: 'allowance', ref };
    const daily             = { cents: 0, purchases: 0 };
    const lifetime             = { cents: 0, purchases: 0 };
    for (const [purchaseId, e] of this.entries) {
      if (!sameIdentity(e.identity, id)) continue;
      if (purchaseId === excludePurchaseId) continue;
      lifetime.cents += e.cents;
      lifetime.purchases += 1;
      if (e.day === day) {
        daily.cents += e.cents;
        daily.purchases += 1;
      }
    }
    return { daily, lifetime };
  }

  // A purchase only submits from 'ready', and every earlier submission either
  // left 'ready' or released its reservation — so an entry already filed under
  // this purchaseId belongs to a different purchase that reused the id.
  // Adopting it would let this purchase consume or release another's benefit.
  reserve(purchaseId        , mandateRef        , day        , cents       )       {
    if (this.entries.has(purchaseId)) {
      throw new Error(`conflicting benefit reservation for ${purchaseId}`);
    }
    this.entries.set(purchaseId, { identity: { kind: 'employer', ref: mandateRef }, day, cents, state: 'reserved' });
  }

  // Reserve donor budget for one charity purchase, checked and inserted in
  // one synchronous operation so two purchases contending for the last
  // capacity cannot both reserve it. The caller passes the allowance's
  // current caps; both the booking day's budget and the lifetime
  // endowment must still cover the new booking. Any refusal leaves the
  // ledger untouched — there is no partial entry. A purchase that never
  // completes keeps holding its reservation until the coordinator's
  // ownership-gated release path confirms nothing stayed committed.
  reserveAllowance(purchaseId        , ref        , bookingDay        , cents       , caps               )       {
    if (
      typeof purchaseId !== 'string' ||
      purchaseId.length === 0 ||
      typeof ref !== 'string' ||
      ref.length === 0 ||
      !Number.isSafeInteger(bookingDay) ||
      bookingDay < 0 ||
      !Number.isSafeInteger(cents) ||
      cents <= 0 ||
      typeof caps !== 'object' ||
      caps === null ||
      !Number.isSafeInteger(caps.maxPerDayCents) ||
      caps.maxPerDayCents < 0 ||
      !Number.isSafeInteger(caps.maxPurchasesPerDay) ||
      caps.maxPurchasesPerDay < 0 ||
      (caps.totalEndowmentCents !== undefined &&
        (!Number.isSafeInteger(caps.totalEndowmentCents) || caps.totalEndowmentCents < 0))
    ) {
      throw new Error('malformed allowance reservation');
    }
    if (this.entries.has(purchaseId)) {
      throw new AllowanceReservationError('conflicting_purchase_id', purchaseId);
    }
    const usage = this.allowanceUsage(ref, bookingDay);
    // The daily purchase count caps too: two bookings each fitting the
    // cents caps must not push the count past maxPurchasesPerDay.
    if (usage.daily.purchases >= caps.maxPurchasesPerDay) {
      throw new AllowanceReservationError('allowance_cap', `${ref}/${bookingDay}`);
    }
    const dailyCents = usage.daily.cents + cents;
    if (!Number.isSafeInteger(dailyCents) || dailyCents > caps.maxPerDayCents) {
      throw new AllowanceReservationError('allowance_cap', `${ref}/${bookingDay}`);
    }
    const lifetimeCents = usage.lifetime.cents + cents;
    if (!Number.isSafeInteger(lifetimeCents) || (caps.totalEndowmentCents !== undefined && lifetimeCents > caps.totalEndowmentCents)) {
      throw new AllowanceReservationError('allowance_cap', ref);
    }
    this.entries.set(purchaseId, { identity: { kind: 'allowance', ref }, day: bookingDay, cents, state: 'reserved' });
  }

  consume(purchaseId        )       {
    const e = this.entries.get(purchaseId);
    if (e) e.state = 'consumed';
  }

  // Removes the booking once, whatever its kind; a repeat call is a no-op.
  // Only the coordinator may call this, and only for a purchase that
  // actually reserved (its ownership flag) once no obligation remains —
  // never by a naked purchaseId that could name another purchase's entry.
  release(purchaseId        )       {
    this.entries.delete(purchaseId);
  }

  // All-days totals for one allowance, detached from retained entries.
  allowanceSummary(ref        )                   {
    const summary                   = {
      allowanceRef: ref,
      reservedCents: 0,
      reservedPurchases: 0,
      consumedCents: 0,
      consumedPurchases: 0,
    };
    for (const e of this.entries.values()) {
      if (e.identity.kind !== 'allowance' || e.identity.ref !== ref) continue;
      if (e.state === 'reserved') {
        summary.reservedCents += e.cents;
        summary.reservedPurchases += 1;
      } else {
        summary.consumedCents += e.cents;
        summary.consumedPurchases += 1;
      }
    }
    return summary;
  }

  state(purchaseId        )                                      {
    return this.entries.get(purchaseId)?.state;
  }
}
