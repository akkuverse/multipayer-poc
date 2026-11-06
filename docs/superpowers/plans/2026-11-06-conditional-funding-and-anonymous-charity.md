# Conditional Funding and Anonymous Charity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` when implementation is requested. Steps use checkboxes for tracking future work. This document does not start implementation or authorize commits, delegation or publication.

**Goal:** Implement signed conditional funds and one-allowance charity purchases, preserving settlement safety and enforcing the two new disclosure profiles.

**Architecture:** A pure funding module owns pledge identity, lapse, threshold evaluation and irreversible roster closure through one decision interface. Existing authority, policy, ledger and privacy modules own charity verification, contribution selection, accounting and disclosure. The coordinator applies decisions and admits frozen intents; the existing settlement module remains the sole owner of payment outcomes, uncertainty, replay and recovery.

**Tech Stack:** Node.js native TypeScript stripping, `node:crypto`, `node:test`, pnpm; zero new dependencies. Runtime floor remains Node >=23.6; explorer generation requires exactly Node 24.6.0 from `tools/explorer/toolchain.json`.

---

## Status and provenance

Planning only, 6 November 2026. Source of truth: [conditional pledging and anonymous charity spec](../specs/2026-11-06-conditional-funding-and-anonymous-charity.md), including its revised timing, cancellation, replay and donor-report decisions.

Grounded in `/home/oppie/www/akku/multipayer-poc-wt/multipayer-poc` at `4e5ce6002901d18466348075a92cf5a7bfbacbb5`. The spec is untracked and `docs/backlog.md` was already modified when planning began. Preserve both. Planning-time inspection found Node 24.6.0 and pnpm 11.15.1. No implementation tests or scenario runs have been performed for this plan.

Deliver in two reviewable milestones: **funds** (Tasks 1–5), then **charity** (Tasks 6–11), followed by combined acceptance and artifact synchronization (Tasks 12–14). They share domain unions, privacy and admission seams, so keep one dependency-ordered plan rather than two competing edits to those owners. A broad coordinator extraction could reduce its size, but is a separate refactor; this plan adds only the funding module and focused private integration helpers.

## Fixed scope and assumptions

- Implement the spec's local deterministic model, S37–S45, and public-interface regression/property coverage. All new events use `LOCAL`; no provider/ECB capability or endorsement claim follows from a local pass.
- Funds require atomic settlement. Charity retains its signed mode, including independent failure/recovery. No new purchase state, generic campaign framework, alternate settlement owner or new dependency.
- One pledge ever per payer per campaign, one allowance per charity purchase. No withdrawal, top-ups, replacement pledges, donor rematching, multi-allowance split, cryptographic privacy machinery or real enrollment/oracle issuance.
- Keep existing employer/split signatures and delegated employer proposals working. Charity requests are buyer-signed only; proposal is never approval. Agents gain no fund/charity capabilities.
- Party projections minimize direct disclosure. The coordinator retains linkage; aggregate differencing and the deterministic allocation digest remain correlation risks.
- **A1 — scenario delivery:** use S37–S45 in CLI/tests and generated-core parity, with interactive explorer walkthroughs explicitly deferred. The current generator requires exact equality between all source scenarios and authored walkthroughs; Task 13 introduces an explicit deferred-scenario inventory rather than bogus walkthroughs or stale generated artifacts. This is the recommended default after the optional scope question received no answer during drafting; it is an explicit tooling contract change, not merely regeneration.
- **A2 — acknowledgment shape:** use the minimal detached `PledgeAcceptance` below; it records acceptance time/version and never changes when a pledge later lapses. Current outcome belongs in retained history and projections.
- **A3 — fixtures:** use human-readable donor labels in scenario descriptions but opaque synthetic donor identifiers in signed records and commitments. Trusted fixture configuration maps `in_need` to `oracle-1`; configuration is detached at construction and cannot be replaced during a run.

## Current code constraints

| Existing owner | Fact that changes the implementation approach |
| --- | --- |
| `Coordinator.commitProposal` | Requires positive total/nonempty shares, invalidates every authorization on version change, derives readiness from all approvers and immediately auto-submits. A collecting fund needs zero total/shares and pledge evidence that survives roster versions. |
| `Coordinator.verifyRequest` | Requires `proposalVersion`; keep this contract for existing requests and `open_fund`. A pledge needs a separate verified entry path; do not invent a dummy version. |
| `Authorization` readers | `authorizationPayer`, `VerifiedAuthority.authorization`, coordinator invalidation/admission/reference logic, privacy and presenter readers assume every non-mandate record has `.approval`. Audit all of them before introducing `basis: 'pledge'`. |
| `Coordinator.refreshAuth` | Currently handles only `p.benefit`. Funds must dispatch to funding decisions; charity must never enter employee standing-authority logic. |
| `Coordinator.runSubmission` | Checks and reserves budgets synchronously before its first await. Preserve that property; a per-purchase guard alone cannot arbitrate capacity across different purchases. |
| `authorizeFirstHandoff` / `firstHandoffRefusal` | Existing synchronous seam for live authority checks. Return a refusal to settlement; do not mutate roster or invoke pre-admission `fail()` once settlement owns the purchase. |
| `BenefitLedger` | Entries keyed by purchase ID currently contain employer reference/day/cents/state. Existing `benefitHeld` prevents rollback or release from touching another purchase's entry. Extend ownership deliberately for charity. |
| `privacy.ts` | `PayerView` always exposes total/others; sponsor projection is per-purchase. Count-only funds need a distinct payer-view shape, and donors need a separate aggregate-report interface. |
| `approveAs` / `sharesDigestOf` | The helper currently reads raw shares and computes a digest itself. Charity must sign the coordinator-projected commitment from one detached displayed snapshot. |
| Explorer generation | All `src/**/*.ts` except CLI are generated automatically; authored manifest scenarios currently equal the complete scenario set. Build/check contracts must accommodate explicitly deferred walkthroughs without dropping core scenario verification. |

## Interfaces and ownership

Names below are proposed additions, not existing exports. Keep imports type-only where possible. Do not add test-only production exports or pluggable adapters for behavior with only one implementation.

### Funding data and decision seam

Add domain records in `src/core/types.ts`; expose the pure function from new `src/core/funding.ts`. `CampaignTerms` contains every signed term, including `purchaseId`, with no defaulted omissions. Use the existing `Rail`, `Cents`, `SubmitPolicy`, `Signed<T>` and `DeepReadonly<T>` types.

