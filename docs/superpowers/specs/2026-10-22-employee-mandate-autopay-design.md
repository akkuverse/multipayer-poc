# Employee mandate, auto-pay and one-off exceptions

Status: reviewed design proposal; implementation has not started.

## Review notes

- Source: the employee-mandate spec supplied in conversation, followed by the codebase-design and product review.
- Method: apply `plan-improve-loop` to the supplied candidate, keeping the requested output a design spec rather than turning it into an implementation task plan. Review in-session; no delegated reviewers.
- Main changes: separate payment versions from mandate revisions; define the automatic execution owner; bind exceptions cryptographically; include fees in limits; specify monthly reservations, expiry, revocation and disputes; preserve employer-funding and concurrency invariants.
- Code checked: `src/core/{coordinator,policy,authority,ledger,signing,types,views}.ts`, `src/settlement/{backend,psp}.ts`, `src/presenter/{session,fixtures,journeys}.ts`, `src/scenarios.ts`, evidence/run records, and the existing signing, quote, scenario and coordinator concurrency contracts.
- This document describes intended behavior. It does not claim these capabilities already exist or that a local simulation establishes payment-provider or ECB support.

## 1. Purpose and scope

Replace the employee limit carried on each employer-benefit purchase with employee-signed standing terms. Distinguish paying automatically under those terms, confirming one purchase, and explicitly allowing one purchase above the normal maximum. An exception never changes standing terms.

Implement in this simulator first. The explorer `Multipayer Explorer v3.dc.html` is a later consumer; its UI is outside this change. Presenter projections, scripted/manual journeys, scenario evidence and documentation are in scope because they already consume the coordinator.

The first version applies employee mandates to employer-benefit purchases created through `Coordinator.propose()`. General split/multi-payee purchases created through `proposeSplit()` retain their existing device approvals and are not automatically paid. Employee mandates are explicitly scoped to employer-benefit purchases; their merchant restrictions are not advertised as account-wide restrictions. The restricted presenter cannot use `proposeSplit()` to escape this scope.

Preserve zero dependencies, native Node TypeScript execution, synthetic actors, integer euro cents and local-only operation. All new coordinator, presenter and simulated PSP events have origin `LOCAL`. No ECB adapter or production integration belongs in this change.

## 2. Product contract and defaults

- An employee chooses standing terms on a trusted device. The agent may read permitted projections and suggest a change, but never signs or publishes it.
- Selecting an offer in an authorized session can result in automatic payment on the next deterministic runner step. Setting up auto-pay must explain this behavior, the trusted merchants, per-purchase and monthly limits, expiry, and how to stop future automatic payments.
- `autoPayMaxCents` is the largest employee debit permitted without a tap. Zero disables auto-pay.
- `maxCents` is the normal confirmation maximum. It is not an absolute ceiling: exceeding it requires a separately acknowledged one-off exception.
- The monthly limit covers net auto-paid employee debits, including fees that were not returned, plus outstanding reservations. Device and exception payments do not consume it.
- Expiry and revocation disable standing automatic payment permission. The last verified maximum and blocked-merchant restrictions remain in force for manual purchases until the employee explicitly replaces those terms. Revoking auto-pay does not silently remove a block or make an over-limit purchase an ordinary confirmation.
- No employee mandate ever published means manual confirmation for every purchase, without a standing maximum or blocked list. Represent absence explicitly, never with a serialized `Infinity` amount.
- Ordinary fixture setup remains manual by default. Auto-pay scenarios explicitly publish an enabled mandate and enable simulated PSP capability. This preserves the purpose of existing manual demonstrations.

These are simulator product choices, not statements about legal authorization, SCA exemptions, refund rights or real PSP capabilities.

## 3. Signed employee terms

Use the existing `Signed<T>`, canonical JSON, Ed25519 and holder-bound public-key registry. Private keys remain in trusted fixture/device code.

An employee mandate contains:

