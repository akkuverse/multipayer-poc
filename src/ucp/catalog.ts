// UCP-shaped catalog: hand-derived types and the CatalogOffer → Product
// mapper for the simulated business side of a Universal Commerce Protocol
// exchange. The catalog is merchant-sourced fixture data, so this module
// serves it directly — it does not go through AgentPresenter (the consumer
// seam), the coordinator or the trace. Pure functions over an injected
// clock: deterministic, no side effects, no network.
//
// Honesty constraints, matching the mock-2 labelling convention:
// - UCP-shaped, not conformance-tested. Every type below is a reading of
//   the published spec (version pinned in UCP_SPEC_VERSION, Shopping
//   vertical, catalog capability); no official schema validates it.
// - UCP requires a description and the local catalog has none, so the
//   mapper synthesizes { plain: title }. That is synthesized content, not
//   real product copy — recorded as a finding, not presented as merchant
//   data.
// - CatalogOffer carries no currency field; every emitted price states
//   'EUR' explicitly. The implicit-EUR assumption is a recorded gap.
// - availability.available is our validity *window* evaluated at `now`,
//   not UCP's stock-purchasability semantic — same name, different
//   meaning, called out rather than papered over.
// - Every local concept with no UCP counterpart lands in metadata, the
//   sanctioned business-extension point, instead of being dropped or
//   forced into a same-named field.

import type { Cents } from '../core/types.ts';
import type { CatalogOffer } from '../presenter/session.ts';

// The spec revision every type below was read from. It is echoed in
// response envelopes so a consumer can see which reading produced the
// shape — the same role backend.specVersion plays for the mock.
export const UCP_SPEC_VERSION = '2026-08-25';

// UCP 2026-08-25, Shopping vertical, catalog capability — money.
// UCP amounts are integer units of the currency's smallest denomination,
// which is what Cents already is.
export interface UcpPrice {
  amount: Cents;
  // No local currency field exists, so the mapper can only ever fill 'EUR'.
  currency: 'EUR';
}

// UCP 2026-08-25, Shopping vertical, catalog capability — availability.
// UCP reads this as purchasability (stock); we can only fill it with the
// offer's validity window.
export interface UcpAvailability {
  available: boolean;
}

