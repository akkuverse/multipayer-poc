# Coordinator-Owned Purchase Store Implementation Plan

> **For agentic workers:** Use an available task-by-task execution workflow when implementation is requested. Steps use checkbox (`- [ ]`) syntax for tracking. This plan does not authorize implementation, delegation, commits or publication by itself.

**Goal:** Make the coordinator the sole owner of live purchase records: one store, ids in and read-only views out, a single write path for `proposal` and `state`, and eager per-payer indexing — so callers can no longer mutate coordinator state, the trace can never drift from the record, and split purchases are indexed like benefit purchases.

**Architecture:** `src/core/coordinator.ts` keeps the mutation and authorization seam. A `purchases: Map<purchaseId, Purchase>` owns every record; a tiny `live-view.ts` module produces memoized deep-read-only proxy views. Two private functions, `commitProposal` and `transition`, are the only places `rec.proposal` and `rec.state` are written; `adopt` handles insertion. `byPayer` replaces `openEmployeePurchases` and indexes every payer of every open purchase.

**Tech Stack:** Existing Node.js >= 23.6, native TypeScript stripping, `node:test`, pnpm; no new dependencies, build step, network or real data.

**Source of truth:** The reviewed "Coordinator-owned purchase store" spec (conversation-supplied), amended by the design decisions in the Contract choices section below. Where this plan and the spec text conflict, this plan states the decision explicitly.

**Status:** Not started; per-task progress is tracked by the checkboxes below.

---

## Execution rules and dependency order

This is one coordinated refactor, not independent plans for a store, a state machine and an API migration. Execute tasks in the listed order. Each task must leave the full suite green before moving on. Task 5 is an intentional coordinated interface migration; do not land its coordinator signature changes separately from its consumer/test migrations.

```text
1. Store, live view, duplicate_purchase
2. transition() + states table + state events everywhere
3. commitProposal() + no-draft adoption
4. byPayer index + openFor()
5. Public API → purchaseId + consumer migration
6. Invariant and lint tests
7. Regenerated comparison and backlog
```

Use `rtk` for shell commands. Each task supplies its exact focused test command; full validation uses the existing package scripts. Establish the baseline with `rtk pnpm test` before implementation; record existing failures separately. Do not add TypeScript, a test library or other dependencies. These are future execution commands, not checks claimed to have run during planning.

Use a failing behavioral case before changing its implementation, then rerun its owner and direct consumers. Node test files are the correct tooling here. The trace is evidence: task 2 deliberately *adds* `state` events; regenerate golden output only in task 7.

After each task, inspect `rtk git diff --check`. Use a coherent task-sized checkpoint when the execution workflow calls for commits; never combine unrelated pre-existing changes. No task writes a private ECB adapter.

## File ownership

| File | Intended responsibility |
| --- | --- |
| `src/core/coordinator.ts` | Store, `get`/`view`/`openFor`, `adopt`/`transition`/`commitProposal`, id-based public API, all mutation and authorization orchestration. |
| `src/core/live-view.ts` (new) | Deep read-only proxy views over purchase records, `unwrapView` for snapshot/clone sites. Plain-data records only. |
| `src/core/states.ts` (new) | The reachable-transition table (`TRANSITIONS`, `ADOPTABLE`, `canTransition`). Pure data plus the check. |
| `src/core/types.ts` | `DeepReadonly<T>` and `PurchaseView = DeepReadonly<Purchase>`. `PurchaseState` unchanged (`draft` stays a reachable state). |
| `src/core/views.ts` | `payerView`/`payeeView`/`sponsorView` accept `PurchaseView` (records remain assignable to it). |
| `src/presenter/session.ts` | Retains `purchaseId` + a created flag; reads through `view()`; passes ids to the coordinator; `snapshot()` still returns a detached `Purchase`. |
| `src/presenter/journeys.ts` | No signature changes expected — it consumes `userFlow`/`snapshot()`/event seqs, all preserved. |
| `src/presenter/fixtures.ts` | Holds purchaseId strings only; change only if a call-site migration requires it. |
| `src/scenarios.ts` | `lunch()` and scenario `run()` return `PurchaseView`; `approveAs` signs from a view and calls `approve(id, …)`. |
| `src/evidence/run-record.ts` | `recordRun` unchanged — it already receives a detached `Purchase` from `snapshot()`. |
| `test/` | All suites migrate from `p` to `view(id)` + id arguments; `test/purchase-store.test.ts` (new) owns the store, invariant and lint coverage. |
| `docs/presenter-comparison.md` | Regenerated once in task 7 (`rtk pnpm --silent presenter --markdown`). |
| `docs/backlog.md` | One entry recording this refactor. |

