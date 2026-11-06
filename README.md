# Akku multi-payer PoC (mock)

[![ci](https://github.com/akkuverse/multipayer-poc/actions/workflows/ci.yml/badge.svg)](https://github.com/akkuverse/multipayer-poc/actions/workflows/ci.yml)

A small, deterministic coordinator for one merchant purchase funded by two payers with **different authority**: an employee approves a specific purchase — by device signature, a signed one-off exception, or automatically under signed standing terms — and an employer contributes under a separate, bounded mandate. Reference case: a EUR 13 lunch = EUR 8 employee + EUR 5 employer. The same coordinator also runs peer bill splits, group purchases and one-payer, multi-payee orders (S03, S12, S18).

Built by Akku Labs to explore co-funded payments in the digital euro, in particular multi-payer transactions. Not affiliated with or endorsed by the European Central Bank.

**This is not a payment system and not the ECB API.** Everything runs locally against simulated settlement ledgers with synthetic actors and amounts. No personal data, no real money, no network calls, no dependencies.

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
| Settlement orchestrator | `src/settlement/orchestrator.ts` | Owns execution, reconciliation and compensation behind `submit`/`reconcile`/`returnSettled`: stable per-leg operation identities, authoritative status under original keys, explicit unwind and compensate scheduling |
| Payer providers | `src/settlement/provider.ts` | Provider-owned bank books: authority acceptance, holds, funding waterfall and reverse waterfall, fees on confirmed settlement, returns; receive-only `ShopProvider` per payee |
| Digital-euro ledger | `src/settlement/digital-euro-ledger.ts` | Pseudonymous holdings, holding limits, holds that expire, same-ledger atomic groups, funding/defunding transit |
| Interbank transfer | `src/settlement/interbank-transfer.ts` | Individual bank transfers; a debit is tracked transit until the destination credit confirms |
| Operations and types | `src/settlement/operations.ts`, `src/settlement/types.ts` | Immutable keyed operation records that refuse changed terms; frozen intents, leg identities and detached settlement snapshots |
| Benefit ledger | `src/core/ledger.ts` | Per-mandate, per-day reservations: reserved at submission, consumed on completion, released on failure or return |
| Signed authority | `src/core/signing.ts`, `src/core/authority.ts` | Ed25519 over canonical JSON for approvals, exception acknowledgments, employee standing terms and employer mandates; the one `AuthorityRegistry` publishes and stores both record kinds — publication is the trust decision — and audits the publish/reject events itself |
| Privacy and party views | `src/core/privacy.ts` | The signed disclosure profiles (`employer_benefit_v1`, `split_bill_v1`), known-group agreements, and what payer, payee and employer may see ([field map](docs/field-map.md)) |
| Evidence | `src/evidence/run-record.ts`, `src/evidence/findings.ts` | Run records with fixture and spec version and a trace digest; findings table generated from runs |
| Diagrams | `src/evidence/mermaid.ts` | Trace to Mermaid sequence diagram |
| Scenarios | `src/scenarios.ts` | Synthetic fixtures and the 36 scenarios below |
| Presenter | `src/presenter/journeys.ts`, `src/presenter/session.ts`, `src/presenter/fixtures.ts` | Scripted synthetic presenter: a restricted agent handle (discover/evaluate/select/explain under a signed grant) beside trusted user-flow and runner handles (approve/submit/reconcile/dispute; the runner's deterministic no-tap step); evidence-backed conversation and comparison records |
| UCP-shaped catalog | `src/ucp/catalog.ts` | Simulated `catalog.search`/`catalog.lookup` over the fixture catalog: request objects in, UCP-shaped response envelopes out — vocabulary contact, not conformance ([contact report](docs/ucp-contact.md)) |

Purchase states: `draft → awaiting_approvals → ready → pending → completed`, with `failed` (nothing committed), `compensated` (a committed leg was automatically returned after a sibling failed, once principal, fees and cleanup confirm), `cancelled` (all obligations resolved) and `recovery_required` (some money committed, purchase not complete; the outstanding amount stays visible). Returns carry their own status and never erase the original settlement.

Concurrent calls: while `submit`, `resubmit`, `reconcile`, `recover`, `refund` or `dispute` is running on a purchase, that coordinator refuses every other mutation of the same purchase with `operation_in_progress`. This includes `approve`, `changeOffer`, `refreshAuthorization` and `cancel`. The refusal changes nothing and is not queued; after the original call settles, the normal state and authority rules apply. Other purchases and read-only projections remain available. A running call is separate from purchase state: the state still reflects the last applied outcome, so it alone cannot say whether a new action is allowed. The presenter retains its stricter session-wide guard.

The simulation supports two settlement modes so the same fixtures can be compared:

- `atomic`: every leg's hold is reserved first, then legs commit — bank legs in proposal order, then the digital-euro legs as one same-ledger group. A conclusive leg failure unwinds the rest: holds release, funding restores, and any committed leg is compensated. This is **reserve-all with compensation across two ledgers**, not a guarantee of cross-ledger atomic settlement — the digital-euro group itself is ledger-local and is a LOCAL mock assumption.
- `independent`: the two-payment baseline available on existing rails. Each leg reserves and commits separately; a settled leg survives a sibling's failure and is returned through the explicit recovery path.

Fees are modelled per payer on top of the merchant total and are zero in every fixture. A provider holds principal plus fee at reserve and charges the fee only once settlement is confirmed. Automatic compensation returns principal and fee; ordinary refunds, disputes and explicit recovery return principal only — an unreturned fee stays visible as `retainedFeeCents` in the settlement snapshot and `unreturnedFeeCents` on the payer's bill. Time runs on a simulated-minute clock: thirty real-world seconds is `0.5` simulated minutes, and a hold expires at `reserveAt + 0.5`.

Every trace event is tagged `LOCAL`. `ECB_API` is reserved for events observed in the ECB test environment; a local pass is never reported as an ECB capability. Cross-party money calls also emit a `<op>_requested` event immediately before dispatch, pairing request and outcome by operation key with `parent` links forming the call tree — see spec §7.2 in [docs/updated-provider-pay-sys.md](docs/updated-provider-pay-sys.md).

## Employee standing terms and automatic payment

Each employee may publish one set of signed standing terms (`AuthorityRegistry.publishEmployeeMandate`); only a next version signed by the employee replaces them. Every employer-benefit purchase carries a deterministic assessment — `Blocked`, `Exception`, `Auto` or `Confirm`, with a single reason — computed from the verified terms, the fee-inclusive employee debit, the merchant, monthly usage, the clock and route capability. `quote()` returns the same assessment read-only: no purchase, reservation or trace.

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
| S01 | Both authorities hold | EUR 8 on digital euro + EUR 5 by bank, reserved then committed; the merchant's EUR 13 lands in its linked bank account (zero holding) |
| S02 | Employee holds EUR 3 | Reverse waterfall funds the remaining EUR 5 of the employee share during reserve |
| S03 | Bill split, three colleagues, EUR 40 | EUR 13.34 + 13.33 + 13.33 commit as one digital-euro group |
| S04 | Employer's provider down at submission (atomic) | Employee's hold waits; `pending`, then completed when the provider recovers |
| S05 | Two-payment baseline, employee leg fails | `recovery_required` with EUR 5 outstanding, then employer refunded and `cancelled` |
| S06 | Same failure, atomic settlement | `failed`, no money moved, nothing to recover |
| S07 | Partial failure, returns unsupported | Stays `recovery_required`; EUR 5 exposure remains visible |
| S08 | Employer mandate expires before initiation | `failed`, zero executions, employee share still EUR 8 |
| S09 | Offer changes to EUR 14 (EUR 9 personal) | Approval invalidated; renewed approval on a EUR 13 alternative completes |
| S10 | Second lunch on the same working day | No employer share; EUR 13 exceeds the standing EUR 8 maximum — `awaiting_approvals` for a signed exception |
| S11 | Employer's provider declines | Reserve refused; holds and funding unwind; employee never charged EUR 13 |
| S12 | Group gift, one colleague's provider declines | Digital-euro group rejected; nobody covers the missing share |
| S13 | Employer's provider unavailable, then declines (atomic) | Employee hold released and funding restored; `failed` |
| S14 | Same, two-payment baseline | EUR 8 settles alone, `recovery_required`, returned, `cancelled` |
| S15 | Request retried with same keys | One execution per leg |
| S16 | Response lost | `pending`, retry deduplicated, status query resolves to `completed` |
| S17 | Full refund near the holding limit | EUR 8 back to employee (excess waterfalls to bank), EUR 5 back to employer |
| S18 | One payer, two payees (restaurant + delivery platform) | One approval, two payee legs with their own references |
| S19 | EUR 4 employee debit inside standing terms | Auto; the trusted runner settles with no tap and issues exactly one receipt |
| S20 | Benefit-eligible but untrusted merchant | Confirm `untrusted_merchant`; a device signature settles; no terms change is published |
| S21 | EUR 8 debit over the EUR 6 automatic limit | Confirm `over_auto_limit`; a device signature settles it |
| S22 | EUR 11 over the EUR 10 standing maximum | Plain signature refused; a signed EUR 1 exception pays once; standing terms unchanged |
| S23 | EUR 6 monthly automatic budget | Second EUR 4 lunch needs a tap for `monthly_cap` alone; the manual payment adds no automatic usage |
| S24 | Offer replaced before the runner step | Stale mandate evidence invalidated; the EUR 8 proposal waits for a device signature — nothing is sent |
| S25 | Second lunch without subsidy | EUR 9 fully personal is Confirm; the EUR 13 variant is Exception; the first purchase is never repriced |
| S26 | Blocked merchant selected | `proposal_rejected: blocked_merchant`; the prior proposal is retained; nothing is paid |
| S27 | Route without mandate capability | Confirm `psp_unsupported`; a device signature is required |
| S28 | Dispute on a completed automatic purchase | Each share returns to its original payer; the monthly booking is released exactly once |
| S29 | `on_ready` proposal | The approval is the last tap: the coordinator self-submits at ready (`trigger: 'auto'`) |
| S30 | Proposal signed under an unregistered key | `bad_signature`; no purchase is created |
| S31 | Split proposed by a non-payer | `proposer_not_a_payer`; the purchaseId stays free for a valid proposal |
| S32 | Cancellation signed by a non-payer | `not_authorized`; a payer's signature cancels the purchase |
| S33 | Refund request signed by a payer | `not_authorized` with the `dispute()` hint; the payee's request returns every share |
| S34 | Submit request signed by a non-payer under `on_request` | `not_authorized`; a payer's signed request completes (`trigger: 'request'`) |
| S35 | Hold expires before commit | No merchant payment ever committed; holds release and funding cleanup confirms before `failed` |
| S36 | Bank share commits, digital-euro group fails | The bank share is compensated; `compensated` once principal, fees and cleanup confirm |

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

## Settlement adapters

The coordinator reaches settlement only through the orchestrator's three-operation interface — `submit`, `reconcile` and `returnSettled` over a frozen `SettlementIntent`, answered by detached `SettlementSnapshot`s (`src/settlement/orchestrator.ts`, `src/settlement/types.ts`). The in-memory provider and ledger modules in `src/settlement/` implement it here. An adapter for a real settlement environment implements the same interface in a separate private repository, tags its observed events `ECB_API`, and proves itself with the same contract suite the in-memory orchestrator passes:

    import { settlementOrchestratorContract } from '<path to this repo>/test/contract/settlement-orchestrator.contract.ts';
    settlementOrchestratorContract('ECB adapter', () => ({ orchestrator, intent, audit, /* fault controls if the environment offers them */ }));

Cases that need a fault control the environment lacks are skipped and reported as `not tested`. The interface is versioned (`settlement-ledgers-1`); compatibility with a future environment is versioned, not assumed.

## Limits and next steps

- Settlement semantics are assumptions (spec version `settlement-ledgers-1`, fixtures `2026.11-5`). Provider acceptance, hold guarantees and expiry, same-ledger atomic groups, funding conservation and transit handling are LOCAL mock assumptions; mandate-capable routing (`supportsMandatePayments`) is a trusted fixture flag, not provider evidence. The real multi-payer API, its atomicity, expiry, retry and return behaviour are unknown until the ECB test environment is available. When it is, an adapter built in its own repository must implement the orchestrator interface, pass the same contract suite and tag its observed events `ECB_API`; no such adapter exists in this repository.
- Online payments only. Offline digital euro payments are out of scope.
- No live AI. The AI presenter artifact is a scripted synthetic presenter (`pnpm presenter`, [docs/presenter-comparison.md](docs/presenter-comparison.md)): deterministic fixtures, not model reasoning. The agent handle can only discover, evaluate, select and explain — approvals, submission, standing-terms changes and disputes stay on the trusted user-flow and runner handles, and agents never call the coordinator's approval or submission functions.

## Explorer

`explorer/` is a static site that runs this coordinator's scenarios in the browser: an externally authored `.dc.html` UI drives a browser core generated from `src/`, with repo-maintained holds/replay scheduling and a conformance check page.

```bash
pnpm explorer:serve        # http://127.0.0.1:8080 — opens multipayer-explorer.dc.html
pnpm explorer:build        # regenerate app/core/, app/manifest.json, app/build.json (pinned Node)
pnpm explorer:check        # read-only Node conformance gate
```

Generated artifacts are committed and never hand-edited; ownership, generation provenance, the import policy and the separate browser/integration acceptance boundaries are documented in [explorer/README.md](explorer/README.md). The imported UI runtime loads React/Babel from a CDN at runtime — see that README before publishing.

## Docs

| Doc | Content |
|---|---|
| [docs/updated-provider-pay-sys.md](docs/updated-provider-pay-sys.md) | Settlement ledgers spec (revised draft): where money lives, module ownership, flow, open questions |
| [docs/experiment-protocol.md](docs/experiment-protocol.md) | Research questions, state and authority model, acceptance matrix, findings table, AI presenter artifact |
| [docs/presenter-comparison.md](docs/presenter-comparison.md) | Generated presenter comparison: four records, conversations, evidence references and limits |
| [docs/field-map.md](docs/field-map.md) | Which party sees which field, and why |
| [docs/initiation-model.md](docs/initiation-model.md) | Per-payer PSP initiation: mock hypothesis and questions for the ECB test environment |
| [docs/agent-protocols.md](docs/agent-protocols.md) | AP2, UCP, ACP and PAP, and the co-funding gap |
| [docs/research/2026-11-05-private-allocation-verification.md](docs/research/2026-11-05-private-allocation-verification.md) | Deferred research: selective allocation verification, Merkle proofs, zero-knowledge proofs and relevance to the experiment |
| [docs/backlog.md](docs/backlog.md) | Known defects and planned work |
| [explorer/README.md](explorer/README.md) | Explorer site: ownership, generation, acceptance boundaries, import policy, vendor audit |
| [docs/references/](docs/references/README.md) | Public ECB call documents used as reference |
