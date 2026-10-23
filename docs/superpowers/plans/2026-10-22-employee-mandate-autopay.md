# Employee Mandate, Auto-Pay and One-Off Exceptions Implementation Plan

> **For agentic workers:** Use an available task-by-task execution workflow when implementation is requested. Steps use checkbox (`- [ ]`) syntax for tracking. This plan does not authorize implementation, delegation, commits or publication by itself.

**Goal:** Implement signed standing employee terms, deterministic automatic payments and signed one-off exceptions, with monthly accounting, receipts and disputes, while preserving the simulator's settlement safety rules.

**Architecture:** The coordinator remains the mutation and authorization seam. A focused employee-authority module owns verified terms and authorization decisions, and a dedicated auto-pay ledger owns monthly reservations. A trusted presenter runner initiates and reconciles automatic purchases through the existing coordinator; the agent receives no spending methods.

**Tech Stack:** Existing Node.js >= 23.6, native TypeScript stripping, `node:crypto`, `node:test`, pnpm; no new dependencies, build step, network or real data.

**Source of truth:** [Reviewed design spec](../specs/2026-10-22-employee-mandate-autopay-design.md). The request to create this plan selects that spec as the planning baseline. Its product defaults and exclusions apply unchanged.

**Status:** Planned; no implementation work performed. Keep the source spec and prior workspace changes intact.

---

## Execution rules and dependency order

This is one coordinated feature, not independent plans for a budget framework, payments platform or UI. Execute tasks in the listed order. Each task must leave its affected public interfaces and consumers coherent before moving on. Task 4 is an intentional coordinated interface migration; do not land its core changes separately from its fixture/presenter/test migrations. Later tasks extend that working manual baseline.

```text
1. Signed employee terms
2. Calendar and monthly accounting
3. Submission intent and safe retries
4. Manual/exception interface cutover, including existing consumers
5. Automatic authority and admission
6. Confirmed returns, receipts and disputes
7. Trusted presenter runner and controls
8. S19–S28 and evidence integration
9. Composed invariant coverage
10. Documentation, generated comparison and final validation
```

Use `rtk` for shell commands. Each task supplies its exact focused test command; full validation uses the existing package scripts. Establish the baseline with `rtk pnpm test` before implementation; record existing failures separately. Do not add TypeScript, a test library or other dependencies. These are future execution commands, not checks claimed to have run during planning.

Use a failing behavioral case before changing its implementation, then rerun its owner and direct consumers. Each new case must protect a named public contract, fail for the intended reason and avoid a duplicate proof at another layer. The test-audit authoring gate applies; do not create ledger seeding, raw-purchase access or fault flags solely to make assertions easier. Wrap real backend methods to hold or lose responses, following the existing concurrency tests. Node test files are the correct tooling here; unrelated framework commands in personal skills do not apply.

After each task, inspect `rtk git diff --check`. Use a coherent task-sized checkpoint when the execution workflow calls for commits; never combine unrelated pre-existing changes. No task writes the explorer or a private ECB adapter.

## File ownership

| File | Intended responsibility |
| --- | --- |
| `src/core/types.ts` | Signed employee terms, exact payment approvals, authorization variants, retained assessment, submission/receipt/dispute data. |
| `src/core/employee-authority.ts` (new) | Verified employee publication and deterministic authorization assessment; retained restrictions and revision rules. No settlement or private keys. |
| `src/core/autopay-ledger.ts` (new) | UTC booking months, owner-bound reservation, consumption and confirmed release. No generic budget abstraction. |
| `src/core/coordinator.ts` | Publication/refresh orchestration, exact approval checks, admission, handoff/retry, state derivation and return/dispute orchestration. |
| `src/core/policy.ts` | Employer eligibility and allocation only; remove employee-limit gating. |
| `src/core/views.ts` | Role-based payer visibility and safe automatic-payment/return projections. |
| `src/core/signing.ts`, `src/core/authority.ts`, `src/core/ledger.ts` | Reuse existing signing/employer behavior; only change if a concrete call-site migration requires it. Do not add employee versions to the employer registry. |
| `src/settlement/backend.ts`, `src/settlement/mock-backend.ts`, `src/settlement/psp.ts` | Preserve the settlement method interface; identify conclusive refusal and capability consistently. |
| `src/scenarios.ts` | Trusted signing helpers, explicit fixture settings, clock advancement, manual baseline and new scenarios. |
| `src/presenter/session.ts` | Restricted agent handle; trusted user and runner handles; detached, current observations. |
| `src/presenter/fixtures.ts`, `src/presenter/journeys.ts` | Manual journey migration, evidence-backed claims and automatic runner journeys. |
| `src/evidence/run-record.ts`, `src/evidence/findings.ts`, `src/evidence/mermaid.ts`, `src/cli.ts` | Preserve readable, deterministic evidence and truthful LOCAL provenance as new scenarios/events are introduced. |

New tests: `test/employee-mandate.test.ts`, `test/autopay.test.ts`, `test/autopay-dispute.test.ts`, `test/presenter-autopay.test.ts`. Existing suites remain the primary owners of their current contracts. New filenames are implementation targets, not currently existing files.

## Contract choices used by the tasks

Names below make cross-task references concrete. Keep the contracts if implementation discovers a clearer local name; change all consumers in the same task.