| Field | Contract |
| --- | --- |
| `mandateRef` | Stable nonempty reference for this employee's standing terms; distinct from the employer mandate reference. |
| `employeeId` | Owner and signer; must match the purchase employee. |
| `version` | Positive integer; initial publication is 1, each replacement or revocation is exactly the prior version plus 1. |
| `autoPayMaxCents` | Nonnegative safe integer cents, at most `maxCents`. |
| `maxCents` | Nonnegative safe integer cents; ordinary-confirmation threshold, fee included. |
| `autoPayMonthlyCents` | Nonnegative safe integer cents; zero permits no positive automatic debit. |
| `trustedMerchants` | Unique nonempty merchant IDs eligible for automatic payment. |
| `blockedMerchants` | Unique nonempty merchant IDs that cannot be paid through this purchase flow. Blocking takes precedence over trust. |
| `validUntil` | Finite nonnegative simulated minute; automatic authority is live through this minute, and expired when `now > validUntil`. |
| `revoked` | Boolean; true disables automatic authority while preserving the restrictions above. |

Maintain one standing record per employee in this version. Publication verifies owner, signature, schema, reference ownership and next version before replacing stored terms. Reject malformed, foreign-signed, stale or replayed publications without changing the last accepted record. Store detached signed records and return detached projections. Do not copy the employer registry's unverified-publication behavior into the employee registry.

Publishing a new version never resets monthly usage. A reference change or removal/recreation is not a supported way to reset standing terms; the budget identity remains the employee even if future migrations introduce new references.

`publishEmployeeMandate(signedTerms)` is the coordinator-owned mutation. A trusted-device `revokeEmployeeMandate()` convenience signs and publishes the next version with `revoked: true`; `trustMerchant(id)` signs a replacement with that merchant added. Neither is an unsigned coordinator shortcut. Trusting a blocked merchant is refused until the employee explicitly removes its block in a full terms edit.

If a stored accepted record cannot be verified at use, fail closed with `employee_mandate_invalid`; do not treat corruption as never having a mandate. Recheck signatures at authorization and first initiation, as with existing signed authority.

## 4. Decision and amount semantics

`employeeDebitCents` is the sum of the employee's amounts and payer fees on the proposal. Compare that amount against both per-purchase thresholds and the monthly cap; use it in confirmations, exceptions and receipts. Validate additions as safe integer arithmetic.

Keep benefit allocation deterministic and separate from employee authorization. Removing `withinInstruction` from benefit eligibility must not affect employer caps, beneficiary/merchant checks or the resulting amounts. One employee-authorization evaluator supplies quotes, proposals and initiation decisions; no presenter or agent duplicates these rules.

| Zone | Condition | Authority needed |
| --- | --- | --- |
| `Blocked` | Current retained restrictions block the merchant. | None can authorize it. |
| `Exception` | A verified standing record exists and the debit exceeds its `maxCents`. | Device signature explicitly acknowledging the exception. |
| `Auto` | Debit is within both limits; standing automatic authority is live and not revoked; merchant is trusted; monthly reserved + consumed usage plus debit fits; routed payer capability is enabled. | Coordinator authorization derived from the signed mandate. |
| `Confirm` | All other payable proposals, including never having a mandate. | Ordinary device signature. |

No positive-debit requirement is imposed on the employee: an employer-funded purchase with zero employee debit may use Auto if the mandate, merchant and PSP conditions hold. Zero auto-pay or monthly limits still mean auto-pay off, including zero-debit purchases; this prevents a disabled setting from initiating orders.

Expired offers and invalid authority are precondition failures, not payable zones. A blocked proposal is rejected before a new purchase is created or an existing offer is replaced. Rejection preserves any prior valid proposal. A later block makes an existing open purchase unpayable and invalidates its authorizations.

Store the evaluated `authZone`, current mandate reference/version or absence, `employeeDebitCents`, and deterministic `autoPayBlockedReason` on the open purchase's authorization assessment. Payment terms and authorization assessment are separate even if the assessment is exposed alongside the proposal in views.

For non-Auto decisions choose the first applicable reason in this order: `blocked_merchant`, `no_employee_mandate`, `exceeds_mandate`, `mandate_revoked`, `mandate_expired`, `auto_off` (either automatic limit is zero), `over_auto_limit`, `untrusted_merchant`, `monthly_cap`, `psp_unsupported`. Rejected invalid authority and expired offers carry their own precondition reason. Document this precedence so traces and presentation agree.

`quote()` remains read-only: no purchase, authorization, reservation, expiry event or trace append. It returns a point-in-time assessment using current usage and capability; it is not a promise that budget will remain available. Presenter evaluation may log its detached observation using the existing evidence mechanism.