Keep `execOwners`, `benefitHeld` ownership and the ledger's `reserve` collision check unchanged: `duplicate_purchase` dedupes only within one coordinator, and two coordinators may still share one backend (B12 stays guarded).

## Contract choices used by the tasks

1. **`view(id): PurchaseView` is a live deep read-only proxy**, not a frozen copy. Reads always reflect the record; every `set`/`deleteProperty`/`defineProperty`/`setPrototypeOf` throws `TypeError('purchase view is read-only')`. Memoized per record so `view(id) === view(id)` and nested identity is stable (`v.legs === v.legs`). The wrapper asserts each reached value is primitive, plain object or array — it throws loudly if a `Map`, `Set`, `Date` or class instance ever enters `Purchase` (proxied `Map`/`Set` methods fail on incompatible receivers, so they must never reach a caller silently). `structuredClone(proxy)` throws `DataCloneError`: sites needing a detached copy call `structuredClone(unwrapView(v))`, where `unwrapView` maps a proxy back to its record via an internal `WeakMap`.
2. **`transition()` emits a `state` event for every state change**, including insertion (`adopt`) and open-state moves. Insertion logs `{ to, reason }` with no `from`. No-op transitions emit nothing; `derive()` keeps its `recovery_required` outstanding-amount re-report as an explicit `this.log('state', { from, to, outstandingCents })` — a re-report, not a transition. `cancel()`'s old `cancelled_before_submission` event becomes `state { to: 'cancelled', reason: 'cancelled_before_submission' }` (no consumer outside the coordinator reads that event name); `fail()`'s `state` event gains `from`. This is a deliberate trace change: digests shift, the comparison document is regenerated in task 7.
3. **`commitProposal(seedOrRec, next, cause, benefitCtx?)` owns the record's whole per-commit tail**, including creation, so the `proposal` event's `state` field is always the post-commit state:

   ```text
   signature: commitProposal(
     rec: Purchase | { purchaseId: string; benefit?: BenefitTerms },
     next: Omit<Proposal, 'version'>,
     cause: 'proposed' | 'split' | 'offer_changed',
     benefitCtx?: { scope: VerifiedAuthority; record: Signed<EmployeeMandate> | undefined;
                    assessment: EmployeeAssessment; ineligibleReason?: string },
   ): Purchase   // the record — callers never keep it across the public seam

   0. for a seed: materialise the record literal here
      ({ ...seed, authorizations: [], legs: [], returnStatus: 'none' }) —
      proposal and state are written only below, inside this function
   1. validate next (non-empty merchantId; positive-int totalCents; ≥1 share;
      non-negative-int amounts/fees; share amounts sum to totalCents)
   2. rec.proposal = { ...next, shares cloned, version: (rec.proposal?.version ?? 0) + 1 }
   3. drop every authorization, logging approval_invalidated per entry
   4. benefitCtx only: set employeeAssessment, log auth_zone, noteMandateExpiry,
      recordMandateAuthorization when Auto and no employee authorization exists
   5. derive open state via the approvers check → adopt() or transition()
   6. log 'proposal' { purchaseId, version, merchantId, totalCents, shares,
      ineligibleReason?, state, cause }
   7. rebuild byPayer entries for rec
   ```

   `benefitCtx` is computed by the caller *before* the commit, because the blocked check must throw before any mutation ("rejection preserves the prior proposal"). Splits pass no `benefitCtx`. The spec's fourth cause `'repriced'` has no producer — `reprice` is removed; add it only if a repricing path appears. The shared helper `prepareBenefitProposal(terms, scope, merchantId, totalCents, exclude?: Purchase)` returns `{ shares, ineligibleReason, assessment, record }`; `exclude` covers both the ledger reservation (`exclude.purchaseId`) and the autopay booking (`excludeOwner`) — `propose` passes none (a fresh purchase holds neither), `changeOffer` passes the purchase.