1. `Coordinator.publishEmployeeMandate(signed)` validates and publishes. `Coordinator.employeeMandate(employeeId)` returns a detached verified signed record or `undefined`. No public unsigned revoke/trust mutation is introduced.
2. Fixture `updateEmployeeMandate(w, changes)` merges only editable terms into the current verified record, sets the next version, signs using the employee's fixture key and calls publication. It is trusted fixture/device code, not an agent capability.
3. `Coordinator.assess(p)` returns a detached, current employee assessment without mutation or logging. `Coordinator.refreshAuthorization(p)` refreshes an idle open purchase, invalidates stale evidence and records mandate authority when eligible. Submission calls the same internal refresh/check logic under its operation guard; it does not recursively acquire the public guard.
4. `Purchase.authorizations` replaces `Purchase.approvals` in the coordinated cutover. Each record has a `basis`. Device/exception records contain their signed approval; mandate records retain a verified employee mandate snapshot and exact purchase/amount bindings. Keep declared share participation separate from basis: use `Share.authority: 'payer' | 'employer_mandate'`, and do not switch the employee's role when Auto becomes available.
5. `approvalCents` and `approvalFeeCents` sum the payer's `payer` shares irrespective of basis. General split purchases continue using device approvals. `payerView` checks payer participation; `sponsorView` remains employer-only.
6. `CoordinatorOptions` gains `calendarEpoch`, `disputeWindowMinutes` and `supportsMandatePaymentsFor?: (payerId: string) => boolean`. Defaults are the spec values and capability false. The same trusted routing data drives direct and per-PSP decisions; capability is not a property added to `SettlementBackend` that would break its existing adapters.
7. `Coordinator.dispute(p, employeeId)` is a trusted call; the session supplies its authenticated employee ID, never a raw agent parameter. It shares the operation guard and return implementation with `refund`/`recover`.
8. `PresenterSession.runner.step()` is trusted, takes no raw purchase or approval input, and advances only the session-owned purchase. `session.agent` gains no method. Trusted `userFlow` gains signed mandate publication conveniences and dispute; its device callback signs the explicit exception choice.

The assessment contract is:

```ts
type AuthZone = 'Blocked' | 'Auto' | 'Confirm' | 'Exception';
type AutoPayBlockedReason =
  | 'blocked_merchant' | 'no_employee_mandate' | 'exceeds_mandate'
  | 'mandate_revoked' | 'mandate_expired' | 'auto_off'
  | 'over_auto_limit' | 'untrusted_merchant' | 'monthly_cap'
  | 'psp_unsupported';

interface EmployeeAssessment {
  authZone: AuthZone;
  employeeDebitCents: number;
  mandate?: { mandateRef: string; version: number; maxCents: number };
  autoPayBlockedReason?: AutoPayBlockedReason;
}
```

Store this on a benefit purchase as `employeeAssessment`; expose it alongside proposal version rather than embedding a mutable authority revision into signed payment terms. Invalid stored authority and expired offers are failures outside this zone union. No mandate is represented by absence, not an infinite monetary amount.

## Task 1: Verified employee terms and trusted fixture publication

**Files:** Create `src/core/employee-authority.ts`, `test/employee-mandate.test.ts`. Modify `src/core/types.ts`, `src/core/coordinator.ts`, `src/scenarios.ts`. Read `src/core/signing.ts` and `test/signing.test.ts`.

**Contract protected:** Only the employee can replace their standing terms, failed writes preserve the accepted version, and callers cannot mutate accepted signed data. Existing employer tests cannot detect this new employee ownership/revision contract.

- [ ] Define `EmployeeMandate` with every field and validation rule in spec §3. Use safe integer cents/version, finite nonnegative validity and exact booleans; reject missing/malformed objects before dereferencing. Validate unique nonempty merchant IDs and `autoPayMaxCents <= maxCents`. Allow trust/block overlap with block precedence; the trust convenience will refuse a blocked ID.
- [ ] Write public publication cases: initial version 1, next version, stale/replayed version, skipped version, different employee taking an existing reference, new reference replacing the same employee, wrong signer, modified signed payload, malformed fields and detached reads. A malformed write must leave the last verified record unchanged.
- [ ] Run `rtk pnpm exec node --test test/employee-mandate.test.ts test/signing.test.ts`; establish the new failure before implementing storage/publication.
- [ ] Implement verified publication and detached reads in the employee-authority module, called only through the coordinator. Check holder identity with `verifyPayload`, copy the signed object and index by employee and reference. At use, verify the retained signature again; report invalid data distinctly from absence. Log accepted publish/revoke and rejected publication exactly once with `LOCAL` origin.
- [ ] Add `updateEmployeeMandate` to trusted fixture code. Keep `world()` from publishing employee defaults until Task 4, avoiding incidental changes to existing trace baselines in this additive task. Add explicit employee fixture settings to `WorldOptions` and preserve existing parameters/PSP topology.
- [ ] Re-run the focused suites. Confirm existing `world()`/lunch outcomes are unchanged at this task boundary.

Publication behavior to exercise through the coordinator, using the complete spec default payload:

```ts
const signed = signPayload(terms, w.signers.get(EMPLOYEE)!);
w.coordinator.publishEmployeeMandate(signed);
const before = w.coordinator.employeeMandate(EMPLOYEE);
assert.throws(() => w.coordinator.publishEmployeeMandate(signed));
assert.deepEqual(w.coordinator.employeeMandate(EMPLOYEE), before);
signed.payload.maxCents = 999_999;
assert.equal(w.coordinator.employeeMandate(EMPLOYEE)!.payload.maxCents, 1000);
```

Here `terms` is the full `EmployeeMandate` literal from spec §12, not a partially signed update. Use separate cases for replay rejection and post-publication caller mutation so one failure cannot mask the other.

## Task 2: Calendar and owner-bound automatic budget

**Files:** Create `src/core/autopay-ledger.ts`, `test/autopay.test.ts`. Modify `src/core/coordinator.ts`, `src/core/types.ts`, `src/scenarios.ts`. Read `src/core/ledger.ts`.

