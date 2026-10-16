// The UCP-shaped product mapper: one CatalogOffer → one Product carrying
// exactly one Variant. These tests pin every spec-required field on both
// levels, the explicit-EUR integer-cent amounts, the window-derived
// availability and the local fields under metadata — plus byte-identical
// output across calls. What they cannot pin is UCP conformance: the shape
// is hand-derived, not schema-validated (see the module header).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUcpProduct, UCP_SPEC_VERSION } from '../src/ucp/catalog.ts';
import { OFFER_A, PRESENTER_CATALOG } from '../src/presenter/fixtures.ts';
import type { CatalogOffer } from '../src/presenter/session.ts';

// The local-only metadata every emitted product and variant carries.
const expectedMetadata = (o: CatalogOffer): Record<string, unknown> => ({
  merchant_account: o.merchantId,
  source: o.source,
  valid_from: o.availability.from,
  valid_until: o.availability.until,
  walking_minutes: o.walkingMinutes,
});

test('UCP_SPEC_VERSION pins the spec reading the types were derived from', () => {
  assert.equal(UCP_SPEC_VERSION, '2026-08-25');
});

test('a live offer maps to the pinned UCP product', () => {
  // OFFER_A: offer-a, merchant-a, 'Vegetarian lunch bowl', EUR 13,
  // window [0, 60], 5 minutes — observed at t=10, inside the window.
  assert.deepEqual(toUcpProduct(OFFER_A, 10), {
    id: 'offer-a',
    title: 'Vegetarian lunch bowl',
    // Synthesized from the title: the catalog has no description field.
    description: { plain: 'Vegetarian lunch bowl' },
    price_range: {
      min: { amount: 1_300, currency: 'EUR' },
      max: { amount: 1_300, currency: 'EUR' },
    },
    tags: ['lunch', 'vegetarian'],
    variants: [
      {
        id: 'offer-a',
        title: 'Vegetarian lunch bowl',
        description: { plain: 'Vegetarian lunch bowl' },
        price: { amount: 1_300, currency: 'EUR' },
        availability: { available: true },
        seller: { name: 'merchant-a' },
        tags: ['lunch', 'vegetarian'],
        metadata: {
          merchant_account: 'merchant-a',
          source: 'merchant-a-menu-feed',
          valid_from: 0,
          valid_until: 60,
          walking_minutes: 5,
        },
      },
    ],
    metadata: {
      merchant_account: 'merchant-a',
      source: 'merchant-a-menu-feed',
      valid_from: 0,
      valid_until: 60,
      walking_minutes: 5,
    },
  });
});

test('every catalog offer emits all spec-required product and variant fields', () => {
  for (const o of PRESENTER_CATALOG) {
    const p = toUcpProduct(o, 10);
    // Product-level required fields.
    assert.equal(p.id, o.offerRef, `${o.offerRef}: product id`);
    assert.equal(p.title, o.title, `${o.offerRef}: product title`);
    assert.deepEqual(p.description, { plain: o.title }, `${o.offerRef}: description`);
    assert.deepEqual(p.price_range, {
      min: { amount: o.priceCents, currency: 'EUR' },
      max: { amount: o.priceCents, currency: 'EUR' },
    });
    assert.deepEqual(p.tags, o.tags);
    assert.equal(p.variants.length, 1, `${o.offerRef}: exactly one variant`);
    assert.deepEqual(p.metadata, expectedMetadata(o));
    // Variant-level required fields.
    const v = p.variants[0]!;
    assert.equal(v.id, o.offerRef, `${o.offerRef}: variant id`);
    assert.equal(v.title, o.title, `${o.offerRef}: variant title`);
    assert.deepEqual(v.description, { plain: o.title });
    assert.deepEqual(v.price, { amount: o.priceCents, currency: 'EUR' });
    // Every fixture window opens at 0, so all offers are live at t=10.
    assert.equal(v.availability.available, true);
    assert.deepEqual(v.seller, { name: o.merchantId });
    assert.deepEqual(v.tags, o.tags);
    assert.deepEqual(v.metadata, expectedMetadata(o));
  }
});

test('all amounts are integer cents', () => {
  for (const o of PRESENTER_CATALOG) {
    const p = toUcpProduct(o, 10);
    for (const amount of [
      p.price_range.min.amount,
      p.price_range.max.amount,
      p.variants[0]!.price.amount,
    ]) {
      assert.ok(Number.isInteger(amount), `${o.offerRef}: non-integer amount ${amount}`);
      assert.equal(amount, o.priceCents);
    }
  }
});

test('availability is the inclusive validity window, not stock', () => {
  // OFFER_A's window is [0, 60]: both bounds are live.
  assert.equal(toUcpProduct(OFFER_A, 0).variants[0]!.availability.available, true);
  assert.equal(toUcpProduct(OFFER_A, 60).variants[0]!.availability.available, true);
  assert.equal(toUcpProduct(OFFER_A, 61).variants[0]!.availability.available, false);
  // A window that has not opened yet is not "expired", just unavailable.
  const upcoming: CatalogOffer = { ...OFFER_A, availability: { from: 50, until: 60 } };
  assert.equal(toUcpProduct(upcoming, 10).variants[0]!.availability.available, false);
});

test('output is deterministic and fresh across calls', () => {
  for (const o of PRESENTER_CATALOG) {
    const a = toUcpProduct(o, 10);
    const b = toUcpProduct(o, 10);
    assert.equal(JSON.stringify(a), JSON.stringify(b), `${o.offerRef} not deterministic`);
    // Distinct objects each call: no node is shared between the two
    // results, or between product- and variant-level prices/metadata.
    assert.notEqual(a.variants[0], b.variants[0]);
    assert.notEqual(a.variants[0]!.price, a.price_range.min);
    assert.notEqual(a.variants[0]!.metadata, a.metadata);
  }
});