```ts
export interface CampaignTerms {
  purchaseId: string;
  payeeId: string;
  condition: { minPayers?: number; minTotalCents?: Cents };
  fundingEndsAt: number;
  settleBy: number;
  acceptPledgesUntil: 'condition_met' | 'deadline';
  submitPolicy: SubmitPolicy;
  settlementMode: 'atomic';
  privacyProfile: 'public_good_pledge_v1';
}
export interface OpenFundRequest extends SignedRequest, CampaignTerms {
  kind: 'open_fund';
  proposalVersion: 1;
}
export interface PledgeRequest {
  kind: 'pledge';
  purchaseId: string;
  by: string;
  pledgeRef: string;
  campaignDigest: string;
  share: {
    role: string; payerId: string; payeeId: string;
    amountCents: Cents; feeCents: Cents; rail: Rail;
  };
  expiresAt: number;
  privacyProfile: 'public_good_pledge_v1';
}
export interface PledgeAcceptance {
  purchaseId: string; pledgeRef: string; acceptedAt: number;
  proposalVersion: number;
}
export interface AcceptedPledge {
  signed: Signed<PledgeRequest>;
  canonicalPayload: string;
  acknowledgment: PledgeAcceptance;
  outcome: 'active' | 'lapsed';
}
export interface FundingState {
  campaign: Signed<OpenFundRequest>;
  campaignDigest: string;
  terms: CampaignTerms;
  phase: 'collecting' | 'closed' | 'admitted';
  history: AcceptedPledge[];
  progress: { livePayers: number; liveTotalCents: Cents; met: boolean };
}
```

Add `Purchase.funding?: FundingState` and `{ basis: 'pledge'; pledge: Signed<PledgeRequest> }` to `Authorization`. Pledge shares use `authority: 'payer'`; their authorization basis is pledge. No new provider authority kind is needed for them. Funding history owns accepted identities/outcomes; active shares and authorizations are coordinator-applied materializations. Compare them to history in the decision snapshot to detect corrupted bindings.

```ts
export interface FundingSnapshot {
  purchaseId: string;
  purchaseState: PurchaseState;
  proposalVersion: number;
  funding: DeepReadonly<FundingState>;
  shares: readonly DeepReadonly<Share>[];
  authorizations: readonly DeepReadonly<Authorization>[];
}
export type FundingCommand =
  | { kind: 'pledge'; signed: Signed<PledgeRequest> }
  | { kind: 'evaluate' }
  | { kind: 'admit' }
  | { kind: 'check_pledge'; pledgeRef: string; share: DeepReadonly<Share> };
export interface FundingVerification {
  campaignValid: boolean;
  retained: ReadonlyMap<string, boolean>; // accepted pledgeRef -> verdict
  incomingValid?: boolean;
}
export type FundingDecision =
  | { kind: 'refused'; reason: string }
  | { kind: 'replay'; acknowledgment: PledgeAcceptance }
  | { kind: 'unchanged' }
  | {
      kind: 'apply'; funding: FundingState; shares: Share[];
      authorizations: Authorization[]; versionDelta: number;
      state: PurchaseState; failureReason?: string;
      accepted?: PledgeAcceptance;
      events: { event: string; detail: Record<string, unknown> }[];
    };
export function decideFunding(
  snapshot: FundingSnapshot, command: FundingCommand,
  now: number, verified: FundingVerification,
): FundingDecision;
```

The function owns schema/binding, replay ordering, liveness, progress and readiness. It returns detached data, never reads keys/registry/ledger, logs, advances a clock or calls settlement. Verification verdicts are explicit; a missing verdict is invalid. Caller verifies signatures using the existing signing/decision authority module. Incoming signature verification precedes replay; an exact accepted payload replay bypasses expiry, closure and evaluation, but never bypasses the operation guard. `admit` validates a closed roster and returns an admitted decision; rollback may restore **closed**, never collecting. Export decision/snapshot types with `decideFunding` from `funding.ts`; durable domain records stay in `types.ts`.

There must be no second set of pledge-binding rules at first handoff. Factor a private verifier of the pledge's signed content/bindings inside `funding.ts`; the `check_pledge` command is a **read-only decision** on a retained pledge and exact share. It returns `unchanged` when currently valid and `refused` otherwise, never an apply decision. It can inspect collecting/closed records for `authorizationCurrentlyValid`, or an admitted frozen leg for `firstHandoffRefusal`; the latter caller separately requires admitted intent identity. This fourth command refines the spec's three mutation/maintenance commands to reuse the same binding logic at both real read/handoff callers. It never evaluates/prunes the roster, even after admission. Missing or malformed history entries must fail closed, including duplicate refs/payers and mismatched materialized authorizations. Reported current liveness never erases evidence or invalidates already-forwarded settlement.

Add `campaignDigestOf(terms: CampaignTerms)` to `signing.ts`. Construct `terms` by explicitly selecting every campaign-table field from the verified opening request; never hash a spread of the envelope that accidentally includes `by`, `kind` or `proposalVersion`, and never fill omitted signed terms with defaults:

```ts
return createHash('sha256')
  .update(canonicalJson({ kind: 'fund_campaign_v1', terms }))
  .digest('hex');
```

Runtime validation rejects supplied `proposalVersion` and `cancelUntil` on pledges, independent fund mode, malformed conditions/times, noninteger cents and overflow before mutation. Required numeric comparisons: collection `now < fundingEndsAt`; authority live `now <= expiresAt`; new admission/first handoff `now <= settleBy`. Both condition clauses mean OR. Fees never count toward condition principal.

### Charity authority, policy and accounting seam

- Split existing `ProposeRequest` into `BenefitProposeRequest` (unchanged fields/grants) and `CharityProposeRequest`, discriminated by `privacyProfile`. Export `ProposeRequest` as their union. Charity fields are exactly spec §3.2; reject `grant`, `mandateRef`, `feesCents`, supplied shares/rails and allocation overrides. Add `AllowanceMandate` and `EligibilityAttestation` with every field in spec §3.1.
- Add `AuthorityKind: 'sponsor_mandate'` and the selected `Share.authorityRef` for donor shares. Retain buyer share with `authority: 'payer'` even at zero cents. Store `Purchase.charity` with buyer ID, benefit class, optional selected allowance reference and donor ID. Do not overload `Purchase.benefit` or employee assessment.
- Add registry publication/read methods: `publishAllowanceMandate`, `allowanceMandate`, `allowanceRefs`, `publishEligibilityAttestation`, `eligibilityAttestation`. Constructor accepts an optional trusted class-to-attestor map, default empty for existing callers. References enumerate only through detached strings; no allocation policy belongs here.
- Add decision-scoped `VerifiedAuthority.allowance(ref)` and `.attestation(subjectId, classId)`. Distinguish absent records from invalid retained records; temporal ineligibility is policy input, not signature absence. Ownership, issuer, lookup binding, schema, signature and accepted version must verify again at use.
- Add pure `evaluateAllowance(input)` and `selectAllowance(inputs)` to `policy.ts`. Inputs contain verified allowance/attestation records, buyer/merchant/total/time and daily/lifetime usage. Result contains donor cents and ineligibility reason; selection includes selected reference. Selection calls the same contribution calculation used for fixed-reference rechecks.
- Extend `BenefitLedger` with typed identity `{ kind: 'employer' | 'allowance'; ref: string }` for new bookings while retaining existing employer `usage`/`reserve` calls. Internally normalize legacy employer calls to employer identity; use structural equality or tuple serialization, never an unescaped string prefix that can collide with a valid employer reference. Add `allowanceUsage(ref, day, excludePurchaseId?)`, `reserveAllowance(...)` and `allowanceSummary(ref)`. The ledger owns reservation/capacity checks and detached summaries; policy consumes usage values.
- Retain a purchase-owned charity reservation flag or booking record alongside `benefitHeld`. Never release by naked purchase ID unless this purchase successfully reserved it. A reserve failure must not clean up another owner's entry. Current synchronous execution is the concurrency assumption, not a persistent transactional backend guarantee.