**Contract protected:** Pending and consumed purchases share one stable employee/month budget; another purchase cannot adopt or release a reservation. The employer ledger owns daily subsidies, not this contract.

- [ ] Define calendar settings and validate a UTC epoch plus finite nonnegative minutes/windows; reject an unrepresentable resulting date. Apply monotonic `advance()` to both clocks. Existing direct coordinator clock writes in tests should be migrated when those tests are touched; do not claim wall-clock or persistence guarantees.
- [ ] Implement `monthOf(now, calendarEpoch)` in the auto-pay ledger module. Use UTC year/month derived from the epoch; never divide by 30 days. The exact month calculation is:

```ts
const instant = new Date(Date.parse(calendarEpoch) + now * 60_000);
const month = `${instant.getUTCFullYear()}-${String(instant.getUTCMonth() + 1).padStart(2, '0')}`;
```

- [ ] Give `AutoPayLedger` a small internal interface: `usage(employeeId, month, excludeOwner?)`, `reserve(owner, booking)`, `rollback(owner)`, `consume(owner)` and `resolve(owner, retainedFeeCents)`. `owner` is the actual purchase identity, not an untrusted purchase-ID string. `booking` holds purchase ID, proposal/mandate version, employee, original month, amount, fee and cap. Check cap and create ownership in the same synchronous reservation operation. Keep a purchase-ID collision check as well as owner identity so a second object cannot reuse an existing entry.
- [ ] `consume` and `resolve` return an accounting delta or no change; the coordinator later uses deltas to emit events once. `resolve` is permitted only after the coordinator proves no unresolved obligations; it reduces usage to the confirmed retained fee, including zero when the employee was never charged. Preserve a terminal ownership record/tombstone so a repeat cannot recreate or double-release that booking.
- [ ] Distinguish safe admission rollback from terminal resolution. `rollback(owner)` can remove only that owner's unconsumed reservation, and only the coordinator's proven-before-handoff path calls it; it allows a corrected attempt by the same purchase to reserve again. Never use terminal `resolve()` to undo acquisition of the first ledger when the second ledger refuses. A consumed or potentially handed-off booking cannot be rolled back.
- [ ] Add focused ledger-interface cases for contention, conflicting identity, own-entry exclusion, repeat consumption/resolution, pre-handoff rollback followed by re-admission, and retained fees. This is an internal module seam used by the coordinator, not a test-only mutation surface. Integration cases will own the independent risk that coordinator lifecycle calls occur at the wrong time.
- [ ] Expose monthly usage only through the coordinator's forthcoming assessment/payer projection; do not expose mutable entries. Wire validated settings through `world()` without enabling automatic submission.
- [ ] Run `rtk pnpm exec node --test test/autopay.test.ts test/quote.test.ts`; expect all new accounting cases and existing side-effect-free quoting to pass.

Calendar cases use literal independent expectations: minute 44,639 is `2026-01`, 44,640 is `2026-02`, and 84,960 is `2026-03` under the January epoch. Include February in a leap year with a separate epoch. Do not derive the expected month using the implementation under test.

## Task 3: Submission intent, first handoff and retry safety

**Files:** Modify `src/core/coordinator.ts`, `src/core/types.ts`, `src/settlement/backend.ts`, `src/settlement/mock-backend.ts`. Extend `test/defects.test.ts`, `test/coordinator-concurrency.test.ts`, `test/psp.test.ts`, `test/backend-port.test.ts`. Keep settlement method signatures unchanged.

**Contract protected:** A lost response cannot release a live reservation or turn replay into a new payment, and delayed per-PSP initiation cannot bypass current authority. This prerequisite applies to the existing manual flow before Auto is enabled.

- [ ] Add a real-backend wrapper that awaits successful submission and then throws once. On the current direct path it exposes the blanket catch/release defect. Assert pending state, retained legs/benefit, stable keys and successful same-key replay with no extra executions. Also cover an error before a conclusive result and the existing PSP route.
- [ ] Add per-leg dispatch knowledge, independent of returned execution reference. Freeze a submission descriptor at admission: group, mode, request legs, authority evidence, and original assembly size/deadline. Replaying it uses those exact values. Retain which individual legs were definitely refused before forwarding versus may have been handed off.
- [ ] Split pre-dispatch validation/reservation cleanup from post-handoff error handling. Known conclusive refusal may roll back only newly owned reservations; generic route errors retain intent and yield unknown outcomes. Normalize those route errors into recorded outcomes so `submit`/`resubmit` returns with the derived pending state, as the current per-PSP path does; guard and conclusive pre-dispatch caller errors may still throw. A failed replay never overwrites an earlier settled/rejected/returned result. Resolve routes before any first send.
- [ ] Normalize mock request validation that is provably before dispatch to the existing `RequestRefusedError`, preserving diagnostic text. In particular, account/fee-collector resolution for a fresh request must remain a conclusive no-debit refusal. Do not classify arbitrary `Error` messages as safe. Retain the B1/B8/B16 regression proving repair of a refused pre-dispatch fixture can be submitted with a fresh authority check.
- [ ] Move first-handoff authority validation immediately before each route call. If a later unsent leg loses authority, record refusal for that leg, retain other leg outcomes, then derive state normally. Never call whole-purchase `fail()` after a leg may have moved. A repeat with a lost reference uses the frozen authorization rather than treating absence of `executionRef` as absence of dispatch.
- [ ] Extend real holds across the first PSP response to mutate authority before the next first send. Assert original atomic assembly deadline and independent recovery outcomes. Keep foreign-execution ownership and reused-purchase-ID protections intact.
- [ ] Run `rtk pnpm exec node --test test/defects.test.ts test/coordinator-concurrency.test.ts test/psp.test.ts test/backend-port.test.ts test/mock-backend.contract.test.ts`. Do not proceed to Auto admission until these pass.

