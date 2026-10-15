# Agent Presenter Surface — Implementation Plan

**Status:** Revised after codebase-design and application-scope review, 15 October 2026. Planned; no presenter implementation exists yet.

**Goal:** Deliver the reproducible, scripted synthetic presenter in [experiment-protocol.md](../../experiment-protocol.md#ai-presenter-artifact): sourced offers, deterministic contributions, employee approval, changed terms and renewed approval, and an honest explanation of pending payment. Include a conventional filter-and-checkout comparison and a message-to-evidence map. These are the exploration outputs promised by application v2 Q18–Q23. A live LLM is optional and outside this slice.

**Architecture:** One presenter-session module owns a purchase and its offer association. Its agent-facing interface exposes discovery, evaluation, proposal selection and explanation through references and detached projections. A separate trusted user-flow handle records approval and drives submission/reconciliation. The coordinator remains the authority for contribution amounts, approval binding and settlement state. Reuse existing signing, party views, fixture controls and run records.

**Spec:** [Experiment protocol](../../experiment-protocol.md), [field map](../../field-map.md), [backlog](../../backlog.md). [Agent protocols](../../agent-protocols.md) remain background context; this implementation claims no AP2/UCP conformance.

## Scope and constraints

- Zero new runtime or dev dependencies; Node.js >= 23.6, native TypeScript stripping, node built-ins and pnpm. No enum, namespace or constructor parameter properties; use type-only imports.
- Synthetic actors, integer euro cents, fixed seeds, fixed fixtures and a scripted clock. No network calls, personal data or real money.
- Every new event is LOCAL. A successful local run establishes no ECB capability. The ECB adapter stays in a separate private repository.
- Preserve completion, no-share-shifting, stable-idempotency and timeout-is-unknown invariants. Reuse the coordinator rather than implementing another payment state machine.
- Agents never receive the coordinator, a live Purchase, payer keys, the trusted user-flow handle, raw trace or backend controls. Agent methods cannot approve, submit, retry, reconcile, recover, refund or revise the employee instruction.
- One session owns one purchase and one fixed employee instruction. This slice chooses alternative C; the optional user-budget-revision branch is deferred. Existing trusted coordinator callers retain reviseInstruction.
- The first artifact is CLI/JSON/Markdown. Clickable UI is separate. Label output **scripted synthetic presenter**, not evidence of live model reasoning or consumer preference.
- No broad coordinator rewrite, global purchase registry, generic agent framework or new protocol port. A future model client consumes the agent-facing session interface; it is not an offer-source adapter.

## Decisions and ownership

| Decision | Owner and consequence |
|---|---|
| A deep presenter-session module | Owns grant checks, trusted employee context, offer resolution, purchase lifecycle calls, recipient projections and evidence linkage. Callers do not assemble these rules themselves. |
| Two restricted handles | A trusted factory returns agent and userFlow. Only agent is handed to the scripted assistant. Closures or runtime-private storage hold dependencies; TypeScript visibility alone is insufficient. This is in-process capability discipline, not isolation from arbitrary hostile JavaScript. |
| Small immutable catalog | Five fixtures: A (€13), replacement B (€14), alternative C (€13), a non-vegetarian decoy and an over-distance decoy. Reuse existing merchant accounts. No platform payees, merchant signers or shared world() expansion. |
| Expiry and replacement | A expires; B is a different offer. No mutable reprice/withdrawal protocol. Offers are immutable within a run; changed terms need a new offer reference. |
| Signed session-scoped grant | Reuse Signed and verifyPayload. The employee is principalId; reserve “sponsor” for the employer. Bind agent, principal, session and purchase. A grant delegates information/proposal operations only. |
| Trusted instruction | Employee identity, personal limit, fee, mandate reference and purchase id enter through trusted session construction. Agent methods accept neither replacements nor raw authoritative amounts. |
| Shared benefit resolution | Add a fresh-purchase Coordinator.quote and extract one private resolver shared with benefitNow. Preserve purchase-specific reservation exclusion on submission/retry. |
| Existing device helper | The trusted runner injects approveOnDevice(p), backed by approveAs(w, p, EMPLOYEE). No new Device class. Only the trusted approval path invokes it. |
| Behaviour proves authority | Test inability to spend through the delivered agent handle. Absence of agent labels on coordinator events is not proof of caller identity. |
| Existing evidence format | Keep RunRecord and traceDigest. Add a presenter wrapper for conversation, comparison and presenter fixture version; do not fork settlement record semantics. |

## Interface contract

The following interfaces are planned. Complete concrete declarations in the named modules. Keep helpers private unless another production caller needs them.

### Offers and time

src/presenter-fixtures.ts contains the five offers, deterministic script inputs and PRESENTER_FIXTURE_VERSION. Each offer has offerRef, merchantId, title, tags, priceCents, availability (from/until), source and walkingMinutes. No payeeId: merchant and payee are identical here.

The session snapshots and validates the fixture array: unique nonempty references, positive integer prices, ordered finite validity windows, finite nonnegative walking times. All returned data is copied. One trusted clock, coordinator.now, is advanced with existing advance(w, t), keeping the mock backend in sync. Agents cannot pass now.

Validity is inclusive (from <= now <= until), matching coordinator approval expiry. Record retrievedAt on each sourced observation. Discovery filters requested tags and maximum walking minutes, sorted by price then reference. Resolve and validate offers again on evaluate/select/approve/submit: retaining a discovery response cannot extend validity. Offer text is data, never instructions or authority.

### Coordinator quote

~~~ts
export interface QuoteInput {
  merchantId: string;
  totalCents: Cents;
  employeeId: string;
  employeeMaxCents: Cents;
  feesCents?: Cents;
  mandateRef: string;
}

// Fresh-purchase projection: no reservation, purchase creation or trace append.
quote(input: QuoteInput): BenefitResult;
~~~

Extract a private benefit resolver accepting terms, merchant, total and an optional purchase id to exclude from ledger usage. quote passes no exclusion; benefitNow passes the existing purchase id. Both resolve and verify the latest mandate and use the same clock and policy evaluation. Do not expose a caller-selected reservation exclusion through QuoteInput.

The missing/invalid-mandate fallback must include fees: totalCents + employeeFeeCents <= employeeMaxCents. This fixes reproduced B13: an unknown mandate currently allows €8 plus a €1 fee under an €8 instruction. Quote validation rejects invalid totals, fees and instructions before evaluation. The session separately logs a recipient-safe quote observation.

Quotes reserve nothing. Two quotes can show the same remaining benefit; initiation still rechecks authority and contention. A fresh quote is not a forecast for an already reserved purchase. After submission, explanation uses retained proposal/status observations, never a new quote substituted for approved shares.

### Presenter session

createPresenterSession accepts trusted session/purchase/agent/employee ids, fixed personal limit and fee, mandate reference, one signed grant, catalog, coordinator, trace, public-key registry and approveOnDevice. Copy caller-owned instruction, offer and grant data on entry. Keep keys, callbacks and raw coordinator in trusted construction code.

~~~ts
export type AgentCapability = 'discover' | 'propose' | 'explain';

export interface AgentGrant {
  grantRef: string;
  agentId: string;
  principalId: string;
  sessionId: string;
  purchaseId: string;
  capabilities: AgentCapability[];
  expiresAt: number;
}

export interface Evidence<T> {
  value: T;
  eventSeqs: number[];
}

export interface AgentPresenter {
  discover(prefs: { tags?: string[]; maxWalkingMinutes?: number }): Evidence<OfferView[]>;
  evaluate(offerRef: string): Evidence<QuoteView>;
  selectOffer(offerRef: string): Evidence<PresenterView>;
  explain(): Evidence<PresenterView>;
}

export interface PresenterUserFlow {
  discover(prefs: { tags?: string[]; maxWalkingMinutes?: number }): Evidence<OfferView[]>;
  evaluate(offerRef: string): Evidence<QuoteView>;
  selectOffer(offerRef: string): Evidence<PresenterView>;
  explain(): Evidence<PresenterView>;
  approve(expectedProposalVersion: number): Evidence<PresenterView>;
  submit(expectedProposalVersion: number): Promise<Evidence<PresenterView>>;
  reconcile(): Promise<Evidence<PresenterView>>;
  snapshot(): Purchase; // detached; trusted runner only, for recordRun
}
~~~

OfferView contains sourced catalog fields and retrieval time. QuoteView adds deterministic personal/combined-other contributions, employee fee, instruction compliance and a safe eligibility explanation. PresenterView composes payerView with selected offer, proposal version/expiry, fixed employee limit, recorded-approval information and safe reasons. Before selection, explain refuses with no_proposal. Do not add unrelated employer details to the general PayerView.

Project reasons through an explicit allowlist: benefit unavailable, merchant ineligible, personal limit exceeded, offer expired or approval expired. Do not expose raw mandate references, other payer ids, signatures, keys, ledger usage, idempotency keys or unfiltered backend errors. Update the field map to distinguish a safe eligibility result from underlying policy/usage data. Agent-visible event references do not grant access to raw audit records.

PresenterView distinguishes **recorded approval** from **currently valid approval**. Clock expiry alone does not mutate the coordinator's ready state. Show recorded terms and expiry honestly, prevent expired submission, and require renewed approval after replacement. A new quote or revoked mandate must never rewrite already approved personal amounts in the explanation.

Every agent operation verifies the signature against principalId, checks expiry at the trusted clock, and matches agent, principal, session, purchase and required capability before reading offers or calling the coordinator. Mapping: discover → discover; evaluate/explain → explain; select → propose. Reject malformed grants and unsupported input fields instead of accepting amount, identity, time or instruction overrides. Return a generic denial externally; retain a specific audit reason. Denial may append evidence but cannot mutate purchase, approvals, ledger or backend.

Agent and trusted discover/evaluate/select/explain share private implementations; only the agent handle checks the agent grant. The trusted handle represents explicit scripted human actions and is never offered as an agent tool. First selection calls propose; later selections call changeOffer on the same retained purchase, preserving version increments and approval invalidation. Only pre-submission states are selectable. These trusted methods support the conventional comparison without duplicating filtering/policy logic or pretending a human is an agent.

Approval checks the displayed version and live offer before invoking approveOnDevice with the retained purchase. Submission checks version and offer, then calls Coordinator.submit(p, 'atomic'); the coordinator rechecks payer/employer authority. No retry/recovery method is exposed by this slice. Trusted reconciliation resolves pending status without new payment keys.

Protect operations during async submit/reconcile with an in-flight guard acquired before the first await and released in finally. While in flight, refuse further session operations, including snapshot, with operation_in_progress. This prevents replacement or double submission while the coordinator awaits a backend response. The guard does not classify a transport timeout as failure.

### Evidence and conversation

Preserve TraceEvent. Session events include session id, purchase id, proposal version where applicable, action id and trusted observation time. Agent events also carry onBehalfOf and grantRef; denials without a usable grant explicitly record that absence. Distinguish agent requests from coordinator/backend observations. Capture operation event sequences; expose only recipient-safe observation references to agents.

Each conversation entry records a deterministic message id, role, permitted recipient, text, structured claims, supporting event sequences and authority classification: user_instruction, user_approval, information_only or status_report. Source events precede the message. User instructions and approvals have corresponding evidence events too. Render amounts/status from structured projections rather than unbound numeric prose.

The workshop artifact may show the synthetic audit trace beside the conversation. Label it an evaluator view; the assistant receives only projections. Payment claims trace to retained state/observations. Pending text cannot claim completion or recommend speculative replacement payment. After trusted reconciliation, a separate message may report the newly confirmed state.

PresenterRecord wraps existing RunRecord, presenter fixture version, delivery mode (scripted/manual), conversation and comparison metadata. Use the trusted detached purchase snapshot with recordRun; agents cannot call snapshot. Store conversation messages/claims in trace events too, so the existing digest covers presented evidence as well as settlement. Return detached record contents; later mutation cannot alter retained evidence. Wall-clock run ids stay outside the digest, as today.

## File map

| File | Work |
|---|---|
| src/coordinator.ts | Quote interface, shared benefit resolver, B13 fee correction |
| src/presenter-session.ts | Session interfaces, grants, retained purchase, safe projections, evidence |
| src/presenter-fixtures.ts | Five offers, fixed instructions/times, presenter fixture version |
| src/presenter.ts | Scripted/manual runs, conversation, comparison, record wrapper |
| src/cli.ts, package.json | Explicit presenter dispatch and command |
| test/quote.test.ts | Quote contract; no duplicate policy arithmetic tests |
| test/defects.test.ts | B13 owner-level regression |
| test/presenter-session.test.ts | Authority, lifecycle, isolation, disclosure, evidence |
| test/presenter.test.ts | Two journeys, two modes, conversation/record/CLI acceptance |
| docs/experiment-protocol.md, docs/field-map.md | Usage and recipient-safe explanation fields |
| docs/presenter-comparison.md | Reproducible comparison, evidence references and limits |
| README.md, docs/backlog.md | Commands, honest completion status and deferred scope |

No shared account/signer expansion, backend-interface change, existing scenario rewrite or application-form edit is required. Reuse world, advance, approveAs, updateMandate and mock fault controls from trusted runner code.

## Implementation tasks

Implement in order. Record the current test baseline (108 passing in the planning review; rerun when implementation starts). Preserve pre-existing worktree changes; do not switch branches or commit unrelated work automatically. Run focused checks, then pnpm test after each task. For new tests name the observable contract and credible regression; avoid source greps, duplicated arithmetic and assertions that only restate labels.

### Task 1: Shared quote semantics and fee fallback

- [x] Add the B13 regression to test/defects.test.ts: unknown and invalidly signed mandates, €8 total + €1 fee, €8 instruction → draft; €9 instruction permits an approval request. Demonstrate failure on pre-fix code for the intended reason.
- [x] Add QuoteInput and a private shared resolver; make quote a fresh-purchase side-effect-free projection and include fees in every instruction check.
- [x] In test/quote.test.ts cover valid/ineligible/unknown/revoked authority, fees and malformed quote inputs. Pin independent expected outcomes and prove quotes change neither trace nor ledger: repeated quotes consume no benefit; a real pending purchase affects a later fresh quote.
- [x] Preserve reservation exclusion at initiation/retry. Existing contention/retry tests remain primary owners of those rules; extend only for a newly exposed gap.
- [x] Run pnpm exec node --test test/quote.test.ts test/defects.test.ts, then pnpm test.

### Task 2: Session ownership, catalog and agent capabilities

- [x] Create presenter fixtures and session modules. Copy trusted inputs; expose only the two intended handles. Implement runtime input validation and the signed session-scoped grant.
- [x] Implement discover/evaluate/select/explain with one clock, immutable offers, sourced amounts and detached projections. Keep filter/mapping helpers private.
- [x] Test invalid signature, expiry, missing capability, wrong agent, wrong principal, wrong session and wrong purchase independently with otherwise valid setup. Each denial leaves money/approval/purchase state unchanged.
- [x] Test capability separation through accepted operations: explain-only can evaluate but cannot select; propose-only can select but cannot discover/explain. A grant for one session cannot be reused in another.
- [x] Test isolation through the delivered agent handle: mutating returned prices, proposal/instruction fields or nested arrays cannot affect later observations. Mutating construction inputs likewise has no effect. Task 3 extends this proof to actual submission terms once trusted execution exists.
- [x] Test discovery decoys/order, source/time, validity at/after the endpoint, and attempts to override amount/limit/identity/time. Prove price mapping through authoritative proposal amounts, not a copier-helper test.
- [x] Run pnpm exec node --test test/presenter-session.test.ts, then pnpm test.

### Task 3: Trusted approval, execution and lifecycle evidence

- [x] Implement trusted selection, version-checked approval/submission, reconciliation, detached snapshots and the in-flight guard. Connect approval to approveAs through the injected device callback.
- [x] Test agent discover/evaluate/select/explain produce no approvals, execution attempts or debits. Inspect observable device/backend effects; coordinator actor labels are not a caller-authority oracle.
- [x] Extend Task 2's mutation case through trusted approval/submission: returned projections and detached snapshots cannot alter the retained amounts, instruction, proposal version or resulting debits.
- [x] Test A approved → A expired → submission refused without execution; and A → B replacement → previous version cannot approve/submit → renewed approval for C succeeds. Same-price different-offer replacement must increment proposal version too.
- [x] Test B remains outside the fixed €8 instruction; agents cannot raise the limit or obtain approval. Existing zero-personal-share approval requirements stay unchanged.
- [x] Test employer authority lost after approval: submission fails without increasing the recorded employee share or moving money. Distinguish approved amounts from a later evaluation showing no benefit.
- [x] Test pending → explain → trusted reconcile: explanation makes no backend status call/retry; pending persists until reconciliation observes a result. Verify one execution per leg and stable keys.
- [x] Test a held-in-flight operation rejects concurrent selection/approval/submission. Release the real mock's delayed response to verify normal completion. A test adapter controls scheduling only, not the asserted outcome.
- [x] Test field allowlists and attribution, including denied operations. Evidence assertions name actual proposal/version/status and recipient, not only event names.
- [x] Run pnpm exec node --test test/presenter-session.test.ts, then pnpm test.

### Task 4: Scripted and manual workshop journeys

- [x] Implement two journeys, each in a fresh world with the same deterministic inputs in scripted and manual modes. Use shared session logic: scripted uses agent; manual uses trusted selection and conventional filter/checkout presentation. Both require the same explicit user approval actions.
- [x] **Changed offer / pending:** at t=10 retrieve A (€13), evaluate €8 + €5, select and explicitly approve. A expires at t=60; advance to t=70, when replacement B (€14) is available. Select B, invalidating the old approval, and show the €9 personal amount exceeding the fixed €8 limit. The user chooses C (€13), approves its new version and submits. Use existing timeout_then_settle to show pending before trusted reconciliation. Completion appears only after reconciliation.
- [x] **Lost employer contribution:** in a fresh world approve a live €13 offer, then revoke the mandate through updateMandate. Submit through the trusted handle; show refusal, zero executions and unchanged €8 approved share. Explain that full personal payment would require a new instruction and approval; do not perform that branch.
- [x] Reuse merchant A/B/C accounts and zero fixture fees. B/C and the loss-journey offer stay live for their paths; grant/mandate lifetimes must not mask the intended condition.
- [x] Produce evidence-backed conversation messages. Explicitly clarify, synthetically, that “within ten minutes” means walking time. Fixed scripted preferences are not evidence of natural-language understanding.
- [x] Produce PresenterRecord with recordRun and the trusted snapshot. Include conversation claims in digest-covered events; version presenter fixtures separately from existing scenario fixtures.
- [x] Build comparison rows for preferences, changed terms, funding loss, user decisions, unsupported assertions and authority preservation. Count explicit decision events; link observations to run/scenario and event references. Label manual assessment; do not invent measured AI benefit.
- [x] Test amounts, proposal versions, preserved limits, pending-before-completion, no duplicate executions, source-before-message and permitted recipients. Repeated runs have identical digests; changed-offer/funding-loss runs differ. Both modes preserve equivalent outcomes without requiring identical trace text.
- [x] Run pnpm exec node --test test/presenter.test.ts, then pnpm test.

### Task 5: Commands and reviewable artifacts

- [ ] Add presenter script: node src/cli.ts --presenter. Dispatch before existing scenario filtering/JSON handling; preserve scenarios, findings and mermaid behavior.
- [ ] pnpm presenter prints labelled conversations, adjacent audit evidence, outcomes and comparison for both journeys/modes. pnpm --silent presenter --json prints one JSON document with four records plus comparison, without package-manager banners. pnpm --silent presenter --markdown renders a shareable artifact from the same records. Support --run-id=<id> on presenter commands for deterministic artifact generation; otherwise use the existing wall-clock run-id convention.
- [ ] Add the smallest CLI smoke check: parse JSON, assert four expected records and LOCAL provenance. Check Markdown/JSON evidence references agree without an exact prose snapshot.
- [ ] Generate docs/presenter-comparison.md with pnpm --silent presenter --markdown --run-id=presenter-doc-2026-10-15, using stdout redirection into that file. Label it a reproducible synthetic design comparison. Inspect rendered text for explanatory gaps; structural tests alone do not judge explanation quality.
- [ ] Update protocol, README and field map with actual commands, scripted status, session restrictions, safe reason fields and reproduction instructions. Keep employer/payer minimisation explicit.
- [ ] Mark only the scripted presenter backlog item implemented after all gates pass. Keep clickable UI, merchant commitments, protocol integration and ECB reruns open. Mark B13 fixed only after repair/regression pass.
- [ ] Run pnpm test, pnpm presenter, pnpm --silent presenter --json, pnpm --silent presenter --markdown, pnpm --silent scenarios --json, pnpm findings and git diff --check. Retain a concise validation result; local checks are never ECB observations.

## Acceptance and stopping point

Complete when another developer can reproduce the four records/comparison; every visible claim has permitted, earlier evidence; the delivered agent handle cannot approve/spend/change instructions or mutate retained state; changed offers require renewed approval; funding loss never shifts cost; and pending remains explicit until authoritative mock confirmation. Existing tests must remain green.

This completes the prepared exploration artifact. It establishes neither live AI capability, AP2/UCP integration, clickable product UI nor ECB settlement semantics. Experimentation continues independently through existing scenarios and the future private adapter.

## Deferred work and priority

1. Evidence quality: the existing per-leg reject-reason backlog item is a separate small change; resolve S04/S12 digest ambiguity before comparative infrastructure reporting.
2. Clickable presenter: reuse the session/evidence outputs if workshop needs justify UI work.
3. Merchant-signed commitments: first define payload equality, offer identity bound to approval, trusted validity/withdrawal enforcement at submission and merchant re-signing. A signature alone does not implement these semantics.
4. Agent protocols/live LLM: require an identified research question, verified protocol mapping and separate network-enabled integration. Local field vocabulary is not protocol support.
5. Platform payees, autonomous mandate-only purchases and presenter budget revision: separate model decisions. Current benefit purchases retain an employee approval share even at zero personal amount; deferral is a scope choice, not a claim of existing vacuous approval.

## Planning assumptions and review record

- The accepted review authorises revising this plan and backlog scope, not executing implementation tasks.
- A prepared synthetic trace plus comparison is the minimum exploration artifact; CLI/JSON/Markdown is sufficient. Application wording/eligibility fields are unchanged.
- Keep the employee instruction at €8; choose C instead of the optional budget-revision branch.
- No external protocol-conformance claim is needed. Local code and the experiment protocol govern implementation.
- Review loop: 3 of 10 iterations; iteration 1 mode: reviewed provided plan; questions asked: 0 of 3; stop reason: stabilized. Iteration 1 rewrote the plan around session ownership and application outputs. Iteration 2 added the manual path's shared read operations, moved submission-dependent isolation checks behind execution implementation, and specified reproducible CLI artifact generation. Iteration 3 found no further substantial changes after checking contracts, local links/anchors, task order and scope. Documentation whitespace checks passed; implementation tests are future task gates, not evidence that the presenter exists.
- No unresolved product decisions are required for this slice; deferred items need separate scope decisions.
