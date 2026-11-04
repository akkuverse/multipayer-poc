# Settlement Ledgers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document authorizes planning only; execution, delegation, commits and publication require the applicable session authorization.

**Goal:** Replace the single balance-owning backend with provider-owned books and explicit ledger-local settlement, preserving spending authority and recovery under uncertainty.

**Architecture:** A deep `SettlementOrchestrator` owns execution, reconciliation and compensation behind three operations. `Coordinator` retains signed requests, authority-budget admission and purchase lifecycle derivation. Concrete in-memory provider and ledger modules implement money movement behind internal seams; no remote adapter, dependency or speculative transport abstraction is introduced.

**Tech Stack:** Node.js >= 23.6, native TypeScript stripping, `node:test`, pnpm; zero added dependencies or build step.

**Spec:** [Settlement ledgers, revised draft](../../updated-provider-pay-sys.md). Read both documents before execution. Status: planned; no implementation performed.

## Global Constraints

- Synthetic data only: no personal data, no real money, no network calls.
- All amounts are integer euro cents.
- Every trace event carries its origin: local modules emit `LOCAL`; `ECB_API` is reserved for observed test-environment events. Same-ledger group atomicity and hold acceptance are LOCAL assumptions.
- Never complete a purchase unless every leg settled; never shift a failed or expired employer share onto the employee; never retry with new idempotency keys; never treat a timeout as failure.
- Deterministic code decides eligibility and amounts. Agents have no approval/submission handles.
- No ECB adapter or confidential contract implementation, institutional endorsement claims, LICENSE changes or new dependencies.
- Preserve live read-only purchase views, signed caller authorization, benefit ownership, monthly booking ownership and same-purchase operation guards.

## Review Focus

Each risk has a primary behavioral test owner below; these are gaps to close, not reasons to duplicate tests across layers.

1. A response is lost before the caller receives a reference: reconcile by stable key, including funding and return operations (Tasks 2–4).
2. One payer appears in several roles/payees or identifiers contain delimiters: operations must not alias (Tasks 1 and 4).
3. Authority changes during an asynchronous wait: unaccepted legs must recheck current authority; accepted holds retain their stated guarantee (Task 5).
4. Cleanup is still running after merchant exposure clears: retain authority budgets until cleanup confirmation (Task 5).
5. A business receives DE above its zero holding limit: transit and bank credit must preserve conservation and never create spendable excess DE (Task 3).

## Repo grounding and file ownership

Current `src/settlement/backend.ts` exposes `submit/status/refund`; `psp.ts` forwards them to `mock-backend.ts`, which owns bank and DE balances together. `Coordinator.runSubmission/send/reconcile/returnSettledLegs` owns settlement scheduling and recovery. `derive` also owns benefit and Auto accounting. `src/scenarios.ts` builds the world, exposes mutable mock accounts and advances both clocks. Its callers and `test/contract/settlement-backend.contract.ts` assume group-wide atomicity. These assumptions must be replaced, not hidden behind aliases.

| Path (relative to repository root) | Responsibility |
|---|---|
| `src/settlement/types.ts` (new) | Frozen intents, operation identities, provider outcomes and settlement snapshots |
| `src/settlement/operations.ts` (new) | Immutable keyed-operation records, term conflict refusal and status lookup |
| `src/settlement/provider.ts` (new) | Provider-owned bank books, authority acceptance, holds, funding and returns; small receive-only shop module |
| `src/settlement/digital-euro-ledger.ts` (new) | Pseudonymous holdings, limits, holds and local atomic groups |
| `src/settlement/interbank-transfer.ts` (new) | Individual transfers and explicit debit/credit transit |
| `src/settlement/orchestrator.ts` (new) | Execution order, intent ownership, reconciliation and compensation |
| `src/core/types.ts`, `coordinator.ts`, `states.ts` | Signed rail binding, orchestration handoff, lifecycle and authority budgets |
| `src/core/employee-authority.ts`, `views.ts` | Rail permission and user-visible settlement/return projections |
| `src/scenarios.ts` | Fixture composition, provider membership, clocks, faults and S01–S36 |
| `src/evidence/{run-record,findings,mermaid}.ts`, `src/cli.ts`, `src/presenter/{fixtures,journeys,session}.ts` | Versioned evidence and read-only presentation consumers |
| `test/` | Behavioral ownership migration described per task |
| `src/settlement/{backend,mock-backend,psp}.ts` | Delete after all callers migrate in Task 6 |

