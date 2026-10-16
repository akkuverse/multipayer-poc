# UCP-Shaped Catalog — Implementation Plan

**Status:** Draft, 16 October 2026.

**Goal:** Emit and consume UCP-shaped catalog data over the synthetic offer catalog — a vocabulary-contact exercise that documents exactly where the local field map meets UCP's. Deliver simulated operations (`catalog.search`, `catalog.lookup`) as pure functions: request objects in, response envelopes out. No transport, no SDK, no conformance claim.

**Architecture:** One module `src/ucp/catalog.ts` (new `src/ucp/` group, per the October reorg). It is a *business-side* simulation: the catalog is merchant-sourced fixture data, so the simulated endpoint serves it directly — it does not go through `AgentPresenter`, which is the consumer-side seam. The mapper translates `CatalogOffer → UCP Product` (one degenerate variant each); the operation layer validates UCP-shaped requests, applies what honestly maps, and reports everything else through the response envelope's `messages[]` — never throws for request-level issues.

**Spec:** [Agent protocols](../../agent-protocols.md) (UCP row, split-payments note), [field map](../../field-map.md), [backlog](../../backlog.md). Target shape: UCP spec version `2026-08-25` (Shopping vertical, catalog capability). UCP conformance is *not* claimed; the deliverable is labelled "UCP-shaped, not conformance-tested" the way `mock-2` labels backend assumptions.

## Scope and constraints

- Zero new runtime or dev dependencies; Node.js >= 23.6, native TypeScript stripping, node:test.
- Pure functions over injected `catalog: CatalogOffer[]` and `now` — no trace dependency, no coordinator, deterministic like `policy.ts`. All amounts remain integer euro cents.
- No network, no socket, no HTTP server. The REST/MCP binding is a thin shell that lives outside this repo (scratch playground, then akku-app).
- No `@ucp-js/sdk`. Types are hand-derived from the spec and labelled with the spec version they were read from. SDK belongs to the future network-enabled module.
- Every gap is recorded as a finding, not papered over: where a UCP concept has no local counterpart, the code refuses, warns via `messages[]`, or demotes the field to `metadata` — and the doc says so.
- Local honesty rules apply unchanged: synthetic data only, `LOCAL` evidence where any exists, and nothing in artifacts may read as protocol support.

## Decisions and ownership

| Decision | Consequence |
|---|---|
| Product = container, Variant = purchasable | Each `CatalogOffer` maps to one Product carrying exactly one Variant. `offerRef` lands on both `product.id` and `variants[0].id` — checkout consumes variant ids. |
| `description` required by UCP, absent locally | Synthesize `{ plain: title }`; recorded in the contact report as a synthesized field, not real content. |
| No local currency field | Emit `currency: 'EUR'` explicitly; the implicit-EUR assumption is a recorded gap. |
| `availability` semantic mismatch | Ours is a validity *window* (`from`/`until` on the coordinator clock); UCP's is stock purchasability. `variants[].availability.available` = `offerLive(now)` evaluation; the window itself goes to `metadata.valid_from`/`valid_until`. Same-name-different-meaning is called out in the doc. |
| `merchantId` is a settlement account | `seller.name` gets the merchant id (display context per spec); the account binding goes to `metadata.merchant_account`. |
| `source`, `walkingMinutes`, window | `metadata` — the sanctioned business-extension point per spec. |
| Free-text `query` has no counterpart | Do not fake NLU: the operation returns all live offers plus a `messages[]` warning that `query` was ignored. This is a runtime-visible finding. |
| `filters` | `filters.price.min/max` → post-filter on `priceCents` (explicit support). `filters.categories[].value` → matched against `offer.tags` under the merchant-taxonomy reading, recorded as an interpretation in the doc. |
| `context`, `signals`, `attribution` | Parsed and ignored; a `messages[]` info entry notes they were received but unused. `context.eligibility` claims are *never* honoured at catalog level — mirrors our rule that authority is resolved at proposal/initiation, and matches the spec's "provisional, not authoritative" note. |
| `pagination` | `limit` supported by slicing with `has_next_page`; a cursor is ignored-with-warning (five-item fixture). |
| Errors | Request-level problems produce `messages[]` entries (`error`/`warning`/`info`, UCP `code`s) inside the envelope — the wire model, not exceptions. Malformed-enough requests (non-object body) throw, as a fixture-level caller bug. |
| Version label | `UCP_SPEC_VERSION = '2026-08-25'` constant; the envelope echoes `ucp.version` and declared capabilities, like `backend.specVersion` does for the mock. |

## Interface contract

