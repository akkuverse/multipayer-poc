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
    categories?: { value: string; taxonomy?: string }[];
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