## 5. Authorization evidence and proposal versions

Do not pretend a coordinator-generated mandate authorization is `Signed<PayerApproval>`. Model employee authorization as a discriminated record:

- `device`: verified employee-signed payment terms.
- `exception`: verified employee-signed payment terms plus explicit exception acknowledgment.
- `mandate`: coordinator-recorded evidence referencing the verified signed employee mandate, exact proposal version and employee debit; no device or agent signature over this purchase.

Employer mandate authority remains distinct from employee mandate authority. Resolve a leg's authority by its owner and evidence, never by the assumption that every `authority: 'mandate'` share is the employer. Employee leg evidence identifies the exact grant/version, not an ambiguous reference alone. For employer authority, retain its existing reference and the verified signed terms used at initiation; this change does not require adding employee-style version numbers to the employer registry. Payer visibility follows the employee's role independently of authorization basis; an automatically paying employee still receives the normal payer view. The employer continues to receive only its sponsor projection.

Every device or exception approval signs all existing `PayerApproval` bindings: approval and purchase IDs, payer, proposal version, merchant, total, own amount, own fee and expiry. The signed payload also identifies its authorization basis. An exception additionally signs `exception: true`, employee mandate reference/version, acknowledged `maxCents` and `overByCents = employeeDebitCents - maxCents`. The coordinator independently checks those values. An unsigned options object cannot upgrade an ordinary signature to an exception.

Payment terms (merchant/payee, total, shares, fees or proposal expiry) changing always creates a new proposal version and invalidates all prior purchase authorizations. A mandate-only change does not change the signed payment terms or proposal version. Refresh the authorization assessment and apply this table:

| Existing authorization | After a mandate-only update |
| --- | --- |
| Mandate | Invalidate. If still Auto, record fresh mandate evidence against the new mandate version; otherwise wait for the appropriate device action. |
| Ordinary device | Preserve only if the exact signed payment terms remain live, merchant is not blocked, and current maximum permits ordinary confirmation. Otherwise invalidate. |
| Exception | Invalidate on any employee-mandate revision because the exception explicitly acknowledged a particular version and maximum. Obtain a new exception, ordinary signature, or mandate authorization as appropriate. |

Passage of time and changes in other purchases' usage/capability also require a fresh assessment at initiation. An unexpired device/exception signature remains usable after automatic permission expires or is revoked only under the retained-restriction and revision rules above. A valid device approval is not converted into mandate evidence merely because Auto becomes available; retain its basis and do not charge the automatic budget.

`Confirm` and `Exception` without valid authorization use `awaiting_approvals`. Auto with recorded mandate evidence, or a valid device approval, uses `ready`. A later merchant block leaves the open purchase `draft` with `blocked_merchant`; unblocking requires a fresh assessment and authorization. Proposal expiry fails initiation without a send. Preserve settlement states and separate return status.

## 6. Employer funding and changing offers

Evaluate employer benefit for a new purchase using the existing ledger and signed employer authority. A new second purchase may have no employer share and may enter Confirm or Exception on that basis.

For an existing proposal, loss of any promised employer funding must never automatically increase the employee share. At an explicit offer change and again before initiation, check that the employer can still fund the retained promised contribution against the original proposal's merchant and total. If it cannot, stop the existing pre-submission purchase as `failed`, preserve its original shares and record `employer_authority_invalid`. A new purchase covering the gap requires a fresh explicit employee decision; the runner must not create or auto-submit a replacement to absorb the gap. Checking the original terms first must not reject a cheaper replacement merely because its total is below the old employer contribution.

Employer mandate publication does not automatically reprice existing purchases. This deliberately replaces the original spec's broad "allowance change creates a new version" rule. New quotes use current terms; existing proposals retain their promised contributions and recheck them at initiation. An increase in available employer support alone does not alter already approved terms.

If employer authority still holds, an offer change can create a new version and recompute both allocation and employee authorization normally. The agent may select a different offer, but cannot mutate fees, shares, standing terms or exception flags.

## 7. Automatic execution and initiation

Keep the agent interface limited to discovery, evaluation, selection and explanation under its signed session grant. Soft `tags` and `maxWalkingMinutes` remain discovery preferences. Do not expose approve, submit, retry, reconcile, mandate writes, trust, dispute or refund as agent tools.