Concrete lost-response wrapper; all payment behavior still belongs to the real backend:

```ts
const submit = w.backend.submit.bind(w.backend);
let loseResponse = true;
w.backend.submit = async (request) => {
  const response = await submit(request);
  if (loseResponse) {
    loseResponse = false;
    throw new Error('synthetic lost submission response');
  }
  return response;
};
```

## Task 4: Manual authority and signed exceptions; coordinated cutover

**Files:** Modify `src/core/{types,employee-authority,policy,coordinator,views}.ts`, `src/scenarios.ts`, `src/presenter/{session,fixtures,journeys}.ts`. Migrate direct consumers in `test/{employee-mandate,quote,signing,scenarios,defects,backend-port,shares,split,views,presenter-session,presenter,coordinator-concurrency,invariants.property,run-record,findings}.test.ts` and affected CLI formatting in `src/cli.ts`.

**Contract protected:** Exact device signatures remain exact; over-limit payment requires a signed exception; a lasting update does not impersonate a one-off approval. This is also the compile/runtime cutover for all removed fields. Work through the substeps before treating the task as complete.

- [ ] Add a signed approval discriminant and explicit exception acknowledgment. Retain all existing payment binding fields; require both device and exception signatures to bind the current purchase/version/merchant/total/own amount/fee/expiry. For exception basis, sign mandate reference/version, acknowledged maximum, `exception: true` and overage. Reject a plain signature in Exception with `exceeds_mandate` and no stored approval.
- [ ] Implement one deterministic assessment function with the spec's exact reason precedence. Its inputs are verified standing terms or absence, employee debit, merchant, usage, clock and capability. Initially all routed capability defaults false. Preserve retained maximum/block restrictions after expiry/revocation. Never downgrade invalid stored authority to absence.
- [ ] Replace `approvals` with basis-discriminated `authorizations`, and share authority with payer participation versus employer mandate. Update readiness, authority references, signed amount helpers, views and the Task 3 first-handoff dispatcher together. Use the same payer aggregation for single-payer multi-payee purchases; no employee Auto behavior is introduced for `proposeSplit()`.
- [ ] Remove `employeeMaxCents` from policy input, `ProposeInput`, `QuoteInput`, retained benefit terms and presenter setup; remove `reviseInstruction` and `withinInstruction`. `quote()` returns allocation plus the current employee assessment, without trace or writes. An unapproved over-limit proposal is now `awaiting_approvals`/Exception, not an automatically payable draft.
- [ ] Add open-purchase registration and refresh. Payment changes bump proposal version and invalidate all evidence. Employee-only publication refreshes idle purchases without a proposal bump: preserve valid ordinary signatures within the new maximum; invalidate all acknowledged exceptions on revision; block invalidates all. In-flight publication changes standing terms but defers purchase mutation. Avoid recursive operation-guard acquisition.
- [ ] Before offer replacement, check retained employer funding against the old proposal. If lost, fail with original amounts. If it holds, reprice the new offer normally, including cheaper offers. New quotes/purchases use current employer terms; publication alone does not reprice open purchases.
- [ ] Publish manual-only employee terms in ordinary `world()` setup: original personal maximum 800, automatic limits zero, no blocks, no trusted merchants required. Allow explicit `employeeMandate: null` for the no-mandate case and explicit overrides for later Auto fixtures. `updateEmployeeMandate` signs revisions; `approveAs` gains a trusted optional exception choice and constructs the signed acknowledgment from the current verified terms.
- [ ] Migrate every old limit call site in one task. B1/B13 fee regressions must still fail at debit including fee; former `reviseInstruction` tests publish signed replacement terms. Tests expecting `p.approvals` inspect the new evidence variant. The property test initially retains manual fixtures and verifies the device branch. Tests that assert an empty trace after `quote()` must compare with the post-setup baseline, because signed publication is now legitimately logged; do not clear setup events.
- [ ] Update presenter projections, `SafeReason`, signed callback shape, conversation claims and evidence checks. Derive limits from observed assessment, not `PRESENTER_SCRIPT` arithmetic. Keep the four existing journeys manual. A message about an over-limit offer offers a one-off exception or a lasting edit; it does not claim that raising the maximum is the only possible action.
- [ ] Run `rtk pnpm test` and `rtk pnpm presenter`. Update expected semantic outcomes/digests with an explanation; never weaken the test to accept any non-completed state. This task is complete only when old consumers work with the new manual model.

The exception acknowledgment must have this signed shape, alongside the existing payment terms:

```ts
const exceptionAcknowledgment = {
  basis: 'exception' as const,
  exception: true as const,
  mandateRef: current.payload.mandateRef,
  mandateVersion: current.payload.version,
  maxCents: current.payload.maxCents,
  overByCents: employeeDebitCents - current.payload.maxCents,
};
```

Here `current` is the coordinator's verified detached employee mandate and `employeeDebitCents` is independently calculated from the retained proposal. A test must sign an ordinary payload and then change only its exception fields; verification must reject it rather than record exception authority.

## Task 5: Automatic authorization and atomic budget admission

**Files:** Modify `src/core/{coordinator,employee-authority,autopay-ledger,types,views}.ts`, `src/scenarios.ts`, `src/settlement/psp.ts`. Extend `test/autopay.test.ts`, `test/employee-mandate.test.ts`, `test/coordinator-concurrency.test.ts`, `test/quote.test.ts`, `test/views.test.ts`.

