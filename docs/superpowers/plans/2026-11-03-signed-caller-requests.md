# Signed Caller Requests Implementation Plan

> **For agentic workers:** Use an available task-by-task execution workflow when implementation is requested. Steps use checkbox (`- [ ]`) syntax for tracking. This plan does not authorize implementation, delegation, commits or publication by itself.

**Goal:** Every call that starts or ends a purchase names its caller, carries that caller's signature, and is checked and logged by the coordinator. Today `propose`/`proposeSplit`/`changeOffer`/`cancel`/`refund`/`submit` take no caller, so the trace shows the coordinator initiating them itself.

**Architecture:** `src/core/coordinator.ts` keeps the mutation and authorization seam. A new `verifyRequest` helper is the single check for signed lifecycle requests: signature against the caller's registered key, binding to `purchaseId` + proposal version, and membership in a per-call allowed-signer set. `src/core/types.ts` gains the request payloads and the new `Proposal` fields (`proposedBy`, `submitPolicy`, `settlementMode`, `amountsFrom`). `src/scenarios.ts` gains signing helpers (`proposeAs`, `proposeSplitAs`, `changeOfferAs`, `cancelAs`, `refundAs`, `submitAs`) in the style of `approveAs`, plus payee/agent keys in `world()`. `src/presenter/session.ts` signs per channel (agent under its grant, or the employee's device key).

**Tech Stack:** Existing Node.js >= 23.6, native TypeScript stripping, `node:test`, pnpm; no new dependencies, build step, network or real data.

**Source of truth:** The reviewed "signed caller requests" spec (conversation-supplied, reproduced in the Decisions section below), plus the three decisions confirmed with the user during planning: (1) `on_ready` self-submission fires the coordinator's own `submit()` at the ready transition with `settlementMode` carried in the signed proposal, and a new `coordinator.idle()` drains in-flight self-submissions; (2) an agent-signed `propose` must carry a `Signed<DelegationGrant>` the coordinator verifies end-to-end; (3) `world()` registers keys for merchants and the platform so payees can sign refund requests.

**Status:** Not started; per-task progress is tracked by the checkboxes below.

---

## Execution rules and dependency order

