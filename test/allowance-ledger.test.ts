// Donor-allowance accounting in the benefit ledger: typed { kind, ref }
// identity keeps employer and allowance bookings collision-safe, a
// reservation is checked and inserted in one synchronous operation so two
// purchases cannot both take the last capacity, and exclusion during a
// recheck hides only the owning purchase's own booking of that allowance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AllowanceReservationError, BenefitLedger } from '../src/core/ledger.ts';

const CAPS = { maxPerDayCents: 1_000, maxPurchasesPerDay: 10, totalEndowmentCents: 5_000 };

test('allowance_usage_and_summary_across_two_days', () => {
  const ledger = new BenefitLedger();
  ledger.reserveAllowance('p-1', 'al-1', 3, 500, CAPS);
  ledger.reserveAllowance('p-2', 'al-1', 4, 400, CAPS);

  // The booking day is the original day, not wherever the clock moved to.
  assert.deepEqual(ledger.allowanceUsage('al-1', 3), {
    daily: { cents: 500, purchases: 1 },
    lifetime: { cents: 900, purchases: 2 },
  });
  assert.deepEqual(ledger.allowanceUsage('al-1', 4), {
    daily: { cents: 400, purchases: 1 },
    lifetime: { cents: 900, purchases: 2 },
  });
  assert.equal(ledger.state('p-1'), 'reserved');

  ledger.consume('p-1');
  assert.equal(ledger.state('p-1'), 'consumed');
  // consume is idempotent; an unknown id is a no-op.
  ledger.consume('p-1');
  ledger.consume('p-unknown');
  assert.deepEqual(ledger.allowanceSummary('al-1'), {
    allowanceRef: 'al-1',
    reservedCents: 400,
    reservedPurchases: 1,
    consumedCents: 500,
    consumedPurchases: 1,
  });

  ledger.release('p-2');
  assert.equal(ledger.state('p-2'), undefined);
  // release removes the booking once; a repeat is a no-op.
  ledger.release('p-2');
  assert.deepEqual(ledger.allowanceSummary('al-1'), {
    allowanceRef: 'al-1',
    reservedCents: 0,
    reservedPurchases: 0,
    consumedCents: 500,
    consumedPurchases: 1,
  });
  // A released booking stops counting everywhere, daily and lifetime.
  assert.deepEqual(ledger.allowanceUsage('al-1', 4), {
    daily: { cents: 0, purchases: 0 },
    lifetime: { cents: 500, purchases: 1 },
  });
  ledger.release('p-1');
  assert.deepEqual(ledger.allowanceSummary('al-1'), {
    allowanceRef: 'al-1',
    reservedCents: 0,
    reservedPurchases: 0,
    consumedCents: 0,
    consumedPurchases: 0,
  });
});

test('duplicate_reservation_id_is_refused', () => {
  const ledger = new BenefitLedger();
  ledger.reserveAllowance('p-1', 'al-1', 3, 500, CAPS);
  assert.throws(() => ledger.reserveAllowance('p-1', 'al-1', 3, 100, CAPS), (err: unknown) => {
    assert.ok(err instanceof AllowanceReservationError);
    assert.equal(err.reason, 'conflicting_purchase_id');
    return true;
  });
  // Even a different allowance/day under the same purchase id is refused.
  assert.throws(() => ledger.reserveAllowance('p-1', 'al-2', 9, 100, CAPS), AllowanceReservationError);
  // The legacy employer path refuses a used purchase id too.
  assert.throws(() => ledger.reserve('p-1', 'mandate-1', 3, 100), /conflicting benefit reservation/);
  // An allowance booking likewise blocks an employer reservation under the
  // same purchase id — the id key is shared across kinds.
  ledger.reserveAllowance('p-9', 'al-2', 3, 100, CAPS);
  assert.throws(() => ledger.reserve('p-9', 'mandate-1', 3, 1), /conflicting benefit reservation/);
  // The refused second attempts left no partial entries.
  assert.equal(ledger.state('p-1'), 'reserved');
  assert.deepEqual(ledger.allowanceUsage('al-1', 3).daily, { cents: 500, purchases: 1 });
});