Contribution calculation, after checking attestation and allowance eligibility:

```ts
const daily = Math.max(0, allowance.maxPerDayCents - usage.daily.cents);
const lifetime = allowance.totalEndowmentCents === undefined
  ? totalCents
  : Math.max(0, allowance.totalEndowmentCents - usage.lifetime.cents);
const donorCents = usage.daily.purchases >= allowance.maxPurchasesPerDay
  ? 0
  : Math.min(totalCents, allowance.maxPerPurchaseCents, daily, lifetime);
// Choose largest donorCents; for a tie compare refs with < / > (code-unit order).
```

Add detached admission evidence to `Submission`: selected signed allowance, signed attestation, signed buyer approval and `bookingDay`. Refresh those records only at an unstarted donor first handoff after current terms authorize the same frozen arrangement. Freeze after forwarding; replay does not consult fresh authority. Record exact revisions via the signed payloads. Recheck the admission day, excluding only this purchase's own booking, even after the clock crosses midnight.

### Privacy interface

Extend `resolveProfile` with campaign and allowance sources, and extend `PrivacyTerms` exactly as spec §4. Add `allowanceReportFor(summary, owner, recipient)` in `privacy.ts` and `Coordinator.allowanceReport(ref, recipient)` for verified read composition. Registry verification must allow an owner to inspect revoked/expired allowance history; corrupt/unknown/unentitled records all return `allowance_report_refused` without ownership/balance detail or a trace event.

Keep the existing ordinary `PayerView` contract for employer/split consumers. Add `FundPayerView` as a distinct result in `PartyView`, not optional total fields sprayed across every caller. It exposes own pledge/expiry/outcome, public campaign terms, and only condition-authorized progress counters. Add charity payer projection with safe donor role/principal and an approval payload projection. If overloads cannot retain an ordinary payer result statically, narrow by profile at existing callers; never cast a fund into the ordinary total-bearing view.

The detached approval projection contains purchase/version/payer/merchant/total/own principal/own fee/expiry/profile, optional existing split-group reference, and coordinator-computed `sharesDigest`. It excludes raw shares, donor ID/reference and internal source. Add an `approval` field to the ordinary/charity payer result using this type; fund views carry no device-approval payload:

```ts
export type ApprovalTerms = Pick<PayerApproval,
  'purchaseId' | 'proposalVersion' | 'payerId' | 'merchantId' | 'totalCents' |
  'amountCents' | 'feeCents' | 'expiresAt' | 'privacyProfile' |
  'disclosureGroupRef' | 'sharesDigest'>;
```

`approveAs` reads one `viewFor` snapshot and signs those exact fields, adding only its approval reference/basis and existing exception acknowledgment. The existing helper call signature may still accept `PurchaseView`; immediately project it and never consume its raw allocation in the signing implementation. Funds reject this helper; they authorize through pledges. Existing exception behavior remains separately tested. Correct comments in `signing.ts` and helpers: the device countersigns a coordinator commitment, not an independently reconstructed hidden allocation.

## Execution tasks

For each task: add the named owner-interface regression, run its focused command and observe the intended missing/incorrect behavior, implement the step, then rerun the focused command. Existing tests provide backward compatibility. Avoid duplicate proof at every layer: pure decisions own truth tables, coordinator tests own ordering/lifecycle, privacy tests own disclosure, and settlement tests own money effects. Use current concrete provider fault controls and existing `holdNext` patterns; do not create test-only production hooks. Commit-sized task boundaries do not grant permission to commit.

### Task 1: Fund contracts, signatures and synthetic fixtures

**Modify:** `src/core/types.ts`, `src/core/signing.ts`, `src/core/verified-authority.ts`, `src/scenarios.ts`; authorization discriminants in `src/core/coordinator.ts`, `src/core/privacy.ts`, `src/presenter/session.ts` as required for exhaustive reads. Add the fund profile literal to `PrivacyProfileId` now; do not enable its projection until Task 5.
**Tests:** extend `test/signing.test.ts`; create `test/funding.test.ts` in Task 2.

- [x] Add the fund records and request kind shown above. Keep `PledgeRequest` outside the version-bound envelope and preserve existing approval fields/digest semantics.
- [x] Add `campaignDigestOf` using the exact canonical input above. Test changing cutoff, settlement deadline, submit policy, payee, condition or mode changes the commitment; object-key order does not. Use independently constructed signed input for mismatches.
- [x] Extend authorization discriminants explicitly: pledge payer is `a.pledge.payload.by`; signature verification is under that payer; pledge reference comes from `pledgeRef`. Do not allow the new branch to fall into `.approval` reads. Presenter code remains benefit-only and refuses unsupported arrangements before projection/assessment; it does not learn pledge actions or disclosure.
- [x] Extend `world` registration, preserving existing actor/pseudonym registration order, with `project-1`/`charity-1` payees and synthetic residents. Include every payee in keys, shops, shops-by-provider and destination routing; residents need keys, provider membership and DE holdings. Keep added fixture publications opt-in so existing lunch traces are not flooded with charity events.
- [x] Define trusted-device helpers for Task 3: `openFundAs(w, terms): string` and `pledgeAs(w, purchaseId, payerId, pledgeRef, amountCents, expiresAt, { feeCents, rail }): { signed: Signed<PledgeRequest>; acceptance: PledgeAcceptance }`. The first signs the complete `open_fund` envelope; the second reads frozen campaign terms, derives role/payee/digest, signs every share field, and returns the signed pledge plus detached acceptance. Implement these helpers with Task 3's entry points, so Task 1 does not call methods that do not exist yet. Tests needing malformed input sign it directly.

