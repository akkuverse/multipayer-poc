// The UCP-shaped product mapper: one CatalogOffer → one Product carrying
// exactly one Variant. These tests pin every spec-required field on both
// levels, the explicit-EUR integer-cent amounts, the window-derived
// availability and the local fields under metadata — plus byte-identical
// output across calls. What they cannot pin is UCP conformance: the shape
// is hand-derived, not schema-validated (see the module header).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUcpProduct, ucpCatalogLookup, ucpCatalogSearch, UCP_SPEC_VERSION } from '../src/ucp/catalog.ts';
import type { UcpCatalogResponse } from '../src/ucp/catalog.ts';
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

// ---------------------------------------------------------------------------
// Simulated operations: catalog.search and catalog.lookup. The interface is
// request-object in, response-envelope out — these tests cross only that
// seam. The rule they pin everywhere: an unsupported or malformed input
// inside an object body surfaces as a messages[] entry, never as silence
// and never as a throw; only a body that cannot be read as a request at
// all — null, a primitive or an array — throws, as a fixture-level caller
// bug.
// Required-field pinning for every offer already lives in the mapper suite
// above — the operations map through toUcpProduct, so what is pinned here is
// selection, ordering, pagination and the messages contract.

// Product ids in envelope order, so expectations read as what a consumer sees.
const productIds = (r: UcpCatalogResponse): string[] => r.products.map((p) => p.id);

// All five fixture offers live at t=10, sorted the way the operation sorts:
// price, then offerRef by codepoint — the same order the session's discover
// applies. offer-a (window [0, 60]) drops out once now > 60.
const LIVE_AT_10 = ['offer-meat', 'offer-far', 'offer-a', 'offer-c', 'offer-b'];
const LIVE_AT_70 = ['offer-meat', 'offer-far', 'offer-c', 'offer-b'];

test('search returns the full live catalog, sorted by price then reference', () => {
  // No query and no filters: the spec requires at least one, so the browse
  // answer comes with a warning that the MUST was not met.
  const res = ucpCatalogSearch({}, PRESENTER_CATALOG, 10);
  assert.deepEqual(res.ucp, {
    version: UCP_SPEC_VERSION,
    capabilities: { 'dev.ucp.shopping.catalog.search': [{ version: UCP_SPEC_VERSION }] },
  });
  assert.deepEqual(productIds(res), LIVE_AT_10);
  assert.deepEqual(res.pagination, { has_next_page: false, total_count: 5 });
  assert.deepEqual(res.messages, [
    {
      type: 'warning',
      code: 'invalid',
      content: 'search request carries no query or filters; the full live catalog is returned',
      path: '$',
    },
  ]);
});

test('a free-text query is reported ignored, never silently understood', () => {
  // Free-text search has no local counterpart — the fixture is five offers,
  // not an index. The honest answer is the full live set plus a warning
  // naming the dropped input.
  const res = ucpCatalogSearch({ query: 'cheap vegetarian nearby' }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(res), LIVE_AT_10);
  assert.deepEqual(res.messages, [
    {
      type: 'warning',
      code: 'unsupported',
      content: 'query was ignored: free-text search is not simulated',
      path: '$.query',
    },
  ]);
});

test('the meat decoy drops under a vegetarian category filter', () => {
  // Bare strings are the spec's request-side categories shape. offer-meat is
  // the cheapest live offer but lacks the tag, so the mapped filter removes
  // it — the same decoy behaviour the session's tag preference produces.
  const res = ucpCatalogSearch({ filters: { categories: ['vegetarian'] } }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(res), ['offer-far', 'offer-a', 'offer-c', 'offer-b']);
  // A spec-conformant request needs no messages at all.
  assert.equal(res.messages, undefined);
});

test('the far decoy is only excludable through price', () => {
  // offer-far carries the vegetarian tag, so categories alone keep it; and
  // walkingMinutes has no UCP filter counterpart — it survives only in
  // metadata — so a price bound is the honest mapped filter that excludes it.
  const res = ucpCatalogSearch(
    { filters: { categories: ['vegetarian'], price: { min: 1_250 } } },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(res), ['offer-a', 'offer-c', 'offer-b']);
  assert.equal(res.messages, undefined);
});