test('capacity_is_rechecked_synchronously_and_atomic', () => {
  const ledger = new BenefitLedger();
  const caps = { maxPerDayCents: 1_000, maxPurchasesPerDay: 10, totalEndowmentCents: 1_500 };
  ledger.reserveAllowance('p-1', 'al-1', 3, 800, caps);
  // 800 daily of 1000 leaves 200; 800 lifetime of 1500 leaves 700.
  ledger.reserveAllowance('p-2', 'al-1', 3, 200, caps);
  const before = ledger.allowanceSummary('al-1');
  // Two purchases contending for the last capacity cannot both reserve it:
  // the second daily overflow is refused before any insert.
  assert.throws(() => ledger.reserveAllowance('p-3', 'al-1', 3, 1, caps), (err: unknown) => {
    assert.ok(err instanceof AllowanceReservationError);
    assert.equal(err.reason, 'allowance_cap');
    return true;
  });
  // Lifetime overflow on a different day is refused the same way.
  ledger.reserveAllowance('p-4', 'al-1', 4, 400, caps);
  assert.throws(() => ledger.reserveAllowance('p-5', 'al-1', 4, 400, caps), AllowanceReservationError);
  assert.equal(ledger.state('p-3'), undefined);
  assert.equal(ledger.state('p-5'), undefined);
  assert.deepEqual(ledger.allowanceSummary('al-1'), {
    ...before,
    reservedCents: 1_400,
    reservedPurchases: 3,
  });
});

test('daily_purchase_count_cap_refuses_the_second_contender', () => {
  const ledger = new BenefitLedger();
  const caps = { maxPerDayCents: 1_000, maxPurchasesPerDay: 2 };
  ledger.reserveAllowance('p-1', 'al-1', 3, 100, caps);
  // Two purchases each well inside the cents caps contend for the last
  // count slot: the first reserves it, the second is refused.
  ledger.reserveAllowance('p-2', 'al-1', 3, 100, caps);
  const before = ledger.allowanceSummary('al-1');
  assert.throws(() => ledger.reserveAllowance('p-3', 'al-1', 3, 100, caps), (err: unknown) => {
    assert.ok(err instanceof AllowanceReservationError);
    assert.equal(err.reason, 'allowance_cap');
    return true;
  });
  // The refusal left no partial entry: usage and entries are unchanged.
  assert.equal(ledger.state('p-3'), undefined);
  assert.deepEqual(ledger.allowanceSummary('al-1'), before);
  assert.deepEqual(ledger.allowanceUsage('al-1', 3).daily, { cents: 200, purchases: 2 });
  // A used-up count on day 3 does not carry into day 4.
  ledger.reserveAllowance('p-4', 'al-1', 4, 100, caps);
  assert.equal(ledger.state('p-4'), 'reserved');
});

test('lifetime_cap_leaves_only_remaining_endowment', () => {
  const ledger = new BenefitLedger();
  const caps = { maxPerDayCents: 1_000, maxPurchasesPerDay: 10, totalEndowmentCents: 1_500 };
  // 1500 endowment, 600 consumed + 400 reserved across two days leaves 500.
  ledger.reserveAllowance('p-1', 'al-1', 1, 600, caps);
  ledger.consume('p-1');
  ledger.reserveAllowance('p-2', 'al-1', 2, 400, caps);
  ledger.reserveAllowance('p-3', 'al-1', 3, 500, caps);
  assert.throws(() => ledger.reserveAllowance('p-4', 'al-1', 3, 1, caps), AllowanceReservationError);
});

test('uncapped_lifetime_totals_remain_exact_across_days_without_partial_booking', () => {
  const ledger = new BenefitLedger();
  const caps = { maxPerDayCents: Number.MAX_SAFE_INTEGER, maxPurchasesPerDay: 10 };
  ledger.reserveAllowance('p-1', 'uncapped', 1, Number.MAX_SAFE_INTEGER, caps);
  ledger.consume('p-1');
  const before = ledger.allowanceSummary('uncapped');
  assert.throws(() => ledger.reserveAllowance('p-2', 'uncapped', 2, 2, caps), AllowanceReservationError);
  assert.equal(ledger.state('p-2'), undefined);
  assert.deepEqual(ledger.allowanceSummary('uncapped'), before);
  assert.deepEqual(ledger.allowanceUsage('uncapped', 2), {
    daily: { cents: 0, purchases: 0 },
    lifetime: { cents: Number.MAX_SAFE_INTEGER, purchases: 1 },
  });
  ledger.release('p-1');
  ledger.reserveAllowance('p-2', 'uncapped', 2, 2, caps);
  assert.equal(ledger.state('p-2'), 'reserved', 'a refusal never claims the purchase id');
});