A trusted deterministic runner, owned by the application/fixture session, advances the purchase after selection returns. On an explicit runner step it attempts initiation only for the current proposal with valid mandate authorization. This is the no-tap path: no scripted device approval or user-flow submit is needed to make an Auto journey settle. The runner can reconcile pending outcomes; it never invents an approval or infers completion from a timeout.

The runner uses the existing coordinator submission seam. One queued logical job per session purchase is sufficient. A job bound to a replaced proposal, cancelled purchase or invalidated authorization does not dispatch old terms. Repeated runner steps do not create extra purchases, receipts, reservations or fresh retry keys. Manual approval/submission remains available through the trusted user flow.

The step between selection and initiation is an intentional deterministic intervention point: S24 changes the offer there. This is not a promised real-world cancellation grace period. After the coordinator hands a request to its settlement route, cancellation cannot undo it; use status/recovery/refund behavior.

Before the first send, under the existing per-purchase operation guard:

1. Check current proposal and offer expiry, recorded evidence and signature bindings, retained restrictions and employer ability to fund the promised share.
2. For mandate authorization, recheck employee mandate signature/revision/expiry/revocation, employee PSP capability, trusted merchant and limits.
3. Check monthly usage and reserve the full employee debit as one synchronous operation, before an asynchronous send. Acquire employer and employee reservations before dispatch; if either acquisition conclusively fails, undo only reservations newly owned by this attempt.
4. If only Auto eligibility was lost, invalidate the mandate evidence, refresh the assessment and wait for Confirm/Exception; do not send, change shares or mint retry keys. A blocked merchant or expired offer follows its specified rejection/failure behavior.
5. Build immutable submission legs with authority evidence and the existing purchase/version/role idempotency keys. Send and derive state from authoritative results.

The admission check and reservations contain no asynchronous gap. Scope guarantees to one coordinator and its ledgers; cross-coordinator ownership remains outside this change, as in the existing backlog.

Per-PSP initiation must recheck the relevant authority immediately before each leg's first handoff, including a first handoff during `resubmit()`. Track handoff independently of `executionRef`. A request already handed off, including one with an unknown outcome or no returned execution reference, remains potentially submitted: preserve its authority snapshot, reservation and idempotency key for reconciliation/deduplication. A documented conclusive pre-forward refusal, such as `PspUnavailableError`, proves no handoff occurred; a generic thrown error does not. Do not reinterpret a lost response as a fresh payment merely because a reference is missing. Replaying an already submitted request never requires new employee approval to discover its original outcome. Preserve the original settlement mode, assembly membership and assembly deadline on replay as well as the leg keys.

If a later first handoff loses authority after another leg may have been sent, refuse that unsent leg and derive the purchase outcome from all leg statuses. Never mark the entire purchase failed, release its reservations or rewrite an unknown/settled leg merely because one still-unsent leg is now refused. Pending atomic groups resolve through their original assembly deadline; independent partial settlements follow recovery.

Mandate publication/revocation is allowed while another operation is awaiting a response. It updates standing terms and refreshes idle open purchases, but does not mutate the in-flight purchase's terms, evidence, legs or reservations. The handoff is the authorization decision point; revocation cannot retroactively cancel a handed-off payment. Subsequent first handoffs see the new terms. Apply any deferred open-purchase refresh after the operation releases its guard.

PSP capability is a trusted fixture/routing property, read by the coordinator for the employee's selected route. Missing capability means false. Provide it for both direct-coordinator and per-PSP initiation fixtures; it must not depend on whether a `SimulatedPsp` wrapper happens to exist. This flag models an assumption only and does not attest legal eligibility or real provider support.

## 8. Monthly budget lifecycle

Use a dedicated employee auto-pay ledger with a narrow interface for usage, admission/reservation and outcome accounting. Reuse the benefit ledger's ownership discipline, not its day buckets or employer assumptions. Do not introduce a generic budget framework for these two ledgers.

The simulator clock remains minutes. Add an explicit fixture epoch, default `2026-01-01T00:00:00Z`. Derive a UTC calendar month from epoch plus simulated minutes; do not approximate months as 30 days. Validate finite nonnegative clock/window values and a valid UTC epoch. Treat time as monotonic within a world; start a fresh world for replay instead of rewinding reservations and deadlines. The epoch is part of reproducible fixture metadata. Keep coordinator and backend clocks synchronized through the existing fixture `advance()` convention.

