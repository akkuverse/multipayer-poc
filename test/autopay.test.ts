// The employee's monthly automatic-payment budget (spec §8) and its UTC
// calendar: pending reservations and consumed debits share one stable
// employee/month budget, every entry is bound to its owning purchase object so
// a second purchase can neither adopt nor release it, and a resolved booking
// leaves a tombstone counting only the confirmed retained fee. The employer
// ledger (src/core/ledger.ts) owns daily subsidies — a different contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoPayLedger, AutoPayReservationError, monthOf } from '../src/core/autopay-ledger.ts';
import type { AutoPayBooking } from '../src/core/autopay-ledger.ts';
import { world, advance, EMPLOYEE } from '../src/scenarios.ts';

// Spec fixture epoch: simulated minutes start at 2026-01-01T00:00:00Z.
const EPOCH = '2026-01-01T00:00:00Z';

// A booking as the coordinator would file it at admission. Literal month
// strings are the independent expectation; monthOf has its own cases below.
const booking = (over: Partial<AutoPayBooking> = {}): AutoPayBooking => ({
  purchaseId: 'purchase-1',
  proposalVersion: 1,
  mandateRef: 'employee-mandate-1',
  mandateVersion: 1,
  employeeId: EMPLOYEE,
  month: '2026-01',
  amountCents: 400,
  feeCents: 0,
  capCents: 3_000,
  ...over,
});

// The owner is the purchase identity itself; a fresh object per purchase.
const owner = (): object => ({ kind: 'purchase' });

test('simulated minutes map onto real UTC calendar months', () => {
  // Literal boundaries under the January 2026 epoch: January has 31 days, so
  // minute 44,639 is still January and 44,640 is February. February 2026 has
  // 28 days, so March starts at 44,640 + 40,320 = 84,960.
  assert.equal(monthOf(0, EPOCH), '2026-01');
  assert.equal(monthOf(44_639, EPOCH), '2026-01');
  assert.equal(monthOf(44_640, EPOCH), '2026-02');
  assert.equal(monthOf(84_960, EPOCH), '2026-03');
});

test('months roll over at year and leap-February boundaries', () => {
  // November 2026 has 30 days: December starts at minute 480,960. The year
  // boundary falls at day 365: minute 525,600 is 2027-01.
  assert.equal(monthOf(480_959, EPOCH), '2026-11');
  assert.equal(monthOf(480_960, EPOCH), '2026-12');
  assert.equal(monthOf(525_599, EPOCH), '2026-12');
  assert.equal(monthOf(525_600, EPOCH), '2027-01');
  // A separate epoch inside a leap-year February: February 2024 has 29 days,
  // so March starts at minute 41,760 — not the 40,320 a 30-day or 28-day
  // approximation would give.
  const leap = '2024-02-01T00:00:00Z';
  assert.equal(monthOf(0, leap), '2024-02');
  assert.equal(monthOf(41_759, leap), '2024-02');
  assert.equal(monthOf(41_760, leap), '2024-03');
});

test('the calendar rejects an invalid epoch, invalid minutes and unrepresentable dates', () => {
  assert.throws(() => monthOf(0, 'not-a-date'), /calendar epoch/);
  assert.throws(() => monthOf(0, ''), /calendar epoch/);
  assert.throws(() => monthOf(-1, EPOCH), /minutes/);
  assert.throws(() => monthOf(Number.NaN, EPOCH), /minutes/);
  assert.throws(() => monthOf(Number.POSITIVE_INFINITY, EPOCH), /minutes/);
  // 200 billion minutes past the epoch lands outside the representable date
  // range; the calendar must refuse rather than report a NaN month.
  assert.throws(() => monthOf(200_000_000_000, EPOCH), /representable/);
});

