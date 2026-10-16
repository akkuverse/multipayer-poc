# UCP catalog contact report

Status: **16 October 2026.** Records where the local catalog vocabulary meets UCP's, and where it does not. Covers `src/ucp/catalog.ts`: simulated `catalog.search` and `catalog.lookup` as pure functions over the synthetic `PRESENTER_CATALOG` — request objects in, response envelopes out, no transport. Spec reading pinned at `2026-08-25` (Shopping vertical, catalog capability); the types are hand-derived and no official schema validates the emitted shape.

## Purpose

Vocabulary contact, not conformance. The exercise answers one question: which UCP concepts have honest local counterparts, and what happens to everything that does not. Every gap below is recorded and surfaced through the response envelope's `messages[]` — refused, warned, or demoted to `metadata` — rather than papered over.

## Field map

Three columns: the local `CatalogOffer` field, the full UCP field it touches, and where the value settled in the emitted shape — a first-class emitted field, a `metadata` key, or a synthesized value.

| Local field | UCP field | Where it landed |
|---|---|---|
| `offerRef` | `product.id`, `variants[].id` | Emitted on **both** ids: Product is the container, Variant is the purchasable, and checkout consumes variant ids |
| `title` | `product.title`, `variants[].title` | Emitted |
| — (no local field) | `product.description`, `variants[].description` | Synthesized `{ plain: title }` — UCP requires a description; this is synthesized content, not merchant copy |
| `priceCents` | `variants[].price.amount`, `product.price_range.min/max.amount` | Emitted as integer cents; `price_range` is degenerate (min = max, one variant per product) |
| — (no local currency field) | `*.currency` | Emitted as the literal `'EUR'` on every price; the implicit-EUR assumption is a recorded gap |
| `availability.from`/`availability.until` | `variants[].availability.available` | Semantic mismatch — see below. `available` = validity window at `now`; the window itself survives as `metadata.valid_from`/`valid_until` |
| `merchantId` | `variants[].seller.name` | Emitted for display per spec; the value is really a settlement account, so the binding is kept as `metadata.merchant_account` |
| `tags` | `product.tags`, `variants[].tags` | Emitted |
| `source` | none | `metadata.source` |
| `walkingMinutes` | none | `metadata.walking_minutes`; the spec's answer is the `dev.ucp.common.location` capability (distance/serves queries) — deferred |
| validity window bounds | none | `metadata.valid_from`, `metadata.valid_until` |
| — (request ids are `offerRef`s already) | `variants[].inputs` correlation array | Not emitted. The spec's client-correlation channel is degenerate here: the product/variant id *is* the requested identifier, so no correlation data can exist. Requirement level unverified |

`metadata` is the spec's sanctioned business-extension point. Because the product↔variant mapping is 1:1, the same metadata block is emitted at **both** levels — a consumer reading either level gets the offer's full local context.

## Request-side findings

| Request field | Handling |
|---|---|
| `query` | No local counterpart — the fixture is five offers, not an index. Returns the full live result set plus a `warning` that `query` was ignored; no faked NLU |
| `filters.categories` | The spec's request-side shape is `Array[string]`; `{value, taxonomy}` objects are the response-side Category. Both are accepted — a correction to the plan's original object-only contract, recorded in the plan file. Values match `offer.tags` under the merchant-taxonomy interpretation; categories combine with **OR** per spec — which differs from the session's all-tags AND preference semantics. A declared `taxonomy` produces a `taxonomy_unresolved` info: the match still runs, the envelope says the taxonomy was not resolved. Two further gaps: the spec's discovery channel for valid values (a `categories` field on search results) is not emitted — our products carry `tags` — so a consumer cannot learn the filterable vocabulary from us; and an empty-string value is `invalid`, whether sent bare or as `{value: ''}` |
| `filters.categories: []` | Spec-valid; an empty list applies no constraint and is served without a message |
| empty request (no `query`, no `filters`) | The spec requires implementations to validate that a request carries at least one recognized input and says empty requests SHOULD be rejected. We take the weaker warn-not-reject reading: an `invalid` warning names the unmet MUST and the browse answer is still served — browse is the honest behaviour for a five-offer fixture, but the deviation is recorded rather than hidden |
| `filters.price.min/max` | Post-filter on `priceCents` — the one filter with an exact local counterpart. Bounds must be non-negative integer cents; a negative bound is `invalid`-warned, and `min > max` warns that the range is empty rather than serving an unexplained empty page |
| `filters.*` (unknown) | Warned-ignored, never thrown |
| `context`, `signals`, `attribution` | Parsed and reported received-but-unused via `info` messages — reported, not silently dropped |
| `context.eligibility` | Acknowledged, **never honoured** at catalog level: the spec marks context provisional and pushes eligibility to checkout with binding transaction data — the same place our mandate model resolves authority (proposal vs initiation). Gets a named `eligibility_not_honoured` info in addition to the generic context notice |
| `context.currency` | The spec denominates `filters.price` in `context.currency`. This catalog is single-currency, so bounds under a non-EUR `context.currency` are still applied in EUR, with a `warning` — not silently filtered in the wrong currency |
| `pagination.limit` | Honoured by slicing with `has_next_page`/`total_count`; default page size 10 (spec-recommended); the pagination block is always present |
| `pagination.cursor` | Never minted; a supplied cursor is ignored with a `warning` and the first page is served. This deviates from a spec MUST — the response-side `cursor` is required when `has_next_page` is true — so when more pages exist than can be served an `info` message reports the unreachable page; `has_next_page: true` stays honest about the count but the absent cursor is a recorded gap. No maximum page size is enforced (the spec permits a business-chosen max; moot at five offers) |