test('exclusion_hides_only_the_owning_purchases_booking', () => {
  const ledger = new BenefitLedger();
  ledger.reserveAllowance('p-1', 'al-1', 3, 300, CAPS);
  ledger.reserveAllowance('p-2', 'al-1', 3, 200, CAPS);
  ledger.reserveAllowance('p-3', 'al-2', 3, 700, CAPS);
  ledger.reserve('p-4', 'mandate-1', 3, 100);

  // Excluding p-1 removes only p-1's al-1 booking, from daily AND lifetime.
  assert.deepEqual(ledger.allowanceUsage('al-1', 3, 'p-1'), {
    daily: { cents: 200, purchases: 1 },
    lifetime: { cents: 200, purchases: 1 },
  });
  assert.deepEqual(ledger.allowanceUsage('al-1', 3, 'p-2'), {
    daily: { cents: 300, purchases: 1 },
    lifetime: { cents: 300, purchases: 1 },
  });
  // Excluding a purchase booked under another allowance, or an employer
  // booking, hides nothing of al-1's.
  for (const id of ['p-3', 'p-4', 'p-absent']) {
    assert.deepEqual(ledger.allowanceUsage('al-1', 3, id), {
      daily: { cents: 500, purchases: 2 },
      lifetime: { cents: 500, purchases: 2 },
    });
  }
});

test('kinds_never_collide_on_a_shared_reference', () => {
  const ledger = new BenefitLedger();
  // Registry rules forbid one ref across kinds; the ledger still must not
  // let a legacy employer call adopt or shadow an allowance booking.
  ledger.reserveAllowance('p-1', 'shared', 3, 500, CAPS);
  ledger.reserve('p-2', 'shared', 3, 100);
  assert.deepEqual(ledger.allowanceUsage('shared', 3), {
    daily: { cents: 500, purchases: 1 },
    lifetime: { cents: 500, purchases: 1 },
  });
  assert.deepEqual(ledger.usage('shared', 3), { cents: 100, purchases: 1 });
  assert.deepEqual(ledger.allowanceSummary('shared'), {
    allowanceRef: 'shared',
    reservedCents: 500,
    reservedPurchases: 1,
    consumedCents: 0,
    consumedPurchases: 0,
  });
  // Releasing the employer booking must not touch the allowance one.
  ledger.release('p-2');
  assert.deepEqual(ledger.allowanceUsage('shared', 3).daily, { cents: 500, purchases: 1 });
});

test('malformed_reservation_is_refused_without_entry', () => {
  const ledger = new BenefitLedger();
  for (const args of [
    ['', 'al-1', 3, 100, CAPS],
    ['p-1', '', 3, 100, CAPS],
    ['p-1', 'al-1', 3.5, 100, CAPS],
    ['p-1', 'al-1', -1, 100, CAPS],
    ['p-1', 'al-1', 3, 0, CAPS],
    ['p-1', 'al-1', 3, -5, CAPS],
    ['p-1', 'al-1', 3, 2.5, CAPS],
    ['p-1', 'al-1', 3, 100, null],
    ['p-1', 'al-1', 3, 100, { maxPerDayCents: -1, maxPurchasesPerDay: 10 }],
    ['p-1', 'al-1', 3, 100, { maxPerDayCents: 1_000, maxPurchasesPerDay: 10, totalEndowmentCents: -1 }],
    ['p-1', 'al-1', 3, 100, { maxPerDayCents: Number.NaN, maxPurchasesPerDay: 10 }],
    ['p-1', 'al-1', 3, 100, { maxPerDayCents: 1_000, maxPurchasesPerDay: -1 }],
    ['p-1', 'al-1', 3, 100, { maxPerDayCents: 1_000, maxPurchasesPerDay: 1.5 }],
    ['p-1', 'al-1', 3, 100, { maxPerDayCents: 1_000 }],
  ] as const) {
    assert.throws(() => ledger.reserveAllowance(...args), Error);
  }
  assert.equal(ledger.state('p-1'), undefined);
  assert.deepEqual(ledger.allowanceUsage('al-1', 3), {
    daily: { cents: 0, purchases: 0 },
    lifetime: { cents: 0, purchases: 0 },
  });
});

test('revision_never_enters_the_booking_identity', () => {
  const ledger = new BenefitLedger();
  // Usage survives allowance revisions: the entry is filed under the
  // reference alone, so a reservation made under version 1 still counts
  // after the allowance moves to version 2 — the same ref, same booking.
  ledger.reserveAllowance('p-1', 'al-1', 3, 500, CAPS);
  assert.deepEqual(ledger.allowanceUsage('al-1', 3).lifetime, { cents: 500, purchases: 1 });
  // A duplicate purchaseId is refused regardless of which revision the
  // caller claims to be under — identity is { kind, ref } plus the id key.
  assert.throws(() => ledger.reserveAllowance('p-1', 'al-1', 3, 100, CAPS), AllowanceReservationError);
});