**Contract protected:** Only currently eligible Auto purchases acquire standing authority and budget; two purchases cannot both spend the last available automatic budget. An agent key or a prior favorable quote is never authority.

- [ ] Add trusted capability resolution for both routing modes. If a `SimulatedPsp` exposes `supportsMandatePayments`, its value and the direct-route lookup must come from the same fixture configuration, defaulting false. Test an actual proposal/submission under false and absent capability, not just a property getter.
- [ ] On proposal creation or idle mutating refresh, record mandate authorization only when current assessment is Auto. Retain the verified signed mandate snapshot, exact employee debit and proposal/version binding; no fabricated per-purchase signature. Zero employee debit is allowed only with positive configured automatic limits and every other eligibility condition.
- [ ] At `submit`, refresh/check both authorities and offer expiry, then reserve employee budget and employer benefit with no asynchronous gap. If the second reservation fails, undo only this attempt's first reservation. A stale Auto decision falling to Confirm/Exception invalidates its record and waits without sending or changing shares. Add owner-collision and partial-acquisition tests.
- [ ] Map authoritative settlement/return outcomes to ledger deltas: pending and recovery hold; complete consumes once; conclusive no-debit failure releases; fully resolved recovery releases never-charged debit and returned principal, retaining only charged fees. Emit `autopay_reserved`, `autopay_consumed`, `autopay_released` for actual changes only.
- [ ] Preserve booking month on retry and use it for a still-unsent leg's budget recheck. Mandate publication never resets the ledger; a cap reduction cannot undo an admitted handed-off payment. Current view separates present eligibility from the frozen authority that funded a submission.
- [ ] Add the admission race using distinct purchase objects and real held sends. Override employer limits sufficiently that employee budget is the limiting resource. Add no-funds outcomes, month rollover, late principal return, lost employer authority before Auto dispatch, and ordinary-signature preservation if a later mandate would also permit Auto.
- [ ] Run `rtk pnpm exec node --test test/autopay.test.ts test/employee-mandate.test.ts test/coordinator-concurrency.test.ts test/quote.test.ts test/views.test.ts test/psp.test.ts`.

Use these independent accounting expectations in the integration tests:

| Actions | Expected automatic usage |
| --- | --- |
| Two EUR 4 proposals, cap EUR 6, neither sent | 0; both quotes can initially be Auto. |
| First admitted and held; second attempts admission | 400 reserved; second waits for Confirm, zero second sends. |
| First completes | 400 consumed; repeated reconciliation leaves 400. |
| First conclusively rejected before a debit | 0 after one release. |
| EUR 4 + EUR 0.20 fee completes, then principal fully returned | 20 consumed, not 0. |
| January admission settles in February | January usage retained; February usage excludes it. |

## Task 6: Return reconciliation, receipts and disputes

**Files:** Modify `src/core/coordinator.ts`, `src/core/types.ts`, `src/core/views.ts`. Create `test/autopay-dispute.test.ts`; extend `test/defects.test.ts` and `test/coordinator-concurrency.test.ts`. Reuse backend `status()`/`refund()` unchanged.

**Contract protected:** A dispute is a request, not proof of a refund; receipt deadlines are stable and budget is released only after confirmed outcomes. Existing refund cases do not exercise loss of the refund response or dispute identity/window.

- [ ] Add return-attempt knowledge distinct from original settlement leg status. On an uncertain refund response, preserve the attempt and query its same execution reference before another refund call. `returned` records confirmation, `settled` allows retry, unknown/unavailable retains the hold. Never turn a completed purchase into an incomplete purchase because a return response is lost.
- [ ] Add a real `refund` wrapper that returns principal in the mock then throws once. Resume through the public refund/dispute path and assert one actual backend return, correct original-payer balances, no extra refund debit and exactly one ledger release. Do not make the mock's refund idempotent to hide the coordinator behavior being tested.
- [ ] On the first fully completed mandate-authorized purchase, retain one receipt with the used mandate revision and first observation time. Emit its original amount/fee/debit, merchant, funding breakdown and fixed `disputeUntil`. Completed device/exception purchases emit no Auto receipt. Replayed responses do not recreate or extend it.
- [ ] Add `dispute(p, employeeId)` using the existing operation guard. Validate owner, Auto receipt, completion and first-request deadline before recording a case. Repeated accepted cases can resume after expiry. Call a shared private return implementation inside the guard, never the public guarded `refund()` recursively.
- [ ] Track request outcome separately: opened, unresolved, unsupported or returned; use the existing purchase return state plus dispute/attempt data rather than interpreting all errors as unsupported. A busy request leaves no case. Expose charged/unreturned fee separately from refunded principal in the payer view.
- [ ] Cover deadline equality, one minute late, wrong employee, no receipt, unsupported return, employee-never-charged recovery, partial returns, repeat dispute/refund, and a refund wait concurrent with publication/cancel. Confirm only eligible first requests emit `dispute_opened` and later changes emit `dispute_updated`.
- [ ] Run `rtk pnpm exec node --test test/autopay-dispute.test.ts test/autopay.test.ts test/defects.test.ts test/coordinator-concurrency.test.ts test/views.test.ts`.

Fixed fixture expectation: first observed completion at minute 10 with a 1,440-minute window yields `disputeUntil = 1450`. At 1450 the first request is accepted; at 1451 a new case is rejected. A case opened at 1450 can finish at 1451 without moving its deadline.

## Task 7: Trusted runner and employee controls in the presenter