Run: `rtk proxy node --test test/signing.test.ts test/signed-requests.test.ts test/presenter-session.test.ts`. Expected: all pass; old delegated employer behavior is unchanged.

### Task 2: Pure funding decisions

**Create:** `src/core/funding.ts`, `test/funding.test.ts`.
**Depends on:** Task 1's types/signing.

- [x] Implement `decideFunding` using the interface above, including the read-only `check_pledge` command. On pledge input: verify incoming signature verdict and forbidden envelope fields; find an accepted reference and compare canonical payload **before** live-roster binding/expiry checks. Equal payload returns replay, different content is `pledge_ref_conflict` even when the changed field would independently mismatch campaign terms. New references then undergo complete schema/binding and prior-payer checks. References are consumed only by acceptance. Retained evidence validation and temporal evaluation run only for a new valid mutation.
- [x] While collecting, reject corrupted retained **active** evidence as whole-purchase failure; lapse expired pledges as one version bump per batch; retain history; recompute principal/count with safe arithmetic. Validate the new pledge completely before applying any lapse or append; a refused new request cannot incidentally mutate funding or auto-submit. For a valid new pledge, lapse existing expired entries, append with one additional version bump, then evaluate the combined roster exactly once. Do not close the roster between pruning and append. Compute its acknowledgment after that append's version, before any asynchronous auto-submit. Reject version/count overflow as well as principal/fee overflow before mutation.
- [x] Evaluate in this order: terminal/admitted no-op; retained binding verification; collecting lapse; `now > settleBy` failure; early closure only for `condition_met`; at/after cutoff close and resolve condition. Under `deadline`, an early met condition is progress only. Empty at cutoff fails without money effects.
- [x] In closed phase, never prune or bump version. Any retained expiry, corrupted authority, changed binding, unmet condition or settlement expiry fails the whole purchase. `admit` requires closed/live/met; successful admission sets phase admitted without changing proposal version.
- [x] Cover the matrix below with table-driven owner tests, using explicit expected principal/count/state/version deltas rather than computing expectations via `decideFunding`.

| Input | Independent expected result |
| --- | --- |
| Two live payers at 300 and 700, `minPayers: 2` | Met; total principal 1000; fees excluded; close only under threshold mode |
| `minPayers: 3, minTotalCents: 1000`, two payers above | Met by OR; no requirement to satisfy both |
| Expiry equals now / now advances beyond expiry | Live at equality / lapsed only while collecting; one lapse-batch bump |
| Deadline-mode pledge expiry equals cutoff | Refuse `pledge_expiry_invalid`; reference remains free |
| Exact accepted replay after closure or lapse | Original acknowledgment; no events, evaluation, shares or version change |
| At cutoff new pledge / delayed evaluation beyond settleBy | No append / settlement-expired failure, no intent |
| Closed roster loses one pledge but remaining total still meets | Whole purchase fails; frozen roster and version preserved |
| Admitted or terminal evaluation | Unchanged; no verification-driven roster edits |
| Unsafe principal+fee or roster sum; zero/negative principal | Refusal before acceptance; original snapshot unchanged |

Run: `rtk proxy node --test test/funding.test.ts`. Expected: all decision cases pass with input snapshots unmodified.

### Task 3: Open, pledge, evaluate and cancel through Coordinator

**Modify:** `src/core/coordinator.ts`, `src/scenarios.ts`, `src/core/privacy.ts` (campaign source resolution only).
**Create:** `test/fund-coordinator.test.ts`.
**Extend:** `test/purchase-store.test.ts`, `test/signed-requests.test.ts` only for distinct store/envelope risks.

- [x] Implement `openFund(signed): string`, `pledge(signed): PledgeAcceptance`, and `evaluate(purchaseId): void`, plus the Task 1 helpers. Add campaign-source `resolveProfile` and frozen campaign `PrivacyTerms` now so opening does not depend on the later projection task. Verify signed envelopes before evaluating or changing funding state. Opening requires the payee signer, registered key, version 1, valid complete terms, atomic mode and unused purchase ID. Validate runtime policy/mode values even though TypeScript literals narrow them.
- [x] Refactor `commitProposal` into explicit ordinary/fund modes while retaining it as the only `.proposal =` writer, with `adopt`/`transition` as the only `.state =` writers. `test/purchase-store.test.ts` enforces these named write owners. Permit zero total/empty shares only for fund opening or a validated **collecting-origin** roster decision, including lapse of the final share followed by deadline failure; never admit an empty ready roster. Add private `applyFundingDecision` that delegates actual proposal changes to this writer with the decision's **exact** version delta, then applies history/authorization/index/trace changes once. Decisions changing only phase/progress/state do not rewrite the proposal or advance its version. No generic readiness recalculation, authorization clearing or premature auto-submit on the fund path. Extract shared private index maintenance if needed, without relaxing the existing write-path lint. Ordinary commits retain their present invalidation/readiness behavior.
- [x] Keep `byPayer` consistent after acceptance/lapse and remove terminal entries through existing transitions. Lapsed-party privacy entitlement uses retained history, not the active payer index. Check that live read-only views reflect the updated roster but cannot mutate it.
- [x] Enforce `requireIdle` and a synchronous mutation guard for funding calls. Apply decisions and release the guard before invoking `maybeAutoSubmit`. Do not start an auto-submit midway through applying shares/history/indexes; keep `idle()` tracking and once-per-version behavior.
- [x] Route fund refresh through `decideFunding`; reject generic approval with `fund_requires_pledge`; refuse offer changes. Fund cancellation verifies current-version payee authority, then cancels before any evaluation/auto-submit. Contributors cannot cancel, even when also the only active payer. Nonfund cancellation keeps existing behavior.
- [x] Add `fund_opened`, `pledge_recorded`, `pledge_lapsed`, `funding_evaluated`, `funding_succeeded`, `funding_failed` with `LOCAL` origin. Do not emit anything for an accepted replay. Record refusals through existing request events, never as successful acceptance.

Core integration assertion using helpers introduced in Task 1:

```ts
const id = openFundAs(w, {
  purchaseId: 'fund-count', payeeId: 'project-1', condition: { minPayers: 2 },
  fundingEndsAt: 20, settleBy: 30, acceptPledgesUntil: 'condition_met',
  submitPolicy: 'on_request', settlementMode: 'atomic',
  privacyProfile: 'public_good_pledge_v1',
});
assert.equal(w.coordinator.view(id).state, 'awaiting_approvals');
assert.equal(w.coordinator.view(id).proposal.totalCents, 0);
const first = pledgeAs(w, id, 'resident-1', 'r1', 300, 30,
  { feeCents: 0, rail: 'digital_euro' });
pledgeAs(w, id, 'resident-2', 'r2', 700, 30,
  { feeCents: 0, rail: 'digital_euro' });
assert.equal(w.coordinator.view(id).state, 'ready');
const events = w.trace.events.length;
assert.deepEqual(w.coordinator.pledge(first.signed), first.acceptance);
assert.equal(w.trace.events.length, events);
assert.equal(w.coordinator.view(id).proposal.totalCents, 1000);
```

Run: `rtk proxy node --test test/fund-coordinator.test.ts test/purchase-store.test.ts test/signed-requests.test.ts`. Expected: all pass; existing zero-total ordinary proposal refusals still hold.

### Task 4: Fund admission and delayed first handoff

**Modify:** `src/core/coordinator.ts`, `src/core/types.ts` (frozen pledge evidence if needed).
**Extend:** `test/fund-coordinator.test.ts`, `test/coordinator-concurrency.test.ts`.

- [ ] In guarded `runSubmission`, request the funding `admit` decision in the same synchronous stretch as intent construction. Validate the signed campaign/digest, exact closed shares, every live pledge, condition and settleBy; bypass no check through generic approver readiness. Retain signed pledges with the frozen submission.
- [ ] Build normal payable legs with their final roster version and `pledge:<ref>` roles. Keep existing `${purchaseId}:v${version}:${role}` keys and atomic orchestration. Funding phase becomes admitted before yielding to settlement, including when the purchase state has not yet received its first pending snapshot.
- [ ] A conclusive orchestrator rejection before intent registration restores the same closed phase and clears only this attempt's unadmitted work. No membership/version change or auto-refire loop. Any returned snapshot keeps admitted funding state and original intent; repeated evaluation is inert.
- [ ] Add the pledge branch to `firstHandoffRefusal`: obtain current signature verdicts and invoke the funding module's read-only `check_pledge` command with the exact frozen share. Return refusal to the orchestrator, which unwinds earlier reservations. Do not reproduce pledge binding logic in the coordinator or call funding evaluation to prune after admission.
- [ ] Test before-dispatch expiry, response loss followed by expiry, rollback and explicit retry, atomic refusal/compensation, fee-bearing pledge and both rails. Assert provider effects, unchanged keys/roster/evidence, and no new charge on replay. Distinguish provider-unavailable/conclusively-unstarted work from forwarded work with unknown outcome using authoritative operation evidence; a timeout alone cannot classify either. Hold real operation seams as existing concurrency tests do; prove `pledge`, `evaluate`, refresh, cancel and submit refuse `operation_in_progress` while another operation owns the same purchase.

Run: `rtk proxy node --test test/fund-coordinator.test.ts test/coordinator-concurrency.test.ts test/settlement-orchestrator.test.ts test/settlement-port.test.ts`. Expected: all pass; timeout remains pending/uncertain until authoritative observation, never funding failure.

### Task 5: Fund recipient projections

**Modify:** `src/core/privacy.ts`, `src/core/types.ts`; adapt ordinary callers only where static narrowing requires it.
**Extend:** `test/privacy.test.ts`, `test/views.test.ts`.

- [ ] Complete the campaign-source support started in Task 3: `checkedTerms` validates profile/source, complete campaign terms and consistent campaign binding; `checkedAudience` retains its known-group-only logic. Refuse malformed retained source data instead of falling through into split behavior.
- [ ] Construct the fund payer result from an explicit allowlist. Entitle active or historically accepted pledgers; return own original pledge, expiry/lapse outcome, own settlement outcome and public campaign terms. Count-only progress contains contributor count, budget-only contains principal total, both contains both. Do not spread an ordinary `PayerView` or internal funding history into it.
- [ ] Payee receives anonymous contribution items and funding outcome. Refuse fund sponsor facet and outsiders. Reading progress must not evaluate, lapse, reserve, emit events or auto-submit.
- [ ] Use nonuniform pledge amounts and fees in privacy regressions so accidental total/others/fee leakage is detectable. Check absence of `totalCents`, `othersCents`, other payer IDs/amounts and raw signatures in count-only views; clone/mutate a returned projection and prove retained purchase state is unchanged.

Run: `rtk proxy node --test test/privacy.test.ts test/views.test.ts test/fund-coordinator.test.ts`. Expected: both old profiles and new fund disclosure rules pass. Funds milestone is complete only when Tasks 1–5 pass together.

### Task 6: Allowance publication and trusted attestations

**Modify:** `src/core/types.ts`, `src/core/authority.ts`, `src/core/verified-authority.ts`, `src/scenarios.ts`.
**Create:** `test/charity-authority.test.ts`.
**Extend:** `test/verified-authority.test.ts` for decision-scope freshness.

- [ ] Implement the registry interface described above with acceptance-time owner/class/version and subject/class/issuer/version metadata separate from mutable records. Validate every field before indexing. Keep reference exclusivity across employer, employee and allowance publication in **both** directions, including employee reference changes.
- [ ] Permit first version 1 and exactly next version thereafter; require original donor and class or original trusted issuer. Reject malformed signed amounts/counts/windows/merchant lists, unsupported profiles, wrong signer, wrong issuer and rollback without replacing accepted records. Emit registry-owned acceptance/rejection events with record identity/revision and `LOCAL` origin.
- [ ] Copy the configured class-to-issuer map once. A registered signing key does not confer attestor privilege. Lookups validate stored subject/class/reference against the requested key and immutable accepted metadata, not just against fields inside the signed record.
- [ ] Add use-time verification and per-decision memoization. Return missing distinctly; corrupt/untrusted/schema-invalid records refuse. New verified scopes after an await or publication must see changed keys/records. Clone evidence before retaining it on purchases.
- [ ] Register opaque donor fixture identifiers under readable labels `donor-1/2`; give donors bank-funded providers. Add opt-in signed allowance/attestation fixture helpers and oracle/resident keys. Do not change employer publication or automatically publish donor records into all worlds.

Test table: buyer self-attestation; registered wrong issuer; wrong class/subject; owner takeover; cross-kind alias each direction; stale/skipped revision; valid revocation; signed malformed windows/caps; retained corruption; rejected update preserves accepted version; external mutation of constructor trust map has no effect. Existing authority tests do not cover these new document/trust rules.

Run: `rtk proxy node --test test/charity-authority.test.ts test/verified-authority.test.ts test/employee-mandate.test.ts`. Expected: all pass with existing authority compatibility intact.

### Task 7: Allowance lifetime accounting and pure selection