4. **`adopt(rec, to, reason)` is the insertion path**: asserts the id is absent, assigns `rec.state`, inserts into `purchases`, logs `state { to, reason }` (no `from`). `byPayer` indexing is *not* here — `commitProposal` step 7 rebuilds entries for adopted and existing records alike, keeping exactly two index write points (contract 7). `ADOPTABLE = ['awaiting_approvals', 'ready']` — no purchase is ever adopted in `draft`. The `version: 0` skeleton is gone; `'draft'` remains a reachable state via `refreshAuth`'s blocked path and stays in `PurchaseState`.
5. **A rejected proposal still logs `proposal_rejected`** (today's behavior at `reprice`'s blocked check). The spec's "leaves nothing behind" covers the *store*: no record, no `byPayer` entry, no `proposal` event. The rejection itself stays evidence.
6. **`propose` computes the benefit split before any record exists**: `resolveBenefit` already takes `BenefitTerms`, not a purchase, so `propose` dup-checks, builds the terms inline, calls `prepareBenefitProposal`, throws (after `proposal_rejected`) on Blocked, then calls `commitProposal({ purchaseId, benefit: terms }, next, 'proposed', ctx)`. `changeOffer` keeps its OPEN guard and the retained-employer-share precheck exactly where they are, then calls `prepareBenefitProposal(…, exclude: rec)` and `commitProposal(rec, next, 'offer_changed', ctx)`.
7. **`byPayer` is written at exactly two points**: `commitProposal` step 7 rebuilds the purchase's entries from current share `payerId`s (handles the employer payer appearing/disappearing on reprice), and `transition` removes all of the purchase's entries when `to` is non-OPEN. Entries therefore exist exactly while a purchase is open. `openFor(payerId)` returns insertion-ordered `purchaseId[]`.
8. **`TRANSITIONS` enumerates reachable pairs** in `src/core/states.ts`:

   ```text
   draft:              → awaiting_approvals, ready, failed, cancelled
   awaiting_approvals: → draft, ready, failed, cancelled
   ready:              → draft, awaiting_approvals, pending, completed,
                         failed, recovery_required, cancelled
   pending:            → completed, failed, recovery_required, cancelled
   recovery_required:  → cancelled
   completed/failed/cancelled: → (terminal)
   ```

   `derive()` can legally jump `ready → completed` (all legs settle in one pass) and `pending → cancelled` (rejected+returned mix). `completed` is terminal here because `reconcile` only queries `unknown` legs and `resubmit` is state-gated — a settled leg can never be reported `unknown` by the current call paths; if a future adapter produces one, `illegal_transition` is the correct loud failure rather than a silent completed→pending downgrade. The table is permissive over *reachable* pairs, not per-cause. Illegal `from → to` throws `illegal_transition`.
9. **Public API takes ids**: `propose`/`proposeSplit → purchaseId`; `approve`, `submit`, `resubmit`, `reconcile`, `recover`, `refund`, `dispute`, `cancel`, `changeOffer`, `refreshAuthorization`, `assess`, `authorizationCurrentlyValid`, `outstandingCents` all take `purchaseId` first. `get(id)` is `private` and returns the record — a record never crosses the seam (verified by the task-6 lint). `authorizationCurrentlyValid` accepts a `DeepReadonly<Authorization>` (view-extracted); internals compare fields, never identity — checked: `authorizationRefusal` reads basis/payload fields only. `inFlight`, `deferredRefresh`, `refreshFailures` rekey to `purchaseId`; `execOwners` stays `Map<execRef, Purchase>` (internal).
10. **`snapshot()` keeps returning a detached `Purchase`**: `requirePurchase()` returns the live view; the snapshot impl returns `structuredClone(unwrapView(view))` — `run()`/`evidenceSince` clone it again, harmlessly. `presenter-session.test.ts` mutates a snapshot to prove detachment, and `recordRun`'s signature is unchanged.
11. **`adopt` event order**: within `commitProposal`, creation emits `auth_zone`/`approval_recorded` (Auto path) *before* the `state` insertion event and the `proposal` event — matching today's order plus the added `state` event, so the trace delta is strictly additive.

## Task 1: Store, live view and duplicate_purchase

**Files:** Create `src/core/live-view.ts`, `test/purchase-store.test.ts`. Modify `src/core/coordinator.ts`, `src/core/types.ts`.