## Contract decisions

1. Keep the existing simulated-minute clock. Thirty seconds is `0.5` minutes. Every module receives `now: () => number`; hold expiry is `reserveAt + 0.5`, and `now >= expiresAt` refuses commit. Never extend expiry on replay. Do not change calendar, monthly budget or dispute-window units.
2. `Rail = 'digital_euro' | 'bank'`. Preserve `(purchaseId, proposalVersion, role)` as leg identity. Encode operation keys with `JSON.stringify` over tuples containing namespace, identity, operation, stage and destination. DE-group keys bind the frozen ordered leg list. Refuse changed terms under any reused key.
3. Keep `settlementMode: 'atomic' | 'independent'` in signed payloads. Explain `atomic` as reserve-all with compensation across ledgers. It is not a guarantee of cross-ledger atomic settlement.
4. Signed split inputs explicitly carry rail. Benefit proposal rails are derived employee=DE/employer=bank. Add `PayerApproval.sharesDigest: string`: SHA-256 hex over `canonicalJson(proposal.shares)` using `node:crypto`. Both signing helpers and Coordinator verification compute it from the retained ordered shares, binding rail/payee/fee/authority as well as roles and amounts. Existing version and amount checks remain. Standing employee terms gain `allowedRails: Rail[]`, a nonempty duplicate-free list of recognized rails validated at publication; fixtures sign DE permission. Missing permission does not silently authorize a different rail. Existing retained evidence is readable but cannot be submitted as new authority without the required binding.
5. Operation status is `not_started | pending | succeeded | rejected | unknown`; terminal operation outcomes are immutable. Hold lifecycle is separately `active | committed | released | expired`. A return refusing support is a conclusive return refusal with reason `unsupported`, not proof that money was returned.
6. The orchestrator has `submit(intent: SettlementIntent): Promise<SettlementSnapshot>`, `reconcile(purchaseRef: string): Promise<SettlementSnapshot>` and `returnSettled(purchaseRef: string, scope: ReturnScope): Promise<SettlementSnapshot>`. `purchaseRef` is the admitted purchase identity; conflict checks bind its version and terms. `ReturnScope` selects frozen leg identities and reason `compensation | recovery | refund | dispute`; public callers do not supply it directly.
7. Construct the orchestrator with provider lookup, injected clock, trace and `authorizeFirstHandoff(leg: SettlementLeg): AuthorityDecision`. This synchronous callback belongs to Coordinator and returns either a refusal reason or accepted evidence tied to leg identity, terms, authority basis and verified signed records. Provider reserve validates evidence and customer membership before accepting. Run the callback immediately before handoff; never retain a `VerifiedAuthority` decision scope across an await. A provider that accepts holds the exact authorized debit until expiry despite subsequent revocation. Replays of an uncertain reserve first query status and reuse the retained acceptance evidence; a conclusively unstarted reserve rechecks live authority before first acceptance.
8. `SettlementIntent` contains purchase/version, mode, ordered legs with payer/payee/rail/principal/fee/authority identity and routing, plus admitted budget metadata. `SettlementLeg` is the frozen leg record described here, including its role/version identity; `AcceptedAuthority` is the evidence record in the successful branch of `AuthorityDecision = { accepted: false; reason: string } | { accepted: true; evidence: AcceptedAuthority }`. `SettlementSnapshot` is detached plain data: phase, ordered leg outcomes, hold lifecycle, operation status and references, principal/fee returned, unresolved operations, cleanup confirmation, retained fees and known exposure. It also distinguishes payment committed from destination credit complete. No mutable Map, module instance or callback enters `PurchaseView`. Operation records retain immutable copied terms, operation key/status, references, reason and known effects. `ReserveOutcome` adds acceptance/hold reference and expiry; `ProviderOutcome` adds committed principal, destination-credit confirmation, fee charged/returned, principal returned, unresolved child operations and cleanup confirmation. `GroupOutcome` carries the group key, per-member commit outcomes and any unresolved group operation. Snapshot application projects existing leg statuses without calling a reserved hold settled.
9. Provider reserve holds principal plus fee; charge fee only when settlement is confirmed. Automatic compensation restores fees and principal. Ordinary refunds, disputes and independent explicit recovery preserve the current principal-only fee policy. The same original execution cannot be returned twice across reasons/scopes. Provider refunds take an explicit `policy: 'principal_only' | 'principal_and_fee'`; never infer money semantics by parsing a key. Compensation uses the latter; ordinary returns use the former.
10. A bank-book debit is transit, not a completed payment. A zero-limit DE destination receives its excess into paired defunding transit; completion awaits confirmed bank credit. Track partial settlement at every child stage so compensation can cancel uncredited transit or return already credited funds without blindly invoking a merchant debit for money it never received.
11. The provider module exports `commitAcceptedDigitalEuroGroup(holds: readonly AcceptedHold[]): Promise<GroupOutcome>` for the orchestrator's internal use. It validates each provider-owned, unexpired acceptance and its frozen group membership, then calls ledger `commitGroup` synchronously before any await. Group results are recoverable by the original group key. Each owning provider subsequently finishes its fee/waterfall bookkeeping through `commit(holdRef)`, recognizing the already committed hold rather than debiting it again. The orchestrator receives this helper in its constructor; it never fabricates provider access or independently changes holdings.
12. Concrete simulation modules expose `setFault(operationKey, stage, fault)` for scenario controls, with `fault = 'reject_before_effect' | 'lose_response_after_effect' | 'defer'`. Stages name their actual operation (bank debit, funding credit, destination credit, hold, commit, release, return). Deferred work progresses only when explicitly resolved by the simulation control, not by a fresh payment key; status reports current evidence. No global coordinator bypass or arbitrary production-only pause is added for tests.
13. Preserve existing `completed` after ordinary refund with separate return status. Add terminal `compensated`; keep reserve/commit phases in settlement progress. Pending and recovery reservations remain owned until snapshot evidence permits release. Durability and cross-coordinator uniqueness remain out of scope; in-memory replay within the same world is required.