**Files:** Modify `src/presenter/session.ts`, `src/presenter/fixtures.ts`, `src/presenter/journeys.ts`, `src/scenarios.ts`. Create `test/presenter-autopay.test.ts`; extend `test/presenter-session.test.ts` and `test/presenter.test.ts`.

**Contract protected:** Agent selection can lead to deterministic no-tap completion while the agent still cannot approve, submit or mutate terms; every employee-facing claim cites a safe observation.

- [ ] Add `runner: { step(): Promise<Evidence<PresenterView>> }` to the trusted `PresenterSession`, never to `AgentPresenter`. Retain one session purchase. Before any selection, a step refuses with `no_proposal`. Otherwise the runner refreshes the current open assessment, then submits only valid mandate authorization. A pending automatic purchase is reconciled or replayed with the existing intent when references were lost. Completed/cancelled states are harmless repeated observations. A manual purchase is never initiated by the runner.
- [ ] Use the session's existing asynchronous guard across a whole step, including refresh and returned observation. A stale queued proposal cannot dispatch its old terms; no second purchase is synthesized. Manual selection/approval/submission and runner steps must not overlap while one is in flight.
- [ ] Add trusted device callbacks for signed publication. User-flow revoke and trust conveniences fetch the current verified projection, sign the next revision on the device and publish it. Refuse trusting a blocked merchant. Pass the exception choice into `approveOnDevice`, which signs it; the coordinator never receives an unsigned exception upgrade. User-flow dispute supplies the session principal.
- [ ] Extend recipient-safe views with current zone/reason, observed mandate version, used authority basis and receipt/return information. Avoid raw signatures, mutable registry/ledger entries and employer-private data. Existing `explain()` must not append core authority events just to display a current zone.
- [ ] Add an Auto journey using actual `agent.selectOffer()` followed by trusted `runner.step()`, with no device-approval callback invocation. Add S24-style selection replacement before the step, capability off, stale offer, and repeated steps after completion. A new-merchant trust suggestion cites the confirmed purchase observation and has no publication side effect.
- [ ] Add a trusted `createScenarioSession(w, { purchaseId, catalog })` fixture helper in `src/scenarios.ts`, constructing a signed session grant, coordinator/options and device callbacks using existing fixture keys. Scenarios and presenter Auto tests share this helper, while the actual runner remains implemented once in `session.ts`. Import `createPresenterSession` directly; do not import `presenter/fixtures.ts` or `journeys.ts` into `scenarios.ts`, since both already import the scenario module and would introduce an initialization cycle. New scenario catalogs are passed as full synthetic `CatalogOffer` objects with correct price and validity, independently of the existing manual catalog.
- [ ] Assert privileged methods are absent from the agent handle and that mutation of returned views cannot alter mandate, purchase or budget. Retain the existing signed agent-grant checks for every agent call; an accepted selection is retained intent, not a new agent call made by the runner.
- [ ] Run `rtk pnpm exec node --test test/presenter-autopay.test.ts test/presenter-session.test.ts test/presenter.test.ts` and `rtk pnpm presenter`. Keep the four existing comparison records unless a distinct automatic journey is explicitly added to their format; do not silently change their count.

The session ownership model remains:

```ts
interface PresenterRunner {
  step(): Promise<Evidence<PresenterView>>;
}

interface PresenterSession {
  agent: AgentPresenter;
  userFlow: PresenterUserFlow;
  runner: PresenterRunner;
}
```

`Evidence`, `PresenterView`, `AgentPresenter` and `PresenterUserFlow` are the existing session types, migrated in Task 4 and extended here. A caller giving the agent the whole session violates the trusted-handle contract; journeys pass only `session.agent` to scripted agent code.

## Task 8: S19–S28, trace explanations and evidence consumers

**Files:** Modify `src/scenarios.ts`, `src/evidence/run-record.ts`, `src/evidence/findings.ts`, `src/evidence/mermaid.ts`, `src/cli.ts` as needed by concrete output changes. Extend `test/scenarios.test.ts`, `test/run-record.test.ts`, `test/findings.test.ts`, `test/mermaid.test.ts`. Use `test/presenter-autopay.test.ts` for the independent no-tap session contract.

**Contract protected:** Each advertised scenario demonstrates its named cause, and generated evidence can account for what happened with LOCAL provenance. Do not reproduce the complete low-level authorization matrix in scenario tests.