test('world() wires calendar settings with spec defaults and capability off', () => {
  const w = world();
  assert.equal(w.coordinator.calendarEpoch, '2026-01-01T00:00:00Z');
  assert.equal(w.coordinator.disputeWindowMinutes, 1_440);
  // Capability defaults to false: no payer route carries mandate-initiated
  // payments until a fixture opts in.
  assert.equal(w.coordinator.supportsMandatePaymentsFor(EMPLOYEE), false);
  const capable = world({}, {}, { calendarEpoch: '2024-06-01T00:00:00Z', disputeWindowMinutes: 60, supportsMandatePayments: true });
  assert.equal(capable.coordinator.calendarEpoch, '2024-06-01T00:00:00Z');
  assert.equal(capable.coordinator.disputeWindowMinutes, 60);
  assert.equal(capable.coordinator.supportsMandatePaymentsFor(EMPLOYEE), true);
  assert.equal(capable.coordinator.supportsMandatePaymentsFor('someone-else'), true);
});

test('world() rejects invalid calendar settings before any purchase exists', () => {
  assert.throws(() => world({}, {}, { calendarEpoch: 'yesterday-ish' }), /calendar epoch/);
  assert.throws(() => world({}, {}, { disputeWindowMinutes: -1 }), /dispute window/);
  assert.throws(() => world({}, {}, { disputeWindowMinutes: Number.POSITIVE_INFINITY }), /dispute window/);
});

test('advance() moves both clocks together and only forward', () => {
  const w = world();
  advance(w, 50);
  assert.equal(w.coordinator.now, 50);
  assert.equal(w.backend.now, 50);
  // Advancing to the same minute is allowed; rewinding is not — a replay
  // starts a fresh world instead of unwinding reservations and deadlines.
  advance(w, 50);
  assert.throws(() => advance(w, 49), /advance/);
  assert.throws(() => advance(w, Number.NaN), /advance/);
  // A refused advance moves neither clock.
  assert.equal(w.coordinator.now, 50);
  assert.equal(w.backend.now, 50);
  // A target the fixture calendar cannot represent passes the rewind check but
  // is refused by the coordinator — the backend clock must not have moved.
  assert.throws(() => advance(w, 200_000_000_000), /representable/);
  assert.equal(w.coordinator.now, 50);
  assert.equal(w.backend.now, 50);
  // The coordinator applies the same rule when driven directly.
  assert.equal(w.coordinator.now, 50);
  w.coordinator.advance(60);
  assert.throws(() => w.coordinator.advance(59), /advance/);
  assert.equal(w.coordinator.now, 60);
  assert.equal(w.backend.now, 50, 'coordinator.advance moves only its own clock');
});

test('a reservation counts against the monthly budget at once', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 0);
  ledger.reserve(a, booking({ amountCents: 350, feeCents: 50 }));
  // The full debit — amount plus fee — is held while the purchase is pending.
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
});

test('two owners contending for the last budget: only the first is admitted', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  const b = owner();
  ledger.reserve(a, booking({ capCents: 500 }));
  // Only 100 of the 500 cap remains: b's 400 debit cannot fit.
  assert.throws(() => ledger.reserve(b, booking({ purchaseId: 'purchase-2', capCents: 500 })), (err: unknown) => {
    assert.ok(err instanceof AutoPayReservationError);
    assert.equal(err.reason, 'monthly_cap');
    return true;
  });
  // The refused reservation left nothing behind.
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
});

test('a reservation exactly reaching the cap is admitted; one cent over is refused', () => {
  const ledger = new AutoPayLedger();
  ledger.reserve(owner(), booking({ amountCents: 400, capCents: 600 }));
  // Exactly the remaining 200 fits.
  ledger.reserve(owner(), booking({ purchaseId: 'purchase-2', amountCents: 200, capCents: 600 }));
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 600);
  const over = new AutoPayLedger();
  over.reserve(owner(), booking({ amountCents: 400, capCents: 600 }));
  assert.throws(() => over.reserve(owner(), booking({ purchaseId: 'purchase-2', amountCents: 200, feeCents: 1, capCents: 600 })), /monthly_cap/);
});