## Task order and validation discipline

Execute Tasks 1–7 sequentially. Tasks 1–4 add independently usable modules while the old simulation remains active; Task 5 migrates Coordinator and all its callers in one integration task; Task 6 removes the old implementation and migrates remaining low-level contracts; Task 7 finishes evidence/docs. No compatibility wrapper may continue deciding settlement after Task 5.

For each behavioral change, first add/extend the primary owning test, observe its intended failure, implement, then run the focused command below. Keep unrelated baseline tests green; intentional old-semantics assertions migrate with their owner. Use the test-audit authoring gate: name the behavior, credible regression, missing existing coverage and real caller for each new test. Prefer extending tables over replaying identical tests at every layer. Commands run from repository root and use `rtk`. Commit only if the execution session authorizes commits.

### Task 1: Define signed rail terms and operation identity

**Files:** Create `src/settlement/types.ts`, `operations.ts`, `test/settlement-operations.test.ts`; modify `src/core/types.ts`, `coordinator.ts`, `employee-authority.ts`, `src/scenarios.ts`, `src/presenter/fixtures.ts`, `test/signing.test.ts`, `test/signed-requests.test.ts`, `test/employee-mandate.test.ts` and directly affected signed-payload fixtures.

**Interfaces:** Produces the types in decisions 2, 5, 8; `operationKey(parts: readonly (string | number)[]): string`; `OperationStore.begin(key: string, terms: unknown): OperationRecord`, `status(key: string): OperationRecord | undefined`, `resolve(key: string, outcome: OperationOutcome): OperationRecord`. Begin copies canonical terms and refuses a mismatch; resolving a terminal result differently is refused. No caller can mutate retained records.

