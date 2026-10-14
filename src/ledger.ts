// Per-mandate record of employer benefit drawn per day. A purchase reserves
// its employer share at submission, consumes it on completion and releases it
// when nothing stays committed (failed, cancelled, fully returned). Pending
// and recovering purchases keep their reservation, so two purchases in flight
// can never both draw the same benefit.

import type { Cents } from './types.ts';

// The coordinator clock counts minutes; a benefit day is 1,440 of them.
export const MINUTES_PER_DAY = 1_440;
export const dayOf = (now: number): number => Math.floor(now / MINUTES_PER_DAY);

export interface DailyUsage {
  cents: Cents;
  purchases: number;
}

interface Entry {
  mandateRef: string;
  day: number;
  cents: Cents;
  state: 'reserved' | 'consumed';
}

export class BenefitLedger {
  private readonly entries = new Map<string, Entry>(); // keyed by purchaseId

  // Reserved and consumed entries both count. A purchase never counts
  // against itself, so it can be re-evaluated at initiation.
  usage(mandateRef: string, day: number, excludePurchaseId?: string): DailyUsage {
    let cents = 0;
    let purchases = 0;
    for (const [purchaseId, e] of this.entries) {
      if (purchaseId === excludePurchaseId || e.mandateRef !== mandateRef || e.day !== day) continue;
      cents += e.cents;
      purchases += 1;
    }
    return { cents, purchases };
  }

  // Idempotent: a retried submission keeps its original reservation. A second
  // reservation for the same purchase on different terms is a caller bug and
  // fails loudly rather than silently keeping the first.
  reserve(purchaseId: string, mandateRef: string, day: number, cents: Cents): void {
    const e = this.entries.get(purchaseId);
    if (!e) {
      this.entries.set(purchaseId, { mandateRef, day, cents, state: 'reserved' });
      return;
    }
    if (e.mandateRef !== mandateRef || e.day !== day || e.cents !== cents) {
      throw new Error(`conflicting benefit reservation for ${purchaseId}`);
    }
  }

  consume(purchaseId: string): void {
    const e = this.entries.get(purchaseId);
    if (e) e.state = 'consumed';
  }

  release(purchaseId: string): void {
    this.entries.delete(purchaseId);
  }

  state(purchaseId: string): Entry['state'] | undefined {
    return this.entries.get(purchaseId)?.state;
  }
}