**Modify:** `src/core/ledger.ts`, `src/core/policy.ts`.
**Create:** `test/allowance-ledger.test.ts`, `test/allowance-policy.test.ts`.

- [ ] Extend ledger entries with collision-safe authority identity, original booking day and reserved/consumed state. Preserve old employer usage/reserve semantics. Add daily/lifetime usage and all-days reserved/consumed summaries. Exclusion applies only to the matching booking of the requested allowance and purchase.
- [ ] `reserveAllowance` accepts purchase ID, allowance reference, booking day, cents and the current daily/lifetime cap values; recheck capacity synchronously and reject duplicate IDs or overflow before inserting. No partial entry on refusal. `consume` is idempotent; `release` removes a confirmed releasable booking once. Coordinator ownership gates remain mandatory.
- [ ] Implement policy using the formula above; require matching live trusted subject/class, live allowance, eligible merchant and donor distinct from buyer. Choose greatest positive contribution and code-unit reference tie-break. No candidate means zero donor contribution, not implicit buyer authorization.
- [ ] Verify exact examples: 100 vs 1000 contribution selects 1000 even with later reference; equal contributions select the same reference in reversed insertion order; lifetime cap 1500 with 600 consumed/400 reserved leaves 500; reduced cap below 1000 usage leaves zero; purchase-count exhaustion yields zero even if cents remain. Revision does not enter the ledger key.
- [ ] Ledger tests independently assert summary state after reserve/consume/release across two days, duplicate reservation refusal, cap failure with unchanged entries and exclusion of only the owning purchase. Policy tests own eligibility/ranking arithmetic; do not retest coordinator settlement here.

Run: `rtk proxy node --test test/allowance-ledger.test.ts test/allowance-policy.test.ts test/quote.test.ts test/defects.test.ts`. Expected: all pass; existing employer daily-limit and collision regressions remain green.

### Task 8: Charity proposal, safe approval projection and explicit consent

**Modify:** `src/core/types.ts`, `src/core/coordinator.ts`, `src/core/privacy.ts`, `src/core/signing.ts`, `src/scenarios.ts`; benefit-specific types in `src/presenter/session.ts`.
**Create:** `test/charity-coordinator.test.ts`.
**Extend:** `test/privacy.test.ts`, `test/signed-requests.test.ts`, `test/signing.test.ts`.

- [ ] Introduce the profile-discriminated `ProposeRequest` union. Narrow the existing employer/delegation path explicitly to `BenefitProposeRequest`. For charity, verify buyer signature and reject delegation/unsigned allocation overrides before any authority lookup or mutation.
- [ ] Within one synchronous verified-read scope, resolve attestation and candidate allowances; refuse corrupt/untrusted retained authority instead of silently omitting it. Missing/revoked/expired attestation or no positive eligible allowance creates a buyer-only proposal with anonymous-profile `request_only` terms. Store the unmatched reason as trusted evidence.
- [ ] Create fixed buyer and optional donor shares with zero fees and rails DE/bank respectively. Keep a zero buyer share in a fully funded arrangement. Store charity context separately from benefits; omit proposer-approval shorthand (`amountsFrom: 'proposer'`) and automatic employee authorization. Every charity proposal starts awaiting explicit buyer approval. Emit `allowance_matched { allowanceRef, donorCents }` only for an accepted positive match; unmatched absence/expiry/revocation records `no_live_attestation` or the applicable no-capacity reason, not request refusal. These are privileged `LOCAL` audit details and never buyer projections.
- [ ] Resolve anonymous privacy source and implement buyer projection/approval snapshot. Donor magnitude is safe; donor identity, allowance reference, attestation and raw shares are not. Include `sharesDigest` computed by privacy/signing ownership from the full retained allocation.
- [ ] Rewrite `approveAs` to sign one detached view snapshot, including its commitment. Preserve existing exception acknowledgment semantics for employer purchases. Never re-read raw proposal shares for charity. Correct misleading digest comments; keep unsalted commitment caveats.
- [ ] Admission of `PayerApproval` requires matching profile/version/digest/own totals and buyer identity, including zero-debit consent. Extend `privacyTermsMatch` explicitly for anonymous allowance and anonymous `request_only` sources; today it rejects allowance sources. Require `basis: 'device'` for charity and reject exception/employee-mandate substitution. Refuse offer changes for charity. A later match or different donor/merchant/price requires a new purchase and fresh approval.

Behavioral assertions: fully sponsored proposal is awaiting approvals with zero buyer principal, then becomes ready only after buyer approval; fallback is not ready until a fresh approval of the full buyer price; same buyer's Auto mandate cannot bypass either; a valid agent delegation still cannot sign this variant; changing a displayed approval field or allocation commitment refuses; a helper supplied only the detached projection never receives hidden donor data.

Run: `rtk proxy node --test test/charity-coordinator.test.ts test/privacy.test.ts test/signing.test.ts test/signed-requests.test.ts test/presenter-session.test.ts`. Expected: all pass, including old helper/exception behavior and no expanded agent capability.

### Task 9: Fixed-donor admission and budget booking

**Modify:** `src/core/coordinator.ts`, `src/core/types.ts`; `src/settlement/types.ts` only for explicit budget/evidence metadata required by its current interface.
**Extend:** `test/charity-coordinator.test.ts`, `test/coordinator-concurrency.test.ts`.

- [ ] Recheck the selected reference only, using current verified allowance/attestation, fixed buyer/merchant/share and retained buyer approval. Verify all bindings and current time. A revision is usable only for the same donor/class and enough capacity. Never select a replacement or increase buyer debit.
- [ ] Reserve the fixed donor amount through the ledger in the same guarded synchronous admission stretch before the first await. Record booking ownership, admission day and detached allowance/attestation/consent evidence. A buyer-only fallback never acquires sponsor authority or a budget booking.
- [ ] Preserve zero-leg filtering: a zero-principal/zero-fee buyer needs consent but emits no payment leg. Donor leg carries `sponsor_mandate` and the selected reference; `authorityRef`, frozen leg and first-handoff evidence must agree.
- [ ] Integrate reservation consume/release into existing snapshot-derived completion, no-exposure failure, compensation and confirmed full-return paths. Extend the existing release owner rather than duplicate accounting in refund/reconcile/resubmit. Pending/uncertain/partially returned work keeps usage. Admission rollback releases only the booking this attempt actually acquired.
- [ ] Race two already approved purchases against a shared final daily/lifetime budget with the first suspended after reservation. The second must fail admission without another donor or increased buyer share. Assert total reservations never exceed caps and a losing attempt cannot release the winner's booking. Include shared-ledger purchase-ID collision coverage.