- [x] Add `operation_identity_separates_roles_versions_and_delimiters`: assert distinct keys for two roles of the same payer, v1/v2 and delimiter-bearing identifiers; assert identical replay returns the original operation and altered payee/amount is refused.
- [x] Extend signed-request/approval tables with `rail_tampering_invalidates_authority`: mutate DE→bank under the old signature and assert refusal before any money operation; an otherwise valid re-signed bank request outside standing allowed rails must not obtain mandate authority.
- [x] Run `rtk pnpm exec node --test test/settlement-operations.test.ts test/signing.test.ts test/signed-requests.test.ts test/employee-mandate.test.ts`; confirm the new cases fail for missing semantics, not unrelated invalid setup.
- [x] Implement the operation store and signed rail/complete-share binding. Extend share producers and all affected signing helpers together. Keep the old backend active until Task 5; it does not yet implement rail selection.
- [x] Rerun the focused command and `rtk pnpm test`; all tests pass. Verify proposal changes still invalidate prior approvals and employee debit never grows to fill a rejected employer share.

### Task 2: Implement ledger-local holds and individual bank transfers

**Files:** Create `src/settlement/digital-euro-ledger.ts`, `interbank-transfer.ts`, `test/settlement-ledgers.test.ts`.

**Interfaces:** `DigitalEuroLedger` receives clock and trace; exposes provider-scoped `hold`, `commitHold`, `commitGroup`, `releaseHold`, `fund`, `defund`, `transfer`, `status`. Requests carry operation keys, immutable pseudonymous terms and caller provider identity. `InterbankTransfer` receives clock/trace and owns keyed transfer state through `transfer(request)`, `status(key)`, `cancelUncredited(key)`. These are concrete internal modules, not additional public pluggable ports. Define typed request/result records in `types.ts` matching decisions 5, 8 and 10.

- [x] Add table cases `hold_replay_does_not_extend_deadline`, `expiry_at_half_minute_forbids_commit`, `group_failure_changes_no_member`, `foreign_provider_cannot_spend_holding` and `bank_response_loss_never_duplicates_credit`. Assert unchanged balances on rejection, original references on replay and explicit transit for unconfirmed destination credit.
- [x] Run `rtk pnpm exec node --test test/settlement-ledgers.test.ts`; confirm intended failures.
- [x] Implement integer-cent/nonnegative checks, aggregate spendable-balance checks including existing holds, frozen group membership and expiration tombstones. DE traces contain pseudonyms and operation/group handles, never payer ids or full authority evidence. Return detached audit balances/holds/transit through read methods used by scenario evidence.
- [x] Rerun the focused test and `rtk pnpm test`; old simulation still passes, ledger groups are atomic only within DE, and bank legs have no group commit.

### Task 3: Deepen payer providers around funding and returns

**Files:** Create `src/settlement/provider.ts`, `test/settlement-provider.test.ts`; extend the types from Task 1 and ledger request records from Task 2.

**Interfaces:** `PayerProvider.reserve(intent: SettlementLeg, evidence: AcceptedAuthority): Promise<ReserveOutcome>`, `commit(holdRef: string): Promise<ProviderOutcome>`, `release(holdRef: string): Promise<ProviderOutcome>`, `status(operationKey: string): Promise<ProviderOutcome>`, `refund(executionRef: string, returnKey: string, policy: 'principal_only' | 'principal_and_fee'): Promise<ProviderOutcome>`. Produces the accepted-group helper from decision 11 and `AcceptedHold`/`GroupOutcome` records keyed by the frozen group identity. Constructor supplies provider identity, customer membership, clock, trace and concrete ledgers. Preserve `available` and `supportsMandatePayments`. `ShopProvider` is receive-only except referenced refunds; it can live privately in this file. These records expose unresolved child effects without requiring callers to schedule them.

- [x] Add `funding_response_loss_debits_bank_once`, `hold_failure_restores_only_its_funding`, `zero_limit_credit_waits_for_bank`, `ordinary_return_retains_fee` and `compensation_returns_fee_once`. Use EUR 8 principal + EUR 0.25 fee where fees matter; assert payer/provider/payee balances and transit independently, not using production totals as the oracle.
- [x] Run `rtk pnpm exec node --test test/settlement-provider.test.ts`; confirm intended failures.
- [x] Implement provider bank books/fee accounts, authority/membership acceptance, DE funding and defunding journals, bank/debit transit, release cleanup and idempotent returns. Reconcile child work internally. Enforce zero DE holdings for business destinations and preserve pre-existing DE when undoing intent-specific funding.
- [x] Rerun focused tests and `rtk pnpm test`; assert conservation across each fault stage and both original rails. No `FEE_COLLECTOR` use in the new implementation.

