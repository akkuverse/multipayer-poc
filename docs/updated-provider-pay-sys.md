# SPEC — Settlement ledgers (core-v9)

Status: revised draft after codebase-design review · 2026-11-04 · target repo `akkuverse/multipayer-poc` (`src/settlement/*`, `src/core/*`, `src/scenarios.ts`)
Replaces: the single `MockBackend` (spec `mock-3`) that holds every balance.

## 1. Why
core-v8 keeps digital-euro holdings and bank balances in one mock backend, so one call can settle an employee's digital-euro share and an employer's bank share together. In reality those live in different places and no single system can commit both. The explorer then teaches something false (S01: "settle as one transaction").

## 2. Decisions (from review)
1. **Atomic scope is per ledger.** Shares on the same ledger may settle all-or-nothing. Shares on different ledgers settle separately; the purchase is complete only when every share settles.
2. **Commit driver is a new coordinator module** — the *Settlement orchestrator*, inside the coordinator's one-operator set (with benefit split, ledger, party views).
3. **Shop providers are receive-only.**
4. Same-ledger atomic groups, provider acceptance and hold guarantees are **LOCAL simulation assumptions**, not demonstrated ECB capabilities. Every event retains its origin; no local result establishes ECB support. No ECB adapter or confidential contract implementation belongs in this repository.
5. This document is the deliverable; code changes land in the repo, then sync to core-v9 / Explorer v20.