Run: `rtk proxy node --test test/charity-coordinator.test.ts test/coordinator-concurrency.test.ts test/defects.test.ts`. Expected: no oversubscription, unchanged buyer debit and stable employer/autopay accounting.

### Task 10: Charity delayed handoff, replay and return accounting

**Modify:** `src/core/coordinator.ts`; keep provider/orchestrator algorithms unchanged unless an actual authority-kind handling assumption needs a narrow fix.
**Extend:** `test/charity-coordinator.test.ts`, `test/coordinator-concurrency.test.ts`.

- [ ] Add sponsor branch at `firstHandoffRefusal`. In a fresh scope check current selected allowance, current trusted attestation, fixed share, original beneficiary/merchant, offer expiry and retained buyer approval. Include the approval for a zero-debit buyer with no leg.
- [ ] Re-evaluate capacity against retained `bookingDay` and lifetime usage excluding the owner's reservation. Refresh evidence to exact revisions used before first handoff; after forwarding retain original evidence and operation keys through expiry/revocation/replay.
- [ ] Test a handoff delayed across minute 1440 with changed current-day availability; its recheck stays on admission day. Test allowance and attestation revocation before first handoff versus after forwarding; use real provider response-loss/deferred-operation controls, not a mock claiming completion.
- [ ] Exercise atomic unwind/compensation and independent partial commitment. Confirm that failed independent purchases expose committed legs and retain booking until recovery proves cleanup. Test pending, partial return, confirmed full return and repeat reconciliation/refund; restored capacity occurs once and only after confirmed cleanup.

Run: `rtk proxy node --test test/charity-coordinator.test.ts test/coordinator-concurrency.test.ts test/settlement-orchestrator.test.ts test/settlement-provider.test.ts`. Expected: no new authority after forwarding, no changed keys, no premature release.

### Task 11: Aggregate donor reports and privacy closure

**Modify:** `src/core/privacy.ts`, `src/core/coordinator.ts`.
**Extend:** `test/privacy.test.ts`, `test/charity-coordinator.test.ts`.

- [ ] Implement `Coordinator.allowanceReport` as verified ownership read + detached ledger summary + `allowanceReportFor`. Verification ignores temporal eligibility/revocation for historical owner access but rejects corrupt authority. Catch ownership/not-found/invalid-record details into one generic report refusal, without writing a trace.
- [ ] Projection returns exactly the specified fields. Compute remaining lifetime from reserved plus consumed cents; return `null` for uncapped and zero for cap lowered below usage. Never include transaction arrays, purchase handles, timestamps, merchant/beneficiary identities or per-purchase statuses.

```ts
const remainingLifetimeCents = owner.totalEndowmentCents === undefined
  ? null
  : Math.max(0, owner.totalEndowmentCents
      - summary.reservedCents - summary.consumedCents);
```

- [ ] Refuse `viewFor(p, { facet: 'sponsor', partyId: donorId })` for every anonymous-profile purchase, even a legitimate donor. Refuse report reads by nonowners or buyer/payee facets, unknown/corrupt references, and a valid owner using the wrong facet. No raw trace fallback.
- [ ] Primary projection tests assert exact report field allowlist and recipient entitlement. Coordinator tests independently verify aggregate values across pending/completed/partial-return/full-return bookings and revoked/uncapped records. Read twice, mutate a returned report, and verify no events, settlement call or retained-state mutation.

Run: `rtk proxy node --test test/privacy.test.ts test/views.test.ts test/charity-coordinator.test.ts`. Expected: unchanged employer sponsor views; charity only aggregate owner access.

### Task 12: Scenarios and composed safety invariants

**Modify:** `src/scenarios.ts`, `test/scenarios.test.ts`, `test/invariants.property.test.ts`; `test/run-record.test.ts` only for changed fixture provenance assertions.

- [ ] Bump `FIXTURE_VERSION` to `2026.11-6`. Add S37–S45, each with `run()` and an independent `check()` consistent with the existing scenario interface. Use helpers/signatures for every mutation; advance/evaluate explicitly, never assume a scheduler.
- [ ] S37 count success; S38 budget success; S39 empty/unmet deadline with no balance changes; S40 collecting lapse and retained entitlement; S41 overfunding to cutoff, one final settlement; S42 greatest-contribution match/tie; S43 full sponsorship with one donor leg and explicit buyer approval; S44 buyer-only missing-attestation/exhausted-allowance variants; S45 report entitlement/accounting including uncapped remainder. Independent-charity failure remains a lifecycle test, not an extra scenario ID.
- [ ] Extend the existing deterministic property generator with open-fund, pledge, evaluate and payee-cancel operations alongside time advance/submit/reconcile/recover/refund. Maintain a small independent model of accepted references/payers, live principal at admission and frozen roster/key identities. Do not call the implementation's threshold helper to compute expected truth.
- [ ] Retain settlement conservation/completion/no-shift invariants. Add no unmet fund admission, no expired new handoff, immutable closed/admitted membership, replay idempotence and payee-only cancellation checks. Derive fault keys from the actual final proposal version and roles: existing property faults pinned to version 1 will miss multi-pledge fund settlement.
- [ ] Verify all trace origins are `LOCAL`; `funding_succeeded` precedes submission and is never treated as payment completion. No runtime path offers fund/charity actions to agents.

Run: `rtk proxy node --test test/scenarios.test.ts test/invariants.property.test.ts test/run-record.test.ts`, then `rtk pnpm scenarios`. Expected: all tests and all 45 scenario checks pass; 250-seed existing property coverage remains, with reproducible seed/operation output on failure.

### Task 13: Preserve generated parity while deferring explorer walkthroughs

**Modify:** `tools/explorer-inputs.mjs`, `tools/ui-data.mjs`, `tools/check-explorer.mjs`, `tools/explorer/manifest-input.json`, `explorer/README.md`.
**Create:** `test/explorer-scenario-inventory.test.ts`.
**Regenerate only:** `explorer/app/core/`, `explorer/app/build.json`, `explorer/app/manifest.json`.

This task follows assumption A1. It does not add interactive fund/charity walkthroughs, imported HTML edits, new presenter journeys or browser acceptance claims.