test('usage is per employee and per month', () => {
  const ledger = new AutoPayLedger();
  ledger.reserve(owner(), booking({ employeeId: EMPLOYEE, month: '2026-01', amountCents: 400 }));
  ledger.reserve(owner(), booking({ purchaseId: 'purchase-2', employeeId: 'colleague-1', month: '2026-01', amountCents: 200 }));
  ledger.reserve(owner(), booking({ purchaseId: 'purchase-3', employeeId: EMPLOYEE, month: '2026-02', amountCents: 700 }));
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
  assert.equal(ledger.usage(EMPLOYEE, '2026-02'), 700);
  assert.equal(ledger.usage('colleague-1', '2026-01'), 200);
});

test('a purchase re-evaluating excludes its own reservation from usage', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  ledger.reserve(a, booking({ amountCents: 400 }));
  // Its own entry does not count against it: a retry re-checking the cap sees
  // the budget without its hold, never reserving twice.
  assert.equal(ledger.usage(EMPLOYEE, '2026-01', a), 0);
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
});

test('a second object cannot reuse an existing purchaseId', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  ledger.reserve(a, booking());
  // A different object claiming the same purchaseId must not adopt the entry.
  const impostor = owner();
  assert.throws(() => ledger.reserve(impostor, booking()), (err: unknown) => {
    assert.ok(err instanceof AutoPayReservationError);
    assert.equal(err.reason, 'conflicting_purchase_id');
    return true;
  });
  // The real owner's reservation is untouched by the impostor's attempt.
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
  // Even the same owner cannot file a second booking under a held id.
  assert.throws(() => ledger.reserve(a, booking()), /conflicting_purchase_id/);
});

test('a second reserve by the same owner under a new purchaseId is refused', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  ledger.reserve(a, booking({ amountCents: 400 }));
  // Re-admission is only ever preceded by rollback; a bare second reserve
  // under a fresh id must not silently replace the held booking.
  assert.throws(() => ledger.reserve(a, booking({ purchaseId: 'purchase-2' })), (err: unknown) => {
    assert.ok(err instanceof AutoPayReservationError);
    assert.equal(err.reason, 'conflicting_purchase_id');
    return true;
  });
  // The first reservation is untouched by the refused attempt.
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
});

test('a malformed booking is refused before anything is recorded', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  // A representative sample of the booking contract; every check runs before
  // any state changes.
  assert.throws(() => ledger.reserve(a, booking({ purchaseId: '' })), /malformed/);
  assert.throws(() => ledger.reserve(a, booking({ proposalVersion: 0 })), /malformed/);
  assert.throws(() => ledger.reserve(a, booking({ amountCents: -1 })), /malformed/);
  assert.throws(() => ledger.reserve(a, booking({ feeCents: 1.5 })), /malformed/);
  assert.throws(() => ledger.reserve(a, booking({ capCents: Number.NaN })), /malformed/);
  // Nothing was filed: usage stays zero and the owner may still book.
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 0);
  ledger.reserve(a, booking());
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
});

test('consume marks the reservation spent once and keeps it counted', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  ledger.reserve(a, booking({ amountCents: 350, feeCents: 50 }));
  const delta = ledger.consume(a);
  assert.deepEqual(delta, {
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    month: '2026-01',
    kind: 'consumed',
    cents: 400,
  });
  // Consuming does not release: the debit stays counted against the month.
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
  // A repeat consume reports no change — the coordinator logs nothing twice.
  assert.equal(ledger.consume(a), undefined);
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
  // An owner that never reserved consumes nothing.
  assert.equal(ledger.consume(owner()), undefined);
});

