# Akku multi-payer PoC (mock)

A small, deterministic coordinator for one merchant purchase funded by two payers with **different authority**: an employee approves a specific purchase, and an employer contributes under a separate, bounded mandate. Reference case: a EUR 13 lunch = EUR 8 employee + EUR 5 employer.

Built by Akku Labs to explore co-funded payments in the digital euro, in particular multi-payer transactions. Not affiliated with or endorsed by the European Central Bank.

**This is not a payment system and not the ECB API.** Everything runs locally against a mock backend with synthetic actors and amounts. No personal data, no real money, no network calls, no dependencies.

## Run

Requires Node.js 23.6 or later (native TypeScript type stripping).

```bash
pnpm test            # or: node --test "test/**/*.test.ts"
pnpm scenarios       # print every scenario trace and final balances
pnpm scenarios S03   # one scenario
pnpm scenarios --json > runs.json   # run records: run id, fixture and spec version, trace digest, events
pnpm findings          # findings table from fresh runs (ECB column: not tested)
```

## What it models

| Part | File | Responsibility |
|---|---|---|
| Policy | `src/policy.ts` | Deterministic eligibility and split. Benefit conditions live in the application, never in the money |
| Coordinator | `src/coordinator.ts` | Proposal versions, approval binding, authority recheck at initiation, idempotent submission, state derivation, reconciliation, recovery, refunds |
| Mock backend | `src/mock-backend.ts` | Holding limits, waterfall and reverse waterfall, zero holding for businesses, idempotency keys, fault injection (decline, lost response), refunds to the original payer |
| Scenarios | `src/scenarios.ts` | Synthetic fixtures and the 12 scenarios below |

Purchase states: `draft → awaiting_approvals → ready → pending → completed`, with `failed` (nothing committed), `cancelled` (all obligations resolved) and `recovery_required` (some money committed, purchase not complete; the outstanding amount stays visible). Returns carry their own status and never erase the original settlement.

The mock supports two settlement modes so the same fixtures can be compared:

- `atomic`: all contributions settle as one transaction or none do (the call's description of multi-payer).
- `independent`: the two-payment baseline available on existing rails, where one leg can settle while the other fails.

Every trace event is tagged `LOCAL`. `ECB_API` is reserved for events observed in the ECB test environment; a local pass is never reported as an ECB capability.

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
| S11 | Second lunch on the same working day | No employer share; EUR 13 exceeds the EUR 8 instruction, so draft |
| S12 | Employer's PSP declines | Atomic group rejected; employee never charged EUR 13 |

Fixture values: the employer cap of EUR 7.67 is the 2026 German ceiling for a tax-advantaged meal subsidy (Sachbezugswert EUR 4.57 + EUR 3.10), modelled as one subsidised meal per working day. The EUR 3,000 individual holding limit is illustrative only; the ECB has not fixed it.

## Relation to agent commerce protocols

The coordinator does not implement any agent protocol. Its authority objects are designed to map onto them, mainly onto AP2 (Agent Payments Protocol), whose mandates solve the same problem for a single payer.

| Coordinator | Closest protocol concept | Gap |
|---|---|---|
| `PayerApproval`, bound to one proposal version and its exact terms | AP2 closed Checkout and Payment Mandates, bound by `checkout_hash` (human present) | None in principle; here it is an unsigned object |
| `EmployerMandate`: caps per purchase and per day, eligible merchants, validity, revocation | AP2 open mandate with Mandate Constraints (autonomous) | AP2 has no notion of a second payer's authority contributing to someone else's purchase |
| Two contributions, one purchase state | None | AP2 binds one mandate to one payment method; split funding and agent-to-agent delegation are outside its scope |
| Recheck of employer authority at initiation | AP2 constraint evaluation by the credential provider | Who evaluates the employer's mandate in a digital euro payment (employer's PSP, employee's PSP, app) is an open question |
| Agent reads the remaining benefit but cannot spend it | PAP (Personal Agent Protocol) OAuth scopes: read-only versus write account access | PAP payments are announced but not yet specified |
| Offer discovery and checkout | UCP (Universal Commerce Protocol), ACP (Agentic Commerce Protocol) | Out of scope for this coordinator |
| Digital euro as funding source | AP2 Payment Instrument extension point | No digital euro instrument type defined |

A natural extension is a co-funding Mandate Constraint: a reference to the co-payer's mandate, its maximum share, and the rule that the purchase completes only when both authorities hold.

## Backend adapters

The coordinator reaches settlement only through `SettlementBackend` (`src/backend.ts`): `submit`, `status` and `refund`, all async. `MockBackend` implements it here. An ECB adapter implements the same interface in a separate private repository, tags its events `ECB_API`, and proves itself with the same contract suite the mock passes:

    import { settlementBackendContract } from '<path to this repo>/test/contract/settlement-backend.contract.ts';
    settlementBackendContract('ECB adapter', () => ({ backend, payeeId, payers, /* fault controls if the environment offers them */ }));

Cases that need a fault control the environment lacks are skipped and reported as `not tested`.

## Limits and next steps

- Backend semantics are assumptions. The real multi-payer API, its atomicity, expiry, retry and return behaviour are unknown until the ECB test environment is available. The planned ECB adapter replaces `MockBackend` behind the same calls and tags its events `ECB_API`.
- Online payments only. Offline digital euro payments are out of scope.
- No AI. The AI-in-payments exploration uses a separate synthetic trace; agents never call the coordinator's approval or submission functions.

## Docs

| Doc | Content |
|---|---|
| [docs/experiment-protocol.md](docs/experiment-protocol.md) | Research questions, state and authority model, acceptance matrix, findings table, AI presenter trace |
| [docs/agent-protocols.md](docs/agent-protocols.md) | AP2, UCP, ACP and PAP, and the co-funding gap |
| [docs/backlog.md](docs/backlog.md) | Known defects and planned work |
| [docs/references/](docs/references/README.md) | Public ECB call documents used as reference |