- [ ] Add the ten scenarios exactly as spec §12 defines, using trusted setup and real prior purchases for usage. S23 overrides monthly cap to 600 and employer allowance to two purchases/1,000 cents. S25 uses two distinct 900-cent lunches; its 1,300-cent variant is Exception. S22 next-purchase checks must account for the consumed employer allowance instead of assuming another EUR 5 contribution.
- [ ] Parameterize direct/per-PSP and capability-off variants at the fixture runner where useful; do not multiply the public scenario chooser into dozens of near-duplicate IDs. The advertised `Scenario.run()` uses its canonical settings. Capability-off Auto journeys stop for a device signature and produce no automatic accounting/receipt.
- [ ] Exercise no-tap progression through `createScenarioSession` and its trusted runner, not `approveAs()` followed by a hidden user submit. Per-PSP completion may require a second step to reconcile the first leg's pending response; bound fixture stepping and fail explicitly if the expected state is not reached. Complete all mutations through the session's trusted handles, then return `userFlow.snapshot()` as the retained `p` for evidence; never submit/refund that detached snapshot through the coordinator.
- [ ] Preserve `Scenario.run(): Promise<{ w, p }>` for S27 without inventing a rejected `Purchase`. First select an allowed but untrusted merchant B so the retained proposal awaits confirmation with no authorization; then select blocked merchant C and assert rejection leaves the prior proposal unchanged, records `proposal_rejected: blocked_merchant`, and sends no payment. The employee-mandate suite separately owns initial blocked `propose()` rejection before any purchase exists and exception refusal on a subsequently blocked open proposal. Describe S27 as a refused blocked replacement, not as successful creation of a blocked purchase.
- [ ] Include relevant trace/balance assertions in each `Scenario.check()`, not only its tests, so findings cannot report a pass from a final-state label alone. `pnpm scenarios` currently prints outcomes without invoking `check()`; retain its display role and use the scenario/findings test owner plus `pnpm findings` to evaluate pass/fail. Existing fault/settlement scenarios retain their original invariant purpose even where manual over-limit waiting is now Exception.
- [ ] Ensure every event in spec §11 is emitted at its owning mutation, with stable IDs, actual basis/version, simulated time and budget deltas. Use the spec's WHY explanations as the later explorer contract; do not create a second unused UI map in this repo. New trace details must remain readable in the existing text/Mermaid output; flatten concise identifying fields rather than rendering opaque nested objects.
- [ ] Preserve detached run records/digests and make the calendar epoch/window reproducible in fixture/run evidence. Add a backwards-compatible optional fixture-settings field to run records if needed; do not report coordinator-only changes as new real backend capabilities. Bump fixture/presenter versions and any mock semantics version only when its own observable behavior changes.
- [ ] Run `rtk pnpm exec node --test test/scenarios.test.ts test/run-record.test.ts test/findings.test.ts test/mermaid.test.ts` and `rtk pnpm scenarios`. All 28 canonical scenarios must pass; the ECB findings column remains `not tested`.

Scenario acceptance ownership:

| Scenario | Required observation |
| --- | --- |
| S19 | EUR 4 Auto completion, one receipt, no device signature. |
| S20 | Untrusted merchant causes Confirm; suggestion does not trust it. |
| S21 | EUR 8 debit causes `over_auto_limit`, not a monthly/capability refusal. |
| S22 | Plain approval refused; signed EUR 1 exception pays once; standing maximum unchanged. |
| S23 | First EUR 4 Auto holds/uses budget; second EUR 4 requires Confirm solely for monthly cap. |
| S24 | Old proposal authorization invalidated before any send; new EUR 8 proposal waits. |
| S25 | Second EUR 9 lunch has no subsidy and needs Confirm; first purchase unchanged. |
| S26 | Dispute returns each original contribution; only confirmed accounting is released. |
| S27 | Blocked selection refused with no payment or exception bypass. |
| S28 | False/absent provider capability prevents Auto despite otherwise eligible terms. |

## Task 9: Composed invariants and coverage gaps

**Files:** Modify `test/invariants.property.test.ts`; add missing cases to their existing owner among `test/employee-mandate.test.ts`, `test/autopay.test.ts`, `test/autopay-dispute.test.ts`, `test/coordinator-concurrency.test.ts`, `test/presenter-autopay.test.ts`. Production files change only to repair a demonstrated failure.

**Contract protected:** Sequences of individually valid actions cannot break authorization, accounting or settlement invariants. This is distinct from duplicating deterministic scenario tests.

- [ ] Extend the current seeded generator with employee publication/revocation, signed exceptions, automatic refresh/admission, cancellation, dispute, time advancement and multiple distinct purchases sharing one budget. Keep bounded seed/step counts and print seed plus action history on failure. Keep scheduled interleaving tests in the concurrency suite rather than simulating concurrency with random sequential calls.
- [ ] Replace "every employee leg has a device approval" with basis-aware proof against retained initiation evidence: device/exception exact signed amount+fee, or a verified employee mandate and admission record for the exact debit. Preserve original evidence after revocation rather than testing against current terms retroactively.
- [ ] Independently track expected admitted charges and confirmed releases by employee/month. Assert no admission exceeds its then-current cap; do not assert current usage is below a cap later lowered by the employee. Unresolved outcomes retain their booking, and mandate updates never reset it.
- [ ] Preserve all-leg completion, no shifting, same-key replay, money conservation including fee collector, LOCAL origin and ownership assertions. Use explicit allowed operation refusals; do not broaden the error catch to swallow arbitrary programming errors.
- [ ] Check contract coverage against the table below. Add a missing regression only at its strongest seam, with a specific failure reason and independent expected outcome. No source-string or method-inventory test substitutes for actual authority enforcement.
- [ ] Run `rtk pnpm exec node --test test/invariants.property.test.ts test/coordinator-concurrency.test.ts`, then `rtk pnpm test` once this composition work is complete. Preserve the failing seed as a focused regression if it reveals a new defect.

## Task 10: Documentation, generated artifacts and final validation

**Files:** Modify `README.md`, `docs/experiment-protocol.md`, `docs/field-map.md`, `docs/presenter-comparison.md`, `docs/backlog.md`; adjust `docs/initiation-model.md` and `docs/agent-protocols.md` only where their existing authority statements become false. Keep the source spec as the design baseline; annotate deviations explicitly rather than silently rewriting its product decisions.

- [ ] Document standing terms, retained restrictions after revoke/expiry, fee-inclusive debit, exception versus lasting edit, monthly booking and no-tap selection semantics. Update module and scenario tables. Describe first handoff, uncertain returns and the immutable retry descriptor in the initiation documentation.
- [ ] Update the field map for automatic employee visibility, current versus used mandate versions, receipts, returned principal and retained fees; preserve sponsor/payee restrictions. Preserve scripted synthetic/LOCAL labels and legal/provider limitations.
- [ ] Generate the existing manual comparison from a fixed run ID; inspect content, reason changes and evidence references. Command: `rtk proxy pnpm --silent presenter --markdown --run-id=employee-mandate-v1 > docs/presenter-comparison.md`. Use raw output for artifacts. This command is for implementation execution, not this planning turn.
- [ ] Run the final commands below. Read output and compare deterministic JSON artifacts; exit code alone is insufficient for findings. Avoid rerunning the full suite after it passes unless subsequent code changes require it.
- [ ] Mark backlog work implemented only after these gates pass. Leave explorer, fee-return support, cross-coordinator ownership and real-provider/legal work open. Update property-test/backlog statements only for coverage actually delivered.

