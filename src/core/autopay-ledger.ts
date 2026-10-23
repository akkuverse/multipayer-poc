// The employee's monthly automatic-payment budget (spec §8). A purchase books
// its full employee debit — share plus PSP fee — into the UTC calendar month
// of its admission; pending reservations and consumed debits share one budget
// per employee and month, so two purchases can never spend the same budget.
//
// Every entry is bound to its owner: the purchase object itself, never an
// untrusted purchaseId string. A second object reusing an existing id can
// neither adopt nor release the entry. A booking ends in one of two ways:
//
//   - rollback(owner): admission-time undo on a path proven to precede any
//     settlement handoff; removes only that owner's unconsumed reservation and
//     frees the purchaseId, so a corrected attempt may book again.
//   - resolve(owner, retainedFeeCents): terminal accounting once the
//     coordinator has proved no unresolved obligations remain; reduces the
//     counted usage to the confirmed retained fee (zero included) and leaves a
//     tombstone, so a repeat can never recreate or double-release the booking.
//
// Usage never falls to zero on a timeout or a generic transport error: only
// the coordinator's conclusive outcomes call resolve. No mutable entries ever
// leave this module.

import type { Cents } from './types.ts';

// Simulated minutes are mapped onto a real UTC calendar through an explicit
// fixture epoch; months are calendar months, never approximated as 30 days.
export const DEFAULT_CALENDAR_EPOCH = '2026-01-01T00:00:00Z';
// How long after an Auto receipt a dispute may be opened (spec §9 default).
export const DEFAULT_DISPUTE_WINDOW_MINUTES = 1_440;

// The simulated minute as a UTC instant: minutes are finite and nonnegative,
// the epoch must parse, and the resulting timestamp must be representable —
// an Invalid Date would silently produce a NaN month.
const instantAt = (now: number, calendarEpoch: string): Date => {
  if (!Number.isFinite(now) || now < 0) throw new Error('simulated minutes must be finite and nonnegative');
  const epoch = Date.parse(calendarEpoch);
  if (!Number.isFinite(epoch)) throw new Error(`invalid calendar epoch: ${calendarEpoch}`);
  const instant = new Date(epoch + now * 60_000);
  if (!Number.isFinite(instant.getTime())) throw new Error('simulated time lands outside the representable date range');
  return instant;
};

// The UTC calendar month ('YYYY-MM') a simulated minute lands in under the
// fixture epoch.
export const monthOf = (now: number, calendarEpoch: string): string => {
  const instant = instantAt(now, calendarEpoch);
  return `${instant.getUTCFullYear()}-${String(instant.getUTCMonth() + 1).padStart(2, '0')}`;
};

// The calendar/window part of CoordinatorOptions, checked before a world runs.
export const validateCalendarSettings = (calendarEpoch: string, disputeWindowMinutes: number): void => {
  instantAt(0, calendarEpoch); // throws on an unparseable epoch
  if (!Number.isFinite(disputeWindowMinutes) || disputeWindowMinutes < 0) {
    throw new Error('dispute window must be finite nonnegative minutes');
  }
};

// What the coordinator files at admission: the exact debit and the terms it
// was admitted under, retained for the booking's whole lifecycle.
export interface AutoPayBooking {
  purchaseId: string;
  // The proposal version the debit was computed from.
  proposalVersion: number;
  // The employee mandate revision the admission was authorized under.
  mandateRef: string;
  mandateVersion: number;
  employeeId: string;
  // UTC month of the admission instant; a purchase crossing a month boundary
  // keeps its original booking month through retries, settlement and returns.
  month: string;
  amountCents: Cents;
  feeCents: Cents;
  // The monthly cap this reservation was checked against.
  capCents: Cents;
}

// Why a reservation attempt was refused. 'monthly_cap' is the deterministic
// assessment reason the coordinator reports; 'conflicting_purchase_id' is a
// caller bug (a second object reusing an id, or a double reservation).
export class AutoPayReservationError extends Error {
  readonly reason: 'monthly_cap' | 'conflicting_purchase_id';

  constructor(reason: AutoPayReservationError['reason'], detail: string) {
    super(`autopay_reservation_refused:${reason}:${detail}`);
    this.name = 'AutoPayReservationError';
    this.reason = reason;
  }
}

// One accounting change, returned by consume()/resolve(), for the coordinator
// to turn into a single trace event. 'consumed': the booked debit became
// confirmed usage. 'released': cents of usage came off; retainedCents is what
// still counts (the confirmed retained fee).
export interface AutoPayDelta {
  purchaseId: string;
  employeeId: string;
  month: string;
  kind: 'consumed' | 'released';
  cents: Cents;
  retainedCents?: Cents;
}

interface Entry {
  booking: AutoPayBooking;
  state: 'reserved' | 'consumed' | 'resolved';
  // What still counts once resolved: the confirmed retained fee.
  retainedCents: Cents;
}

// Reserved and consumed entries count in full; a resolved tombstone counts
// only its retained fee.
const counted = (e: Entry): Cents => (e.state === 'resolved' ? e.retainedCents : e.booking.amountCents + e.booking.feeCents);