Reservations are keyed by purchase ownership and record employee ID, proposal version, mandate version, original booking month, amount, fee and lifecycle. All mandate versions share the same employee/month budget. Usage counts reserved plus consumed unreleased debits. A retry excludes its own reservation from availability checks and never reserves twice. Any eligibility check for a still-unsent leg of an admitted purchase uses that reservation's original month, not the retry's current month; already handed-off requests retain their original admission decision.

| Outcome | Budget treatment |
| --- | --- |
| Before submission / cancelled before admission | No usage. |
| Admitted and awaiting settlement | Reserve full debit. |
| Unknown outcome, lost response, partial settlement, recovery required | Retain reservation; never release on a timeout or generic transport exception. |
| All legs conclusively rejected before any debit | Release owned reservation once. |
| Purchase completed | Consume reserved debit once; original booking month remains. |
| Recovery or refund resolves all purchase obligations | Release employee debit conclusively never charged and principal confirmed returned; retain any employee fees actually charged and not returned. |
| Return unsupported, incomplete or outcome uncertain | Keep accounting held until the confirmed-return rule can be applied. |

Current backend returns cover principal, not fees. For this version, a fully returned fee-bearing purchase therefore retains its charged fee in consumed monthly usage. A zero-fee full return releases all usage. Do not claim zero outstanding personal cost merely because principal was returned. This does not implement the separate backlog work on refunding fees.

A purchase crossing a month boundary remains booked in its admission month, including retry, settlement and later refund accounting. A fresh purchase books in the new month. Lowering a cap below already reserved/consumed usage does not undo handed-off purchases; it prevents further Auto admission until budget is available. Mandate replacement, revocation and trust changes never clear usage.

Known pre-dispatch refusal may release an attempt's reservation. A generic exception is not proof that nothing moved. Keep the submission intent and same keys available for authoritative resolution; do not copy the current direct-submit blanket catch-and-release behavior onto auto-pay.

## 9. Receipts and disputes

On the first observation that an automatically authorized purchase is fully completed, emit one `autopay_receipt`. Retain `receiptAt`, original employee amount/fee/debit, merchant, purchase/proposal IDs, funding breakdown, used mandate revision, and `disputeUntil = receiptAt + disputeWindowMinutes`. Default window: 1,440 minutes. Observation time is used because the current backend does not expose a settlement timestamp. Reconcile/resubmit and delayed duplicate outcomes never reissue the receipt or extend the deadline.

The trusted employee flow may open a dispute for their completed Auto purchase when `now <= disputeUntil`. Authenticate the employee using the existing trusted user-flow separation; a dispute is not an agent tool. Ordinary device/exception purchases retain the existing refund route and do not receive this Auto dispute window.

An accepted dispute records `dispute_opened` once and requests the existing full-purchase refund: every settled share goes to its original payer, including the employer. It does not promise a unilateral employee-only refund. Record dispute request/return outcome separately from purchase completion. Opening a dispute alone releases no budget.

Repeated requests for an accepted dispute refer to the same case and may resume an incomplete refund with the same execution references. An accepted case can continue after its window closes; a first request after the deadline is rejected with `dispute_window_expired`. Also reject wrong employee, absent receipt and ineligible purchase, with distinct reasons. Preserve `operation_in_progress` behavior; a refused concurrent request has not opened a case.

Unsupported or uncertain returns remain visible as such. A completed purchase stays completed with its separate return status, as today. Receipt/return projections must expose any unreturned employee fee; the employee must be able to distinguish "dispute recorded", "refund unsupported/pending" and "principal returned; fee retained".

Preserve a per-leg uncertain return attempt if a refund call throws after handoff. Before retrying that leg's refund, query the same execution reference through the existing backend `status()` seam: `returned` confirms the return, `settled` permits another refund attempt, and `unknown` or an unavailable status keeps the request unresolved. The mock's `refund()` is not idempotent after a completed return; simply repeating it after a lost response would throw. Reuse confirmed return state to make repeated dispute/refund actions harmless without adding a new settlement interface or minting new references. This status-before-retry rule applies under the simulator's existing backend status semantics; it is not a guarantee about a future provider's asynchronous return protocol.