test('category entries in {value, taxonomy} form match the same tags', () => {
  // {value, taxonomy} is the spec's response-side Category shape; accepting
  // it request-side is a recorded interpretation. A declared taxonomy cannot
  // be resolved against offer tags — the match still runs and the envelope
  // says so.
  const res = ucpCatalogSearch(
    { filters: { categories: [{ value: 'vegetarian', taxonomy: 'merchant-menu' }] } },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(res), ['offer-far', 'offer-a', 'offer-c', 'offer-b']);
  assert.deepEqual(res.messages, [
    {
      type: 'info',
      code: 'taxonomy_unresolved',
      content:
        'category values are matched against offer tags under the merchant-taxonomy reading; declared taxonomies are not resolved',
      path: '$.filters.categories',
    },
  ]);
});

test('unsupported filter fields are warned-ignored, never thrown', () => {
  // 'distance' has no local counterpart and 'unit' is not a price-filter
  // field: both are reported at their paths and dropped, while the
  // recognised filters still narrow the result.
  const res = ucpCatalogSearch(
    {
      filters: {
        categories: ['vegetarian'],
        distance: { maxKm: 2 },
        price: { min: 1_250, unit: 'EUR' },
      },
    },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(res), ['offer-a', 'offer-c', 'offer-b']);
  assert.deepEqual(res.messages, [
    {
      type: 'warning',
      code: 'unsupported',
      content: 'unsupported filter "distance" was ignored',
      path: '$.filters.distance',
    },
    {
      type: 'warning',
      code: 'unsupported',
      content: 'unsupported price filter "unit" was ignored',
      path: '$.filters.price.unit',
    },
  ]);
});

test('malformed filter shapes degrade to warnings, not exceptions', () => {
  // Each bad shape is reported at its path AND ignored — asserting the
  // products, not just the message, pins that a warned filter was actually
  // dropped rather than coerced and applied.
  const badFilters = ucpCatalogSearch({ filters: 'vegetarian' }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(badFilters), LIVE_AT_10);
  assert.deepEqual(badFilters.messages, [
    { type: 'warning', code: 'invalid', content: 'filters must be an object and was ignored', path: '$.filters' },
  ]);
  const badCategories = ucpCatalogSearch({ filters: { categories: 'vegetarian' } }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(badCategories), LIVE_AT_10);
  assert.deepEqual(badCategories.messages, [
    {
      type: 'warning',
      code: 'invalid',
      content: 'filters.categories must be an array and was ignored',
      path: '$.filters.categories',
    },
  ]);
  // A bad entry drops but its valid siblings still apply — the array is
  // per-entry malformed, not wholesale. An empty {value: ''} is as invalid
  // as a bare '' would be.
  const mixedEntries = ucpCatalogSearch(
    { filters: { categories: [42, 'vegetarian', { value: '' }] } },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(mixedEntries), ['offer-far', 'offer-a', 'offer-c', 'offer-b']);
  assert.deepEqual(mixedEntries.messages, [
    {
      type: 'warning',
      code: 'invalid',
      content: 'filters.categories[0] needs a string value and was ignored',
      path: '$.filters.categories[0]',
    },
    {
      type: 'warning',
      code: 'invalid',
      content: 'filters.categories[2] needs a string value and was ignored',
      path: '$.filters.categories[2]',
    },
  ]);
  const badBound = ucpCatalogSearch({ filters: { price: { min: 'low' } } }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(badBound), LIVE_AT_10);
  assert.deepEqual(badBound.messages, [
    {
      type: 'warning',
      code: 'invalid',
      content: 'filters.price.min must be a non-negative integer number of cents and was ignored',
      path: '$.filters.price.min',
    },
  ]);
  // A negative bound is integer-but-meaningless for cent amounts — reported
  // and ignored rather than silently emptying the result.
  const negativeBound = ucpCatalogSearch({ filters: { price: { max: -1 } } }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(negativeBound), LIVE_AT_10);
  assert.deepEqual(negativeBound.messages, [
    {
      type: 'warning',
      code: 'invalid',
      content: 'filters.price.max must be a non-negative integer number of cents and was ignored',
      path: '$.filters.price.max',
    },
  ]);
  // An inverted range empties the result honestly, but the envelope says
  // why — an unexplained empty page would read as a catalog with nothing.
  const inverted = ucpCatalogSearch({ filters: { price: { min: 1_400, max: 1_100 } } }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(inverted), []);
  assert.deepEqual(inverted.messages, [
    {
      type: 'warning',
      code: 'invalid',
      content: 'filters.price.min exceeds filters.price.max; the range is empty',
      path: '$.filters.price',
    },
  ]);
  // A non-object price block is ignored wholesale the same way.
  const badPrice = ucpCatalogSearch({ filters: { price: 1_300 } }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(badPrice), LIVE_AT_10);
  assert.deepEqual(badPrice.messages, [
    { type: 'warning', code: 'invalid', content: 'filters.price must be an object and was ignored', path: '$.filters.price' },
  ]);
});