### Task 4: Implement orchestration behind its three-operation interface

**Files:** Create `src/settlement/orchestrator.ts`, `test/settlement-orchestrator.test.ts`; use concrete providers from Task 3.

**Interfaces:** Produces the constructor and three methods in decisions 6–8, plus the provider-owned group helper from decision 11. Submit/reconcile/return always yield snapshots of the same intent. Known pre-handoff input conflicts throw conclusive refusal; uncertainty after handoff is recorded in the snapshot. Provider operation keys are known before dispatch, so loss of all response references remains reconcilable.

- [x] Add `reserve_timeout_does_not_reject`, `bank_first_then_de_group`, `bank_settled_de_rejected_compensates`, `unknown_commit_is_resolved_before_return`, `unsupported_return_keeps_exposure`, `same_payer_multi_payee_has_distinct_operations` and `independent_keeps_successful_leg`. Assert original keys, visible exposure and returned principal/fees. Use the EUR 8 DE + EUR 5 bank lunch and inject failures at the named operation stages.
- [x] Run `rtk pnpm exec node --test test/settlement-orchestrator.test.ts`; confirm intended failures.
- [x] Implement freeze/reserve/commit/cleanup/compensation scheduling. Stop dependent work while a required operation is unresolved. Resume it only through authoritative status. Compensation cannot finish while bank/DE transit, held fees or funding cleanup is unresolved.
- [x] Rerun the focused tests and `rtk pnpm test`; observe bank commit order in evidence, not by spying on private calls. All new settlement events are LOCAL.

### Task 5: Integrate Coordinator, budgets and the scenario world

**Files:** Modify `src/core/coordinator.ts`, `src/core/types.ts`, `src/core/states.ts`, `src/core/views.ts`, `src/scenarios.ts`, `src/evidence/run-record.ts`, `src/evidence/findings.ts`, `src/evidence/mermaid.ts`, `src/cli.ts`, `src/presenter/journeys.ts`, all direct `new Coordinator(...)` consumers and affected provider/authority/concurrency/refund/presenter tests. Core budget modules `src/core/ledger.ts` and `autopay-ledger.ts` change only if snapshot integration requires it.

**Interfaces:** `Coordinator` constructor takes `createSettlement: (authorize: (leg: SettlementLeg) => AuthorityDecision) => SettlementOrchestrator` in place of `SettlementBackend`. It calls this factory once after initializing its state, passing a bound synchronous callback adapting `firstHandoffRefusal` and current verified evidence. The world factory retains the constructed orchestrator for simulation/evidence access. This avoids a construction cycle or exposing private authority methods; the factory must not submit during construction. Coordinator public purchase methods retain their current signatures and signed caller checks. Add `Purchase.settlement?: SettlementSnapshot`. Replace `World.backend` with `World.settlement: SettlementOrchestrator`, `World.providers: Map<string, PayerProvider>` keyed by payer and `World.digitalEuro: DigitalEuroLedger`; a world-owned shop map and bank-transfer module support composition. Fixtures configure balances and faults through concrete module methods; no legacy aggregate mutable account facade.