This is one coordinated seam change executed in three tasks. Task 1 lands the machinery additively — legacy unsigned signatures keep working so the suite stays green. Task 2 migrates every caller and removes the legacy branches — the suite is green only when every consumer moves together (the same coordinated-cutover rule as the purchase-store plan's task 5). Task 3 adds the new scenarios, docs and regenerated digests.

```text
1. Signed-request plumbing (additive) + focused tests
2. Caller migration + enforcement cutover
3. New scenarios + docs + digests
```

Use `rtk` for shell commands. Each task must leave `rtk pnpm test` and `rtk pnpm scenarios` green. Establish the baseline first. No new dependencies; no ECB adapter code; trace events stay `LOCAL` and never imply ECB capability.

## File ownership

| File | Intended responsibility |
| --- | --- |
| `src/core/types.ts` | `SubmitPolicy`, `AmountsFrom`, `RequestKind`, `SignedRequest`, `DelegationGrant`, per-kind request payloads (`ProposeRequest`, `SplitRequest`, `ChangeOfferRequest`, `CancelRequest`, `RefundRequest`, `SubmitRequestPayload`), new `Proposal` fields. |
| `src/core/coordinator.ts` | `verifyRequest` + `request_refused` event, delegation-grant check, signed entry points, proposer-approval coverage, `maybeAutoSubmit` + `idle()`, comments on coordinator-owned calls. |
| `src/scenarios.ts` | `world()` payee/agent signers, `submitPolicy`/`settlementMode` world defaults, signing helpers, scenario migrations and new scenarios, `FIXTURE_VERSION` bump. |
| `src/presenter/session.ts` | `signAsAgent`/`signAsPrincipal` callbacks, channel-aware request signing, `userFlow.cancel`, runner submit-policy branches. |
| `src/presenter/journeys.ts` | Session wiring for the new callbacks/options only; no journey logic change. |
| `test/` | `test/signed-requests.test.ts` (new) owns the new-seam coverage; all other files migrate call sites in task 2. |
| `docs/initiation-model.md` | Who-signs-what table. |
| `docs/presenter-comparison.md` | Regenerated in task 3. |
| `docs/backlog.md` | One entry recording this change. |

## Contract choices used by the tasks

1. **`SignedRequest` binding.** Every lifecycle request payload carries `{ kind, purchaseId, proposalVersion, by }` plus kind-specific terms. `proposalVersion` is the committed version the request targets: `1` for a proposal creating a purchase (no committed version exists), the current version for change/cancel/refund/submit. Kinds: `'propose' | 'propose_split' | 'change_offer' | 'cancel' | 'refund' | 'submit'`. The signed submit payload is named `SubmitRequestPayload` (the backend's leg `SubmitRequest` already exists).
2. **`verifyRequest(signed, expected)`** is the single private check. Expected carries `{ kind, purchaseId, proposalVersion, signers: readonly string[] }`. Order: signature verifies under `by`'s registered key else `bad_signature`; `kind`/`purchaseId`/`proposalVersion` match — wrong version is `stale_version`, wrong kind or purchase is `not_authorized`; `by` in `signers` else `not_authorized`. Every refusal logs `request_refused { kind, purchaseId, by, reason, now }` and throws `Error(reason)`; the refund-by-payer refusal's message carries the hint that payers request returns through `dispute()`.
3. **`Proposal` gains** `proposedBy: string`, `submitPolicy: SubmitPolicy`, `settlementMode: SettlementMode`, `amountsFrom?: AmountsFrom` (splits only). Optional during task 1 (unsigned transitional proposals lack them), required in task 2 once every proposal is signed-created. The `proposal` trace event gains `proposedBy`, `submitPolicy` and `amountsFrom` where present; `changeOffer` also logs the signer (`by` = new version's `proposedBy`).
4. **`propose(signed)`** — `by === payload.employeeId` is enough; otherwise `by` must name an agent and the payload carries `grant: Signed<DelegationGrant>` which the coordinator verifies in full: grant signature under `employeeId`, `agentId === by`, `principalId === employeeId`, `purchaseId` matches, `capabilities` includes `'propose'`, not expired — any failure is `not_authorized` (grant signature failure is `bad_signature`). `DelegationGrant` lives in `types.ts`; the presenter's `AgentGrant` structurally satisfies it.
5. **`proposeSplit(signed)`** — `by` must appear in `shares[].payerId`, else `proposer_not_a_payer`. `amountsFrom: 'proposer'` means the shares carry explicit amounts and the proposer's signature itself is their approval of their own shares — recorded as an `approval_recorded` event with `source: 'proposal'`, and payer coverage sees it without an `Authorization` entry. `amountsFrom: 'equal_split'` means the payload carries `totalCents` and shares without amounts; the coordinator computes `equalShares` and records no approval.
6. **Proposer-approval coverage.** A proposal signed with `amountsFrom: 'proposer'` covers `proposedBy`'s shares: the ready check in `commitProposal`, `refreshAuth` and `approve` (today `approvers(q).every(id => authorizations.some(...))`) gains `|| (proposal.amountsFrom === 'proposer' && proposal.proposedBy === id)`. `firstHandoffRefusal` treats a proposal-covered leg as holding valid authority (the proposal the submission froze is unchanged while that version lives). `authorityRef` for such a leg returns a distinct proposal reference, e.g. `proposal:<purchaseId>:v<version>` — never a fabricated `appr-` approvalRef.
7. **`changeOffer(purchaseId, signed)`** — expected signers are `{ proposal.merchantId, proposal.proposedBy, benefit?.employeeId }` (the merchant of record for new price/expiry; the proposer or employee for a different offer). Bound to the current version; a stale request gets `stale_version`. Version bump and approval voiding unchanged; the new version's `proposedBy` is the signer.
8. **`cancel(purchaseId, signed)`** — expected signers are every `shares[].payerId` of the purchase. Pre-submission rule unchanged; the `state` transition to `cancelled` gains `by`.
9. **`refund(purchaseId, signed)`** — expected signers are every `shares[].payeeId` of the purchase. A signer who is a payer but no payee gets `not_authorized` with the `dispute()` hint in the message and the `request_refused` detail. Return mechanics unchanged; the request logs `by` (e.g. a `refund_requested` event or on `refund_completed`).
10. **`submit(purchaseId, request?)`** — mode is `proposal.settlementMode`, no longer an argument (task 2 removes the parameter; task 1 keeps `submit(p, mode?, request?)` transitional). `on_request`: the request is required, verified as a payer-signed request bound to the current version; the `submit` event gains `{ trigger: 'request', by }`. `on_ready`: a request is not needed; the coordinator self-fires `submit()` when the purchase becomes `ready` — fired from the ends of `commitProposal`, `approve` and `refreshAuth` (the three places a purchase becomes ready), guarded by the purchase's `inFlight` membership and a once-per-ready `autoSubmitFired` guard so a pre-dispatch rollback to `ready` cannot spin a retry loop; failures are caught and logged `submit_auto_refused`, never unhandled rejections. Self-fired submissions are tracked in `autoOps`; `async idle()` drains them (`await Promise.allSettled` until empty) for scenarios and tests. Under `on_ready` the `submit` event logs `trigger: 'auto'`.
11. **`world()` signers** — add keypairs for `MERCHANT_A`, `MERCHANT_B`, `MERCHANT_C`, `PLATFORM` and `'agent-1'` alongside the existing payers/employer, so payees and agents hold registered keys. `World`/`WorldOptions` gain `submitPolicy` (default `'on_request'`) and `settlementMode` (default `'atomic'`).
12. **Signing helpers** — `proposeAs`, `proposeSplitAs`, `changeOfferAs`, `cancelAs`, `refundAs`, `submitAs`, in `approveAs`'s style: build the payload, `signPayload` with the named party's key — a party with no registered key signs with an unregistered one, which the coordinator rejects (that is how the bad-signature negative works). `submitPolicy`/`settlementMode` default to the world's values and take per-call overrides.
13. **Presenter signing** — `PresenterSessionOptions` gains `submitPolicy`/`settlementMode` (defaults `'on_request'`/`'atomic'`) and two callbacks: `signAsPrincipal(payload)` (employee's device key) and `signAsAgent(payload)` (agent's key). `selectImpl` signs the `ProposeRequest`/`ChangeOfferRequest` by channel — agent channel signs as the agent and attaches the session's stored `Signed<AgentGrant>` as `grant`; user channel signs as the employee. `userFlow.submit` signs a `SubmitRequestPayload` with the principal key. New `userFlow.cancel()` signs a `CancelRequest`. Runner: under `on_ready` it never submits (the coordinator fired at ready); under `on_request` it sends a signed submit request only while standing-terms evidence is currently valid — the exact condition it uses today.
14. **Unchanged calls** — `dispute` keeps its principal argument (spec: unchanged). `reconcile`, `resubmit`, `recover` are the coordinator's own post-failure work: their comments say so; they take no caller signature.

## Task 1: Signed-request plumbing (additive) + focused tests

**Files:** Modify `src/core/types.ts`, `src/core/coordinator.ts`, `src/scenarios.ts` (world + helpers only, no scenario changes). Create `test/signed-requests.test.ts`.

**Contract protected:** Every lifecycle request that arrives signed is verified against the caller's registered key and bound to the purchase and proposal version — the session's identity alone is never enough. Legacy unsigned calls keep working in this task; enforcement is task 2's cutover.

- [x] `types.ts`: add `SubmitPolicy`, `AmountsFrom`, `RequestKind`, `SignedRequest`, `DelegationGrant`, `ProposeRequest`, `SplitRequest`, `ChangeOfferRequest`, `CancelRequest`, `RefundRequest`, `SubmitRequestPayload` per contracts 1/4/5; extend `Proposal` with the contract-3 fields as **optional** this task.
- [x] `coordinator.ts`: implement `verifyRequest` per contract 2 (with the `request_refused` event) and the delegation-grant verification per contract 4.
- [x] `propose`: accept `ProposeInput | Signed<ProposeRequest>` (discriminate on `'payload' in arg`); the signed path verifies per contract 4 and stores `proposedBy`/`submitPolicy`/`settlementMode` on the committed proposal.
- [x] `proposeSplit`: same union; signed path per contract 5 — `proposer_not_a_payer` refusal, `equalShares` computation for `amountsFrom: 'equal_split'`, `approval_recorded { source: 'proposal' }` for `amountsFrom: 'proposer'`.
- [x] Approver coverage per contract 6 at all three `approvers(q).every(...)` sites plus `firstHandoffRefusal` and `authorityRef`.
- [x] `changeOffer`: accept `signed` variant per contract 7 (legacy shape retained).
- [x] `cancel`/`refund`: accept optional `signed` per contracts 8/9; when present, verify first.
- [x] `submit`: accept `submit(purchaseId, mode?, request?)`; when `proposal.submitPolicy` is defined, mode comes from `proposal.settlementMode` and contract 10's policy rules apply (`request` required under `on_request`, logged `trigger`/`by`); when undefined, today's `(purchaseId, mode)` behaviour stands.
- [x] `maybeAutoSubmit` + `autoOps` + `autoSubmitFired` + `idle()` per contract 10.
- [x] Comments on `reconcile`/`resubmit`/`recover` stating they are the coordinator's own post-failure work and take no caller signature.
- [x] `scenarios.ts`: `world()` registers signers/keys for `MERCHANT_A`, `MERCHANT_B`, `MERCHANT_C`, `PLATFORM`, `'agent-1'` per contract 11; `World`/`WorldOptions` gain `submitPolicy`/`settlementMode`; add the six signing helpers per contract 12. **No scenario or `lunch()` changes this task.**
- [x] `test/signed-requests.test.ts`: signature checks — bad signature refused `bad_signature` with `request_refused` logged; non-payer split proposer refused `proposer_not_a_payer`; request for a superseded version refused `stale_version`; caller rules — a payer may `cancelAs` (state `cancelled`, event carries `by`), a payee may `refundAs` (`returnStatus` progresses), a payer's refund is `not_authorized` and the error names `dispute`, a non-payer submit under `on_request` is `not_authorized`; proposer-approval — an `amountsFrom: 'proposer'` split is `ready` at proposal and `approval_recorded` carries `source: 'proposal'`, an `equal_split` proposal waits for every payer; submit policies — `on_ready` self-submits after `approveAs` (`await w.coordinator.idle()`, `submit` event `trigger: 'auto'`), `on_request` requires and accepts a payer's signed request (`trigger: 'request'`, `by`); agent grant — a `propose` signed by `agent-1` with a valid `grant` is accepted and logged `proposedBy: 'agent-1'`, the same without/with a mismatched grant is `not_authorized`.
- [x] `rtk pnpm exec node --test test/signed-requests.test.ts`, then `rtk pnpm test` and `rtk pnpm scenarios` — all green; zero changes to existing tests or scenarios.

## Task 2: Caller migration + enforcement cutover

**Files:** `src/core/coordinator.ts`, `src/core/types.ts` (proposal fields required), `src/scenarios.ts` (all scenario `run` bodies + `lunch` + `createScenarioSession`), `src/presenter/session.ts`, `src/presenter/journeys.ts`, all of `test/` (`coordinator-concurrency.test.ts`, `invariants.property.test.ts`, `defects.test.ts`, `psp.test.ts`, `split.test.ts`, `autopay*.test.ts`, `presenter*.test.ts`, `employee-mandate.test.ts`, `purchase-store.test.ts`, `scenarios.test.ts`, `views.test.ts`, `quote.test.ts`, `run-record.test.ts`, `findings.test.ts`, `mermaid.test.ts`, `verified-authority.test.ts`, `backend-port.test.ts`, `mock-backend.contract.test.ts`, `ucp-catalog.test.ts`).

**Contract protected:** Every call that starts or ends a purchase arrives signed by an authorised caller; unsigned calls no longer exist. One task lands the whole migration — do not commit it split from its consumers.

- [x] Enforce signatures: `propose(signed)`, `proposeSplit(signed)`, `changeOffer(purchaseId, signed)`, `cancel(purchaseId, signed)`, `refund(purchaseId, signed)`, `submit(purchaseId, request?)`. Remove every legacy/union branch and the `mode` parameter — `p.proposal.settlementMode` is the only mode source.
- [x] `Proposal` fields become required (`proposedBy`, `submitPolicy`, `settlementMode`; `amountsFrom` stays splits-optional). `commitProposal` receives them from the verified request — pass the verified `by`/policy/mode/amountsFrom through, don't re-derive from unverified input.
- [x] `scenarios.ts`: `lunch()` becomes `proposeAs(w, EMPLOYEE, …)`; every scenario's proposal carries `submitPolicy`/`settlementMode` (world defaults `'on_request'`/`'atomic'`, overridden per call where the scenario needs `'independent'` — S05, S07, S14 — or `'on_ready'`). Specific mappings: S03 `proposeSplitAs(w, {…, amountsFrom: 'equal_split', totalCents: 4_000}, EMPLOYEE)` with skeleton shares and all three `approveAs`; S09 first `changeOfferAs` signed by `MERCHANT_A`, the pick signed by `EMPLOYEE`; S12 `amountsFrom: 'proposer'`, drop the employee's `approveAs`, keep the colleagues'; S17 `refundAs(w, p, MERCHANT_A)`; S18 `amountsFrom: 'proposer'`, drop the `approveAs`. Every `w.coordinator.submit(...)` becomes `submitAs(w, p, EMPLOYEE)`; every `w.coordinator.cancel/refund` its `…As` counterpart.
- [x] `session.ts`: options `submitPolicy`/`settlementMode` and the `signAsAgent`/`signAsPrincipal` callbacks per contract 13; `selectImpl` takes its channel and signs `ProposeRequest` (first select, `proposalVersion: 1`) or `ChangeOfferRequest` (re-select, bound to current version) — agent channel attaches the stored grant; `submitImpl` signs the submit request with the principal key; add `userFlow.cancel()` (signed `CancelRequest`, audited like every op); runner step branches on `p.proposal.submitPolicy` per contract 13.
- [x] `journeys.ts` + `createScenarioSession`: wire `signAsPrincipal`/`signAsAgent` (`w.signers.get(...)`), `submitPolicy: 'on_request'`, `settlementMode: 'atomic'`.
- [x] Migrate all test call sites: `coordinator.submit(id, mode)` → `submitAs(w, view, payer)` with `settlementMode` moved into the proposal-creation options where a test wants `'independent'`; `coordinator.propose/proposeSplit` → `proposeAs`/`proposeSplitAs` (choose `amountsFrom` per site — `'proposer'` for explicit shares, `'equal_split'` where the test intent is every payer approving separately); `cancel`/`refund`/`changeOffer` → their `…As` helpers with the appropriate signer; `userFlow.submit`/`session.runner` call sites stay (session signs internally). Tests asserting a `ready`-at-proposal change for `amountsFrom:'proposer'` splits are adjusted to the new honest state.
- [x] `rtk pnpm test`, then `rtk pnpm scenarios` — all green; scenario outcomes unchanged from baseline, trace content differs by the new fields/events only.

## Task 3: New scenarios + docs + digests

**Files:** `src/scenarios.ts` (append scenarios), `docs/initiation-model.md`, `docs/backlog.md`, `docs/presenter-comparison.md`.

**Contract protected:** The new caller rules are demonstrated as named scenarios, and every recorded output reflects the new trace shape.

- [ ] Append scenarios (continuing the S-numbering after S28): `S29-submit-on-ready` — lunch with `submitPolicy: 'on_ready'`, `approveAs` only, `await w.coordinator.idle()`, check `completed` and the `submit` event's `trigger: 'auto'`; `S30-proposal-bad-signature` — `proposeAs` signed by an unregistered key, `bad_signature` + `request_refused`, no purchase created; `S31-split-nonpayer-proposer` — `proposeSplitAs` by a non-share payer, `proposer_not_a_payer`; `S32-cancel-nonpayer` — `cancelAs` by a non-payer, `not_authorized`; `S33-refund-by-payer` — `refundAs` by a payer on a completed purchase, `not_authorized` with the `dispute` hint in evidence; `S34-submit-nonpayer` — `submitAs` by a non-payer under `on_request`, `not_authorized`. Each `check` asserts its trace evidence, each `responsibility` states the rule shown.
- [ ] `docs/initiation-model.md`: add a "who signs what" table — propose (employee or agent under a verified `propose` grant), proposeSplit (a share's payer), changeOffer (merchant of record, or proposer/employee), approve (the payer, existing `Signed<PayerApproval>`), cancel (any payer, pre-submission), refund (any payee; payers use `dispute()`), submit `on_request` (any payer), submit `on_ready` (coordinator self-fires at ready), dispute (session employee, unchanged), reconcile/resubmit/recover (coordinator's own post-failure work).
- [ ] Bump `FIXTURE_VERSION` to `2026.11-2` with a comment (caller-signed requests; proposals carry `submitPolicy`/`settlementMode`/`proposedBy`/`amountsFrom`).
- [ ] Regenerate `docs/presenter-comparison.md` (`rtk pnpm --silent presenter --markdown --run-id=employee-mandate-v1 > docs/presenter-comparison.md`); review the diff — new fields/events and digests, no outcome changes.
- [ ] `docs/backlog.md`: one entry recording the change (signed lifecycle requests, `verifyRequest`, proposer-approval, `submitPolicy`/`settlementMode`, payee/agent keys, presenter channel signing).
- [ ] Final validation: `rtk pnpm test`, `rtk pnpm scenarios`, `rtk pnpm --silent findings`, `rtk git diff --check`.

## Assumptions

- `settlementMode` moving into the signed proposal is a user-confirmed decision (an `on_ready` self-submission needs a mode source; binding it into the signed terms also means payers sign off on atomic-vs-independent semantics). `submit(p, mode)` loses its parameter.
- The transitional dual-signature window inside task 1 is deliberate so the task boundary stays green; task 2 removes it in the same commit that migrates every caller — there is no commit where signed calls exist but the old paths are reachable by real callers.
- `changeOffer` stays benefit-only (splits throw `split purchases cannot be repriced`), so its signer set is `{ merchantId, proposedBy, employeeId }`.
- Refund signing is by payee id: the fixture registers merchant/platform keys; a payee that is also a payer id is allowed (it is the payee role that authorises).
- Cancel stays "any payer" including the employer payer on a benefit purchase.
- Digest changes are expected: new trace fields/events shift `docs/presenter-comparison.md`, regenerated in task 3 — tests assert determinism, not pinned values.