test('price.max alone narrows from above', () => {
  // EUR 12 ceiling keeps the two cheapest offers; min was already exercised
  // against the far decoy above.
  const res = ucpCatalogSearch({ filters: { price: { max: 1_200 } } }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(res), ['offer-meat', 'offer-far']);
  assert.equal(res.messages, undefined);
});

test('price bounds under a non-EUR context.currency are applied in EUR and reported', () => {
  // The spec denominates filters.price in context.currency; this catalog
  // knows only EUR (the implicit-EUR gap), so the bound still applies —
  // with a warning naming the unmet denomination, not a silent answer in
  // the wrong currency.
  const res = ucpCatalogSearch(
    { filters: { price: { min: 1_250 } }, context: { currency: 'USD' } },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(res), ['offer-a', 'offer-c', 'offer-b']);
  assert.deepEqual(res.messages, [
    { type: 'info', code: 'unused', content: 'context was received but is not used by this catalog', path: '$.context' },
    {
      type: 'warning',
      code: 'unsupported',
      content: 'price bounds were applied in EUR; context.currency "USD" is not a currency this catalog knows',
      path: '$.context.currency',
    },
  ]);
});

test('remaining unsupported inputs each surface a messages[] entry', () => {
  // Category-entry extras are dropped field by field — entry-level noise
  // gets the same warned-ignored treatment as every other level.
  const entryExtras = ucpCatalogSearch(
    { filters: { categories: [{ value: 'vegetarian', label: 'Veg' }] } },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(entryExtras), ['offer-far', 'offer-a', 'offer-c', 'offer-b']);
  assert.deepEqual(entryExtras.messages, [
    {
      type: 'warning',
      code: 'unsupported',
      content: 'unsupported category field "label" was ignored',
      path: '$.filters.categories[0].label',
    },
  ]);
  // A non-object pagination block and unknown pagination fields are
  // warned-ignored; an invalid limit falls back to the default page size.
  const badPagination = ucpCatalogSearch(
    { filters: { categories: ['lunch'] }, pagination: 'next' },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(badPagination), LIVE_AT_10);
  assert.deepEqual(badPagination.messages, [
    {
      type: 'warning',
      code: 'invalid',
      content: 'pagination must be an object and was ignored',
      path: '$.pagination',
    },
  ]);
  const badLimit = ucpCatalogSearch(
    { filters: { categories: ['lunch'] }, pagination: { limit: 0, after: 'x' } },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(badLimit), LIVE_AT_10);
  assert.deepEqual(badLimit.pagination, { has_next_page: false, total_count: 5 });
  assert.deepEqual(badLimit.messages, [
    {
      type: 'warning',
      code: 'unsupported',
      content: 'unsupported pagination field "after" was ignored',
      path: '$.pagination.after',
    },
    {
      type: 'warning',
      code: 'invalid',
      content: 'pagination.limit must be a positive integer; the default page size applies',
      path: '$.pagination.limit',
    },
  ]);
  // Lookup warns on unknown top-level fields the same way search does.
  const lookupExtra = ucpCatalogLookup({ ids: ['offer-a'], expand: ['variants'] }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(lookupExtra), ['offer-a']);
  assert.deepEqual(lookupExtra.messages, [
    {
      type: 'warning',
      code: 'unsupported',
      content: 'unsupported request field "expand" was ignored',
      path: '$.expand',
    },
  ]);
});