## 3. Where money lives
| Ledger | Holds | Who may act on it |
|---|---|---|
| **Provider books** (one per payer's provider) | That customer's bank balance (commercial bank money) | Only that provider |
| **Digital-euro settlement** (Eurosystem) | Digital-euro holdings, pseudonymous, with holding limit | Only the holder's provider, for its own customer |
| **Interbank transfer** | Nothing per customer; moves bank money provider → provider | Providers |

- Employer, shops and the platform hold no digital euro (unchanged rule, now enforced at the Eurosystem ledger: `holdingLimitCents = 0`).
- The digital-euro ledger knows holdings by pseudonym only; the provider maps pseudonym ↔ customer. Traces from this ledger carry the pseudonym, never the payer id.
- Offline digital euro: out of scope.

## 4. Modules
### 4.1 `PayerProvider` (replaces `SimulatedPsp`)
- Owns its customers' bank accounts (`bankCents`) and their digital-euro pseudonym.
- Interface: `reserve(intent, authorityEvidence)`, `commit(holdRef)`, `release(holdRef)`, `status(operationKey)`, `refund(executionRef, returnKey)`. Every mutating operation carries a stable operation key and immutable terms. Reserve returns an acceptance reference and hold expiry; status can locate an operation even when its response and reference were lost.
- Reserve validates provider ownership, rail, amount, fee and accepted authority evidence. Funding, defunding, pseudonym mapping and ledger-specific recovery stay inside the provider implementation. Status reports their unresolved effects until cleanup is confirmed.
- A share is paid from the customer's **digital euro** or **bank**, decided by the share's `rail` (see §5).
- `available` and `supportsMandatePayments` keep their current meaning.
- Charges its own fee; `FEE_COLLECTOR` (`psp-fees`) is removed. Fee lands in the provider's own fee account.

### 4.2 `ShopProvider` (new, receive-only)
- Holds the shop's bank account. Receives interbank credits and digital-euro credits (immediately defunded to bank: holding limit 0).
- Supports `debitForRefund(ref)` only when a refund is issued; never initiates payments.
- No availability toggle in v9 (keeps scope tight); listed as open question §11.

### 4.3 `EurosystemLedger` (new)
- Holds `{ pseudonym, deCents, holdingLimitCents }`.
- Operations (provider-only): `hold`, `commitHold`, `releaseHold`, `fund` (from bank), `defund` (to bank), `transfer`.
- Supports a **same-ledger atomic group**: several holds committed in one step. The group has frozen membership and a stable identity; it validates all holds before changing any holding. This is a LOCAL mock assumption. A merchant credit at holding limit zero must route excess into tracked defunding transit rather than temporarily violating the holding limit.

### 4.4 `InterbankTransfer` (new)
- Moves bank money from payer provider to shop provider. Settles each transfer on its own; no groups. A payer-book debit alone is not settlement: the provider tracks the amount in transit until the destination credit is confirmed. Lost responses remain unknown and never create a second debit.

### 4.5 `SettlementOrchestrator` (new, inside the coordinator set)
- Turns a submitted purchase into ledger work, drives reserve → commit / release, reconciles, and issues compensating returns.
- Holds no money and no keys beyond the coordinator's own. It never acts for a payer without that payer's provider accepting.
- Replaces the backend's group assembly (`assemble`, `assembling`, `expiredGroups`) and the coordinator's direct calls into `MockBackend`.
- Its records join the coordinator's evidence log (actor `orchestrator`).

### 4.6 Interface depth and ownership
- The coordinator verifies signed requests and terms, admits employer-benefit and Auto budgets, and derives purchase outcomes from settlement evidence. The orchestrator owns execution ordering, frozen operation identities, reconciliation and compensation. The coordinator does not drive individual ledger operations.
- The orchestrator presents `submit(frozenIntent)`, `reconcile(purchaseRef)` and `returnSettled(purchaseRef, scope)` returning a settlement snapshot. Snapshots include per-leg principal, fees, progress, unknown operations, confirmed returns and outstanding exposure. A repeated call resumes the same intent; changed terms are refused.
- Before each leg's first provider handoff, the orchestrator invokes the coordinator's deterministic authority recheck. This preserves existing expiry, mandate revision/revocation, eligibility and booked-budget checks. Agents receive neither this interface nor approval/submission handles.
- Ledger adapters and the small receive-only shop module are internal seams of settlement. No extra public abstraction is required merely for diagram symmetry. Tests exercise the orchestrator interface; provider and ledger contracts verify their own money and identity invariants.
- Retire the old assembly and route/reconciliation implementation when replacing it. Update the public settlement contract, fixtures, views and evidence consumers together; do not leave a second settlement driver in `Coordinator`.

## 5. Shares get a rail
Each share in a proposal carries `rail: 'digital_euro' | 'bank'`, fixed when the proposal is signed (part of the signed terms, like `settlementMode`).
- Employee/colleagues: `digital_euro` by default.
- Employer: always `bank` (businesses hold no digital euro).
- Signed split requests carry each share's rail; benefit proposals deterministically derive employee `digital_euro` and employer `bank`. Approval binding includes the complete per-share terms (role, payer, payee, rail, principal and fee), not only payer totals. Standing terms must permit the selected rail; unsupported rail changes require new terms and approvals.
- A purchase whose shares span both rails is a **cross-ledger purchase**. In the default S01 lunch (employee EUR 8 digital euro + employer EUR 5 bank) this is the normal case.

## 6. Settlement flow
Submission starts from a payer-signed request or the existing deterministic `on_ready` path. Both use the same verified terms and authority checks.

1. Freeze the authorised intent, payable leg identities, ledger routing, commit order and deadlines. Admit employer-benefit and Auto budgets synchronously before the first handoff, as today.
2. **RESERVE** every leg through its payer provider, rechecking authority at each first handoff. A provider acceptance binds the exact terms until `holdExpiresAt` under this LOCAL model. Later mandate revocation or approval expiry does not revoke an already accepted hold; an unaccepted leg must still pass the current checks.
3. A conclusive reserve refusal stops new work and releases accepted holds. Reconcile any unknown reserves and undo their funding effects before declaring cleanup complete. A timeout is never a refusal.
4. Once every reserve is confirmed, **COMMIT** bank legs in frozen proposal order, then the digital-euro atomic group. These are separate commits. A bank leg is settled only after destination credit; a digital-euro leg requiring waterfall is settled only after the destination bank credit is confirmed.
5. Complete the purchase only when every leg is confirmed settled. A conclusive commit failure stops further commits, releases uncommitted holds, and starts compensating returns of confirmed settlements. Resolve unknown commits before deciding what to return; never race a return against an unresolved original operation.
6. Compensation is complete only after all required returns, hold releases and funding cleanup are confirmed. Unsupported, failed or unknown returns keep exposure visible and recoverable.

Rules:
- Reserve-first reduces payment divergence; it does not guarantee compensation or mean no money moved. Funding may already have moved money before any merchant payment commits. Evidence distinguishes **no merchant payment committed** from **all funding effects restored**.
- Hold expiry is checked on the owning ledger's injected clock. For v9, each hold expires at reserve time + 30 simulated seconds, on either rail; `now >= holdExpiresAt` forbids commit. Reserve replay never extends it. Shop providers do not receive holds. These are synthetic fixture choices, not real-system claims.
- Before any payment commits, hold expiry causes cleanup; after a confirmed payment commit it causes compensation. An unknown commit remains unknown even after its hold deadline passes; authoritative status decides whether commit or expiry won.
- `settlementMode: 'atomic'` means reserve-all with compensation across ledgers, not cross-ledger atomicity. Evidence and UI must say so. `independent` reserves and commits each leg separately, cleans up failed legs, and retains the existing explicit recovery path for partial payment rather than automatically compensating successful legs.

### 6.1 Funding, waterfall and conservation
- Reverse waterfall is provider-owned work during reserve: reserve/debit linked-bank funds, record funding transit, then credit digital euro and establish the payment hold. Track bank debit and ledger funding separately with stable child operation identities. Never repeat a debit because funding timed out.
- If funding fails conclusively, restore the bank debit once. If funding succeeds but the payment hold fails, defund only the amount funded for that intent and restore it to bank. Unknown funding, defunding or restoration stays unresolved until status confirms its outcome.
- Waterfall credits and refunds above a holding limit similarly move excess through tracked defunding transit to bank. A lost destination credit response does not permit a second credit. Defunding can remain unresolved even with an always-available shop provider.
- Every movement has a matching destination or explicit in-transit entry. Holds reduce spendable funds without creating an additional balance. Synthetic conservation checks cover bank books, digital-euro holdings, provider fees and transit, with explicit paired bank/DE conversion entries; no amount disappears or is counted twice.
- Reserve holds principal plus the authorised fee. Charge fees only on confirmed settlement. Automatic compensation refunds principal and charged fees; `compensated` requires both restored. Ordinary post-completion refunds retain the existing principal-only fee policy, with unreturned fees visible.

## 7. Idempotency, status, unknown outcomes
- Preserve the existing leg identity `(purchaseId, proposalVersion, role)`; roles are unique per proposal. Extend it with a namespaced operation type for reserve, commit, release, return, fund and defund. Child movements also include their stage and destination. Use unambiguous tuple encoding, not unchecked delimiter concatenation.
- A digital-euro group has its own stable key, frozen ordered member leg identities and terms. Each ledger/provider retains its own idempotency store. Reusing a key with different terms is conclusively refused; replay never generates new keys, membership or deadlines.
- Record the operation intent before handoff. Status by the original key reports `not_started`, `pending`, `succeeded`, `rejected` or `unknown`, with the relevant hold/execution reference when known. `not_started` permits replay only with the same key and terms; it is not a final rejection. Pending/unknown or unavailable status never proves failure. Confirmed operation results are immutable; hold lifecycle (active, committed, released, expired) is reported separately.
- Unknown is per operation, not merely per ledger: two bank transfers on the same rail can differ. The provider reconciles its internal funding/defunding steps and exposes unresolved effects; orchestrator `reconcile()` resumes all unresolved provider operations and compensation using their original identities.
- The existing same-purchase operation guard covers submission, reconciliation and returns. Freeze intent across retries and retain ownership checks so foreign execution references cannot be returned.

### 7.1 Purchase state and accounting
Keep purchase lifecycle states separate from settlement progress. `reserving`, `reserved`, `committing` and `compensating` belong to the settlement snapshot, not `PurchaseState`.

| Confirmed evidence | Purchase state | Budget treatment |
|---|---|---|
| First handoff started; reserve/commit or cleanup unresolved, no confirmed payment exposure | `pending` | Retain reservations |
| Every leg settled | `completed` | Consume employer benefit and Auto booking once |
| No payment committed; all holds and funding effects cleaned up | `failed` | Release reservations once |
| Incomplete payment with confirmed committed principal, fee or recovery exposure | `recovery_required` | Retain reservations; report unknown operations and outstanding amounts |
| Automatic compensation and all cleanup confirmed, including charged fees | `compensated` | Release reservations once |
| Independent-mode explicit recovery fully resolved | `cancelled` | Existing release policy, retaining any charged fee in Auto usage |

- Add `compensated` as terminal. Required new reachable pairs: `ready → pending`; `pending → recovery_required | completed | failed | compensated`; `recovery_required → pending | compensated`, in addition to existing applicable pairs. `recovery_required → pending` is only for confirmed payment exposure cleared while cleanup remains unresolved. Terminal states cannot be asserted from a timeout.
- The coordinator alone writes purchase states and budget effects from the snapshot. Never release benefit or monthly budget merely because a hold expired, a response timed out or compensation was requested. Hold accounting remains distinct from these authority-budget reservations.
- Ordinary refund of a completed purchase retains `completed` with separate return status, as today. Dispute, selective payee returns, partial returns, outstanding principal and unreturned fees remain visible and preserve current caller-authorisation rules.

### 7.2 Request/outcome trace

Outcome events alone misread causality: a ledger hold appeared before the provider's confirmation, a sent-but-unanswered call left no trace, and one action read as three unrelated events. Every cross-party call that can move or reserve money therefore emits a `<op>_requested` event **from the sender, immediately before dispatch**, carrying:

- `key` — the operation identity the outcome event pairs with (identical on both),
- `to` — the receiving actor (`orchestrator`, a provider id, `de-ledger`, `bank-transfer`; provider-internal bank-book children carry the provider itself),
- `parent` — the key of the request that caused this one (`null` at a coordinator submit or explicit return root),
- `attempt` — the sender's dispatch count under that key: a retry is a new `_requested` with a higher attempt, never a new key, and the receiver's deduped outcome is unchanged.

`parent` resolves to the nearest earlier `_requested` event carrying that key. Calls forwarded under an unchanged key (payer provider → shop provider → ledger/bank) keep the key on both hops, so the onward request's `parent` equals its own key and resolves to the immediately preceding request — the shop hop.

Coordinator submit and explicit return dispatches share the purchase reference key and sender counter: after one submit, the first explicit return has `attempt: 2`. The return root carries its reason and leg scope; downstream return requests resolve their purchase-reference parent to this root. The pre-existing `refund_requested` event records the authorized user's intent before state checks; it is a lifecycle note, not a dispatch request, and carries no `to` or operation key.

Request events by edge:

| Edge | Events |
|---|---|
| coordinator → orchestrator | `submit_requested` (initial and every resubmit), `return_settled_requested` (refund, recovery and dispute) |
| orchestrator → provider | `reserve_requested`, `commit_requested`, `release_requested`, `return_requested` |
| orchestrator → DE ledger (via the provider-owned group helper) | `de_group_commit_requested` |
| provider → DE ledger | `de_hold_requested`, `de_commit_requested`, `de_release_requested`, `de_fund_requested`, `de_defund_requested`, `de_cancel_requested` |
| provider → interbank transfer | `bank_transfer_requested`, `bank_cancel_requested` |
| provider → own bank book | `bank_debit_requested`, `bank_hold_requested`, `bank_release_requested`, `bank_restore_requested` |
| payer provider → shop provider | `confirm_credit_requested`, `cancel_uncredited_requested`, `debit_for_refund_requested` |
| shop provider → DE ledger / interbank | `de_defund_requested`, `de_cancel_requested`, `bank_transfer_requested` (parent = the forwarded key) |

Reads, status queries, registry reads, signature checks and coordinator-internal reservations emit no request. A refusal before acting (provider unavailable, validation) pairs its rejected outcome with the request. A request with no outcome stays visibly open — never synthesize an outcome; the lost-reply scenarios exist to show exactly that. `pnpm scenarios --mermaid` draws each dispatch request as an arrow from sender to `to`; lifecycle notes without `to` remain notes.

## 8. Initiation modes
- `per_payer_psp` (default): as above.
- `coordinator_as_psp`: the coordinator is the payer's provider — it then also holds that payer's provider books. Mixed (some payers on own providers) stays refused (`direct_initiation_mixed_psps`).
- `test_bypass_psp`: test-only; orchestrator talks to ledgers directly with provider checks off. Never shown as realistic.

## 9. Scenarios to re-derive
| Scenario | Change |
|---|---|
| S01 both approve | Title no longer "one transaction": two ledgers, reserve both, commit both. |
| S02 reverse waterfall | Funding step at the provider during reserve; new failure point between bank debit and digital-euro credit. |
| S04, S06, S13, S14 | Conclusive pre-handoff refusal stops reserve; reconcile unknown work, release holds and restore funding effects before `failed`. |
| S05 independent partial failure | Unchanged in spirit; per-share reserve/commit. |
| S16 timeout | Unknown is per ledger; status asked at that ledger. |
| S17 refund holding limit | Refund credit above the limit defunds at the payer's provider. |
| S18 multi-payee | One shop provider per payee; interbank per payee. |
| S33 refund by payer | Shop provider debits, interbank back, payer provider credits (digital-euro or bank per original rail). |
| **New** S35 hold expires before commit | No merchant payment committed; release holds and confirm funding cleanup before `failed`. |
| **New** S36 commit diverges | Bank committed, digital-euro group fails → compensating return of the bank share; purchase ends `compensated` only after principal, fees and cleanup are confirmed. |

### 9.1 Required acceptance coverage
In addition to re-derived scenarios, verify through the owning module's interface:
- Lost reserve response after hold creation: status finds the same hold; no second hold, fresh deadline or premature budget release.
- Lost funding/defunding response and failed hold after funding: one debit/credit per original operation; transit remains visible until restored.
- Lost commit response after settlement: resolve it before returning funds; no duplicate payment or return.
- Failed, unsupported and unknown compensation: no terminal `compensated` until all principal, fees and cleanup resolve.
- One payer with multiple roles and payees, plus changed proposal versions: distinct leg operations; replay preserves each identity; changed terms under an existing key are refused.
- Mandate revocation/expiry between reserves and before commit: unaccepted legs fail current first-handoff checks; accepted holds follow the explicit acceptance guarantee until expiry.
- Hold expiry racing commit, bank debit preceding destination credit, and atomic DE-group member failure: preserve per-ledger guarantees and visible transit.
- Concurrent purchases competing for balances and benefit/Auto budgets: reservations cannot overspend; unresolved work retains budget; confirmed cleanup releases once.
- Completed-purchase refunds, disputes and independent recovery preserve current authorisation and accounting semantics. All traces retain origin and ledger traces expose pseudonyms rather than payer ids.

Use synthetic fixtures, injected clocks and no network calls or dependencies. Preserve the four repository safety invariants and run `pnpm test` and `pnpm scenarios` after implementation. Update contract tests, property invariants, run-record digests, findings and presenter consumers for the new assumption version; LOCAL passes remain LOCAL.

## 10. Explorer consequences (Explorer v20)
- Setup step 2 → "Providers open accounts": balances per provider; digital-euro holdings shown under the Eurosystem ledger by pseudonym. Step 6 merges into it.
- "Payment system" card splits into **Digital-euro settlement** and **Bank transfers**.
- New card **Settlement orchestrator** inside the coordinator's dashed set.
- Provider tiles show balance, hold and per-step status (reserve → commit / release). One receive-only **Shop provider** tile per payee.
- No real institution names anywhere.

## 11. Open questions
1. Production hold guarantees and expiry values are unverified; v9 uses the explicit synthetic policy in §6.
2. Can a shop provider be offline (credit fails after payer commit → compensation)? Deferred from v9.
3. Ordinary-refund fee policy remains the existing backlog item. Automatic compensation restores fees under §6.1.
4. Interactive employee rail choice is deferred. v9 uses the signed/derived rail rules in §5; it never silently substitutes a rail.