**Contract protected:** The coordinator owns every live purchase record; callers can never obtain it. A reused `purchaseId` is refused before any state or trace change (B12's class of bug closes at the entry door instead of being survived downstream).

- [x] Write failing cases in `test/purchase-store.test.ts`: `propose` with an existing id throws `duplicate_purchase` and appends no trace events; `proposeSplit` same; `view(id)` reads current fields and reflects later mutations; every write shape throws (`v.state =`, `v.legs.push`, `v.legs[0].status =`, `delete v.state`); `view(id) === view(id)`; `assert.deepEqual(view, plainLiteral)` works; `view('nope')` throws `unknown_purchase`; `structuredClone(unwrapView(v))` returns a mutable plain copy that no longer tracks the record.
- [x] Run `rtk pnpm exec node --test test/purchase-store.test.ts`; establish the new failures.
- [x] Implement `live-view.ts`: a `readonlyView(rec)` deep proxy — `get` wraps results through a shared `seen: WeakMap` (stable nested identity, cycles-safe); `set`/`deleteProperty`/`defineProperty`/`setPrototypeOf` throw; a `proxy→target` `WeakMap` backs `unwrapView`. Assert plain-data values at wrap time (throw on `Map`/`Set`/`Date`/class instances) so a non-plain `Purchase` field fails loudly at the view, not inside a caller.
- [x] In `Coordinator`: add `private readonly purchases = new Map<string, Purchase>()`, `private readonly viewCache = new WeakMap<Purchase, Purchase>()`, `private get(id)`, `view(id)` (memoized proxy typed `PurchaseView`). `propose`/`proposeSplit` throw `duplicate_purchase` when `purchases.has(input.purchaseId)`, then `purchases.set` **at the existing success point** — for `propose` that is after `reprice` returns (where `openEmployeePurchases` registers today), so a rejected proposal leaves no record; for `proposeSplit` it is just before the `proposal` log. **Signatures unchanged this task**: they still return `p`. `openFor` lands in task 4.
- [x] Add `DeepReadonly`/`PurchaseView` to `types.ts`.
- [ ] Re-run the focused suite plus `rtk pnpm test`. All existing tests pass: the store is additive, callers still hold the record.

## Task 2: `transition()` and the states table

**Files:** Create `src/core/states.ts`. Modify `src/core/coordinator.ts`, `test/purchase-store.test.ts`.

**Contract protected:** `rec.state` has exactly one writer, every move is trace-visible, and unreachable moves are refused. The added `state` events are deliberate evidence, not drift.

- [x] Write failing cases: a unit test over `states.ts` (`canTransition` true for every table pair, false for `completed → cancelled`, `pending → draft`, `draft → pending`); a fold test asserting that replaying `state` events for a purchase id yields `view(id).state` after a propose→approve→submit→reconcile run; a test that `approve`'s `awaiting_approvals → ready` now emits `state`.
- [x] Implement `states.ts` per contract 8 (`TRANSITIONS`, `ADOPTABLE`, `canTransition(from, to)`).
- [x] Implement `private transition(rec, to, detail?)`: same-state → return early (no log); `canTransition` false → throw `illegal_transition`; assign `rec.state`; log `state { from, to, ...detail, now }` in the same step. In this task it also clears nothing index-related — `byPayer` arrives in task 4.
- [x] Route every `p.state =` site through it: `refreshAuth` (blocked → `'draft'` with `reason: 'blocked_merchant'`; open-state re-derive), `approve` (→ready), `derive` (computed state; keep the recovery re-report as the explicit log in contract 2), `cancel` (→cancelled with `reason: 'cancelled_before_submission'`), `fail` (→failed with `reason` + `shares`). `fail` still sets `rec.reason`; `cancel` sets no reason (matching today). Both still release benefit around the call.
- [x] Interim note: `propose`'s v0 skeleton still exists this task, so `reprice`'s `draft → awaiting_approvals` move emits a `state` event until task 3 removes the skeleton — accepted interim noise.
- [x] Re-run `rtk pnpm test`. Expect failures only where a test pins the old trace shape (anything asserting `cancelled_before_submission` as an event name, `state`-event counts, or a proposal being a purchase's first event) — update those assertions to the new shape. Scan `test/` for `event === 'state'` and `cancelled_before_submission`. `foldEvents` in the property test folds only named events and tolerates additions.

## Task 3: `commitProposal()` and no-draft adoption

**Files:** Modify `src/core/coordinator.ts`, `test/purchase-store.test.ts`.

**Contract protected:** `rec.proposal` has exactly one writer; versions start at 1 and bump by 1; a rejected proposal leaves no record; the `proposal` event's `state` is always the post-commit state.

- [x] Write failing cases: `propose` yields `view(id).proposal.version === 1` with no observable `version: 0` moment; a blocked-merchant `propose` throws, `view(id)` throws `unknown_purchase`, and the trace gained only `proposal_rejected`; `proposeSplit` emits `state`(created→awaiting_approvals) then `proposal` in that order; `changeOffer` bumps to v2, emits `approval_invalidated` before the new `state`/`proposal`, and carries `cause: 'offer_changed'`.
- [x] Implement `commitProposal` per contract 3 (seed-or-record signature, record literal materialised inside), `adopt` per contract 4, and `prepareBenefitProposal` per contract 3's tail note.
- [x] Rewrite `propose` and `proposeSplit` per contract 6 — both still return `p` this task.
- [x] Remove `reprice`; `changeOffer` keeps its OPEN guard and retained-employer-share precheck, then delegates as in contract 6.
- [x] `refreshAuth`'s tail (state re-derive) stays — it uses `transition`, not `commitProposal`. Its `rec.reason` assignments and `authorizations` pruning are outside the two write paths by design.
- [x] Re-run `rtk pnpm test`.

## Task 4: `byPayer` index and `openFor`

**Files:** Modify `src/core/coordinator.ts`, `test/purchase-store.test.ts`.

**Contract protected:** `openFor(payer)` returns exactly the open purchases where `payer` holds a share — benefit and split alike — and standing-terms publication reaches every open purchase of the employee.

- [x] Write failing cases: `proposeSplit` with three payers indexes all three; `openFor(employer)` lists benefit purchases carrying an employer share; after `submit`, `openFor` returns `[]` for every payer; a `changeOffer` that drops the employer share removes the employer's index entry; publishing new employee terms refreshes an open benefit purchase *and* visits a split where the employee is a payer (assert the split is unchanged — `refreshAuth` no-ops on `!benefit` — while the benefit purchase's assessment actually refreshes).
- [x] Implement `byPayer: Map<string, Set<string>>`, the commitProposal step-7 rebuild, the non-OPEN cleanup inside `transition`, and `openFor(payerId): string[]`.
- [x] Replace `openEmployeePurchases` in `onStandingTermsAccepted` with `openFor(employeeId)` → `get(id)` per id; drop the lazy-delete branch (the index is eager); `deferredRefresh` becomes `Set<string>` of ids, resolved through `get` in `drainDeferredRefresh`.
- [x] Rekey `inFlight` (`WeakSet<Purchase>` → `Set<string>`) and `refreshFailures` (`WeakMap` → `Map<string, string>`) to `purchaseId`; `withOperation`/`requireIdle` still take the record but key on `rec.purchaseId`. `execOwners` keeps storing records.
- [x] Re-run `rtk pnpm test`.

## Task 5: Public API → `purchaseId` (coordinated cutover)

**Files:** `src/core/coordinator.ts`, `src/presenter/session.ts`, `src/scenarios.ts`, `src/core/views.ts`, `src/presenter/fixtures.ts` (only if a call site requires it), all of `test/` (notably `invariants.property.test.ts`, `coordinator-concurrency.test.ts`, `split.test.ts`, `employee-mandate.test.ts`).

**Contract protected:** No caller can hold, forge or mutate coordinator state — including splicing a `Signed<PayerApproval>` from another purchase into `authorizations` (the binding checks signature/version/expiry but `authorizationRefusal` never compares `payload.purchaseId`; only `approve()` did). Signing helpers read views; approval binding still checks `payload.purchaseId === id`. One task lands the whole migration — the suite is green only when every consumer moves together.

- [ ] Flip the signatures in contract 9; each public method starts `const p = this.get(purchaseId)`. `propose`/`proposeSplit` return `input.purchaseId`.
- [ ] Migrate `session.ts`: keep `purchaseId` + `let created = false` (set when `propose` resolves); `requirePurchase()` throws `no_proposal` before creation, else returns `coordinator.view(purchaseId)`; every coordinator call passes `purchaseId`; `approveOnDevice` callback type becomes `(p: PurchaseView, choice?) => void`; `snapshot()` impl returns `structuredClone(unwrapView(requirePurchase()))` — `run()` would `DataCloneError` on a raw view; `presenterView()` binds `const p = coordinator.view(purchaseId)` once per call.
- [ ] Migrate `scenarios.ts`: `lunch()` returns `w.coordinator.view(w.coordinator.propose(input))`; `expectState`, `check({ w, p })`, `approveAs` take `PurchaseView` and pass `p.purchaseId` to mutators.
- [ ] Migrate `views.ts` params to `PurchaseView` (records still assignable).
- [ ] Migrate tests with the same two patterns: `const p = c.view(c.propose(input))` then `c.submit(p.purchaseId, …)`. **Two non-mechanical sites**: `invariants.property.test.ts` `observeFirstHandoffs` must store `structuredClone(unwrapView(p))` — it needs a point-in-time clone, and a live view would mutate under it; anywhere else calling `structuredClone(p)` gets the same treatment. `assess`, `authorizationCurrentlyValid`, `outstandingCents` switch to id-first calls.
- [ ] Run `rtk pnpm test`, then `rtk pnpm scenarios`. Zero behavioral changes to scenario outcomes; only trace content (task 2/3 additions) differs from the pre-refactor baseline.

## Task 6: Invariant and lint tests

**Files:** Extend `test/purchase-store.test.ts`.

**Contract protected:** The spec's §3 invariants are executable, and the single-write-path rule is enforced mechanically, not by review discipline.

- [ ] Trace fold invariants (run over a mixed benefit+split scenario): latest `proposal` event per purchase matches `view(id).proposal` (version, merchant, total, `role:amount` share encoding — the event encodes shares as strings); folded `state` events equal `view(id).state`, including the insertion event.
- [ ] Version monotonicity: across `changeOffer` chains, versions are 1,2,3… and only `commitProposal` writes them (the lint below guards the writer).
- [ ] Lint test: read `src/core/coordinator.ts` source; assert every `\.(state|proposal)\s*=` assignment sits inside `transition`/`adopt`/`commitProposal` bodies (slice by method boundaries), and no non-`private` method declares a `Purchase` return type. This is a source-scan test like the mermaid label tests, not a new tool.
- [ ] `openFor` exactness and duplicate-id cases land here if not already covered in tasks 1/4.
- [ ] Run `rtk pnpm test`.

## Task 7: Regenerated comparison and backlog

**Files:** `docs/presenter-comparison.md`, `docs/backlog.md`.

- [ ] Regenerate the comparison document (`rtk pnpm --silent presenter --markdown > docs/presenter-comparison.md`); review the diff — it must contain only digest/seq changes and the added `state` events, no outcome changes.
- [ ] Add a `docs/backlog.md` entry describing the refactor (store, single write path, `byPayer`, id-based API), noting `execOwners`/ledger-ownership defenses remain for cross-coordinator backend sharing, and noting the explorer §5 items (Purchase store card part, `state`-event trace note, proposal-drawer `cause`) as follow-up for the explorer artifact.
- [ ] Final full validation: `rtk pnpm test`, `rtk pnpm scenarios`, `rtk pnpm --silent findings`, `rtk git diff --check`.

## Assumptions

- Live read-only view chosen over frozen deep copy (user decision): ~40 lines of Proxy machinery is accepted to keep the ~900 read-after-mutation call sites essentially unchanged.
- `state` events emitted on every transition including insertion (user decision): trace content and digests intentionally change; `presenter-comparison.md` is regenerated, not hand-edited.
- `proposal_rejected` is kept as evidence on refused proposals; "leaves nothing behind" applies to store state (contract 5).
- The explorer artifact (`Multipayer Explorer v10.dc.html`) is **not in this repository** — this checkout contains only its design docs (`docs/superpowers/specs/interactive-explorer-design*.md`) and a static explainer `docs/index.html`. The spec's §5 explorer edits are deferred to wherever that artifact lives and are tracked via the backlog entry in task 7, not implemented here.
- The `superpowers:writing-plans` skill is not installed in this environment; the repo's established `docs/superpowers/plans/` format was applied directly.

## Resolved decisions

- **`Purchase` keeps its name** — no `PurchaseRecord` rename. The seam is enforced mechanically (`private get`, `view()` as the only accessor, the task-6 lint), and `Purchase`/`PurchaseView` correctly reads as one entity with two mutability facets. Record the contract in `Purchase`'s JSDoc in `types.ts` during task 1: "internal coordinator record; never returned across the public seam — callers receive `PurchaseView`".