## Decisions

| Decision | Reason |
|---|---|
| Product = container, Variant = purchasable; each `CatalogOffer` → one Product with exactly one Variant | Degenerate but honest: the local catalog has no product/variant distinction. `offerRef` lands on both ids because checkout consumes variant ids |
| `description` synthesized as `{ plain: title }` | UCP requires it, the local catalog has none; recorded as synthesized content, not presented as merchant data |
| Explicit `'EUR'` on every price | No local currency field exists; the implicit-EUR assumption is a recorded gap rather than an unexamined default |
| `availability.available` = validity window at `now` | Same name, different meaning: UCP reads stock purchasability, we have a validity window on the coordinator clock. Called out; the window bounds are preserved in metadata |
| `seller.name` = `merchantId`; `metadata.merchant_account` keeps the binding | `merchantId` is a settlement account, not a display name; the spec's display slot gets it, the account semantics survive in metadata |
| Local-only fields under `metadata`, at both product and variant level | The sanctioned extension point; the 1:1 mapping makes either level reachable |
| Free-text `query`: full live set + warning | Faking relevance over a five-item fixture would report a capability that does not exist |
| Request-level problems → `messages[]`, never exceptions | The spec's wire model: `error`/`warning`/`info`, freeform lowercase codes, RFC 9535 JSONPath paths. Only a non-object body throws — a caller bug, not wire data |
| `UcpMessage.severity` added during execution | Spec Message (Error) requires it; every error this simulation emits is `unrecoverable` for the element it names — retrying an unknown id or an empty ids array cannot conjure a different answer |
| `not_found` emitted as type `error` | The spec's own material is split on whether a miss is informational or an error — the lookup doc's identifiers-not-found example uses `info`. The plan settles on `error`, the stronger reading of a miss |
| Per-operation capability ids: `dev.ucp.shopping.catalog.search` / `.lookup` | The granularity the published capability table uses; echoed in `ucp.version` = `2026-08-25`, the same role `backend.specVersion` plays for the mock |

## Operation semantics

- **Search is live-only.** Only offers whose window covers `now` are searchable — the same rule as the session's `discover`; discovery never extends validity.
- **Lookup resolves identity, not availability.** An expired offer still answers with `available: false` — the response describes what the catalog knows, the field says whether it can be bought. Duplicate ids deduped (one product per resolution); unknown ids are per-id `unrecoverable` `not_found` errors and are omitted from `products`; empty or non-array `ids` produce error messages, not throws.
- **Both operations validate envelopes the same way.** Unknown request fields are warned-ignored — note that spec-defined optional lookup fields (`filters`, `context`) get this treatment too, since only `ids` is simulated. Malformed inputs produce `invalid` messages — warnings on search, unrecoverable errors on lookup. Results order deterministically by price then `offerRef`, the session's ordering.

## What the shape does not claim

- UCP **conformance** — no official schema validates these types.
- **Transport** — no REST endpoint, no MCP server, no network. The binding lives outside this repo.
- A **live merchant** — all data is the synthetic fixture catalog.
- **Eligibility honouring** — `context.eligibility` is acknowledged, never applied; eligibility resolves at checkout, as our authority resolves at initiation.
- **Multi-variant products** — the mapping is strictly 1:1.
- Currencies other than **EUR**.
- **Cursor pagination** — offsets only via `limit`; no cursors are minted.
- **Taxonomy resolution** — category matching is the merchant-taxonomy tag interpretation only.
- **Free-text search** — `query` is reported ignored.
- **The full lookup capability** — `dev.ucp.shopping.catalog.lookup` also defines the single-product `get_product` operation ("full product detail"); only the batch-ids operation is simulated.
- **Strict request validation** — an input-free search request warns but still serves the browse answer, where the spec allows rejection.

*UCP-shaped, not conformance-tested — synthetic data, no live merchant.*