test('resolve reduces usage to the confirmed retained fee and leaves a tombstone', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  ledger.reserve(a, booking({ amountCents: 400, feeCents: 50 }));
  ledger.consume(a);
  // Principal confirmed returned, fee actually charged and not returned: only
  // the 50 fee stays counted.
  const delta = ledger.resolve(a, 50);
  assert.deepEqual(delta, {
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    month: '2026-01',
    kind: 'released',
    cents: 400,
    retainedCents: 50,
  });
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 50);
  // A repeat resolution cannot release the booking twice — not even under a
  // different retained fee: the tombstone is terminal and reports no change.
  assert.equal(ledger.resolve(a, 50), undefined);
  assert.equal(ledger.resolve(a, 0), undefined);
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 50);
  // The tombstone still owns the purchaseId: neither the same owner nor a new
  // object can recreate the booking.
  assert.throws(() => ledger.reserve(a, booking()), /conflicting_purchase_id/);
  assert.throws(() => ledger.reserve(owner(), booking()), /conflicting_purchase_id/);
  // And a consumed booking cannot be un-admitted once resolved.
  assert.throws(() => ledger.rollback(a), /resolved/);
});

test('a fully refused or fully returned booking resolves to zero retained usage', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  ledger.reserve(a, booking({ amountCents: 400, feeCents: 50 }));
  // Every leg conclusively rejected before any debit: the whole hold goes back.
  const delta = ledger.resolve(a, 0);
  assert.equal(delta?.kind, 'released');
  assert.equal(delta?.cents, 450);
  assert.equal(delta?.retainedCents, 0);
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 0);
});

test('the retained fee may never exceed the booked fee', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  ledger.reserve(a, booking({ amountCents: 400, feeCents: 50 }));
  assert.throws(() => ledger.resolve(a, 51), /retained fee/);
  // Nothing was released by the rejected resolution.
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 450);
});

test('resolving an owner that never reserved is a no-op', () => {
  const ledger = new AutoPayLedger();
  // The coordinator only resolves purchases it admitted; a stray resolve must
  // neither report a delta nor file a tombstone.
  assert.equal(ledger.resolve(owner(), 0), undefined);
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 0);
  // The purchaseId is still free: no tombstone was left behind.
  ledger.reserve(owner(), booking());
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
});

test("a resolved tombstone's retained fee still counts against the monthly cap", () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  ledger.reserve(a, booking({ amountCents: 400, feeCents: 50, capCents: 500 }));
  ledger.consume(a);
  ledger.resolve(a, 50);
  // The 50-cent retained fee is real usage: a debit that would only fit a
  // zero baseline is refused, while one that respects the fee is admitted.
  assert.throws(() => ledger.reserve(owner(), booking({ purchaseId: 'purchase-2', amountCents: 451, capCents: 500 })), (err: unknown) => {
    assert.ok(err instanceof AutoPayReservationError);
    assert.equal(err.reason, 'monthly_cap');
    return true;
  });
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 50);
  ledger.reserve(owner(), booking({ purchaseId: 'purchase-2', amountCents: 450, capCents: 500 }));
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 500);
});

test('pre-handoff rollback frees the reservation and allows same-purchase re-admission', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  ledger.reserve(a, booking({ amountCents: 400 }));
  // The attempt proves nothing was handed off (e.g. the other ledger refused
  // synchronously): only this owner's reservation is removed.
  ledger.rollback(a);
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 0);
  // A corrected attempt by the same purchase books again under the same id.
  ledger.reserve(a, booking({ amountCents: 300, capCents: 300 }));
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 300);
});

test('rollback removes only that owner\u2019s reservation', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  const b = owner();
  ledger.reserve(a, booking({ amountCents: 400 }));
  ledger.reserve(b, booking({ purchaseId: 'purchase-2', amountCents: 200 }));
  ledger.rollback(a);
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 200, "b's reservation is untouched by a's rollback");
  // Rolling back an owner that holds nothing is a safe no-op.
  ledger.rollback(owner());
  ledger.rollback(a);
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 200);
});

test('a consumed booking cannot be rolled back', () => {
  const ledger = new AutoPayLedger();
  const a = owner();
  ledger.reserve(a, booking());
  ledger.consume(a);
  // Once the reservation is consumed — or the request may have been handed
  // off — the only way out is a terminal resolution, never admission undo.
  assert.throws(() => ledger.rollback(a), /consumed/);
  assert.equal(ledger.usage(EMPLOYEE, '2026-01'), 400);
});