```bash
rtk pnpm test
rtk pnpm scenarios
rtk pnpm presenter
rtk proxy pnpm --silent scenarios --json --run-id=employee-mandate-v1 > /tmp/employee-mandate-scenarios-a.json
rtk proxy pnpm --silent scenarios --json --run-id=employee-mandate-v1 > /tmp/employee-mandate-scenarios-b.json
rtk proxy cmp /tmp/employee-mandate-scenarios-a.json /tmp/employee-mandate-scenarios-b.json
rtk proxy pnpm --silent presenter --json --run-id=employee-mandate-v1 > /tmp/employee-mandate-presenter-a.json
rtk proxy pnpm --silent presenter --json --run-id=employee-mandate-v1 > /tmp/employee-mandate-presenter-b.json
rtk proxy cmp /tmp/employee-mandate-presenter-a.json /tmp/employee-mandate-presenter-b.json
rtk pnpm findings
rtk git diff --check
```

Expected: the full tests pass, including the scenario/findings suite invoking all 28 canonical checks; four migrated manual presenter comparison records remain evidence-backed; repeated fixed-input JSON is byte-identical; findings report local observations and no tested ECB capability. Automatic session execution is additionally proven by the presenter Auto suite and new scenario traces. Artifact commands use `rtk proxy` to preserve the CLI's raw JSON/Markdown.

## Spec coverage and test ownership

| Spec area | Tasks | Primary behavioral owner |
| --- | --- | --- |
| Scope/defaults and signed terms (§1–3) | 1, 4, 10 | Employee publication suite plus existing manual scenario/split suites. |
| Zones, fee-inclusive amounts and quote purity (§4) | 4, 5 | Employee authority and quote suites; ledger tests do not duplicate decision precedence. |
| Evidence, exception signing and invalidation (§5) | 4, 5 | Employee mandate suite and existing signing binding tests. |
| Employer funding/no shifting (§6) | 3–5 | Defects/scenario cases for lost authority and distinct second purchase. |
| Runner, PSP capability and first handoff (§7) | 3, 5, 7 | Coordinator concurrency/PSP suites for dispatch; presenter Auto suite for restricted handles/no tap. |
| Monthly lifecycle/rollover/fees (§8) | 2, 5, 6 | Ledger mechanics in Auto suite; coordinator integration for timing and charged fees. |
| Receipts/disputes/uncertain returns (§9) | 6, 7 | Auto dispute suite, with shared guard interleavings in concurrency suite. |
| Migration/privacy/trace (§10–11) | 4, 7, 8, 10 | Views/presenter evidence/run-record suites. |
| S19–S28 and composed invariants (§12) | 8, 9 | Canonical Scenario checks and independent seeded sequence oracle. |

## Planning assumptions and review record

- Preserve all decisions in the reviewed spec: benefit-purchase scope; manual defaults; retained restrictions; signed exception revision binding; UTC booking months; fee retention; trusted runner; no compatibility purchase cap.
- No outside dependencies, network, new UI, real-provider adapter, account-wide split mandate or durable persistence is needed.
- Tests/examples name proposed interfaces explicitly; implementation should refine private organization without inventing new caller responsibilities. The coherent Task 4 cutover is larger than the other tasks because splitting a breaking interface from its consumers would create an unusable intermediate state.
- Planning validation covers source/test ownership, paths, command entry points, dependency ordering and spec coverage. Runtime tests are execution gates, not evidence obtained by writing this plan.

### Loop report

- Final plan: `docs/superpowers/plans/2026-10-22-employee-mandate-autopay.md`.
- Iterations run: **4 of 10**.
- Iteration 1 mode: **created with superpowers:writing-plans**. Applied the task-by-task format with focused contracts/examples and repository-specific validation; implementation and execution handoff remain out of scope for this planning request.
- Questions asked: **0 of 3**; the reviewed spec supplies the product decisions.
- Stop reason: **stabilized**.
- Pass 1: created ten ordered tasks with file ownership, public contracts, the coordinated manual migration, behavioral test owners and final acceptance gates.
- Pass 2: reconciled scenario/evidence constraints with source: retained-purchase S27, no circular presenter-fixture import, session snapshot ownership, bounded per-PSP runner steps, scenario checks versus CLI display, and raw artifact output.
- Pass 3: separated safe pre-handoff reservation rollback from terminal accounting resolution, preserving corrected retries; specified pending outcomes for generic route errors.
- Pass 4: checked source/spec coverage, task prerequisites, path/command references, local links and document structure. No further substantial change within scope.
- Assumptions: the source spec is the selected planning baseline; S27 uses a rejected replacement to preserve the existing scenario result contract, with initial rejection covered at the coordinator seam; automatic scenario setup uses the real presenter runner; the four manual comparison records remain four.
- Unresolved decisions: none blocking simulator execution under the spec defaults. Real-provider authorization/legal classification and production refund rights remain deferred as in the spec.
- Validation performed: documentation whitespace/structure, task numbering, source/test paths, focused command targets and local links. No runtime tests run and no production/test files changed during planning.
