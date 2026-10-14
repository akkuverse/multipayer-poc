# Agent payment protocols and the co-funded mandate

Status: **note, 14 October 2026.** Background for the mapping table in the [README](../README.md#relation-to-agent-commerce-protocols).

## Position

Interoperate, don't depend. The digital euro is public infrastructure with its own rulebook, so the mandate design *builds on AP2's mandate model* and names the gap. It does not say the PoC is built on AP2, UCP, ACP or PAP. None of them is integrated in code.

## Landscape (as checked 14 October 2026)

| Protocol | Who | Layer | Status | Relevance |
|---|---|---|---|---|
| **AP2** (Agent Payments Protocol) | Google; FIDO Alliance governance reported since April 2026 (secondary source, unverified) | Proof of authorisation: signed **Checkout Mandate** and **Payment Mandate** (SD-JWT), `checkout_hash` binds payment to the approved checkout. Human-present (closed mandate) and autonomous (open mandate with constraints) modes | Public spec | **High.** Same problem as the coordinator |
| **UCP** (Universal Commerce Protocol) | Google, Shopify and others; launched 11 Jan 2026 | Discovery, cart, checkout, orders; can chain AP2 for payment | Public spec, Apache-2.0 | AI workstream only (offer discovery) |
| **ACP** (Agentic Commerce Protocol) | OpenAI, Stripe | Checkout inside ChatGPT | In production since late 2025 | One mention only |
| **PAP** (Personal Agent Protocol) | Meta, Sierra, with Genesys, Instinct, Rocket, Shopify, Stripe, Walmart; announced 6 Oct 2026 | Personal agent ↔ company connection; OAuth with read or write account access, guest then authenticated sessions | Announcement only; v0.1 spec promised "later this month". Payments named as a future extension, unspecified | AI workstream: read-versus-spend boundary |

Note: "intent and cart mandates" is AP2's 2025 vocabulary; the current spec uses checkout and payment mandates.

## The gap

The AP2 spec does not cover split funding, and it puts agent-to-agent delegation explicitly out of scope. A mandate covers one purchase paid by one payer, using one payment method. AP2's extension points are **Mandate Constraints** (new constraint type: schema plus evaluation algorithm) and **Payment Instrument** types. A co-funding constraint and a digital euro instrument type would be the natural route. Do not claim UCP, ACP or PAP "assume one payer": that was not verified for them. The verified claim is only that none addresses co-funded purchases.

## Mapping

See the [README](../README.md#relation-to-agent-commerce-protocols).

## To check

- Check whether PAP v0.1 has been published and whether it specifies payments; update the README table if so.
- Verify AP2's FIDO Alliance governance against a primary source before citing it anywhere.

## Sources

- [AP2 specification](https://ap2-protocol.org/ap2/specification/)
- [Google Developers Blog: Under the Hood, UCP](https://developers.googleblog.com/under-the-hood-universal-commerce-protocol-ucp/) · [ucp.dev](http://ucp.dev/)
- [Sierra: Introducing the Personal Agent Protocol](https://sierra.ai/blog/introducing-personal-agent-protocol)
- [Agentic Commerce Standards: UCP vs ACP vs AP2 in 2026](https://www.digitalapplied.com/blog/agentic-commerce-standards-ucp-acp-ap2-2026-merchant-guide) (secondary)