// UCP 2026-08-25, Shopping vertical, catalog capability — Variant, the
// purchasable unit. Checkout consumes variant ids, which is why the offer
// reference lands here and not only on the product.
export interface UcpVariant {
  id: string;
  title: string;
  description: { plain: string };
  price: UcpPrice;
  availability: UcpAvailability;
  // Display context per spec; our merchantId is really a settlement
  // account, so the account binding also survives in metadata.
  seller?: { name: string };
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// UCP 2026-08-25, Shopping vertical, catalog capability — Product, the
// container under which variants group. Our mapping is degenerate: one
// CatalogOffer produces one Product carrying exactly one Variant, so
// price_range always has min === max.
export interface UcpProduct {
  id: string;
  title: string;
  description: { plain: string };
  price_range: { min: UcpPrice; max: UcpPrice };
  tags?: string[];
  variants: UcpVariant[];
  metadata?: Record<string, unknown>;
}

// UCP 2026-08-25, Shopping vertical, catalog capability — message.
// Request-level findings travel inside the response envelope, never as
// thrown errors: an unsupported input is reported, not hidden.
export interface UcpMessage {
  type: 'error' | 'warning' | 'info';
  // Spec Message (Error) requires severity; every error this simulation
  // emits is unrecoverable for the element it names — retrying an unknown
  // id or an empty ids array cannot conjure a different answer.
  severity?: 'recoverable' | 'unrecoverable';
  code?: string;
  content: string;
  path?: string;
}

// UCP 2026-08-25, Shopping vertical, catalog capability — catalog.search
// request. Fields our local catalog has no counterpart for (query,
// context, signals, attribution) are still parsed so the operation layer
// can report them ignored via messages[] rather than silently dropping
// them.
export interface UcpSearchRequest {
  query?: string;
  context?: unknown;
  signals?: unknown;
  attribution?: unknown;
  filters?: {
    // The spec's request-side categories is Array[string]; the
    // {value, taxonomy} object is the response-side Category shape. Both
    // are accepted here — a bare string reads as {value} — so spec-shaped
    // wire input is not refused (recorded as a plan correction in the plan
    // file and the contact report).
    categories?: (string | { value: string; taxonomy?: string })[];
    price?: { min?: Cents; max?: Cents };
  };
  pagination?: { limit?: number; cursor?: string };
}

// UCP 2026-08-25, Shopping vertical, catalog capability — catalog.lookup
// request.
export interface UcpLookupRequest {
  ids: string[];
}

// UCP 2026-08-25, Shopping vertical, catalog capability — response
// envelope. ucp.version and ucp.capabilities declare which spec reading
// and which simulated capabilities produced this response.
export interface UcpCatalogResponse {
  ucp: {
    version: string;
    capabilities: Record<string, { version: string }[]>;
  };
  products: UcpProduct[];
  pagination?: { has_next_page: boolean; total_count: number };
  messages?: UcpMessage[];
}

// Local-only offer fields that survive under metadata. The product↔variant
// mapping is 1:1, so both levels carry the same metadata — a consumer
// reading either level gets the offer's full local context.
const localMetadata = (o: CatalogOffer): Record<string, unknown> => ({
  // merchantId is a settlement account, not a display name — seller.name
  // gets it for display, and the account binding keeps its real meaning here.
  merchant_account: o.merchantId,
  source: o.source,
  valid_from: o.availability.from,
  valid_until: o.availability.until,
  walking_minutes: o.walkingMinutes,
});

// One CatalogOffer → one UCP Product carrying exactly one Variant. The
// offer reference is both ids because checkout consumes variant ids.
// Fresh objects throughout: nothing in the result aliases the input offer
// or shares a mutable node between product- and variant-level fields.
export function toUcpProduct(o: CatalogOffer, now: number): UcpProduct {
  const variant: UcpVariant = {
    id: o.offerRef,
    title: o.title,
    // Synthesized, not merchant-authored — see the header note.
    description: { plain: o.title },
    price: { amount: o.priceCents, currency: 'EUR' },
    availability: {
      // Inclusive validity window on the coordinator clock — the same
      // rule as the session's offerLive, not a stock level.
      available: o.availability.from <= now && now <= o.availability.until,
    },
    seller: { name: o.merchantId },
    tags: [...o.tags],
    metadata: localMetadata(o),
  };
  return {
    id: o.offerRef,
    title: o.title,
    description: { plain: o.title },
    price_range: {
      min: { amount: o.priceCents, currency: 'EUR' },
      max: { amount: o.priceCents, currency: 'EUR' },
    },
    tags: [...o.tags],
    variants: [variant],
    metadata: localMetadata(o),
  };
}

// ---------------------------------------------------------------------------
// Simulated operations
//
// catalog.search and catalog.lookup as pure functions over the injected
// catalog and clock: UCP-shaped request objects in, response envelopes out.
// A request that is not even an object throws — that is a caller bug, not
// wire data. Everything malformed inside an object body is a request-level
// finding and travels in the envelope's messages[] — the wire model the spec
// defines — never as an exception and never as silence.
//
// Capability ids use the spec's per-operation naming
// (dev.ucp.shopping.catalog.search / .lookup) rather than one umbrella
// catalog capability — the granularity the published capability table uses.
// Message codes are the spec's freeform lowercase convention; `not_found`
// matches the identifiers-not-found example verbatim. Message paths are
// RFC 9535 JSONPath, as the spec's Message type requires.

const CATALOG_SEARCH_CAPABILITY = 'dev.ucp.shopping.catalog.search';
const CATALOG_LOOKUP_CAPABILITY = 'dev.ucp.shopping.catalog.lookup';

// The spec's recommended default page size. A request without pagination
// still gets a pagination block, because the business must always apply a
// page size — limit is a request, not a guarantee.
const DEFAULT_PAGE_LIMIT = 10;

// The fields each request envelope may carry. Anything else is
// warned-ignored: reported, never thrown, never silently dropped.
const SEARCH_REQUEST_FIELDS = new Set(['query', 'context', 'signals', 'attribution', 'filters', 'pagination']);
const LOOKUP_REQUEST_FIELDS = new Set(['ids']);
const FILTER_FIELDS = new Set(['categories', 'price']);
const PRICE_FIELDS = new Set(['min', 'max']);
const PAGINATION_FIELDS = new Set(['limit', 'cursor']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// The same inclusive window the session's offerLive applies on the
// coordinator clock, restated here because this module takes `now` as a
// parameter rather than reading coordinator.now.
const offerLiveAt = (o: CatalogOffer, now: number): boolean =>
  o.availability.from <= now && now <= o.availability.until;

// The session's discovery ordering: price, then offerRef by codepoint
// comparison — reproducible regardless of host locale (unlike localeCompare).
const byPriceThenRef = (a: CatalogOffer, b: CatalogOffer): number =>
  a.priceCents - b.priceCents || (a.offerRef < b.offerRef ? -1 : a.offerRef > b.offerRef ? 1 : 0);

// Every envelope declares exactly the capability the operation simulated,
// and carries messages[] only when there is something to report — the field
// is optional on the wire, so an empty array would say nothing twice.
const envelope = (
  capability: string,
  products: UcpProduct[],
  messages: UcpMessage[],
  pagination?: { has_next_page: boolean; total_count: number },
): UcpCatalogResponse => ({
  ucp: { version: UCP_SPEC_VERSION, capabilities: { [capability]: [{ version: UCP_SPEC_VERSION }] } },
  products,
  ...(pagination === undefined ? {} : { pagination }),
  ...(messages.length === 0 ? {} : { messages }),
});

// Simulated `catalog.search`. Only offers live at `now` are searchable —
// discovery can never extend validity, the same rule the session applies.
// Filters combine with AND across kinds; within categories the spec reads
// OR ("any listed category"), which differs from the session's all-tags
// preference semantics — an interpretation, recorded as such.
export function ucpCatalogSearch(req: unknown, catalog: readonly CatalogOffer[], now: number): UcpCatalogResponse {
  if (!isRecord(req)) throw new Error('catalog.search request must be an object');
  const messages: UcpMessage[] = [];
  for (const k of Object.keys(req)) {
    if (!SEARCH_REQUEST_FIELDS.has(k)) {
      messages.push({ type: 'warning', code: 'unsupported', content: `unsupported request field "${k}" was ignored`, path: `$.${k}` });
    }
  }

  // The spec requires at least one of query, filters or an extension input;
  // an input-free request still gets the browse answer, but the envelope
  // says the MUST was not met rather than pretending it was.
  if (req.query === undefined && req.filters === undefined) {
    messages.push({ type: 'warning', code: 'invalid', content: 'search request carries no query or filters; the full live catalog is returned', path: '$' });
  }

  // Free-text query has no local counterpart — the fixture is five offers,
  // not an index — so the honest answer is the full live result set plus a
  // warning that the query was dropped. Faking a relevance ranking over a
  // five-item fixture would report a capability that does not exist.
  if (req.query !== undefined) {
    messages.push({ type: 'warning', code: 'unsupported', content: 'query was ignored: free-text search is not simulated', path: '$.query' });
  }

  // context, signals and attribution are parsed so the envelope can report
  // them received-but-unused rather than silently dropping them.
  for (const field of ['context', 'signals', 'attribution'] as const) {
    if (req[field] !== undefined) {
      messages.push({ type: 'info', code: 'unused', content: `${field} was received but is not used by this catalog`, path: `$.${field}` });
    }
  }
  // context.eligibility is an authority-adjacent claim. The spec marks
  // context provisional and pushes eligibility enforcement to checkout with
  // binding transaction data — the same place our mandate model resolves
  // authority — so a catalog-level claim is acknowledged, never honoured.
  // It is reported in addition to the generic context notice: the generic
  // one covers the whole field, this one names the specific claim.
  if (isRecord(req.context) && 'eligibility' in req.context) {
    messages.push({
      type: 'info',
      code: 'eligibility_not_honoured',
      content: 'context.eligibility was received but is not honoured at catalog level; eligibility resolves at checkout',
      path: '$.context.eligibility',
    });
  }

  let minCents: Cents | undefined;
  let maxCents: Cents | undefined;
  let categories: string[] | undefined;
  const filters = req.filters;
  if (filters !== undefined) {
    if (!isRecord(filters)) {
      messages.push({ type: 'warning', code: 'invalid', content: 'filters must be an object and was ignored', path: '$.filters' });
    } else {
      for (const k of Object.keys(filters)) {
        if (!FILTER_FIELDS.has(k)) {
          messages.push({ type: 'warning', code: 'unsupported', content: `unsupported filter "${k}" was ignored`, path: `$.filters.${k}` });
        }
      }
      const c = filters.categories;
      if (c !== undefined) {
        if (!Array.isArray(c)) {
          messages.push({ type: 'warning', code: 'invalid', content: 'filters.categories must be an array and was ignored', path: '$.filters.categories' });
        } else {
          const values: string[] = [];
          let taxonomyDeclared = false;
          c.forEach((entry, i) => {
            // Spec wire shape is a bare string; the {value, taxonomy}
            // object is the response-side Category reading the plan
            // adopted. Both are accepted.
            if (typeof entry === 'string' && entry.length > 0) {
              values.push(entry);
            } else if (isRecord(entry) && typeof entry.value === 'string' && entry.value.length > 0) {
              values.push(entry.value);
              if (entry.taxonomy !== undefined) taxonomyDeclared = true;
              for (const k of Object.keys(entry)) {
                if (k !== 'value' && k !== 'taxonomy') {
                  messages.push({ type: 'warning', code: 'unsupported', content: `unsupported category field "${k}" was ignored`, path: `$.filters.categories[${i}].${k}` });
                }
              }
            } else {
              messages.push({ type: 'warning', code: 'invalid', content: `filters.categories[${i}] needs a string value and was ignored`, path: `$.filters.categories[${i}]` });
            }
          });
          categories = values;
          if (taxonomyDeclared) {
            // The merchant-taxonomy reading: offer.tags is the only
            // taxonomy this catalog knows, so a declared taxonomy cannot be
            // resolved — the match still runs, and the envelope says so.
            messages.push({
              type: 'info',
              code: 'taxonomy_unresolved',
              content: 'category values are matched against offer tags under the merchant-taxonomy reading; declared taxonomies are not resolved',
              path: '$.filters.categories',
            });
          }
        }
      }
      const p = filters.price;
      if (p !== undefined) {
        if (!isRecord(p)) {
          messages.push({ type: 'warning', code: 'invalid', content: 'filters.price must be an object and was ignored', path: '$.filters.price' });
        } else {
          for (const k of Object.keys(p)) {
            if (!PRICE_FIELDS.has(k)) {
              messages.push({ type: 'warning', code: 'unsupported', content: `unsupported price filter "${k}" was ignored`, path: `$.filters.price.${k}` });
            }
          }
          // Integer-cent bounds, applied as a post-filter on priceCents —
          // the one filter with an exact local counterpart. A negative
          // bound is integer-but-meaningless, so it is reported rather
          // than silently applied (a max of -1 would empty the result
          // with no explanation).
          for (const bound of ['min', 'max'] as const) {
            const v = p[bound];
            if (v !== undefined) {
              if (Number.isInteger(v) && v >= 0) {
                if (bound === 'min') minCents = v;
                else maxCents = v;
              } else {
                messages.push({ type: 'warning', code: 'invalid', content: `filters.price.${bound} must be a non-negative integer number of cents and was ignored`, path: `$.filters.price.${bound}` });
              }
            }
          }
          // An inverted range yields an empty result honestly, but the
          // envelope still says why — an unexplained empty page would read
          // as a catalog with nothing in it.
          if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) {
            messages.push({ type: 'warning', code: 'invalid', content: 'filters.price.min exceeds filters.price.max; the range is empty', path: '$.filters.price' });
          }
        }
      }
    }
  }

  // The spec denominates filters.price in context.currency. This catalog
  // is single-currency (the implicit-EUR gap), so bounds arriving under a
  // declared non-EUR context.currency are still applied in EUR — and the
  // envelope says so instead of silently filtering in the wrong currency.
  if (
    (minCents !== undefined || maxCents !== undefined) &&
    isRecord(req.context) &&
    req.context.currency !== undefined &&
    req.context.currency !== 'EUR'
  ) {
    messages.push({ type: 'warning', code: 'unsupported', content: `price bounds were applied in EUR; context.currency "${req.context.currency}" is not a currency this catalog knows`, path: '$.context.currency' });
  }

  let limit = DEFAULT_PAGE_LIMIT;
  const pagination = req.pagination;
  if (pagination !== undefined) {
    if (!isRecord(pagination)) {
      messages.push({ type: 'warning', code: 'invalid', content: 'pagination must be an object and was ignored', path: '$.pagination' });
    } else {
      for (const k of Object.keys(pagination)) {
        if (!PAGINATION_FIELDS.has(k)) {
          messages.push({ type: 'warning', code: 'unsupported', content: `unsupported pagination field "${k}" was ignored`, path: `$.pagination.${k}` });
        }
      }
      // Cursors are opaque continuation state this fixture never mints; a
      // supplied cursor is ignored with a warning and the first page is
      // served, rather than faking a position in a five-item catalog.
      if (pagination.cursor !== undefined) {
        messages.push({ type: 'warning', code: 'unsupported', content: 'pagination.cursor was ignored: this catalog serves results from the first page', path: '$.pagination.cursor' });
      }
      const l = pagination.limit;
      if (l !== undefined) {
        if (Number.isInteger(l) && l > 0) {
          limit = l;
        } else {
          messages.push({ type: 'warning', code: 'invalid', content: 'pagination.limit must be a positive integer; the default page size applies', path: '$.pagination.limit' });
        }
      }
    }
  }

  const matched = catalog
    .filter((o) => offerLiveAt(o, now))
    .filter((o) => minCents === undefined || o.priceCents >= minCents)
    .filter((o) => maxCents === undefined || o.priceCents <= maxCents)
    .filter((o) => categories === undefined || categories.length === 0 || categories.some((v) => o.tags.includes(v)))
    .sort(byPriceThenRef);
  // has_next_page:true would advertise a page this simulation cannot serve:
  // no cursor is ever minted and supplied cursors are ignored. The flag is
  // still honest about the count, so the unreachable page is reported.
  if (matched.length > limit) {
    messages.push({ type: 'info', code: 'unsupported', content: 'further pages exist but cannot be fetched: cursors are not minted and supplied cursors are ignored', path: '$.pagination' });
  }
  return envelope(
    CATALOG_SEARCH_CAPABILITY,
    matched.slice(0, limit).map((o) => toUcpProduct(o, now)),
    messages,
    { has_next_page: matched.length > limit, total_count: matched.length },
  );
}

// Simulated `catalog.lookup`. Lookup resolves identity, not availability:
// an offer whose window has closed still maps to a product — it simply
// carries availability.available=false — because the response describes
// what the catalog knows and the field says whether it can be bought.
export function ucpCatalogLookup(req: unknown, catalog: readonly CatalogOffer[], now: number): UcpCatalogResponse {
  if (!isRecord(req)) throw new Error('catalog.lookup request must be an object');
  const messages: UcpMessage[] = [];
  for (const k of Object.keys(req)) {
    if (!LOOKUP_REQUEST_FIELDS.has(k)) {
      messages.push({ type: 'warning', code: 'unsupported', content: `unsupported request field "${k}" was ignored`, path: `$.${k}` });
    }
  }

  const resolved = new Map<string, CatalogOffer>();
  const ids = req.ids;
  if (!Array.isArray(ids)) {
    messages.push({ type: 'error', severity: 'unrecoverable', code: 'invalid', content: 'catalog.lookup requires an ids array', path: '$.ids' });
  } else if (ids.length === 0) {
    messages.push({ type: 'error', severity: 'unrecoverable', code: 'invalid', content: 'ids must name at least one identifier', path: '$.ids' });
  } else {
    // Spec: duplicate identifiers are deduplicated and a product answers
    // once however many ids resolve to it. Product id and variant id are
    // both the offerRef, so resolution is a single key lookup either way.
    const seen = new Set<string>();
    ids.forEach((raw, i) => {
      if (typeof raw !== 'string' || raw.length === 0) {
        messages.push({ type: 'error', severity: 'unrecoverable', code: 'invalid', content: `ids[${i}] must be a non-empty string`, path: `$.ids[${i}]` });
        return;
      }
      if (seen.has(raw)) return;
      seen.add(raw);
      const o = catalog.find((x) => x.offerRef === raw);
      if (o === undefined) {
        // Identifiers-not-found per spec: success for what resolved, a
        // per-id message for what did not — never an exception. The spec's
        // own example uses type info; the plan settles on error, the
        // stronger reading of a miss.
        messages.push({ type: 'error', severity: 'unrecoverable', code: 'not_found', content: `identifier "${raw}" resolved to no catalog entry`, path: `$.ids[${i}]` });
      } else {
        resolved.set(raw, o);
      }
    });
  }
  const products = [...resolved.values()].sort(byPriceThenRef).map((o) => toUcpProduct(o, now));
  return envelope(CATALOG_LOOKUP_CAPABILITY, products, messages);
}