## 10. Module ownership and migration

The coordinator is the mutation and authorization seam. A focused internal employee-authorization module resolves signed terms and computes decisions. Its implementation may use an employee registry and auto-pay ledger; callers do not coordinate those pieces. Benefit policy continues deciding allocation, and the existing settlement adapter interface remains the money-movement seam.

The coordinator owns references to its open purchases so employee publication can refresh affected idle purchases. Clock/usage changes need not scan all purchases eagerly: read-only projections can show a current assessment without recording authority, and every mutation/runner step must refresh before acting. Preserve the distinction between an observed zone and already recorded valid authorization. Expiry is logged once per accepted mandate revision at the first mutating observation after its deadline; a quote never emits it.

Remove `employeeMaxCents` from `ProposeInput`, `QuoteInput`, retained benefit terms and presenter session setup. Remove `reviseInstruction()`. There is no compatibility per-purchase cap in this version: this private simulator's known call sites are migrated together. Device approval retains its existing signed-input coordinator interface, extended for the two signed bases. Presenter approval may accept an exception choice, but the trusted device callback must sign it before the coordinator receives it.

Update `approvalCents`/fee calculation, approver readiness, initiation/retry dispatch and views so they do not equate employee identity with device approval or all mandates with employer authority. Keep S03–S18 behavior and privacy intact. Do not give agents raw private keys, live purchase objects or mutable mandate/ledger records.

Replace the presenter's fixed-limit/`withinInstruction` projection with debit, normal maximum or absence, zone, reason, authority basis, proposal version and observed mandate version. Retain detached recipient-safe evidence. New presenter claims, including trust suggestions, must cite earlier observed events; suggestions never publish terms. Do not disclose employee standing restrictions or monthly usage through sponsor/payee views.

Update existing scenarios and the four `presenter-*-manual`/`presenter-*-scripted` records to publish a manual-only employee mandate with their former personal maximum. Existing over-limit draft cases become awaiting explicit exception rather than silently proceeding. Update explanatory wording and expectations deliberately; a formerly over-limit scenario must not gain an exception unless that scenario includes a new employee action.

Keep the current scenario fixture format and run-record construction. Bump fixture/presenter versions when semantics change, review changed trace digests, regenerate presenter comparison evidence, and update README, experiment protocol and field map. The explorer's form changes and rendering are deferred, but the event explanation contract below is part of this spec.

## 11. Trace and explanation contract

Every new stateful action, accepted or rejected authorization and budget transition is traceable. Events include applicable purchase/proposal IDs, employee or mandate reference/version, reason, simulated time and budget month/amount. Record used authority separately from currently published authority. Avoid signatures/private keys in recipient projections. Existing event names may be extended where their meaning already matches.

| Event | Plain-English explanation for the later explorer WHY map |
| --- | --- |
| `employee_mandate_published` | The employee signed new standing payment terms. |
| `employee_mandate_revoked` | The employee stopped future automatic payments; retained restrictions still apply. |
| `employee_mandate_expired` | The standing automatic permission has passed its expiry. |
| `employee_mandate_rejected` | The proposed standing terms were invalid or were not signed by their owner. |
| `auth_zone` | The coordinator determined which authority this purchase currently needs. |
| `proposal_rejected` | The requested purchase or offer change is not permitted. |
| `approval_recorded` | This proposal now has device, exception or standing-mandate authority. |
| `approval_invalidated` | Earlier authority no longer authorizes this proposal under the current rules. |
| `approval_rejected` | The supplied approval does not satisfy the required authority. |
| `autopay_reserved` | This purchase has reserved part of the employee's monthly automatic-payment budget. |
| `autopay_consumed` | A confirmed automatic employee debit or retained fee counts against the reserved budget. |
| `autopay_released` | Confirmed rejection or return has restored the stated amount of automatic-payment budget. |
| `autopay_receipt` | The automatic purchase completed; the employee is notified of its terms and dispute deadline. |
| `dispute_opened` | The employee requested a refund of this automatic purchase within the allowed window. |
| `dispute_rejected` | This request cannot open a dispute under the purchase's dispute rules. |
| `dispute_updated` | The existing dispute's refund outcome changed or remains unresolved. |