- [ ] Extend `test/coordinator-concurrency.test.ts`, `test/verified-authority.test.ts`, `test/employee-mandate.test.ts` and `test/autopay-dispute.test.ts` for authority changing between reserves, accepted holds surviving revocation until expiry, unresolved cleanup retaining benefit/Auto bookings and release happening once. Preserve signed payee-only refund and payer dispute behavior from existing owners.
- [ ] Run `rtk pnpm exec node --test test/coordinator-concurrency.test.ts test/verified-authority.test.ts test/employee-mandate.test.ts test/autopay-dispute.test.ts`; confirm intended failures before integration.
- [ ] Replace send/route/assembly/reconcile/return scheduling with orchestrator calls under the existing operation guard. Keep `runSubmission` authority-budget admission and rollback ownership, including the original Auto booking month on deferred handoff; no rollback after any possibly accepted handoff. Snapshot application alone derives states, receipts, disputes and budget effects. Refreshing authorizations must not invalidate an already accepted provider hold or move an in-flight purchase back into a proposal-editable state.
- [ ] Implement `compensated` transitions and release rules from spec §7.1, including `recovery_required → pending` only after confirmed payment exposure clears with cleanup still unresolved. Preserve separate ordinary refund status and retained Auto fees.
- [ ] Rebuild `world()` using provider membership, rail-specific balances and the shared minute clock. Preserve three initiation modes and mandate capability. Mixed-provider coordinator mode refuses before handoff/budget leakage. Test bypass relaxes provider access only, never authority checks or conservation.
- [ ] Migrate all scenario and presenter callers to the new world in this task so commands remain runnable. Re-derive S04/S13/S14 outcomes from the revised reserve policy rather than preserving old assembly waits. Re-derive S01/S02/S05/S16–S18/S33. S33 must still refuse a payer-signed refund and then accept the payee-signed return; its short label is not permission for payer refund initiation. Add S35 expiry using a `0.5` minute advance and S36 divergence with confirmed compensation.
- [ ] Run focused tests, `rtk pnpm test`, `rtk pnpm scenarios`, `rtk pnpm presenter`, `rtk pnpm findings`. All checks pass or intentionally obsolete low-level backend tests are explicitly assigned to removal in Task 6; no retained safety test may be skipped or weakened. Migrate metadata and evidence readers to `settlement: { name, origin, specVersion }` and `settlement-ledgers-1` here; update affected expectations to keep the full suite green. Task 7 owns final fixture version, published artifacts and claim audit, not a delayed repair of broken readers.

### Task 6: Replace old contracts and extend composed safety invariants

**Files:** Modify `test/invariants.property.test.ts`, `test/defects.test.ts`, `test/shares.test.ts`, `test/psp.test.ts`, `test/backend-port.test.ts`, `test/mock-backend.contract.test.ts`, `test/contract/settlement-backend.contract.ts`; delete `src/settlement/backend.ts`, `mock-backend.ts`, `psp.ts` after their last caller migrates. Move retained regressions to the settlement test owners in Tasks 1–5; replace obsolete contract files with `test/contract/settlement-orchestrator.contract.ts` and `test/settlement-orchestrator.contract.test.ts`.

**Interfaces:** Export `settlementOrchestratorContract(name, makeFixture)` from the new contract runner. Its fixture supplies the public orchestrator plus synthetic intent/provider composition, clock and optional stage faults; unavailable fault controls are skipped as `not tested`, not counted as passes. No assumption that cross-ledger groups settle atomically.

- [ ] Inventory each affected old test against its production caller, credible regression and replacement owner. Move unique safety cases; delete forwarding/assembly mechanics only after the stronger behavioral proof exists. Do not add aliases solely to retain test imports.
- [ ] Extend the existing property generator with per-operation response loss, provider availability, `0.5` minute expiry, multi-payee roles and compensation. Keep an independent shadow of budgets, funds and paired conversion/transit entries. Assert every-completed-leg, no employer-gap transfer, stable retry identities and timeout uncertainty across composed operation sequences.
- [ ] Run `rtk pnpm exec node --test test/invariants.property.test.ts test/defects.test.ts test/shares.test.ts test/settlement-orchestrator.contract.test.ts`; demonstrate new fault cases fail before the owning repair if they expose a missed case. Repair at the owner, not in the oracle.
- [ ] Remove the old runtime modules, stale imports, assembly-only knobs and mutable aggregate-account fixture use. Update comments that promise the future private adapter the obsolete interface; future compatibility is versioned, not assumed.
- [ ] Run `rtk pnpm test` and `rtk pnpm scenarios`; no surviving duplicate settlement driver and every retained regression has an owner.

### Task 7: Version evidence, document assumptions and close the plan

**Files:** Modify `src/evidence/run-record.ts`, `findings.ts`, `mermaid.ts`, `src/cli.ts`, `src/presenter/journeys.ts`, `src/scenarios.ts`, `test/run-record.test.ts`, `findings.test.ts`, `mermaid.test.ts`, presenter test owners, `README.md`, `docs/initiation-model.md`, `experiment-protocol.md`, `field-map.md`, `index.html`, `backlog.md`, `presenter-comparison.md` and this plan.