test('an expired offer is absent from search but still answers lookup', () => {
  // offer-a's window ends at t=60. Search serves only live offers — the same
  // rule as the session's discover — so at t=70 the result shrinks to four.
  assert.deepEqual(productIds(ucpCatalogSearch({}, PRESENTER_CATALOG, 70)), LIVE_AT_70);
  // Lookup resolves identity, not availability: the expired product is still
  // described, and availability.available — not absence — carries the verdict.
  // The full envelope is pinned: lookup declares its own capability and a
  // clean request adds neither pagination nor messages keys.
  assert.deepEqual(ucpCatalogLookup({ ids: ['offer-a'] }, PRESENTER_CATALOG, 70), {
    ucp: {
      version: UCP_SPEC_VERSION,
      capabilities: { 'dev.ucp.shopping.catalog.lookup': [{ version: UCP_SPEC_VERSION }] },
    },
    products: [
      {
        id: 'offer-a',
        title: 'Vegetarian lunch bowl',
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
            availability: { available: false },
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
      },
    ],
  });
});

test('lookup returns known products and a per-id error for each miss', () => {
  // Identifiers-not-found per spec: resolved ids answer normally, each miss
  // gets its own unrecoverable error naming its position — never a throw.
  // Products come back in the operation's sort order, not the request order.
  const res = ucpCatalogLookup(
    { ids: ['offer-c', 'nope-1', 'offer-meat', 'nope-2'] },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(res), ['offer-meat', 'offer-c']);
  assert.deepEqual(res.messages, [
    {
      type: 'error',
      severity: 'unrecoverable',
      code: 'not_found',
      content: 'identifier "nope-1" resolved to no catalog entry',
      path: '$.ids[1]',
    },
    {
      type: 'error',
      severity: 'unrecoverable',
      code: 'not_found',
      content: 'identifier "nope-2" resolved to no catalog entry',
      path: '$.ids[3]',
    },
  ]);
});

test('lookup input problems are error messages, not throws', () => {
  // An empty ids array cannot conjure an answer — a request-level error,
  // not a caller bug.
  const empty = ucpCatalogLookup({ ids: [] }, PRESENTER_CATALOG, 10);
  assert.deepEqual(empty.products, []);
  assert.deepEqual(empty.messages, [
    {
      type: 'error',
      severity: 'unrecoverable',
      code: 'invalid',
      content: 'ids must name at least one identifier',
      path: '$.ids',
    },
  ]);
  // A non-array ids gets the same treatment.
  assert.deepEqual(
    ucpCatalogLookup({ ids: 'offer-a' }, PRESENTER_CATALOG, 10).messages,
    [
      {
        type: 'error',
        severity: 'unrecoverable',
        code: 'invalid',
        content: 'catalog.lookup requires an ids array',
        path: '$.ids',
      },
    ],
  );
  // A malformed entry is reported at its index while good ids still resolve;
  // the duplicated 'offer-a' deduplicates silently — a product answers once.
  const mixed = ucpCatalogLookup({ ids: ['offer-a', 42, 'offer-a'] }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(mixed), ['offer-a']);
  assert.deepEqual(mixed.messages, [
    {
      type: 'error',
      severity: 'unrecoverable',
      code: 'invalid',
      content: 'ids[1] must be a non-empty string',
      path: '$.ids[1]',
    },
  ]);
});

test('a request that is not an object throws — caller bug, not wire data', () => {
  // Everything malformed *inside* an object body is a messages[] entry; a
  // non-object body cannot even be read as a request, so it throws.
  for (const bad of [null, 'x', 42, []]) {
    assert.throws(() => ucpCatalogSearch(bad, PRESENTER_CATALOG, 10), /must be an object/);
    assert.throws(() => ucpCatalogLookup(bad, PRESENTER_CATALOG, 10), /must be an object/);
  }
});

test('unknown top-level request fields are warned-ignored', () => {
  const res = ucpCatalogSearch(
    { filters: { categories: ['vegetarian'] }, locale: 'en-GB' },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(res), ['offer-far', 'offer-a', 'offer-c', 'offer-b']);
  assert.deepEqual(res.messages, [
    {
      type: 'warning',
      code: 'unsupported',
      content: 'unsupported request field "locale" was ignored',
      path: '$.locale',
    },
  ]);
});

test('pagination.limit slices the page and reports what cannot be fetched', () => {
  // total_count is the full match and has_next_page is honest about the
  // remainder — but cursors are never minted, so the unreachable page is
  // itself reported rather than advertised as fetchable.
  const res = ucpCatalogSearch({ pagination: { limit: 2 } }, PRESENTER_CATALOG, 10);
  assert.deepEqual(productIds(res), ['offer-meat', 'offer-far']);
  assert.deepEqual(res.pagination, { has_next_page: true, total_count: 5 });
  assert.deepEqual(res.messages, [
    {
      type: 'warning',
      code: 'invalid',
      content: 'search request carries no query or filters; the full live catalog is returned',
      path: '$',
    },
    {
      type: 'info',
      code: 'unsupported',
      content: 'further pages exist but cannot be fetched: cursors are not minted and supplied cursors are ignored',
      path: '$.pagination',
    },
  ]);
});