```ts
export const UCP_SPEC_VERSION = '2026-08-25';

export interface UcpPrice { amount: Cents; currency: 'EUR' }
export interface UcpAvailability { available: boolean }
export interface UcpVariant { id; title; description: { plain: string }; price: UcpPrice; availability: UcpAvailability; seller?: { name: string }; tags?: string[]; metadata?: Record<string, unknown> }
export interface UcpProduct { id; title; description: { plain: string }; price_range: { min: UcpPrice; max: UcpPrice }; tags?: string[]; variants: UcpVariant[]; metadata?: Record<string, unknown> }

export interface UcpMessage { type: 'error' | 'warning' | 'info'; code?: string; content: string; path?: string }
export interface UcpSearchRequest { query?: string; context?: unknown; signals?: unknown; attribution?: unknown; filters?: { categories?: { value: string; taxonomy?: string }[]; price?: { min?: Cents; max?: Cents } }; pagination?: { limit?: number; cursor?: string } }
export interface UcpLookupRequest { ids: string[] }
export interface UcpCatalogResponse { ucp: { version: string; capabilities: Record<string, { version: string }[]> }; products: UcpProduct[]; pagination?: { has_next_page: boolean; total_count: number }; messages?: UcpMessage[] }

export function toUcpProduct(o: CatalogOffer, now: number): UcpProduct;
export function ucpCatalogSearch(req: unknown, catalog: readonly CatalogOffer[], now: number): UcpCatalogResponse;
export function ucpCatalogLookup(req: unknown, catalog: readonly CatalogOffer[], now: number): UcpCatalogResponse;
```

## Tasks

### Task 1: Shape types and the product mapper

- [ ] Define the UCP-shaped interfaces above in `src/ucp/catalog.ts`, each labelled with the spec section it was read from.
- [ ] Implement `toUcpProduct`: degenerate single-variant product; `description` synthesized from `title`; `price`/`price_range` with explicit `EUR`; `availability.available` from the offer's validity window evaluated at `now`; local-only fields under `metadata` (`merchant_account`, `source`, `valid_from`, `valid_until`, `walking_minutes`); `seller.name` = merchantId; `tags` carried over.
- [ ] Pin the emitted shape in `test/ucp-catalog.test.ts`: every spec-required field present on Product and Variant; amounts stay integer cents; deterministic across calls.

### Task 2: Simulated operations

- [ ] `ucpCatalogSearch`: validate the request envelope; apply `filters.price` and `filters.categories` (merchant-taxonomy tag match); honour `pagination.limit` with `has_next_page`/`total_count`; emit `messages[]` warnings for ignored `query`, `cursor`, `context`/`signals`/`attribution`; only live offers are returned (window check at `now`), same rule as `discoverImpl`.
- [ ] `ucpCatalogLookup`: resolve `ids` against `offerRef`; unknown ids produce per-id `messages[]` errors (identifiers-not-found scenario per spec) and are omitted from `products`; empty `ids` is an error message, not a throw.
- [ ] Both declare their capability in the response `ucp.capabilities` map with `version: UCP_SPEC_VERSION`.
- [ ] Envelope ordering is deterministic (price, then offerRef — the same sort the session uses).

### Task 3: Tests

- [ ] Required-field pinning for every offer in `PRESENTER_CATALOG`; the two decoys still decoy through the mapped filters.
- [ ] `query` ignored → full live result set + warning message; never silently treated as understood.
- [ ] Price filter and category filter narrow results correctly; unknown fields in `filters` are warned-ignored, not thrown.
- [ ] Expired offer (clock past `until`) is absent from search results and shows `available: false` on a lookup'd product.
- [ ] Lookup with a mix of known/unknown ids returns the known products plus per-id error messages.
- [ ] Determinism: identical inputs → byte-identical JSON (`JSON.stringify` equality) across two runs.
- [ ] `pnpm test` green.

### Task 4: Contact report and bookkeeping

- [ ] `docs/ucp-contact.md`: the three-column field diff (ours / full UCP / settled subset), request-side findings, and every decision above recorded with its reason. Ends with the explicit label: "UCP-shaped, not conformance-tested — synthetic data, no live merchant."
- [ ] One line in `docs/agent-protocols.md` linking the contact report from the UCP row.
- [ ] Backlog: record that a real UCP client/server (REST or MCP) lives outside this repo and should use `@ucp-js/sdk` — with the split-payments and eligibility-claim findings as context. Note `context.eligibility` as the UCP hook most adjacent to our mandate model (provisional at catalog, binding at checkout — parallel to proposal vs initiation).
- [ ] README file-map row for `src/ucp/catalog.ts`.

## Acceptance and stopping point

Complete when `pnpm test` is green including the new suite, `toUcpProduct`/`ucpCatalogSearch`/`ucpCatalogLookup` emit deterministic UCP-shaped envelopes for the fixture catalog, every unsupported input produces a `messages[]` entry rather than silence, and `docs/ucp-contact.md` states precisely which claims the shape does and does not support. This establishes vocabulary contact only — no UCP conformance, no transport, no live merchant.

## Deferred work and priority

1. Real REST endpoint / MCP server over the same functions — scratch playground first, akku-app second; uses `@ucp-js/sdk` there.
2. Dev-time shape validation against official generated schemas (`@ucp-js/sdk` as a devDependency) — only if a research question needs the stronger "parses against official schema" claim; requires a dependency decision.
3. Cart/checkout/order capabilities — UCP checkout ≈ our coordinator's domain; a contact report for *that* (instruments ↔ legs, `incomplete`/`recoverable` ↔ `recovery_required`) is a separate exercise.
4. UCP Food vertical when published — our lunch scenario maps onto Shopping today.
5. Location capability for `walkingMinutes` — UCP's answer is `dev.ucp.common.location` distance/serves queries, not an offer field; note in the contact report.

## Planning assumptions

- Spec version pinned to `2026-08-25` (latest published at planning time); the draft branch is ignored.
- The catalog source stays `PRESENTER_CATALOG` / `CatalogOffer` — no fixture changes needed for this slice.
