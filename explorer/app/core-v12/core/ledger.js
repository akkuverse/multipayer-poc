// GENERATED from src/core/ledger.ts — type-stripped build artifact; never hand-edit.








// The coordinator clock counts minutes; a benefit day is 1,440 of them.
export const MINUTES_PER_DAY = 1_440;
export const dayOf = (now) => Math.floor(now / MINUTES_PER_DAY);













export class BenefitLedger {
    entries = new Map(); // keyed by purchaseId

  // Reserved and consumed entries both count. A purchase never counts
  // against itself, so it can be re-evaluated at initiation.
  usage(mandateRef, day, excludePurchaseId) {
    let cents = 0;
    let purchases = 0;
    for (const [purchaseId, e] of this.entries) {
      if (purchaseId === excludePurchaseId || e.mandateRef !== mandateRef || e.day !== day) continue;
      cents += e.cents;
      purchases += 1;
    }
    return { cents, purchases };
  }

  // A purchase only submits from 'ready', and every earlier submission either
  // left 'ready' or released its reservation — so an entry already filed under
  // this purchaseId belongs to a different purchase that reused the id.
  // Adopting it would let this purchase consume or release another's benefit.
  reserve(purchaseId, mandateRef, day, cents) {
    if (this.entries.has(purchaseId)) {
      throw new Error(`conflicting benefit reservation for ${purchaseId}`);
    }
    this.entries.set(purchaseId, { mandateRef, day, cents, state: 'reserved' });
  }

  consume(purchaseId) {
    const e = this.entries.get(purchaseId);
    if (e) e.state = 'consumed';
  }

  release(purchaseId) {
    this.entries.delete(purchaseId);
  }

  state(purchaseId) {
    return this.entries.get(purchaseId)?.state;
  }
}