test('a supplied cursor is ignored with a warning; the first page is served', () => {
  // The fixture never mints cursors, so one arriving on the wire is reported
  // and dropped — faking a position in a five-item catalog would claim a
  // capability that does not exist.
  const res = ucpCatalogSearch(
    { query: 'anything', pagination: { limit: 2, cursor: 'opaque-string' } },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(res), ['offer-meat', 'offer-far']);
  assert.deepEqual(res.messages, [
    {
      type: 'warning',
      code: 'unsupported',
      content: 'query was ignored: free-text search is not simulated',
      path: '$.query',
    },
    {
      type: 'warning',
      code: 'unsupported',
      content: 'pagination.cursor was ignored: this catalog serves results from the first page',
      path: '$.pagination.cursor',
    },
    {
      type: 'info',
      code: 'unsupported',
      content: 'further pages exist but cannot be fetched: cursors are not minted and supplied cursors are ignored',
      path: '$.pagination',
    },
  ]);
});

test('context, signals and attribution are acknowledged but unused', () => {
  // Parsed so the envelope can report them received-but-unused — a silent
  // drop would read as support.
  const res = ucpCatalogSearch(
    {
      filters: { categories: ['lunch'] },
      context: { locale: 'en-GB' },
      signals: { session: 's-1' },
      attribution: { campaign: 'c-1' },
    },
    PRESENTER_CATALOG,
    10,
  );
  // Every fixture offer carries the 'lunch' tag; the advisory fields narrow
  // nothing.
  assert.deepEqual(productIds(res), LIVE_AT_10);
  assert.deepEqual(res.messages, [
    { type: 'info', code: 'unused', content: 'context was received but is not used by this catalog', path: '$.context' },
    { type: 'info', code: 'unused', content: 'signals was received but is not used by this catalog', path: '$.signals' },
    {
      type: 'info',
      code: 'unused',
      content: 'attribution was received but is not used by this catalog',
      path: '$.attribution',
    },
  ]);
});

test('context.eligibility is acknowledged but never honoured', () => {
  // An authority-adjacent claim arriving at catalog level gets named in the
  // envelope — in addition to the generic context notice — and the result
  // set is untouched by it: eligibility resolves at checkout, the same place
  // the mandate model resolves authority.
  const res = ucpCatalogSearch(
    { filters: { categories: ['vegetarian'] }, context: { eligibility: { employer_benefit: true } } },
    PRESENTER_CATALOG,
    10,
  );
  assert.deepEqual(productIds(res), ['offer-far', 'offer-a', 'offer-c', 'offer-b']);
  assert.deepEqual(res.messages, [
    { type: 'info', code: 'unused', content: 'context was received but is not used by this catalog', path: '$.context' },
    {
      type: 'info',
      code: 'eligibility_not_honoured',
      content: 'context.eligibility was received but is not honoured at catalog level; eligibility resolves at checkout',
      path: '$.context.eligibility',
    },
  ]);
});

test('search and lookup envelopes are byte-identical across calls', () => {
  // The same determinism bar the mapper meets: identical inputs must produce
  // identical JSON, messages ordering included.
  const searchReq = {
    query: 'ignored',
    context: { eligibility: {} },
    filters: { categories: ['vegetarian'], price: { max: 1_350 } },
    pagination: { limit: 3 },
  };
  assert.equal(
    JSON.stringify(ucpCatalogSearch(searchReq, PRESENTER_CATALOG, 10)),
    JSON.stringify(ucpCatalogSearch(searchReq, PRESENTER_CATALOG, 10)),
  );
  const lookupReq = { ids: ['offer-b', 'missing', 'offer-a'] };
  assert.equal(
    JSON.stringify(ucpCatalogLookup(lookupReq, PRESENTER_CATALOG, 70)),
    JSON.stringify(ucpCatalogLookup(lookupReq, PRESENTER_CATALOG, 70)),
  );
});