- [ ] Add optional `deferredScenarioIds: string[]` to authored input and generated manifest, empty when absent; include S37–S45 deliberately. Validation requires unique nonempty IDs, disjoint from authored walkthrough IDs, and exact equality of their union to all source scenario IDs. No scenario may silently disappear or be listed twice. Keep current S01–S36 walkthroughs unchanged.
- [ ] Update manifest generation so **every source scenario still runs/checks and gets a baked digest**, but only supported walkthroughs become `manifest.scenarios` entries. Do not add fake steps, no-op operations or steps that claim an unimplemented UI.
- [ ] Update the Node checker inventory rule to compare source/generated sets exactly, and source against supported+deferred manifest sets exactly. Leave expected baked keys, full scenario execution, three-way source/generated/baked digest equality, journey checks, input hashing and generated-module inventory enforcement intact for all 45 scenarios.
- [ ] Add owner-interface tooling tests using temporary directories or direct exported validators: missing ID, overlap, duplicate deferred ID, unknown ID, and valid explicit partition. Prove a deferred scenario still requires a digest and a passing source/generated check. Do not test source strings or maintain a second copied scenario list.
- [ ] Document what deferred means and regenerate under the pinned Node. Inspect the diff: new module(s), updated source copies/metadata, no hand edits or imported UI changes. Browser core `check.html` and real UI acceptance remain separate, unrun gates.

Run: `rtk proxy node --test test/explorer-scenario-inventory.test.ts`, `rtk pnpm explorer:build`, then `rtk pnpm explorer:check`. Expected: 45 source/generated scenarios verified; 36 interactive walkthroughs plus nine explicitly deferred IDs; all journeys and provenance checks pass. A second build with identical input must produce no further artifact diff.

### Task 14: Documentation, final gate and review

**Modify:** `README.md`, `docs/field-map.md`, the existing conditional-funding/charity entry in `docs/backlog.md`; update this plan's execution status only when work is actually performed.

- [ ] Add both profile columns/recipient contracts to the field map, including count-only omission, retained-lapse entitlement, anonymous buyer allocation commitment and aggregate owner reports. Retain PSP visibility/correlation caveats and synthetic-only framing.
- [ ] Update README domain/scenario tables and commands for S37–S45; explain fixed commitment/no withdrawal, collection versus settlement deadline, greatest-contribution matching, explicit zero-debit buyer consent and no rematching. Document all-days lifetime reports as capacity accounting, not deposited balances.
- [ ] Update the existing backlog item without overwriting unrelated edits. Mark only tested core behavior implemented; keep explorer walkthroughs/browser acceptance, presenter capabilities, cryptographic verification, multi-allowance funding and withdrawal deferred. Record any newly discovered defect separately.
- [ ] Run the final checks below once; repeat only checks affected by subsequent changes. Review the diff for accidental changes to existing signature meanings, employee Auto eligibility, state transitions, provider replay, generated ownership, hidden-data exposure or dependencies.
- [ ] Report source Node tests, scenario checks, explorer Node parity and browser/UI acceptance separately, with exact commands/results. No commit, push or deployment without separate authorization.

```sh
rtk pnpm test
rtk pnpm scenarios
rtk pnpm explorer:check
rtk git diff --check
rtk git status --short
```

Expected: all Node tests and 45 scenarios pass, explorer Node parity passes, whitespace is clean. `src/core/states.ts` remains unchanged. No dependency/lockfile/license/environment-file change. Browser core and real UI remain explicitly **not run / deferred**; generated parity alone is not browser acceptance.

## Acceptance ownership and coverage map

| Spec requirement | Primary owner/test | Tasks |
| --- | --- | --- |
| Signed opening, complete immutable terms, no duplicate purchase | coordinator / fund-coordinator, signing | 1, 3 |
| Replay/conflict/unique payer, expiry/OR/closure | funding / funding | 2 |
| Store/index/version/application/auto-submit/cancel ordering | coordinator / fund-coordinator, concurrency | 3–4 |
| Admission and unstarted versus forwarded authority | coordinator + existing settlement / lifecycle tests | 4, 9–10 |
| Trusted issuer, revision/namespace/retained corruption | authority / charity-authority, verified-authority | 6 |
| Greatest-contribution policy, exact-reference recheck | policy / allowance-policy; coordinator for fixed choice | 7–10 |
| Daily/lifetime booking, ownership, release/concurrency | ledger / allowance-ledger; coordinator for actual lifecycle | 7, 9–10 |
| Explicit full-sponsor/fallback consent; opaque approval snapshot | coordinator/privacy / charity-coordinator, privacy | 8 |
| Profile/source/entitlement/no-leak/report contracts | privacy / privacy, views | 5, 8, 11 |
| S37–S45, LOCAL evidence, composed invariants | scenarios / scenarios, invariants.property | 12 |
| Deferred walkthrough inventory and complete generated parity | explorer tooling / explorer-scenario-inventory, explorer:check | 13 |
| Product wording, limitations and existing backlog | README, field map, backlog | 14 |

## Improvement loop record

- Limits: 10 iterations, 3 questions; bounded clarification.
- Iteration 1: created with `superpowers:writing-plans`, grounded in current source/validation and the supplied spec. Identified proposal-store, authorization-union, zero-debit consent and explorer inventory constraints.
- Iteration 2: corrected execution dependencies (campaign privacy resolution before opening; helpers with entry points), preserved the enforced proposal/state write owners, made append/lapse evaluation atomic, specified replay-conflict precedence, and added the shared read-only pledge check and explicit approval projection type.
- Iteration 3: reconciled the read-only pledge check across collecting/closed/admitted phases, made the command union match its callers, and closed the missing match/unmatched trace contract. Checked booking-day exclusion, ownership on rollback, zero-debit delayed consent, source-profile matching and complete generated scenario verification.
- Iteration 4: corrected the final-pledge-lapse write path so an empty collecting-origin roster can fail at cutoff without weakening ordinary proposal validation; phase-only decisions never rewrite a frozen proposal. Made campaign digest field selection explicit to exclude envelope metadata.
- Iteration 5: full spec/task/dependency and interface review found no further substantial improvement. Verified all referenced existing paths and declared new files, local links, 14 task headings, code-fence balance, absence of placeholders/trailing whitespace, and unchanged pre-existing spec/backlog fingerprints.
- Questions asked: 1 of 3, about handling the source-scenario versus deferred-walkthrough conflict. No answer received during drafting; A1 records the recommended default.
- Assumptions: A1–A3 above. No unresolved product decision blocks the core plan; explorer tooling scope is explicitly an unanswered recommendation, not a claimed user choice.
- Iterations run: **5 of 10**. Stop reason: **stabilized**.

## Planning validation versus implementation evidence

Planning checks cover actual paths, interfaces, call ordering, task dependencies, spec coverage, validation entry points and preservation of pre-existing docs. The document checks passed for 42 referenced paths and its spec link; `git diff --check` passed. They do not establish that any proposed behavior exists or passes tests. No source/test code or generated artifacts were changed, no implementation tests were run, and no commit was made. Execution must record new results; older backlog test counts are not this plan's validation.
