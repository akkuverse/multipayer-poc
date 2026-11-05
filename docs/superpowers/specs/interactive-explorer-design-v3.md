# Interactive Explorer Design v3

## Review Notes

- Source version reviewed: `docs/superpowers/specs/interactive-explorer-design-v2.md`.
- What changed: architecture flipped from *baked replay* to **in-browser execution of the real `src/` modules**. The bake step now emits type-stripped `.js` plus metadata instead of run records; the sandbox becomes genuinely free-form; guided mode becomes "live drive + scripted hints"; presenter journeys run live then replay their trace step-wise.
- Why it changed: verified the browser blockers are narrow — (a) `.ts` files need type stripping (Node's own `module.stripTypeScriptTypes()` does it with zero deps; `.ts` would be served as `video/mp2t` on Pages so emit `.js` and rewrite `./x.ts` specifiers); (b) the only Node-specific import in the runtime graph is `node:crypto` in `src/core/signing.ts` and `src/evidence/run-record.ts` — browser import maps can alias it to a ~80-line shim over `@noble/curves`/`@noble/hashes`, and sync `verify()`/`sign()` match the coordinator's synchronous call sites (WebCrypto's async API could not); (c) `Buffer` usage confined to `signing.ts`, covered by a mini-shim. Ed25519 is deterministic and `keyPairFromSeed` = sha256(seed), so browser traces can be **byte-identical** to `pnpm scenarios` — enabling a live digest-match fidelity check.
- Code areas checked: `grep` over `src/` for `node:` imports, `Buffer`, `process.` — confirmed only `signing.ts`, `run-record.ts`, `cli.ts` (not shipped). Re-verified `world()`/`lunch()`/`approveAs()`/`advance()` in `src/scenarios.ts`, `createPresenterSession`/`runPresenterJourneys` in `src/presenter/`, `DiscoveryPrefs` shape, `Trace`/`recordRun`/`toMermaid`, and `docs/index.html` conventions.
- Remaining uncertainties: whether the designer vendors noble's ESM directly (no package manager) or uses a bundler; whether `scenario.run()` should later be refactored into exported step lists (optional `src/` change, not required); visual system.

## Spec

Design spec for a graphical, turn-based explorer of the multi-payer PoC, to be
handed to a designer. One visual component per code component; the 18 scenarios
and two presenter journeys as guided walkthroughs; a real sandbox; a technical
info modal on every component and action. Written 16 October 2026.

### Decisions taken

| # | Decision | Consequence |
|---|---|---|
| D1 | **Static hosting** (GitHub Pages, under `docs/`) | No server. All execution is client-side. |
| D2 | **In-browser execution of the real code** | The page ships `src/` modules type-stripped to `.js`; `node:crypto` is aliased to a noble-backed shim via import map. Nothing is re-implemented — the emitted files are build artifacts of the real source. |
| D3 | **Guided scenarios + real sandbox** | Guided = live drive with a "suggested next action" hint; sandbox = free composition of fixtures and actions. Presenter journeys run live, then replay step-wise. |
| D4 | **Two UI-layer deps: `@noble/curves`, `@noble/hashes`** | Confined to `docs/app/` (shim only); `src/` stays zero-dependency. Noble is audited pure-JS Ed25519/SHA-256 with sync APIs — chosen over WebCrypto because `verifyPayload`/`signPayload` are synchronous and called inside sync coordinator paths. **Requires the repo owner's sign-off as a dependency exception;** noble has zero transitive deps so vendoring ESM files avoids a package manager entirely. Designer may add further UI-only deps (React/D3) at their discretion — anything that builds to static files works on Pages. |

### Honesty and repo constraints the UI must inherit

Hard requirements, not suggestions:

- The backend visual is labelled **"Mock backend (spec `mock-2`)"** — never "ECB", never styled to imply ECB affiliation. A local pass is never presented as an ECB capability; the ECB column reads `not tested`.
- Every trace event keeps its `origin` tag (`LOCAL`; `ECB_API` is reserved and never appears yet).
- The agent component can never approve, submit or move money: its buttons are `discover`, `evaluate`, `selectOffer`, `explain` only. Approval and submission live on the employee's trusted device actions.
- Amounts are integer cents rendered `EUR x.xx` (`euro()` convention).
- Synthetic-data banner: no personal data, no real money, no network calls.
- The benefit rule stays visibly *in the application*, never in the money.
- **Fidelity note, displayed in the page footer/About modal:** "Running the actual coordinator code from this repository — types stripped; signatures computed by an equivalent audited Ed25519 implementation (`@noble/curves`)."

### Build pipeline (what the implementer builds first)

`pnpm ui-data` (new script, zero deps) emits `docs/app/`:

1. **Stripped modules** — for every runtime file under `src/` (everything except `cli.ts`): run `module.stripTypeScriptTypes()`, rewrite import specifiers `./x.ts` → `./x.js`, emit to `docs/app/core/` mirroring the `src/` layout. These are generated artifacts — never hand-edited; CI fails if `pnpm ui-data` produces a diff.
2. **`shims/node-crypto.js`** — hand-written, committed (not emitted). Implements exactly the used surface: `createHash` (→ `@noble/hashes` sha256, sync), `createPrivateKey`/`createPublicKey`/`sign`/`verify` (→ `@noble/curves` ed25519), and the `Buffer` slice `signing.ts` uses (`from(hex)`, `concat`, `toString('base64url')`). Models `KeyObject` as a raw-bytes wrapper. Fidelity test in CI: a browser-run signature must equal the Node one for the fixed fixture seeds.
3. **Import map** — in `docs/app/index.html`: `{ "imports": { "node:crypto": "./shims/node-crypto.js" } }`. That's the only module rewrite needed.
4. **`manifest.json`** — `{ manifestVersion, components: ComponentRegistry, scenarios: ScenarioMeta[], bakedDigests: { scenarioId → traceDigest } }`. `ScenarioMeta` = `id`, `title`, `question` (Q1–Q3), `responsibility`, setup-card fixture deltas (account/mandate overrides, faults, PSP availability, `refundsSupported`, initiation mode, start `t`). Component registry: component id → display name, `src/` path, GitHub blob URL (`https://github.com/akkuverse/multipayer-poc/blob/main/<path>`), modal content key.
5. **Baked baseline** (optional but recommended): the 18 `RunRecord`s + 4 `PresenterRecord`s as JSON — used by the **digest-match fidelity check** and compare mode even if live execution is disabled or fails.

### Screen layout

Three regions:

1. **Component map** (canvas): one node per component below, edges for real interactions. Node card = display name, one-line responsibility, live state chips (purchase state, leg statuses, balances, mandate fields, PSP `available`), action buttons, ⓘ modal button, GitHub source link.
2. **Trace rail** (right/bottom): the shared audit log appended per action, rendered like `Trace.format()` — `seq [ORIGIN] actor event detail`. `state` events render as transition chips (`from → to`, `outstandingCents`). Click any row → modal with raw `detail` JSON + a one-line "why this exists".
3. **Scenario bar** (top): scenario picker (S01–S18 + presenter journeys + "free play"), turn counter, expected-outcome card (`title` + `responsibility`), final **observed/pass|fail** (the scenario's real `check()` runs live at the end) next to the run's live `traceDigest` vs the baked digest — both shown, "match ✓" badge.

Plus a persistent **world clock** widget (`t`, day `⌊t/1440⌋` per `dayOf()`):
S06, S11, S17 and the presenter journey are unintelligible without seeing time
advance; "advance clock" is itself a user action.

### Interaction model — live drive, three modes

- **Guided**: pick a scenario → its setup card applies the fixture deltas to a
  fresh in-browser `world()` → the walkthrough script highlights the next
  suggested action (employee: "Approve proposal v1"; coordinator: "Submit
  atomic"; world: "advance clock to t=20"). The user can always deviate —
  guided mode is just a hint layer over the sandbox. The scenario's `check()`
  and `recordRun` run live at the end.
- **Sandbox / free play**: a fresh `world()` plus a fixture lab (account
  fields, mandate fields, fault toggles, PSP availability, `refundsSupported`,
  initiation mode, clock). Every component's buttons work; the system enforces
  the real guards.
- **Replay**: presenter journeys (and optionally any scenario) execute silently
  in a fresh world, then the user steps the resulting trace event-by-event
  forward/back — best for scripted narratives like `changed-offer`.

**Turn mechanics**: a turn = one action call + the trace events it appends
(the UI snapshots `trace.events.length` before/after and animates the range).
Packets travel the real call path per event (coordinator → `psp-employer-1` →
backend → reply), coloured by origin. **Disabled buttons mirror the real
guards**: `approve` only in `awaiting_approvals`, `submit` only in `ready`,
`recover` only in `recovery_required`, `changeOffer`/`reviseInstruction`/`cancel`
only in OPEN (`draft`/`awaiting_approvals`/`ready`), `resubmit` only in
`pending`/`completed`; presenter adds `in_flight` and grant-denial states.
Disabled tooltips cite the guard — the main teaching device. `advance()` is a
clock turn that can cascade into state changes (expired offer, expired mandate,
expired assembly group).

### Component inventory (node → file → actions → modal)

| Node | Source | State chips | Actions | Modal content |
|---|---|---|---|---|
| **Employee device** (`employee-1`) | `src/presenter/session.ts` (`PresenterUserFlow`), `src/scenarios.ts` (`approveAs`) | deCents + linked bank; fixed instruction; approvals with `bindsCurrentProposal`/`currentlyValid` | "Approve proposal v{N}" (`expectedProposalVersion` — device confirms exact shown terms), "Choose offer", "Confirm payment", "Revise instruction" (OPEN only), "Cancel" | `PayerApproval` binding fields; AP2 checkout/payment-mandate analogy (README table); Ed25519 over canonical JSON; instruction set by a person, enforced by deterministic code, never raisable by AI. |
| **Agent presenter** (`agent-1`) | `src/presenter/session.ts` (`AgentPresenter`), `journeys.ts`, `fixtures.ts` | grant validity, capabilities `discover/propose/explain`, denials | Prompt chips mapped **honestly** to `DiscoveryPrefs {tags, maxWalkingMinutes}` + the fixed instruction — e.g. "Vegetarian lunch within 10 min, max EUR 8 personal" (`PRESENTER_SCRIPT.preferences`); then `discover`/`evaluate`/`selectOffer`/`explain` | `AgentGrant` binding (session/purchase/principal/agent, capabilities, expiry); what the handle can never do; denials append `presenter_denied` events; AP2/PAP mapping (`docs/agent-protocols.md`); "scripted synthetic presenter — not a live model". **Copy constraint:** prefs support positive tag filters + walking cap only — no price bound (that's the fixed instruction) and no negation ("without fish" isn't expressible without a code change). |
| **Employer** (`employer-1`) | `src/core/authority.ts`, `src/scenarios.ts` (`updateMandate`) | latest mandate fields + `revoked`; sponsor view | "Publish mandate" (`maxPerPurchaseCents`, `maxPerDayCents`, `maxPurchasesPerDay`, `eligibleMerchants`, validity window), "Revoke mandate" | `EmployerMandate` as the authority boundary — policy match ≠ spending authority; bounded pre-approved co-payment. AP2 open-mandate-with-constraints analogy + co-funding gap. EUR 7.67/one-meal-a-day fixture + tax caveat (`docs/backlog.md`). |
| **Merchants** (`merchant-a/b/c`; `platform-1` payee-only) | `src/presenter/fixtures.ts`, `src/ucp/catalog.ts` | offer list; payee balance (linked bank only) | Browse catalogue (`CatalogOffer` cards); "serve `catalog.search`/`catalog.lookup`" toggles UCP-envelope view of the same offers | UCP honesty notes (`src/ucp/catalog.ts` header + `docs/ucp-contact.md`): reading `2026-08-25`, capability ids `dev.ucp.shopping.catalog.search/.lookup`, "vocabulary contact, not conformance", synthesized description, implicit-EUR gap, `availability` meaning mismatch, `messages[]` for unsupported inputs. ucp.dev link. |
| **Coordinator** | `src/core/coordinator.ts` | purchase state; legs (status, `idempotencyKey`, `authorityRef`); `outstandingCents` | "Submit (atomic/independent)", "Resubmit same keys", "Reconcile", "Recover", "Refund", "Change offer", "Cancel" — enabled only where the code allows | Derived state machine (`draft→awaiting_approvals→ready→pending→completed` + `failed`/`cancelled`/`recovery_required`); the four invariants; `idempotencyKey = purchaseId:v{N}:{role}`; `quote` vs `propose` (projection vs purchase). |
| **Benefit policy** | `src/core/policy.ts` | `employerCents`/`employeeCents`/`withinInstruction`/`ineligibleReason` | — (pure function; modal opens from proposal events) | `evaluateBenefit` rules; employee always covers the remainder; fail-closed malformed limit; "conditions live in the application, never in the money". |
| **Benefit ledger** | `src/core/ledger.ts` | reservation per purchaseId (`reserved`/`consumed`), day bucket | — | Reserve at submission / consume on completion / release on failure; two in-flight purchases can't draw the same benefit; day = 1440 minutes. |
| **Key + mandate registries** | `src/core/signing.ts`, `src/core/authority.ts` | `keyId → holder` bindings; latest mandate per ref | — | Registry stores signed payloads unverified — publish is not the trust decision; mandate ref bound to first publisher. |
| **PSPs** (`psp-*`) | `src/settlement/psp.ts` | `available` per PSP | "Take offline / bring back" | Per-payer initiation; `PspUnavailableError` = conclusive non-submission; assembly hypothesis → `docs/initiation-model.md`. |
| **Mock backend** | `src/settlement/mock-backend.ts`, `src/settlement/backend.ts` | per-account balances + `reverseWaterfall`; `specVersion mock-2`; assembling groups + `assembleBy`; `refundsSupported` | Fault toggles (`none`/`decline`/`timeout_then_settle`/`timeout_then_reject`); "refunds unsupported"; assembly deadline | The big honesty modal: "**not the ECB API**"; `SettlementBackend` port + contract suite the private ECB adapter must pass; holding limits / waterfalls / zero business holdings as publicly described features; **"the digital euro would never be programmable money"** → ECB FAQ Q20 (`ecb.europa.eu/euro/digital_euro/faqs/html/ecb.faq_digital_euro.en.html`) + speech `ecb.sp251117_1`; assembly deadline = mock hypothesis. |
| **Trace / run record** | `src/evidence/*` | seq count, origin, live digest vs baked | "Show Mermaid" (`toMermaid` runs live), "Download run JSON" | Origin taxonomy; digest reproducibility + the **live digest-match badge**; findings table (`observed/pass` … `not tested`). |
| **Party views** (overlay) | `src/core/privacy.ts`, `docs/field-map.md` | — | "See as: employee / merchant / employer" | Field map: employer never sees total or employee share; payee sees receipts not payers. Disable "employer" on non-benefit purchases (`viewFor` sponsor facet refuses) and "payer" for the employer (`viewFor` payer facet refuses for mandate payers). |

### Info modals — general pattern

Title, plain-language paragraph, authoritative detail (object fields or a
mini-diagram), links: GitHub source file, matching `docs/*.md`, external spec
(ucp.dev / ECB FAQ / ap2-protocol.org). Every modal ends with a **"local mock"**
tag and, where relevant, `not tested on ECB`.

### Fidelity story (feature worth surfacing in the UI)

Ed25519 is deterministic and fixture keys come from fixed seeds, so a browser
run should reproduce `pnpm scenarios` byte-for-byte. The UI recomputes
`traceDigest` live and compares it to the baked baseline: a green
**"digest matches `pnpm`"** badge is the page's own proof it runs the real
code. CI additionally runs one headless browser run and diffs digests.

### Out of scope

- A live LLM behind the agent presenter — it stays "scripted synthetic".
- Any network calls; ECB adapter lives in a private repo anyway.
- Re-implementing coordinator logic in the UI — the whole point is the real modules.
- ECB branding; licence undecided (no LICENSE file).

### File/link map for the designer

| UI element | Links to |
|---|---|
| Coordinator node | `src/core/coordinator.ts` |
| Policy, ledger, signing/authority, views nodes | `src/core/policy.ts`, `ledger.ts`, `signing.ts`, `authority.ts`, `privacy.ts` |
| Backend + port + PSP nodes | `src/settlement/mock-backend.ts`, `backend.ts`, `psp.ts` |
| Agent + user flow | `src/presenter/session.ts`, `journeys.ts`, `fixtures.ts` |
| Merchant catalogues | `src/presenter/fixtures.ts` + `src/ucp/catalog.ts` |
| Modals' doc links | `docs/experiment-protocol.md`, `field-map.md`, `initiation-model.md`, `agent-protocols.md`, `ucp-contact.md`, `presenter-comparison.md`, `backlog.md` |
| External | ucp.dev; ECB FAQ Q20 + `ecb.sp251117_1`; ap2-protocol.org |
| Emitted artifacts | `docs/app/core/**.js` (generated), `docs/app/shims/node-crypto.js` (hand-written), `docs/app/manifest.json` |
