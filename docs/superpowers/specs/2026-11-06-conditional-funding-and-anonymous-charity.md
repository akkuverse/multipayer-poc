# Conditional pledging and anonymous charity

Status: design revised after codebase-design and product review, 6 November 2026; implementation has not started. Explorer and presenter surfaces are explicitly deferred.

## Review notes

- Source: design discussion 6 November 2026, building on the parked charity deltas in [2026-11-04-party-handles-share-visibility](2026-11-04-party-handles-share-visibility.md) §"The charity scenario" and the deferred constructions in [2026-11-05-private-allocation-verification](../../research/2026-11-05-private-allocation-verification.md).
- Retained decisions: overfunding is a per-campaign term; under `acceptPledgesUntil: 'deadline'` the purchase becomes ready only at deadline evaluation and settles once over the final roster; one allowance per purchase; campaigns are opened by a payee-signed `open_fund` request, not by fixture configuration or the first pledge; active pledge withdrawal remains deferred.
- Review decisions: separate collection cutoff from settlement validity; replace `cancelUntil` with the pledge's single authorization expiry; make roster closure irreversible and prohibit funding mutations after admission; define signed pledge identity and replay; restrict campaign cancellation to its payee; require atomic fund settlement; select the greatest available charity contribution with reference order as tie-breaker; make donor reports aggregate and ownership-checked. These supersede the earlier timing, cancellation, lowest-reference matching and per-purchase donor-view choices.
- Initial discussion recorded checks of `src/core/{coordinator,privacy,types,states,policy,ledger,signing,authority,verified-authority}.ts`, `src/scenarios.ts`, and `test/invariants.property.test.ts`. The revision follows static review of the current coordinator, authority, policy, ledger, privacy and settlement contracts at `4e5ce60`; no implementation tests were run for this document change.
- This document describes intended behavior. It does not claim these capabilities exist, nor that a local simulation establishes provider or ECB support.

## 1. Purpose and scope

Two new situations on the existing coordinator/settlement core, each with its own signed disclosure profile:

- **Conditional pledging (the fund).** Contributors pledge to a public-good payee; pledges settle only if a signed funding condition is met — "I contribute if X people contribute or if Y budget is reached." The campaign collects until `fundingEndsAt`, and permits new settlement initiation only through `settleBy`. Each pledge has one `expiresAt` covering both its participation and spending authority. Pledges cannot be actively withdrawn in this version. If funding evaluation fails, no money has moved.
- **Anonymous charity (allowance matching).** A donor publishes a standing allowance for an attested beneficiary class (e.g. `in_need`); when an attested buyer proposes a purchase, the coordinator finds a matching live allowance and draws a donor share. Mutual donor↔buyer anonymity is a requirement (caffè sospeso, hardship funds, sadaqah, SNAP/EBT stigma design — see the party-handles spec).