**Interfaces:** Record `settlement: { name, origin, specVersion }` rather than pretending one backend holds all funds. Preserve readability of historical records with their legacy `backend` metadata where consumed; new records name `settlement-ledgers-1`. Set fixture version `2026.11-4`. Read-only projections expose provider books, pseudonymous DE, progress, transit, principal and fee recovery without handing mutable records to agents.

- [ ] Extend existing evidence tests for new version metadata, pseudonymous ledger traces, distinct orchestrator/provider events and unknown recovery exposure. Regenerate pinned digests only after behavior checks pass.
- [ ] Update CLI, Mermaid and presenter evidence references to real events. Revise titles and claims about one transaction; findings keep ECB status `not tested`. Explain fee/compensation policy and minute/second conversion. Update the static scenario table to S01–S36.
- [ ] Document Explorer v20 integration requirements (provider tiles, receive-only shops, separate DE/bank cards and orchestrator inside coordinator set). Actual external Explorer implementation/sync is outside this checkout; do not claim it delivered by updating docs.
- [ ] Run `rtk pnpm test`, `rtk pnpm scenarios`, `rtk pnpm findings` and `rtk pnpm --silent presenter --json`. Verify all 36 canonical scenarios satisfy their checks and all four presenter records retain restricted agent capabilities.
- [ ] Regenerate `docs/presenter-comparison.md` with `rtk pnpm --silent presenter --markdown --run-id=employee-mandate-v1`; run through `rtk proxy pnpm` when capturing so RTK does not filter the artifact; capture exact output to a temporary file before replacing the artifact. Run `rtk git diff --check`, review semantic changes/digests and mark backlog/plan tasks complete only with the recorded validation evidence.

## Acceptance mapping

Spec §§1–5 → Tasks 1–3 and 5; §6 funding/commit/compensation → Tasks 2–5; §7 identity/status/lifecycle → Tasks 1, 4–6; §8 initiation modes → Task 5; §9 scenarios/invariants → Tasks 5–6; §10 evidence/Explorer consequences → Task 7; §11 deferred choices → contract decisions and scope limits above.

## Assumptions and scope limits

- This is one sequential simulation migration, not independent subsystem projects: funds, authority and recovery compose through one observable purchase contract.
- Use the revised draft as authority. Rail permission, immutable operation records and minute conversion are explicit implementation choices; no external financial-system behavior is being asserted.
- No durable storage, cross-coordinator identity guarantee, merchant offline mode, interactive rail-choice UI or external Explorer deployment in this plan.
- Commit granularity and execution method are decided at implementation time; this planning session does not change source/tests or authorize execution.

## Plan improvement loop report

- Iteration 1: created with superpowers:writing-plans (installed Claude plugin cache, version 7.0.0). Grounded file ownership, three-method orchestrator interface, minute conversion and seven sequential tasks in current source.
- Iteration 2: substantial rewrite after interface/dependency review. Added explicit fee policy to provider refunds, provider-owned multi-provider DE group authorization, deterministic per-stage fault controls, and same-task migration of all world/evidence readers. Preserved S33's payee-only return authorization and removed an intermediate allowance for a failing full suite.
- Iteration 3: substantial rewrite after tracing signed approvals, minute clocks and constructor ownership. Specified `sharesDigest` and `allowedRails`, provider/snapshot outcome records, a one-time coordinator-owned construction factory, preserved admitted-month authority checks, and raw artifact capture. No private authority method is exported for tests.
- Iteration 4: full coverage/interface/dependency pass found no further substantial improvement. Verified spec linkage, seven ordered tasks, owning test paths, validation commands and scope exclusions; whitespace validation passed.
- Iterations run: 4 of 10. Iteration 1 mode: created with superpowers:writing-plans. Questions asked: 0 of 3. Stop reason: stabilized.
- Assumptions: simulation-only migration; 30 seconds equals 0.5 existing clock minutes; explicit signed rail permission; no persistence or external Explorer delivery. These are recorded above.
- Unresolved decisions: none requiring user input for this plan. Production hold guarantees, durable/cross-coordinator identity and external Explorer implementation remain explicitly deferred.
- Validation performed during planning: document structure, linked spec, existing test paths and `rtk git diff --check`. Runtime tests were not run; source/tests were not changed.
