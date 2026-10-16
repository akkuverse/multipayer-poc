# Interactive Explorer Design v2

## Review Notes

- Source version reviewed: `docs/superpowers/specs/interactive-explorer-design.md` (v1, ephemeral draft context: user decisions D1 static hosting, D2 guided+sandbox, D3 designer's-choice deps).
- What changed: corrected the example agent prompt (DiscoveryPrefs has only `tags` + `maxWalkingMinutes` — no price bound, no exclusion filter); corrected "check() description" → check *result* with `title`/`responsibility` as text; added the shared world clock as a first-class widget (drives S06, S17, journey offer expiry); added view-toggle disabling rules (`sponsorView`/`payerView` throw when inapplicable); marked `platform-1` as payee-only; Mermaid output is baked, not ported; specified bake/CI placement and a manifest schema version.
- Why it changed: each fix is a direct consequence of reading `src/` — the spec must not promise the designer UI affordances the code cannot produce, and must not hide mechanics (time, view restrictions) that the scenarios depend on.
- Code areas checked: `src/core/{coordinator,policy,ledger,authority,signing,views,types}.ts`, `src/settlement/{backend,mock-backend,psp}.ts`, `src/presenter/{session,journeys,fixtures}.ts`, `src/ucp/catalog.ts`, `src/evidence/{trace,run-record,findings,mermaid}.ts`, `src/scenarios.ts`, `src/cli.ts`, `docs/{experiment-protocol,field-map,initiation-model,agent-protocols,ucp-contact,backlog}.md`, `docs/index.html`, `.github/workflows/ci.yml`.
- Remaining uncertainties: where exactly the page is mounted (new `docs/app/` vs a section of `docs/index.html`); whether baked JSON is committed or produced by a Pages-deploy workflow; visual system beyond the tokens already in `docs/index.html`.

## Spec

Design spec for a graphical, turn-based explorer of the multi-payer PoC, to be
handed to a designer. It maps one visual component per code component, drives
the 18 scenarios and the two presenter journeys step by step, and gives every
component and action a technical info modal. Written 16 October 2026.

### Decisions taken (from the requester)

| # | Decision | Consequence |
|---|---|---|
| D1 | **Static hosting** (GitHub Pages, under `docs/`) | The coordinator cannot run in the visitor's browser: the modules are TypeScript stripped by Node at run time and use `node:crypto`. The UI replays **pre-computed runs** baked by a generator script. |
| D2 | **Guided scenarios + sandbox** | Guided = scripted turn lists per scenario. Sandbox on a static host = a baked **decision tree** (pre-computed alternative continuations), not arbitrary live composition. |
| D3 | **UI deps: designer's choice, vanilla preferred** | Anything that builds to static files works on Pages. Runtime code (`src/`) stays zero-dependency regardless; any UI toolchain lives in the UI layer only. |

### Honesty and repo constraints the UI must inherit

Every one of these is a hard requirement for the design, not a suggestion:

- The backend visual is labelled **"Mock backend (spec `mock-2`)"** — never "ECB", never styled to imply ECB affiliation. A local pass is never presented as an ECB capability; the ECB column reads `not tested`.
- Every trace event shown in the UI keeps its `origin` tag (`LOCAL`; `ECB_API` is reserved and simply never appears yet).
- The agent component can never approve, submit or move money: its buttons are `discover`, `evaluate`, `selectOffer`, `explain` only. Approval and submission live on the employee's trusted device actions.
- Amounts are integer cents rendered as `EUR x.xx` (`euro()` helper convention).
- Synthetic-data banner on the page: no personal data, no real money, no network calls.
- The benefit rule stays visibly *in the application*, never in the money — the "not programmable money" modal is where this is taught.

### Data pipeline (what the implementer builds first)

`pnpm ui-data` (new script, zero deps) writes `docs/app/data/`:

1. **Run records** — for each of S01–S18: `recordRun(runId, scenarioId, world, purchase)` JSON (already serialisable: `runId`, `fixtureVersion`, `backend {name, origin, specVersion}`, `result`, `traceDigest`, `events[]`).
2. **Presenter records** — `runPresenterJourneys(runId)` → the four `PresenterRecord`s (2 journeys × 2 modes) with conversations, claims and `eventSeqs` evidence anchors.
3. **Turn manifest** — per scenario, the scripted turn list binding *action labels* to *trace seq ranges*. Today each scenario's `run()` knows which call produced which events, so the generator wraps each call, records `trace.events.length` before/after, and emits `{ scenarioId, setup, turns: [{ id, actor, action, label, seqFrom, seqTo, clockAfter }] }`. A `manifestVersion` field bumps on schema change, matching the `specVersion`/`FIXTURE_VERSION` convention.
4. **Setup cards** — per scenario, the fixture deltas from `world()` defaults (account overrides, mandate overrides, `faults` entries, PSP availability, `refundsSupported`, initiation mode, clock position `t`), rendered before turn 1.
5. **Decision-tree branches** — for the sandbox: named bake points (e.g. "after approval of proposal v1") with each continuation baked as a separate run keyed by a stable branch id. New branch variants are just new bake-time runs over the real coordinator — cheap to add.
6. **Mermaid text** — `toMermaid(events)` baked per run into the manifest (do **not** port the renderer to JS; it would fork the source of truth).
7. **Component registry** — static JSON: component id, display name, source path, GitHub URL (`https://github.com/akkuverse/multipayer-poc/blob/main/<path>`), modal content references. Designer restyles; ids are stable.

Expected outcome per scenario: the manifest stores `title`, `question` (Q1–Q3
from `docs/experiment-protocol.md`), `responsibility`, and the `check()` *result*
(pass, or the failure string). `check()` itself is code, not prose — the prose
is `title` + `responsibility`.

Integrity: each baked record keeps `traceDigest` (SHA-256, 16 hex over
`JSON.stringify(events)` — byte-identical reproduction in the browser, so the
page can re-hash with WebCrypto and show "verified"). A "reproduce locally"
line links to `pnpm scenarios S03 --json`.

Placement: `docs/app/` (served by Pages alongside `index.html`) or a section of
the existing landing page — designer's call. Baked JSON is small and
deterministic: recommend committing it and adding a CI step that fails if
`pnpm ui-data` produces a diff, so the page can never drift from the code.

### Screen layout

Three regions:

1. **Component map** (main canvas): nodes for each component below, edges for
   real interactions. Each node card shows: display name, a one-line
   responsibility, live state chips (purchase state, leg statuses, balances,
   clock), its action buttons, an ⓘ button opening its modal, and a footer
   link to the source file on GitHub.
2. **Trace rail** (right side, or bottom on narrow screens): the shared audit
   log, appended per turn, in `seq [ORIGIN] actor event detail` form — the same
   columns `Trace.format()` prints. `state` events render specially (a state
   transition chip with `from → to` and `outstandingCents`). Clicking an event
   opens its explanation modal with the raw `detail` JSON.
3. **Scenario bar** (top): scenario picker (S01–S18 + presenter journeys),
   turn counter, expected-outcome card (`title` + `responsibility`), and at the
   end **observed/pass** or **observed/fail** next to the run's `traceDigest`.

Plus a persistent **world clock** widget (`t`, and day `⌊t/1440⌋` per
`dayOf()`): scenarios that hinge on time — mandate expiry (S06), offer
availability windows (presenter journey), the assembly deadline (S17), second
lunch same day (S11) — are unintelligible without it.

### Component inventory (node → file → actions → modal)

Names in `code` are real ids/files. Action labels are illustrative for the designer.

| Node | Source | State chips | Actions (buttons) | Modal content |
|---|---|---|---|---|
| **Employee device** (`employee-1`) | `src/presenter/session.ts` (`PresenterUserFlow`), `src/scenarios.ts` (`approveAs`) | own balance (deCents + linked bank), fixed instruction `employeeMaxCents`, recorded approvals with `bindsCurrentProposal`/`currentlyValid` | "Approve proposal v{N}" (takes `expectedProposalVersion` — the device confirms the exact shown terms), "Choose offer C instead", "Confirm payment", "Revise instruction" (`reviseInstruction`, OPEN states only), "Cancel" | What an approval binds: `PayerApproval` fields (purchaseId, proposalVersion, merchantId, totalCents, amountCents, feeCents, expiresAt) — the AP2 checkout/payment-mandate analogy from the README mapping table. Ed25519 over canonical JSON (`src/core/signing.ts`). The instruction is set once per session — a person sets it, deterministic code enforces it, no AI may raise it. |
| **Agent presenter** (`agent-1`) | `src/presenter/session.ts` (`AgentPresenter`), `src/presenter/journeys.ts`, `src/presenter/fixtures.ts` | grant validity, capabilities `discover/propose/explain`, denials counter | Pre-written prompt chips mapped **honestly** to `DiscoveryPrefs` = `{tags, maxWalkingMinutes}` plus the fixed instruction: e.g. "Vegetarian lunch within 10 min, max EUR 8 personal" (the real `PRESENTER_SCRIPT.preferences`). Then `discover` / `evaluate` / `selectOffer` / `explain` | The signed `AgentGrant`: session/purchase/principal/agent binding, capability list, expiry; what the handle can never do (approve, submit, reconcile, snapshot) — every denial appends a `presenter_denied` audit event. AP2/PAP read-vs-spend mapping from `docs/agent-protocols.md`. Labelled "scripted synthetic presenter — not a live model". **Constraint for prompt copy:** `DiscoveryPrefs` supports positive tag filters and a walking-time cap only — no price bound (the personal cap is the fixed instruction) and no negation ("without fish" is not expressible today; chips must phrase filters as inclusions, or the code needs a small extension). |
| **Employer** (`employer-1`) | `src/core/authority.ts` (`MandateRegistry`), `src/scenarios.ts` (`updateMandate`) | latest mandate fields + `revoked`; sponsor view projection | "Publish mandate" (fields: `maxPerPurchaseCents`, `maxPerDayCents`, `maxPurchasesPerDay`, `eligibleMerchants`, `validFrom`/`validUntil`), "Revoke mandate" | The `EmployerMandate` object as the authority boundary — a policy match alone is not spending authority; the employer pre-approves a bounded co-payment, not a purchase. AP2 open-mandate-with-constraints analogy; the co-funding gap note (`docs/agent-protocols.md`). The EUR 7.67 / one-meal-per-working-day fixture and its tax caveat (`docs/backlog.md` domain check). |
| **Merchants** (`merchant-a/b/c`; `platform-1` is payee-only, no catalogue) | `src/presenter/fixtures.ts` (`PRESENTER_CATALOG`), `src/ucp/catalog.ts` | per-merchant offer list, payee balance (linked bank only — zero holdings) | Browse catalogue (renders `CatalogOffer` cards: title, tags, price, availability window, source, walking minutes); "serve `catalog.search` / `catalog.lookup`" toggles the UCP-envelope view of the same offers | The UCP honesty notes from `src/ucp/catalog.ts` header + `docs/ucp-contact.md`: spec reading `2026-08-25` (Shopping vertical, catalog capability), capability ids `dev.ucp.shopping.catalog.search/.lookup`, "vocabulary contact, not conformance", synthesized description, implicit-EUR gap, `availability` meaning mismatch, `messages[]` for unsupported inputs. Link to ucp.dev. |
| **Coordinator** | `src/core/coordinator.ts` | purchase state chip (`draft → awaiting_approvals → ready → pending → completed` + `failed` / `cancelled` / `recovery_required`), legs with status + `idempotencyKey` + `authorityRef`, `outstandingCents` | (driven by other components' turns; as a node it exposes) "Reconcile (status queries)", "Recover", "Refund", "Resubmit same keys", "Cancel", "Change offer" — each enabled only in the states the code allows | The derived-state machine diagram; the four invariants (never complete without every leg settled; never shift a failed/expired share onto another payer; never retry with new idempotency keys; never treat a timeout as failure). `idempotencyKey = purchaseId:v{version}:{role}`. `propose`/`proposeSplit`/`quote` differences (quote is a projection that reserves nothing). |
| **Benefit policy** | `src/core/policy.ts` | evaluation result: `employerCents` / `employeeCents` / `withinInstruction` / `ineligibleReason` | — (pure function; its modal opens from the coordinator's proposal event) | `evaluateBenefit` rules: beneficiary, merchant eligibility, validity window, per-purchase cap, remaining daily budget, one meal/day; employee covers the remainder; fail-closed "malformed limit = 0". Key line: "benefit conditions live in the application, never in the money". |
| **Benefit ledger** | `src/core/ledger.ts` | reservation per purchaseId: `reserved` / `consumed`, day bucket | — | Reserve-at-submission / consume-on-completion / release-on-failure; why two in-flight purchases can't draw the same benefit; day = 1440 coordinator minutes. |
| **Key registry + mandate registry** | `src/core/signing.ts`, `src/core/authority.ts` | registered `keyId → holder` bindings; latest mandate per ref | — | Ed25519 over canonical JSON; registry stores signed payloads unverified — publish is not the trust decision; mandate ref bound to first publisher. |
| **PSPs** (`psp-employee-1`, `psp-employer-1`, …) | `src/settlement/psp.ts` | `available` flag per PSP | "Take PSP offline / bring back" (sandbox knob) | Per-payer initiation: each PSP submits only its own payer's leg; `PspUnavailableError` = conclusive non-submission; group-assembly hypothesis link to `docs/initiation-model.md`. |
| **Mock backend** | `src/settlement/mock-backend.ts`, `src/settlement/backend.ts` | per-account `deCents` / `holdingLimitCents` / `linkedBankCents` / `reverseWaterfall`; `specVersion mock-2`; assembling groups with `assembleBy` deadline; `refundsSupported` | Fault toggles per payer: `none` / `decline` / `timeout_then_settle` / `timeout_then_reject`; "refunds unsupported" toggle; settlement mode shown on submit (`atomic` vs `independent`); assembly deadline (5 min) | The big honesty modal: "This is a mock of what a simulated PSP might see — **not the ECB API**"; `SettlementBackend` port (`submit`/`status`/`refund`) and the contract suite an ECB adapter must pass in a private repo; holding limits / waterfall / reverse waterfall / zero-holding-for-businesses as publicly described design features; **"the digital euro would never be programmable money"** linking to the ECB FAQ (Q20, `https://www.ecb.europa.eu/euro/digital_euro/faqs/html/ecb.faq_digital_euro.en.html`) and speech `ecb.sp251117_1`; assembly deadline = mock hypothesis. |
| **Trace / run record** | `src/evidence/trace.ts`, `src/evidence/run-record.ts`, `src/evidence/findings.ts`, `src/evidence/mermaid.ts` | `seq`, origin tag, digest | "Show Mermaid" (baked text), "Download run JSON" | Origin taxonomy (`LOCAL` vs reserved `ECB_API`), digest reproducibility, findings table (`observed/pass` … `not tested`). |
| **Party views** (overlay, not a node) | `src/core/views.ts`, `docs/field-map.md` | — | "See as: employee / merchant / employer" toggle that re-renders the purchase through `payerView` / `payeeView` / `sponsorView` | The field map: employer never sees the total or the employee's share; payee sees what it received, not who paid. **Disabling rules:** `sponsorView` throws on non-benefit purchases and `payerView` throws for mandate-backed payers — disable "employer" on split scenarios (S13–S15) and "payer" for the employer everywhere. |

### Turn model (the "turn-based" mechanic)

- A **turn** = one user-invoked action + every trace event it appends
  (`seqFrom..seqTo` in the manifest). Example: clicking **Approve proposal v1**
  on the employee device plays `approval_recorded` and the `state` transition,
  animates a signature token from Employee → Coordinator, and updates the state
  chip.
- Between turns the diagram idles; the trace rail shows what just happened.
  Every event row is clickable → modal with the raw detail JSON and a one-line
  "why this exists" (e.g. `reverse_waterfall` → linked bank pulled EUR 5
  because holdings covered only EUR 3).
- **Availability mirrors the code**: buttons are disabled exactly where the
  coordinator would throw (`approve` only in `awaiting_approvals`, `submit`
  only in `ready`, `recover` only in `recovery_required`, `changeOffer` only in
  OPEN, …). A disabled button gets a tooltip citing the guard. This is the main
  teaching device. The presenter session adds two more visible gates: the
  `in_flight` guard (`operation_in_progress`) and grant checks (`presenter_denied`
  with a safe generic message).
- Message animation: per event, a packet travels along the edge for the real
  call path — e.g. `submit` in `per_payer_psp` mode shows coordinator →
  `psp-employer-1` → backend, and an `unknown` reply packet in return. Colour
  by origin (all `LOCAL` for now).
- **Clock turns**: `advance()` is itself a turn ("time passes to t=70") that
  moves the world clock widget and can trigger downstream state changes
  (expired offer, expired mandate, expired assembly group).

### Guided mode

Each scenario is a script of turns (baked manifest) preceded by its **setup
card** — e.g. S03: "employee holds EUR 3, reverse waterfall off, mode =
independent". The scenario's `responsibility` and `check()` result render in
the outcome card; the last turn shows the final state, `outstandingCents`,
balances diff, and pass/fail. Presenter journeys work identically, with
`presenter_message` events rendered as conversation bubbles on their turn
(each bubble keeps its `authority` class — `user_instruction`, `user_approval`,
`information_only`, `status_report` — as a badge).

### Sandbox on a static host (decision tree)

Since nothing executes client-side, the sandbox offers baked branches:

- **Decision points** marked on the turn rail — e.g. after "offer B prices
  EUR 14": `{choose C & re-approve}` (S07 path), `{raise instruction to EUR 9}`
  (a baked variant), `{cancel}`. Each choice splices in the matching baked
  continuation trace and re-bases seq numbers.
- **Fixture lab**: knobs that map onto existing baked variants — settlement
  mode (`S03`↔`S04`), PSP availability (`S17`/`S18`), mandate expiry (`S06`),
  employee balance + waterfall (`S02`/`S03`), refunds unsupported (`S05`),
  offer change (`S07`), second lunch (`S11`), PSP decline fault (`S12`),
  split / multi-payee / per-PSP initiation (`S13`–`S16`). Picking a combination
  that has a baked run loads it; uncovered combinations are listed honestly as
  "not baked — run locally with `pnpm scenarios`".
- **Compare mode**: open two baked runs of the same fixture side by side
  (S03 vs S04 is the flagship atomic-vs-independent comparison), trace rails
  aligned by event kind.

### Info modals — general pattern

Modal = title, plain-language paragraph, the authoritative detail (object
fields or a mini-diagram), "deeper" links: source file on GitHub, the matching
doc (`docs/*.md`), external reference where one exists (ucp.dev, the ECB FAQ,
AP2 spec). Every modal ends with a **"local mock" tag** and, where relevant,
the `not tested on ECB` line.

### Out of scope for v1

- Live coordinator in the browser (would need a JS port — forks the single
  source of truth) or any network calls.
- A live LLM behind the agent presenter; it stays "scripted synthetic".
- Arbitrary sandbox compositions (requires live execution; a `pnpm ui`-style
  local server via `node:http` is a possible later extension, stays zero-dep).
- Any ECB branding; licence remains undecided (no LICENSE file).

### File/link map for the designer

| UI element | Links to |
|---|---|
| Coordinator node | `src/core/coordinator.ts` on GitHub |
| Policy, ledger, signing/authority, views nodes | `src/core/policy.ts`, `ledger.ts`, `signing.ts`, `authority.ts`, `views.ts` |
| Backend + port + PSP nodes | `src/settlement/mock-backend.ts`, `backend.ts`, `psp.ts` |
| Agent + user flow | `src/presenter/session.ts`, `journeys.ts`, `fixtures.ts` |
| Merchant catalogues | `src/presenter/fixtures.ts` + `src/ucp/catalog.ts` |
| Modals' doc links | `docs/experiment-protocol.md`, `field-map.md`, `initiation-model.md`, `agent-protocols.md`, `ucp-contact.md`, `presenter-comparison.md`, `backlog.md` |
| External | ucp.dev; ECB digital-euro FAQ Q20 + `ecb.sp251117_1` speech; ap2-protocol.org |