Out of scope: the explorer UI; new presenter/agent capabilities (agents cannot sign fund requests or the new charity proposal variant, approve, or submit); active pledge withdrawal; splitting one share across several allowances; Merkle/ZK or other proof machinery (tracked in issue #1); the ECB adapter. Existing delegated employer-benefit proposals retain their current contract.

Existing guarantees carry verbatim: integer cents, every leg settled before completion, a failed or lapsed contribution never migrates onto another payer, retries keep their original keys, timeout is uncertainty. Privacy resolution and projections never grant spending authority, reserve money or initiate settlement.

## 2. The fund purchase

A fund is a purchase whose share set grows through individually signed pledges under immutable campaign terms. The payee (the public-good project) opens it; pledgers join it; the coordinator resolves it deterministically on its simulated clock.

### 2.1 Campaign terms

Created by one signed request, kind `open_fund`, signer = the campaign payee (a registered key holder, as payees already are for refunds and offer changes). The payload fixes every campaign term; after open they never change — the request is the mandate-publication analog, not a negotiated object:

| Field | Contract |
|---|---|
| `purchaseId` | The fund's identity; also the SignedRequest binding. A reuse is `duplicate_purchase`. |
| `payeeId` | The public-good recipient and the required signer. |
| `condition` | `{ minPayers?: number, minTotalCents?: Cents }` — at least one clause, each a positive safe integer; when both are present **either** suffices (OR). `minPayers` counts distinct live payers with positive principal. Fees never count toward `minTotalCents`. |
| `fundingEndsAt` | Collection cutoff in simulated minutes, strictly after opening time. Pledges are accepted only while `now < fundingEndsAt`; evaluation closes collection when `now >= fundingEndsAt`. |
| `settleBy` | Latest time for admission or an unstarted first handoff; `settleBy > fundingEndsAt`. Maps to `Proposal.expiresAt`. Both times must be finite and nonnegative. This is not a deadline for resolving already-forwarded payments. |
| `acceptPledgesUntil` | `'condition_met'` closes the roster at the pledge that tips the condition; `'deadline'` keeps accepting while `now < fundingEndsAt` — the overfunding option. |
| `submitPolicy`, `settlementMode` | Frozen like any proposal; policy is `'on_ready'` or `'on_request'`. Funds require `settlementMode: 'atomic'`; reject `'independent'` before opening. |
| `privacyProfile` | Required, must be `'public_good_pledge_v1'`. |

`OpenFundRequest` uses the existing signed envelope: `{ kind: 'open_fund', purchaseId, proposalVersion: 1, by: payeeId, ...campaignTerms }`. `open_fund` commits the purchase in `awaiting_approvals` — here meaning "funding open" — with zero shares and `funding.phase: 'collecting'`. Campaign terms comprise every table field, including `purchaseId`; they exclude envelope metadata. `campaignDigest` is SHA-256 over `canonicalJson({ kind: 'fund_campaign_v1', terms: campaignTerms })`, with no omitted defaults. Pledge signatures bind this digest. The campaign payee is also the proposal's merchant of record.

A second `open_fund` for the same `purchaseId` is refused as `duplicate_purchase`. A fund with zero pledges at cutoff evaluation, while still within `settleBy`, fails `funding_condition_unmet`, an ordinary empty outcome.

### 2.2 Pledges

A pledge signs this complete payload (no inferred fee, payee or role):

```ts
{ kind: 'pledge', purchaseId, by: payerId, pledgeRef, campaignDigest,
  share: { role: `pledge:${pledgeRef}`, payerId, payeeId,
           amountCents, feeCents, rail },
  expiresAt, privacyProfile: 'public_good_pledge_v1' }
```

- `PledgeRequest` is a separate signed-request variant, **not** an extension of the version-bound `SignedRequest`. It carries no `proposalVersion`; reject a supplied one. Its signature is the pledger's approval and records `Authorization { basis: 'pledge', pledge: Signed<PledgeRequest> }`. It binds campaign digest, pledge identity, own complete share, expiry and profile, never the complete roster. Existing request and `PayerApproval` bindings remain unchanged.
- Verify `by === share.payerId`, the campaign digest/profile echo, campaign payee, recognized rail, positive safe-integer principal and nonnegative safe-integer fee. Check principal-plus-fee and roster sums for safe-integer overflow before mutation. The role must equal the derived role above; arbitrary roles are refused.
- `pledgeRef` is nonempty and unique within the campaign. At most one pledge may ever be accepted from a payer in that campaign, including after lapse; top-ups and replacements are deferred. Retain acceptance history after lapse. This gives each active payer one authorization and each settlement leg a unique role.
- After signature verification, an exact canonical-payload replay of an accepted `(purchaseId, pledgeRef)` returns the original detached acceptance acknowledgment without an event, version bump, evaluation, or added share, even after closure or lapse. Reuse with different content is `pledge_ref_conflict`; another reference from an already accepted payer is `payer_already_pledged`. Refused requests do not consume a reference.
- `expiresAt` is the **only** personal expiry. It must be finite, strictly after acceptance time, and at most `settleBy`; live through equality, expired when `now > expiresAt`. For `'deadline'` campaigns it must also be strictly after `fundingEndsAt`, ensuring a valid pledge can survive collection closure. `cancelUntil` is rejected, not interpreted as withdrawal permission. Shorter personal commitments are supported during collection under `'condition_met'`.
- Each accepted pledge appends its share and bumps the proposal version for observability; pledge evidence is unaffected by roster version. `totalCents` is the live principal sum. Once the roster closes, no new pledge is accepted.
- No `withdraw_pledge` exists. While collecting, expiry removes participation. Only the campaign payee may sign whole-campaign `cancel`, bound to its current proposal version, before admission; contributor status grants no campaign veto. Payee cancellation validates and applies before any evaluation that could auto-submit. After admission, settlement reconciliation/recovery/refund rules apply.

### 2.3 Evaluation and resolution

The funding module owns the decision rules below. The coordinator applies returned decisions under its existing per-purchase operation guard, including through unsigned `evaluate(purchaseId)`. This maintenance call applies already signed terms; it grants no new spending authority. It may trigger the previously authorized `'on_ready'` submission. Authenticated mutations verify their envelope before changing funding state; public maintenance remains separately callable. Calls during an in-flight operation refuse `operation_in_progress`.

| Funding phase | Permitted evaluation and mutation |
|---|---|
| `collecting` (`awaiting_approvals`) | Verify retained active pledge signatures and campaign/share bindings; corrupted evidence fails the whole purchase with `pledge_authority_invalid`, never contributes to a threshold. Remove expired pledges from active shares and authorizations, retaining their acceptance history and lapse outcome. Bump the version once per lapse batch. Compute condition and progress over the remaining live pledges. A valid new pledge is appended only before the cutoff, then evaluated immediately. |
| `closed` (`ready`, no admitted intent) | Membership, amounts and version are frozen. Revalidate every retained pledge and the condition. Any pledge expiry/signature failure fails the **whole** purchase, even if a smaller roster could still meet the condition; never prune, substitute or reopen it. |
| `admitted` (settlement owns the outcome) | Funding evaluation is a no-op. Never delete shares/evidence or change the proposal version. Reconcile, resubmit and recover operate on the frozen intent and its original keys. |
| Terminal purchase | Funding evaluation is a no-op; retain evidence and outcomes. |

While collecting, after lapse removal:

1. If `now > settleBy`, fail `funding_settlement_expired` without creating an intent.
2. If `'condition_met'` and the live condition holds, close the roster and transition to `ready`.
3. Otherwise, if `now >= fundingEndsAt`, close collection: a met live condition produces `ready`, an unmet condition produces `failed` / `funding_condition_unmet`.

Under `'deadline'`, only step 3 can produce `ready`. Evaluation uses **actual current time**, never backdates signature validity to the cutoff. If evaluation is delayed past a pledge's expiry, that pledge cannot contribute; if delayed past `settleBy`, the campaign fails even if funding previously appeared sufficient. Scenarios must explicitly advance the clock and evaluate; there is no background scheduler guarantee. At exact `fundingEndsAt`, collection is closed but eligible pledges remain live because their expiry is later.

At `ready`, `'on_ready'` schedules `maybeAutoSubmit` after the funding mutation releases its guard; `'on_request'` waits for a current-version payer-signed `submit`. Admission revalidates the closed roster, campaign digest, every signature/expiry, condition and `settleBy` in one guarded decision, then freezes the intent. A conclusive pre-dispatch rollback may return to the same closed roster; it never reopens collection or changes keys on retry. Generic `approve` refuses fund purchases (`fund_requires_pledge`) rather than replacing pledge evidence. `refreshAuthorization` delegates funds to funding evaluation, without introducing employee standing authority. Proposal-commit helpers must not independently derive fund readiness from “all payers authorized”; all readiness decisions use the funding module. `changeOffer` refuses fund purchases.

Immediately before each unstarted first handoff, recheck that leg's retained pledge signature, expiry, campaign binding, exact frozen share and `settleBy`. A refusal is handled by settlement, including cleanup of other reservations; it is not a roster edit or a direct pre-admission `fail()`. Once forwarded, preserve the authority evidence and replay the same intent/key despite later expiry. The existing atomic mode reserves all legs before commit and compensates on conclusive commit failure; it does not promise a single cross-ledger transaction or instant compensation. Unknown outcomes retain uncertainty and any outstanding accounting.

### 2.4 Fund invariants

Each covered by tests, extending the AGENTS.md list:

- Never submit — and therefore never complete — a fund whose condition is unmet at admission (the employer-recheck analog: re-evaluate at initiation, fail rather than proceed).
- An expired pledge can never be newly admitted or first handed off. Expiry does not invalidate a previously forwarded operation or prevent its reconciliation.
- Only live, non-lapsed pledges count toward `minPayers`/`minTotalCents`.
- A pledge after roster close is refused; nothing retroactively reopens a `ready` roster.
- An accepted pledge replay never changes principal, version, contributor count or settlement identity.
- No contributor can cancel the campaign; no funding evaluation mutates an admitted intent or terminal purchase.

## 3. Anonymous charity: allowance matching

The charity case reuses the mandate machinery rather than the fund lifecycle: a donor's standing allowance is the `EmployerMandate` analog whose beneficiary is an attested class instead of a named `beneficiaryRef`.

### 3.1 Two new signed records

`AllowanceMandate` — published through `AuthorityRegistry` as a new document kind, keyed by `allowanceRef`, same verify-at-publish-and-use discipline:

| Field | Contract |
|---|---|
| `allowanceRef`, `donorId`, `version` | Stable reference, owner/signer, monotone revisions — as `EmployerMandate`. |
| `beneficiaryClass` | The class this allowance funds (fixture: `'in_need'`). Replaces `beneficiaryRef`. |
| `maxPerPurchaseCents`, `maxPerDayCents`, `maxPurchasesPerDay` | Same semantics as the employer caps. |
| `totalEndowmentCents` | Optional lifetime cap; the ledger gains lifetime totals alongside per-day usage. |
| `eligibleMerchants`, `validFrom`, `validUntil`, `revoked` | As `EmployerMandate`. |
| `privacyProfile` | Required, `'anonymous_donation_v1'`. |

Allowance references share the registry's exclusive authority-reference namespace: they cannot alias employer or employee references. The initial donor permanently owns its reference; revisions must be exactly the previous accepted version plus one, starting at 1. Class and donor identity are immutable for a reference; other terms, including caps and revocation, may be revised. Budget usage survives revisions and revocation. Signed amounts/counts are nonnegative safe integers, validity windows are finite and ordered, and merchant IDs are unique and nonempty. A rejected publication leaves the accepted record untouched.

`EligibilityAttestation`: `{ attestorId, subjectId, classId, validFrom, validUntil, version, revoked }`, signed by an authorized oracle. Trusted fixture configuration explicitly maps each supported class to **one** authorized attestor (`in_need → oracle-1`); a registered signing key alone grants no attestation privilege. The registry validates that mapping, schema and signature at publication; `VerifiedAuthority` checks them again at use.

The registry stores attestations by `(subjectId, classId)`, with acceptance-time issuer/version metadata separate from mutable retained records. Initial version is 1; replacement/revocation requires the next version from the same configured issuer. A different issuer, buyer self-attestation, rollback, or malformed window is refused without replacing accepted authority. Changing an issuer mapping during a running fixture is out of scope. The stored subject and class must match the lookup. Add memoized `attestation(subjectId, classId)` and `allowance(allowanceRef)` reads scoped to one synchronous decision, never across an `await`.

### 3.2 Charity proposal and deterministic match

`propose` accepts a second variant — a discriminated union in the `SplitRequest` style:

```ts
{ kind: 'propose', purchaseId, proposalVersion: 1, by: employeeId,
  employeeId, merchantId, totalCents, expiresAt, submitPolicy,
  settlementMode, privacyProfile: 'anonymous_donation_v1',
  benefitClass: 'in_need' }   // no mandateRef; the signer asks the
                              // coordinator to find the match
```

Resolution, all within one verified-read decision:

1. Verify the buyer's signature and a live attestation whose subject/class match the request. A genuinely absent, expired or revoked attestation gives no donor share (the purchase proceeds like the `request_only` benefit fallback — buyer funds all, no sponsor entitlement). Corrupted, unverifiable or untrusted retained records fail closed with a refusal, not silent fallback. The same distinction applies to allowance records.
2. Among verified live allowances — unrevoked, in window, merchant eligible, `beneficiaryClass` matching, donor distinct from buyer — compute each available contribution. Choose the **greatest contribution**, with ascending code-unit `allowanceRef` order as a deterministic tie-breaker. One allowance per purchase. This minimizes the buyer's remainder among current candidates; fairness, donor rotation and multi-allowance splitting are deferred. No positive candidate means buyer-only funding.
3. Donor share = `min(totalCents, maxPerPurchaseCents, remainingDailyCents, remainingLifetimeCents)`, zero if the daily purchase count is exhausted. No lifetime cap means that term imposes no limit. Give the share role `'donor'`, `authority: 'sponsor_mandate'`, and `authorityRef: allowanceRef`; `'employer_mandate'` is untouched. This version derives buyer rail `'digital_euro'`, donor rail `'bank'`, and zero fees for both; reject caller overrides rather than inventing unsigned donor debit terms.
4. Buyer share = remainder; **zero is legal** (fully sponsored). The buyer still signs a normal `PayerApproval` over the proposal — consent to the arrangement — and zero-amount shares emit no leg under the existing `amountCents + feeCents > 0` filter. This answers the party-handles open question: a no-`'payer'`-amount purchase is valid because its approver is the beneficiary.

The proposal is not approval of the derived allocation: charity purchases always require an explicit buyer `PayerApproval`, even when fully sponsored or falling back to buyer-only funding. Existing employee automatic authority must not substitute for it. The buyer sees the exact remainder before approving; “no match” never silently authorizes the full price. The new variant accepts only the buyer's signature, not delegated agent proposals. Its shares, selected allowance and merchant cannot be repriced or rematched through `changeOffer`; a changed arrangement needs a fresh purchase and approval.

Admission rechecks the **original selected allowance**, live subject/class attestation, buyer approval and current caps. It never reruns selection to replace the donor. Any shortfall fails pre-dispatch with `donor_authority_invalid:<reason>`; the gap never migrates to the buyer. Store detached signed allowance and attestation evidence, their revisions, buyer-consent binding, and the admission budget day alongside the frozen submission. A revision may authorize the same fixed donor/share only if its current terms still cover that exact arrangement.

Immediately before an unstarted donor first handoff, perform the same checks in a fresh verified-read decision: current allowance and trusted attestation, exact fixed share/beneficiary/merchant, proposal expiry, and retained buyer approval (including the zero-debit buyer who has no leg). Recheck against the admission budget day and lifetime usage, excluding this purchase's own reservation. Refresh evidence to the exact revisions used for that first handoff. Revocation, expiry or loss of capacity refuses the handoff through the settlement module; never directly release a pending purchase's accounting. Once the request was forwarded, freeze its evidence and replay its original key; later revocation does not erase an uncertain payment or authorize replacement funding.

Allowance usage books into the benefit ledger under a namespaced allowance identity and `purchaseId`: reserve atomically with guarded admission before the first asynchronous handoff, consume on completion, release only after authoritative no-exposure failure or confirmed full return/compensation. Pending, uncertain and partially returned purchases retain their reservation or consumption. Lifetime usage includes both reservations and consumed entries across all days and allowance revisions; a confirmed full return restores capacity under the same rules as daily usage. A lowered cap below outstanding usage leaves zero new capacity; it never erases existing entries. Excluding a purchase during its recheck must exclude only its own booking. Two purchases contending for the last allowance capacity cannot both reserve it.

Charity retains the signed choice of settlement mode. Under `'independent'`, one settled leg may remain committed after another fails until explicit recovery; the purchase is not completed and its budget is not released prematurely. The main charity scenarios use `'atomic'`, with a separate failure case documenting the independent behavior.

### 3.3 The digest caveat (acknowledged, not solved)

The buyer's `PayerApproval` still binds `sharesDigest` over the complete share array — which under mutual anonymity contains a `payerId` the buyer may not legitimately hold. This is the open conflict from the party-handles spec arriving for real. This version adopts its **option A** position: the signing helper signs a coordinator-projected opaque digest ("I countersign the coordinator's commitment to this allocation"), the misleading "the device digests what it saw" comments get corrected, and the research brief's caveat stands: the unsalted deterministic digest is a binding, not an anonymity guarantee — fixtures use opaque donor ids so the hash does not trivialize to a lookup. Cryptographic independence stays in issue #1.

## 4. The two privacy profiles

The closed catalog gains `public_good_pledge_v1` and `anonymous_donation_v1`; both follow every existing rule — signed profile echo on requests and approvals, frozen `PrivacyTerms` on the proposal, `resolveProfile`/`viewFor` as the only purchase-projection paths, refusal over defaults. Cross-purchase donor reports use the privacy module's report projection described below.

| Facet | `public_good_pledge_v1` | `anonymous_donation_v1` |
|---|---|---|
| Payer | Own pledge, its expiry/outcome, campaign terms and progress counters **limited to what the signed condition exposes**: `minPayers` → live contributor count; `minTotalCents` → live pledged total; both → both. Do not inherit unconditional `totalCents`/`othersCents` from today's payer projection for count-only campaigns. | Own share + the donor share as role+magnitude (`donor: €5`), plus the opaque allocation commitment needed for approval; never donor identity or allowance reference. |
| Other payers | Never disclosed — identities and amounts both hidden (the `split_bill_v1` delta). | Same. |
| Payee | Itemized anonymous contributions (existing `PayeeView`) plus the funding outcome; never payer identities. | Unchanged `PayeeView` — the anonymity pair is donor↔buyer, not buyer↔merchant. |
| Sponsor | None. | No per-purchase donor projection: `viewFor(..., { facet: 'sponsor' })` refuses for this profile. Ownership-checked aggregate allowance reports provide budget oversight, with no transaction list, purchase handles, merchant IDs, beneficiary IDs or per-purchase statuses. |

New `PrivacyTerms` sources: `{ kind: 'campaign', campaignDigest, terms: CampaignTerms }` and `{ kind: 'allowance', allowanceRef, version, donorId }`, plus the `request_only` source shape explicitly paired with `anonymous_donation_v1` for unmatched charity proposals. Frozen campaign terms expose all choices the pledger signs, including cutoff, `settleBy`, closing rule and submission policy. These internal sources are never copied wholesale into party views. `checkedTerms` validates each profile/source pairing; `checkedAudience` retains its existing known-group check and does not demand a frozen participant list for campaigns. Per-recipient entitlement checks still apply. A payer whose pledge lapsed can read its retained pledge outcome and the permitted campaign progress through acceptance history, without reacquiring active funding authority.

`Coordinator.allowanceReport(allowanceRef, recipient)` is a read, where `recipient` is the same trusted caller identity context used by purchase projections, not an authentication mechanism. It obtains verified allowance ownership and a detached ledger summary, then delegates disclosure to `privacy.allowanceReportFor(summary, owner, recipient)`. Only the owning donor's sponsor facet is entitled; reference knowledge, buyer participation, and merchant status grant nothing. Revocation does not remove the owner's access to historical accounting. Unknown, corrupt and unentitled references return a generic report refusal without exposing balances or ownership.

Report fields are `{ allowanceRef, reservedCents, reservedPurchases, consumedCents, consumedPurchases, remainingLifetimeCents }`. Counts and amounts cover all days, exclude bookings released after confirmed full cleanup/return, and distinguish uncertain reserved work from completed consumption. `remainingLifetimeCents = max(0, totalEndowmentCents - reservedCents - consumedCents)`; it is `null` when no lifetime cap exists. It is not a promise of available daily capacity or a deposited balance.

This is participant data minimization, not resistance to all correlation: polling aggregate differences, sparse campaigns, disclosed amounts, external observations and the opaque digest can still reveal information. No timestamp-free or aggregate shape guarantees anonymity against those inferences. Cryptographic privacy, report batching/delay and minimum cohort sizes remain deferred; the product must not claim those guarantees.

## 5. Module ownership

| File | Responsibility |
|---|---|
| `src/core/types.ts` | Complete signed request variants, campaign terms/phases and retained pledge history; pledge authorization; sponsor authority; privacy sources; allowance/attestation types; frozen submission evidence and booking day; charity proposal variant |
| `src/core/funding.ts` (new) | One pure decision interface owning pledge acceptance/replay rules, expiry, condition truth, progress, irreversible roster closure and admission eligibility; returns decisions without mutating purchases or initiating settlement |
| `src/core/policy.ts` | Pure allowance eligibility/contribution policy shared by initial selection and exact-selected-allowance rechecks; greatest-contribution selection with deterministic ties; no registry reads or money effects |
| `src/core/privacy.ts` | Both profiles, source resolution, complete approval projection, progress-limited fund views, retained-pledge entitlement, refusal of per-purchase charity sponsor views, and ownership-checked aggregate report projection |
| `src/core/authority.ts`, `src/core/verified-authority.ts` | Allowance/attestation publication, namespace and immutable owner/issuer metadata, configured class trust, audit, detached evidence and verified reads scoped to one decision; no allocation policy |
| `src/core/coordinator.ts` | Verify requests, obtain decision-scoped authority/ledger inputs, apply funding decisions under the existing operation guard, keep payer indexes consistent when active shares change, schedule auto-submission after mutation, and route charity admission/first-handoff checks through shared policy; gather report inputs and delegate disclosure |
| `src/core/ledger.ts` | Daily and lifetime usage, reservation/consumption/release ownership and detached summaries; allowance accounting survives revisions and uncertain/partial outcomes |
| `src/settlement/` | Retain the existing orchestration interface and ownership of outcome/recovery; new authority kinds use the coordinator's existing first-handoff seam and immutable replay rules |
| `src/core/states.ts` | Unchanged — `awaiting_approvals` carries the funding phase |
| `src/scenarios.ts` | `oracle-1`, `donor-1/2`, attested `resident-*` buyers, `project-1`/`charity-1` payees, signing helpers, `FIXTURE_VERSION` → `2026.11-6` |
| `test/` | Public-interface funding/allowance behavior, both profiles' disclosure/refusal contracts, authority and concurrency cases below; property generation gains fund opening, pledge, evaluate and payee-cancel operations |
| docs | field-map columns for both profiles, backlog, README model/scenario rows |

The funding module's interface takes a detached funding snapshot (phase, campaign terms, active pledges and acceptance history), a command (`pledge`, `evaluate` or `admit`), current time and already-verified signature verdicts. It returns either a refusal, an unchanged replay acknowledgment, or a decision containing roster changes, progress, next phase and readiness/failure reason. The coordinator applies that decision once, including version/index/trace changes; it must not independently recalculate threshold, lapse or closure rules in callers. Cryptographic verification stays in the signing/authority modules. The same interface is the funding module's test surface.

Allowance policy receives verified records, merchant/beneficiary context, clock and ledger usage as values. Initial selection evaluates candidates through the same contribution calculation used for the chosen allowance at admission and first handoff; rechecks accept only that fixed reference. This keeps policy local without introducing a generic campaign framework, a second settlement owner, or an adapter seam with no varying implementation. Read-only privacy progress is built from retained funding state and must not trigger evaluation or settlement.

## 6. Trace contract

All new events are `LOCAL`: `fund_opened`, `pledge_recorded`, `pledge_lapsed`, `funding_evaluated { met, progress }`, `funding_succeeded`, `funding_failed { reason }`, and `allowance_matched { allowanceRef, donorCents }`. `funding_succeeded` means the roster closed ready for admission, never proof of payment completion. Accepted pledge replay and allowance reports emit no events. Publication/rejection events for both new authority kinds belong to the registry and identify the record and revision without implying acceptance of rejected authority.

Refusals reuse `request_refused`/`approval_rejected` as appropriate: `roster_closed`, `pledge_expired`, `pledge_expiry_invalid`, `pledge_authority_invalid`, `pledge_ref_conflict`, `payer_already_pledged`, `campaign_terms_mismatch`, `funding_condition_unmet`, `funding_settlement_expired`, `fund_atomic_required`, `fund_requires_pledge`, `not_authorized`, and `donor_authority_invalid:<reason>`. Attestation publication/use distinguishes `attestor_not_trusted`, `signature_invalid`, `version_not_next`, and malformed records. A missing/live-window-ineligible attestation records an unmatched reason (`no_live_attestation`), not a request refusal when buyer-only fallback was successfully proposed.

Privileged audit traces may contain donor/beneficiary linkage and pledge identities; they are not recipient projections and must never be handed to a participant as a reporting shortcut. Existing settlement request/outcome events and origins remain authoritative for money movement.

## 7. Scenarios and acceptance

| ID | Scenario | Required observation |
|---|---|---|
| S37 | Count-threshold fund meets `minPayers` | Pledges accumulate; `ready` at the tipping pledge under `condition_met`; all roster legs settle atomically |
| S38 | Budget-threshold fund meets `minTotalCents` | As S37 with the total counter disclosed in payer views |
| S39 | Deadline passes unmet | `failed`/`funding_condition_unmet`, zero legs, every balance unchanged |
| S40 | Pledge expires while collecting | Under `condition_met`, expired share removed at evaluation, outcome retained for its payer, and remaining pledges re-evaluated; no leg ever carried it |
| S41 | Overfunding `'deadline'` | Pledges after condition-met accepted before cutoff; at cutoff eligible pledges remain live; one settlement over the final roster |
| S42 | Charity match | Greatest available contribution selected; reference order breaks equal-contribution ties; buyer approval binds the commitment; both legs settle |
| S43 | Fully sponsored | Donor share covers all; buyer approval recorded; one leg only |
| S44 | No live attestation / allowance exhausted | Buyer funds all under `request_only`-style terms; no sponsor entitlement |
| S45 | Donor report entitlement and accounting | Per-purchase sponsor view refused; only the donor can read aggregate reserved/consumed totals, with bounded or explicitly unbounded lifetime remainder |

Acceptance must also cover these interactions through public module interfaces (scenario IDs above need not multiply for every case):

- **Time and phases:** pledge immediately before cutoff versus at cutoff; evaluation at cutoff and after pledge expiry/`settleBy`; `expiresAt === now`; invalid deadline-mode expiry; expiration in `ready` fails the entire closed roster without pruning, version changes or reopening. Repeated evaluation of pending/terminal purchases preserves frozen shares, evidence, keys and accounting. A confirmed pre-dispatch rollback keeps the same closed roster. Neither generic approval nor refresh bypasses the funding gate.
- **Binding and replay:** wrong campaign digest/payee/profile/signer, supplied proposal version, malformed amounts/overflow, empty reference and wrong derived role refuse without accepting a pledge. An exact accepted replay before/after lapse or closure is inert; conflicting reference reuse and second pledges from the same payer are refused. Distinct contributors cannot collide on settlement role. Signature expiry/tampering cannot count toward readiness or admission.
- **Cancellation and settlement:** a contributor cannot cancel; the payee can cancel an open or ready fund before admission. Payee cancellation does not accidentally auto-submit first. Independent fund mode is refused. Delayed first handoff after expiry cleans up via settlement; a lost reply followed by expiry replays the original forwarded operation and key. Atomic failure/compensation preserves uncertainty and existing no-shift guarantees.
- **Attestor trust:** a registered buyer cannot self-attest; wrong class issuer, wrong subject lookup, stale revision, unauthorized issuer replacement, malformed record and signature corruption fail closed. Valid revocation or expiry prevents new sponsored admission/handoff; it does not rewrite forwarded work. Rejected publications leave accepted authority intact.
- **Charity selection and consent:** with €1 and €10 candidate contributions on a €10 purchase, select €10 even when its reference sorts later; ties are stable regardless of registry insertion order. Buyer-only fallback requires a fresh explicit approval. No automatic employee authorization or delegated proposal substitutes for charity consent. A selected donor's later shortfall fails without rematching or raising the buyer share. Fully sponsored purchases still require live buyer consent at an unstarted donor handoff.
- **Capacity and replay:** simultaneous purchases competing for the final daily/lifetime capacity cannot both reserve it; delayed handoff crosses a day boundary without moving the booking; revisions do not reset usage. Revocation after admission but before first handoff refuses; revocation after forwarding does not create a fresh authority/key. Unknown/partial returns retain usage; confirmed full return restores capacity once. Independent charity failure exposes committed legs and retains accounting until recovery resolves them.
- **Privacy and reports:** count-only fund views omit total/other principal; lapsed contributors retain only their permitted history/progress. Donor identity/reference never reaches buyer views or approval helpers; helpers sign one detached displayed snapshot and its coordinator-projected digest. Nonowners, buyer/payee facets and unknown/corrupt report references receive no report data. Pending, completed, partial-return, fully returned and uncapped reports have the specified counts and amounts. No per-purchase sponsor projection or raw trace bypass is used.

Property tests extend with opening, pledge, evaluation and cancellation operations; the new invariants join existing settlement checks. All these are local acceptance requirements, not evidence of implementation or provider support. Node, browser-core and real-UI explorer acceptance remain separate and deferred for these features.

## 8. Assumptions, deferred work, rejected alternatives

- The coordinator always knows the full roster and the donor↔buyer pairing. Projections minimize direct disclosure; they do not establish anonymity against metadata correlation or guessing. The charity payee's PSP still observes individual credits (field-map caveat).
- Option C (campaigns as fixture configuration, the `knownSplitGroups` precedent) was rejected: group agreements are config because they are multi-party consent no single signer can grant, whereas campaign terms are unilateral — the payee's own ask — so signed publication is both possible and the better precedent.
- First-pledge-creates was rejected: it lets a contributor fix the goal other contributors must echo.
- Deferred/rejected: a second settlement intent for overfunding overflow; multi-allowance co-funding; pledge top-ups/replacements; a new purchase state (`awaiting_approvals` plus explicit funding phase suffices). Active withdrawal is deferred: expiry is **not** “cancel within a time frame”; this version offers a fixed-duration commitment with no contributor withdrawal operation.
- Product choices: a contributor cannot veto a campaign; funds require atomic settlement; charity matching minimizes the buyer's remainder within the one-allowance limit. Determinism alone is not donor fairness, and neither campaign thresholds nor allowance caps guarantee that accounts will have funds at settlement.
- Identity/key enrollment and oracle issuance remain trusted fixture assumptions; the class-to-issuer trust map and publication/use enforcement are modeled. Verification of real-world need and oracle enrollment are not modeled.
- Agents keep their existing capability set; nothing here is an agent capability.