`approval_recorded` includes basis and either device approval identity, signed exception acknowledgment/overage, or employee mandate identity/version. Never include a fabricated device signature for mandate evidence. `approval_rejected` includes `exceeds_mandate` for an ordinary signature in Exception and `not_auto_zone` for an invalid internal mandate-authorization attempt. `auth_zone` is emitted at proposal creation and when a mutating refresh changes the assessment, including within the same proposal version. Repeat read-only observations do not append core events. Accepted revocation emits the revocation event once rather than an additional publication event for the same revision.

## 12. Scenarios and acceptance

Use these explicit auto-pay fixture terms for S19–S27, overriding them where stated:

```ts
const autoPayFixture = {
  employeeMandate: {
    mandateRef: 'employee-mandate-1', employeeId: 'employee-1', version: 1,
    autoPayMaxCents: 600, maxCents: 1000, autoPayMonthlyCents: 3000,
    trustedMerchants: ['merchant-a'], blockedMerchants: [],
    validUntil: 1000, revoked: false,
  },
  // Trusted fixture routing option, available in both initiation modes:
  supportsMandatePayments: true,
  calendarEpoch: '2026-01-01T00:00:00Z',
  disputeWindowMinutes: 1440,
};
```

Each scenario asserts outcome, balances, relevant authorization/trace evidence and absence of forbidden actions. Seed prior usage through real earlier purchases with distinct IDs; do not add a ledger mutation/restoration seam solely for tests. Monthly-cap and contention cases must isolate the monthly constraint from the employer's one-meal-per-day rule. Clock-spanning cases explicitly extend or renew employee/employer mandates and offer expiry to reach the intended month-boundary condition.

| ID | Setup and required result |
| --- | --- |
| S19-autopay-within | EUR 9 purchase, EUR 5 employer, EUR 4 employee at trusted merchant: Auto; runner completes it and emits one receipt without a per-purchase device signature. |
| S20-autopay-new-merchant | Same split at an eligible but untrusted merchant: Confirm with `untrusted_merchant`; employee signs; after completion an evidence-backed suggestion may offer trusting the merchant, without publishing anything. |
| S21-autopay-over-auto | EUR 13 total with EUR 5 benefit: EUR 8 employee debit is Confirm with `over_auto_limit`. |
| S22-exception-one-euro | EUR 16 total with EUR 5 benefit: EUR 11 employee debit against EUR 10 maximum; ordinary approval rejected, signed EUR 1 exception settles; next purchase still uses EUR 10 maximum; automatic usage unchanged. |
| S23-monthly-cap | Set monthly cap to EUR 6 and the employer's daily allowance to two purchases/EUR 10. Complete one EUR 9 lunch with EUR 4 automatic employee debit. A second EUR 9 lunch still has EUR 5 benefit but only EUR 2 automatic budget left: Confirm with `monthly_cap`; a manual approval settles without increasing automatic usage. |
| S24-offer-change-leaves-auto | EUR 4 employee v1 is Auto-authorized but runner has not dispatched; change offer to EUR 13/EUR 8 employee: v2 Confirm, old evidence invalidated, no automatic send until appropriate new authority. |
| S25-employer-share-lost-auto | Complete a subsidized EUR 9 lunch; a distinct second EUR 9 lunch that day has zero employer share and EUR 9 employee debit: Confirm under the default EUR 10 maximum. A EUR 13 second-lunch variant is Exception. Neither reprices the first purchase. |
| S28-autopay-dispute | Completed zero-fee Auto purchase; timely dispute requests full refund, returns each share to its owner, releases automatic usage once and leaves completion with separate completed-return status. |
| S26-blocked-merchant | Blocked merchant selected: `proposal_rejected`, `blocked_merchant`, no new purchase/authorization/settlement; an exception cannot override it. |
| S27-psp-no-mandate | Otherwise eligible Auto purchase with capability false or absent: Confirm with `psp_unsupported`, device approval required. |

Run Auto-capable journeys in both direct and per-PSP initiation. Parameterized capability-off variants of Auto journeys must wait for a real device signature and produce no mandate authorization, reservation or Auto receipt. S27 specifically owns the unsupported-capability example.

Additional required contracts, preferably extending the existing strongest public-interface test owner rather than duplicating entire scenarios:

- Signature/identity: wrong signer, wrong employee, stale mandate publication, payload mutation, replay, invalid stored authority, forged exception flag and stale exception acknowledgment fail for their intended reason.
- Amounts: exact Auto/max/monthly equality, one cent above, fee crossing each threshold, zero debit, disabled limits and safe-integer/schema rejection.
- Lifetime: never-published versus expired versus revoked, retained blocks/maxima, expiry between approval and submission, mandate change preserving ordinary approval but invalidating an acknowledged exception, and newly blocked open proposals.
- Contention: two otherwise Auto proposals compete for insufficient combined budget; only one is admitted automatically. Use real asynchronous holds as in `test/coordinator-concurrency.test.ts` to protect reservations and frozen terms during waits.
- Handoffs: revocation before first send stops it; revocation after handoff cannot erase an unknown payment; subsequent first PSP handoffs recheck; retries use identical keys. A direct-backend generic lost-response error retains accounting and can resolve.
- Funding: lost/expired employer authority on an existing Auto proposal never enlarges the employee share or starts a replacement; a fresh second purchase uses fresh eligibility.
- Month: calendar rollover including February, old-month pending retries and late refunds, replacement/revocation preserving usage, and cap reductions below current usage.
- Returns: unsupported/incomplete refunds retain accounting, a returned fee-bearing purchase retains its unreturned fee, an employee leg never charged releases its full hold after recovery resolves, a lost refund response is reconciled before another return attempt, duplicate receipt/dispute/refund actions do not double-release, deadline equality is accepted and a later first dispute is rejected.
- Presenter/privacy: agent cannot invoke privileged mutations; automatic progression uses the trusted runner; quotations are side-effect-free; employee receives Auto payer view while sponsor/payee views do not gain employee mandate details.
- Compatibility: existing atomic/independent settlement invariants and S03–S18 remain intact; manual fixtures do not silently gain Auto or exception authority.

Validate implementation with `pnpm test`, `pnpm scenarios` and `pnpm presenter`. All scenarios must satisfy their updated expected outcomes, all traces must retain correct origins, and presenter claims must have evidence. Check reproducibility with fixed run identifiers through the existing JSON run-record paths. Use `git diff --check` for the documentation change itself; no runtime pass is evidence that this unimplemented spec already works.

## 13. Assumptions, deferred work and loop report

Design choices made without an additional interview: employee mandates are scoped to the benefit-purchase flow; ordinary fixtures keep Auto off; retained restrictions survive revocation/expiry; any mandate revision invalidates an exception; automatic execution uses a trusted explicit runner step; months use UTC; refunded fees remain counted until actually returned; no compatibility purchase cap is retained.

No unresolved product decision blocks simulator planning under those defaults. Implementation may choose names and private types consistent with existing code, but must preserve these contracts. Production authority/SCA classification, real provider support, merchant refund rights and a production dispute window require separate investigation; this spec makes no conclusion on them. Explorer rendering, general split auto-pay, real integrations, cross-coordinator ownership, persistence across process restart and fee-return support remain outside scope.

### Loop report

- Iterations run: **4 of 10**.
- Iteration 1 mode: **reviewed provided plan**, using the supplied inline spec as the candidate and preserving the requested spec output format.
- Questions asked: **0 of 3**. The defaults above resolve the design choices without requiring an interview.
- Stop reason: **stabilized**. The final pass found no further substantial change within the stated scope.
- Pass 1: resolved the original approval-version conflict; defined authority ownership, automatic execution, scope, retained restrictions, budgets, disputes and migration.
- Pass 2: clarified first handoff versus missing execution references, immutable retry assembly terms, partial-send authority loss, employer evidence, clock assumptions and executable monthly-cap setup; removed a proposed test-only ledger restoration seam.
- Pass 3: grounded uncertain-return retry behavior in the mock's non-idempotent refund and existing status interface; specified release of never-charged employee holds and original-month retry checks.
- Pass 4: checked scenarios, state/authority and accounting rules, source paths, fixture/CLI conventions, document structure and backlog linkage; no substantial rewrite.
- Validation performed for this documentation change: whitespace checks, balanced fenced blocks, all thirteen numbered sections, the ten S19–S27 scenario rows, referenced source paths and local backlog links. Runtime tests were not run; no implementation changed.
