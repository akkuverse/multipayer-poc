# Akku multi-payer PoC (mock)

[![ci](https://github.com/akkuverse/multipayer-poc/actions/workflows/ci.yml/badge.svg)](https://github.com/akkuverse/multipayer-poc/actions/workflows/ci.yml)

A small, deterministic coordinator for one merchant purchase funded by two payers with **different authority**: an employee approves a specific purchase — by device signature, a signed one-off exception, or automatically under signed standing terms — and an employer contributes under a separate, bounded mandate. Reference case: a EUR 13 lunch = EUR 8 employee + EUR 5 employer. The same coordinator also runs peer bill splits, group purchases and one-payer, multi-payee orders (S13–S15).

Built by Akku Labs to explore co-funded payments in the digital euro, in particular multi-payer transactions. Not affiliated with or endorsed by the European Central Bank.

**This is not a payment system and not the ECB API.** Everything runs locally against a mock backend with synthetic actors and amounts. No personal data, no real money, no network calls, no dependencies.

## Run

Requires Node.js 23.6 or later (native TypeScript type stripping).

```bash
pnpm test            # or: node --test "test/**/*.test.ts"
pnpm scenarios       # print every scenario trace and final balances
pnpm scenarios S03   # one scenario
pnpm scenarios --json > runs.json   # run records: run id, fixture and spec version, trace digest, events
pnpm scenarios S03 --mermaid   # sequence diagram for slides or GitHub
pnpm findings          # findings table from fresh runs (ECB column: not tested)
pnpm presenter         # scripted synthetic presenter: conversations, audit evidence, comparison
pnpm --silent presenter --json     # one JSON document: four run records plus comparison
pnpm --silent presenter --markdown --run-id=<id>   # regenerates docs/presenter-comparison.md
# test/invariants.property.test.ts checks the safety rules over 250 seeded random runs
```

## What it models

| Part | File | Responsibility |
|---|---|---|
| Policy | `src/core/policy.ts` | Deterministic eligibility and split. Benefit conditions live in the application, never in the money |
| Coordinator | `src/core/coordinator.ts` | Proposal versions as shares, basis-discriminated authorization (device signature, signed exception, standing-mandate evidence), assessment and atomic budget admission at initiation, first-handoff rechecks, frozen submission intent for retries, state derivation, reconciliation, recovery, refunds, receipts and disputes |
| Employee authority | `src/core/employee-authority.ts` | Verified signed standing terms per employee — publication is the trust decision — plus the deterministic Auto/Confirm/Exception/Blocked assessment |
| Auto-pay ledger | `src/core/autopay-ledger.ts` | Per-employee, per-UTC-month automatic-payment budget: owner-bound reservation at admission, consumed on completion, released on conclusive failure or confirmed return |
| Backend port | `src/settlement/backend.ts` | `SettlementBackend`: the async seam the mock and a future ECB adapter implement; contract suite in `test/contract/` |
| Mock backend | `src/settlement/mock-backend.ts` | Holding limits, waterfall and reverse waterfall, zero holding for businesses, idempotency keys, fault injection (decline, lost response), refunds to the original payer |
| PSPs | `src/settlement/psp.ts` | Per-payer initiation: each payer's simulated PSP forwards its own leg; group assembly with a deadline is a mock hypothesis |
| Benefit ledger | `src/core/ledger.ts` | Per-mandate, per-day reservations: reserved at submission, consumed on completion, released on failure or return |
| Signed authority | `src/core/signing.ts`, `src/core/authority.ts` | Ed25519 over canonical JSON for approvals, exception acknowledgments, employee standing terms and employer mandates; latest signed employer mandate per ref, bound to its employer |
| Party views | `src/core/views.ts` | What payer, payee and employer may see ([field map](docs/field-map.md)) |
| Evidence | `src/evidence/run-record.ts`, `src/evidence/findings.ts` | Run records with fixture and spec version and a trace digest; findings table generated from runs |
| Diagrams | `src/evidence/mermaid.ts` | Trace to Mermaid sequence diagram |
| Scenarios | `src/scenarios.ts` | Synthetic fixtures and the 28 scenarios below |
| Presenter | `src/presenter/journeys.ts`, `src/presenter/session.ts`, `src/presenter/fixtures.ts` | Scripted synthetic presenter: a restricted agent handle (discover/evaluate/select/explain under a signed grant) beside trusted user-flow and runner handles (approve/submit/reconcile/dispute; the runner's deterministic no-tap step); evidence-backed conversation and comparison records |
| UCP-shaped catalog | `src/ucp/catalog.ts` | Simulated `catalog.search`/`catalog.lookup` over the fixture catalog: request objects in, UCP-shaped response envelopes out — vocabulary contact, not conformance ([contact report](docs/ucp-contact.md)) |

Purchase states: `draft → awaiting_approvals → ready → pending → completed`, with `failed` (nothing committed), `cancelled` (all obligations resolved) and `recovery_required` (some money committed, purchase not complete; the outstanding amount stays visible). Returns carry their own status and never erase the original settlement.

Concurrent calls: while `submit`, `resubmit`, `reconcile`, `recover`, `refund` or `dispute` is running on a purchase, that coordinator refuses every other mutation of the same purchase with `operation_in_progress`. This includes `approve`, `changeOffer`, `refreshAuthorization` and `cancel`. The refusal changes nothing and is not queued; after the original call settles, the normal state and authority rules apply. Other purchases and read-only projections remain available. A running call is separate from purchase state: the state still reflects the last applied outcome, so it alone cannot say whether a new action is allowed. The presenter retains its stricter session-wide guard.

The mock supports two settlement modes so the same fixtures can be compared:

- `atomic`: all contributions settle as one transaction or none do (the call's description of multi-payer).
- `independent`: the two-payment baseline available on existing rails, where one leg can settle while the other fails.

Every trace event is tagged `LOCAL`. `ECB_API` is reserved for events observed in the ECB test environment; a local pass is never reported as an ECB capability.

## Employee standing terms and automatic payment

Each employee may publish one set of signed standing terms (`Coordinator.publishEmployeeMandate`); only a next version signed by the employee replaces them. Every employer-benefit purchase carries a deterministic assessment — `Blocked`, `Exception`, `Auto` or `Confirm`, with a single reason — computed from the verified terms, the fee-inclusive employee debit, the merchant, monthly usage, the clock and route capability. `quote()` returns the same assessment read-only: no purchase, reservation or trace.

Benefit-purchase amounts and fee-inclusive debits must be safe integer cents; overflow is rejected before an assessment or proposal is published. Calendar epochs must be ISO UTC timestamps ending in `Z`, optionally with three-digit milliseconds, so booking months are independent of the host timezone.

- `maxCents` is the ordinary-confirmation maximum, fee included; `autoPayMaxCents` is the largest debit payable without a tap; `autoPayMonthlyCents` is the monthly automatic budget. A zero automatic limit disables auto-pay entirely.
- Expiry and revocation disable automatic authority only. The last verified maximum and the blocked-merchant list stay in force for manual purchases until the employee signs replacement terms.
- Exceeding `maxCents` needs a signed one-off exception acknowledging the exact overage against the current revision — an exception never changes the standing terms. A lasting edit is a separate signed revision, and any revision invalidates recorded exceptions.
- Automatic debits book into the UTC calendar month of admission in the dedicated auto-pay ledger: reserved synchronously before the first send, consumed once on completion, released only on a conclusive no-debit outcome or a confirmed return. Timeouts, lost responses and unresolved returns hold the booking; a returned principal keeps any unreturned fee in usage.
- No-tap selection: in a presenter session, `agent.selectOffer()` can leave the purchase Auto-authorized; a trusted deterministic `runner.step()` then submits it. The agent never approves, submits, retries, publishes terms or disputes — and the interval between selection and the runner step is an explicit intervention point (S24 changes the offer there), not a cancellation grace period.
- The first fully completed mandate-authorized purchase earns exactly one receipt with a fixed dispute deadline; the trusted employee flow may open a dispute inside that window to request the existing full-purchase return — a request, not proof a refund happened. Device- and exception-paid purchases keep the plain refund route.
- Return summaries reflect progress even when a later PSP call throws: `unresolved` means a return attempt is uncertain with no confirmed returned leg, and `partial` means some principal is confirmed returned with other legs outstanding. Uncertainty supersedes an earlier `unsupported` result. An accepted dispute follows the same summary; only a confirmed full return releases its holds.

These are simulator product choices, not statements about legal authorization, SCA exemptions, refund rights or real PSP capabilities.

## Scenarios

| ID | Scenario | Expected result |
|---|---|---|
| S01 | Both authorities hold | EUR 8 + EUR 5 settle; merchant receives EUR 13 in its linked bank account (zero holding) |
| S02 | Employee holds EUR 3 | Reverse waterfall funds the remaining EUR 5 of the employee share |
| S03 | Two-payment baseline, employee leg fails | `recovery_required` with EUR 5 outstanding, then employer refunded and `cancelled` |
| S04 | Same failure, atomic settlement | `failed`, no money moved, nothing to recover |
| S05 | Partial failure, returns unsupported | Stays `recovery_required`; EUR 5 outstanding remains visible |
| S06 | Employer mandate expires before initiation | `failed`, zero executions, employee share still EUR 8 |
| S07 | Offer changes to EUR 14 (EUR 9 personal) | Approval invalidated; stale approval rejected; renewed approval on a EUR 13 alternative completes |
| S08 | Request retried with same keys | One execution per leg |
| S09 | Response lost | `pending`, retry deduplicated, status query resolves to `completed` |
| S10 | Full refund near the holding limit | EUR 8 back to employee (excess waterfalls to bank), EUR 5 back to employer |
| S11 | Second lunch on the same working day | No employer share; EUR 13 exceeds the standing EUR 8 maximum — `awaiting_approvals` for a signed exception |
| S12 | Employer's PSP declines | Atomic group rejected; employee never charged EUR 13 |
| S13 | Bill split, three colleagues, EUR 40 | EUR 13.34 + 13.33 + 13.33 settle as one transaction |
| S14 | Group gift, one colleague's PSP declines | Atomic group rejected; nobody covers the missing share |
| S15 | One payer, two payees (restaurant + delivery platform) | One approval, two payee legs with their own references |
| S16 | Each payer's PSP submits its own leg (atomic) | Backend assembles the group; first PSP sees pending, then completed |
| S17 | Employer's PSP unavailable (atomic, per PSP) | Group expires at the deadline; nothing settles |
| S18 | Employer's PSP unavailable (two-payment baseline) | EUR 8 settles alone, `recovery_required`, returned, `cancelled` |
| S19 | EUR 4 employee debit inside standing terms | Auto; the trusted runner settles with no tap and issues exactly one receipt |
| S20 | Benefit-eligible but untrusted merchant | Confirm `untrusted_merchant`; a device signature settles; no terms change is published |
| S21 | EUR 8 debit over the EUR 6 automatic limit | Confirm `over_auto_limit`; a device signature settles it |
| S22 | EUR 11 over the EUR 10 standing maximum | Plain signature refused; a signed EUR 1 exception pays once; standing terms unchanged |
| S23 | EUR 6 monthly automatic budget | Second EUR 4 lunch needs a tap for `monthly_cap` alone; the manual payment adds no automatic usage |
| S24 | Offer replaced before the runner step | Stale mandate evidence invalidated; the EUR 8 proposal waits for a device signature — nothing is sent |
| S25 | Second lunch without subsidy | EUR 9 fully personal is Confirm; the EUR 13 variant is Exception; the first purchase is never repriced |
| S26 | Dispute on a completed automatic purchase | Each share returns to its original payer; the monthly booking is released exactly once |
| S27 | Blocked merchant selected | `proposal_rejected: blocked_merchant`; the prior proposal is retained; nothing is paid |
| S28 | Route without mandate capability | Confirm `psp_unsupported`; a device signature is required |

Fixture values: the employer cap of EUR 7.67 is the 2026 German ceiling for a tax-advantaged meal subsidy (Sachbezugswert EUR 4.57 + EUR 3.10), modelled as one subsidised meal per working day. The EUR 3,000 individual holding limit is illustrative only; the ECB has not fixed it.

## Relation to agent commerce protocols

The coordinator does not implement any agent protocol. Its authority objects are designed to map onto them, mainly onto AP2 (Agent Payments Protocol), whose mandates solve the same problem for a single payer.

| Coordinator | Closest protocol concept | Gap |
|---|---|---|
| `PayerApproval`, bound to one proposal version and its exact terms | AP2 closed Checkout and Payment Mandates, bound by `checkout_hash` (human present) | None in principle; signed with Ed25519 over canonical JSON; not SD-JWT |
| `EmployerMandate`: caps per purchase and per day, eligible merchants, validity, revocation | AP2 open mandate with Mandate Constraints (autonomous) | AP2 has no notion of a second payer's authority contributing to someone else's purchase |
| `EmployeeMandate`: standing terms — automatic per-purchase/monthly limits, trusted/blocked merchants, expiry, revocation | AP2 open mandate with Mandate Constraints (autonomous payments) | An exception acknowledgment binding one over-limit purchase to a terms revision has no AP2 counterpart we know of |
| Two contributions, one purchase state | None | AP2 binds one mandate to one payment method; split funding and agent-to-agent delegation are outside its scope |
| Recheck of employer authority at initiation | AP2 constraint evaluation by the credential provider | Who evaluates the employer's mandate in a digital euro payment (employer's PSP, employee's PSP, app) is an open question |
| Agent reads the remaining benefit but cannot spend it | PAP (Personal Agent Protocol) OAuth scopes: read-only versus write account access | PAP payments are announced but not yet specified |
| Offer discovery and checkout | UCP (Universal Commerce Protocol), ACP (Agentic Commerce Protocol) | Out of scope for this coordinator |
| Digital euro as funding source | AP2 Payment Instrument extension point | No digital euro instrument type defined |

A natural extension is a co-funding Mandate Constraint: a reference to the co-payer's mandate, its maximum share, and the rule that the purchase completes only when both authorities hold.

## Backend adapters

The coordinator reaches settlement only through `SettlementBackend` (`src/settlement/backend.ts`): `submit`, `status` and `refund`, all async. `MockBackend` implements it here. An ECB adapter implements the same interface in a separate private repository, tags its events `ECB_API`, and proves itself with the same contract suite the mock passes:

    import { settlementBackendContract } from '<path to this repo>/test/contract/settlement-backend.contract.ts';
    settlementBackendContract('ECB adapter', () => ({ backend, payeeId, payers, /* fault controls if the environment offers them */ }));

Cases that need a fault control the environment lacks are skipped and reported as `not tested`.

## Limits and next steps

- Backend semantics are assumptions (spec version `mock-3`). Group assembly for per-PSP initiation is a mock hypothesis; mandate-capable routing (`supportsMandatePayments`) is a trusted fixture flag, not provider evidence. The real multi-payer API, its atomicity, expiry, retry and return behaviour are unknown until the ECB test environment is available. The ECB adapter implements `SettlementBackend`, passes the contract suite and tags its events `ECB_API`.
- Online payments only. Offline digital euro payments are out of scope.
- No live AI. The AI presenter artifact is a scripted synthetic presenter (`pnpm presenter`, [docs/presenter-comparison.md](docs/presenter-comparison.md)): deterministic fixtures, not model reasoning. The agent handle can only discover, evaluate, select and explain — approvals, submission, standing-terms changes and disputes stay on the trusted user-flow and runner handles, and agents never call the coordinator's approval or submission functions.

## Docs

| Doc | Content |
|---|---|
| [docs/experiment-protocol.md](docs/experiment-protocol.md) | Research questions, state and authority model, acceptance matrix, findings table, AI presenter artifact |
| [docs/presenter-comparison.md](docs/presenter-comparison.md) | Generated presenter comparison: four records, conversations, evidence references and limits |
| [docs/field-map.md](docs/field-map.md) | Which party sees which field, and why |
| [docs/initiation-model.md](docs/initiation-model.md) | Per-payer PSP initiation: mock hypothesis and questions for the ECB test environment |
| [docs/agent-protocols.md](docs/agent-protocols.md) | AP2, UCP, ACP and PAP, and the co-funding gap |
| [docs/backlog.md](docs/backlog.md) | Known defects and planned work |
| [docs/references/](docs/references/README.md) | Public ECB call documents used as reference |