const centsField = (v: unknown): v is Cents => Number.isSafeInteger(v) && (v as number) >= 0;

export class AutoPayLedger {
  // Keyed by the owner object — the real purchase identity — so no purchaseId
  // string, trusted or not, can ever address another purchase's entry.
  private readonly entries = new Map<object, Entry>();

  // Reserved plus consumed unreleased debits for one employee in one month.
  // A purchase re-evaluating at initiation excludes its own reservation.
  usage(employeeId: string, month: string, excludeOwner?: object): Cents {
    let cents = 0;
    for (const [owner, e] of this.entries) {
      if (owner === excludeOwner) continue;
      if (e.booking.employeeId !== employeeId || e.booking.month !== month) continue;
      cents += counted(e);
    }
    return cents;
  }

  // Cap check and ownership creation in one synchronous operation: there is
  // no asynchronous gap in which a second purchase could draw the same budget.
  // Throws AutoPayReservationError on refusal; nothing is recorded then.
  reserve(owner: object, booking: AutoPayBooking): void {
    if (typeof owner !== 'object' || owner === null) {
      throw new Error('autopay reservation needs a purchase owner object');
    }
    const b = booking;
    if (
      typeof b !== 'object' ||
      b === null ||
      typeof b.purchaseId !== 'string' ||
      b.purchaseId.length === 0 ||
      !Number.isSafeInteger(b.proposalVersion) ||
      b.proposalVersion < 1 ||
      typeof b.mandateRef !== 'string' ||
      b.mandateRef.length === 0 ||
      !Number.isSafeInteger(b.mandateVersion) ||
      b.mandateVersion < 1 ||
      typeof b.employeeId !== 'string' ||
      b.employeeId.length === 0 ||
      typeof b.month !== 'string' ||
      b.month.length === 0 ||
      !centsField(b.amountCents) ||
      !centsField(b.feeCents) ||
      !centsField(b.capCents)
    ) {
      throw new Error('malformed autopay booking');
    }
    // This owner already holds an entry: reserving again under any purchaseId
    // would silently replace its booking. Re-admission is only ever preceded
    // by an explicit rollback.
    if (this.entries.has(owner)) {
      throw new AutoPayReservationError('conflicting_purchase_id', b.purchaseId);
    }
    // An existing entry under this purchaseId belongs to a booking another
    // object already filed. Adopting it would let this purchase consume or
    // release another's budget.
    for (const e of this.entries.values()) {
      if (e.booking.purchaseId === b.purchaseId) {
        throw new AutoPayReservationError('conflicting_purchase_id', b.purchaseId);
      }
    }
    if (this.usage(b.employeeId, b.month, owner) + b.amountCents + b.feeCents > b.capCents) {
      throw new AutoPayReservationError('monthly_cap', `${b.employeeId}/${b.month}`);
    }
    // A copy: later edits to the caller's booking must not alter the entry.
    this.entries.set(owner, { booking: { ...b }, state: 'reserved', retainedCents: 0 });
  }

  // Admission-time undo: removes only this owner's still-unconsumed
  // reservation. Only the coordinator's proven-before-handoff path calls it —
  // once the request may have moved, the exit is terminal resolve(), never
  // rollback. Deleting the entry frees the purchaseId for a corrected attempt
  // by the same purchase.
  rollback(owner: object): void {
    const e = this.entries.get(owner);
    if (!e) return;
    if (e.state !== 'reserved') {
      throw new Error(`cannot roll back a ${e.state} autopay booking for ${e.booking.purchaseId}`);
    }
    this.entries.delete(owner);
  }

  // The booked debit is confirmed spent: reserved becomes consumed, and the
  // debit keeps counting against the month. Returns the delta once; a repeat
  // (or a call for an owner that never reserved) reports no change.
  consume(owner: object): AutoPayDelta | undefined {
    const e = this.entries.get(owner);
    if (!e || e.state !== 'reserved') return undefined;
    e.state = 'consumed';
    const b = e.booking;
    return { purchaseId: b.purchaseId, employeeId: b.employeeId, month: b.month, kind: 'consumed', cents: b.amountCents + b.feeCents };
  }

  // Terminal accounting once no unresolved obligations remain: usage drops to
  // the confirmed retained fee — including zero when the employee was never
  // charged — and the entry becomes a tombstone that still counts the fee,
  // still owns the purchaseId, and refuses both rollback and a second release.
  resolve(owner: object, retainedFeeCents: Cents): AutoPayDelta | undefined {
    const e = this.entries.get(owner);
    if (!e || e.state === 'resolved') return undefined;
    if (!centsField(retainedFeeCents) || retainedFeeCents > e.booking.feeCents) {
      throw new Error(`retained fee ${retainedFeeCents} outside booked fee ${e.booking.feeCents}`);
    }
    const released = counted(e) - retainedFeeCents;
    e.state = 'resolved';
    e.retainedCents = retainedFeeCents;
    const b = e.booking;
    return { purchaseId: b.purchaseId, employeeId: b.employeeId, month: b.month, kind: 'released', cents: released, retainedCents: retainedFeeCents };
  }
}
