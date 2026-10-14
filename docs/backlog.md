# Backlog

Known defects and planned work. Defects B1–B5 from the 14 October 2026 review are fixed; see git history.

## Defects

None open. Fixed since the review:

- **B6 (fixed).** `reconcile` on a purchase that was never submitted derived `completed` from a vacuous all-settled check on zero legs — a status query alone could complete a purchase with no money moved. `reconcile` now refuses with `nothing to reconcile` when the purchase has no legs. Found by `test/invariants.property.test.ts` (seed 1); regression in `test/defects.test.ts`. The sibling path — a zero-amount proposal completing vacuously — is also closed: `propose`/`changeOffer` refuse non-positive or non-integer totals.
- **B7 (fixed).** `resubmit` had no state guard and no authority recheck, so a leg refused before reaching the backend (no `executionRef`) got its *first* initiation on retry — it could settle under a revoked mandate and could reopen `failed`, `cancelled` or `recovery_required` purchases after the benefit reservation was released or money was returned. `resubmit` now runs only in `pending` (or `completed`, where the backend dedupes) and re-runs the initiation recheck — approval signature and expiry, or the employer mandate via `benefitNow` — for every leg that was never forwarded. Found by the plan's integrative review; regression in `test/defects.test.ts`.
- **B8 (fixed).** `MockBackend.submit` resolved each leg's accounts inside `settle`, so an unknown payee or fee collector on a later leg threw *after* earlier legs had settled — a thrown request left committed money the coordinator could no longer see. Accounts for every leg in the request are now resolved before the first debit and before any idempotency key is recorded, and again before an assembled group settles (an account may vanish mid-assembly; the group stays alive so its deadline can still resolve it). Found by the integrative review; regression in `test/defects.test.ts`.
- **B9 (fixed).** `derive` had no case for `returned` legs of a `completed` purchase, so a `reconcile` or `resubmit` after a refund relabelled the purchase `cancelled` (full refund) or `recovery_required` (mid-refund bail), after which `refund` itself refused — the same logical state got two labels by call order. Returned legs of a completed purchase now count as settled in `derive`, matching `refund`'s contract that the purchase stays `completed`. Regression in `test/defects.test.ts`.

## Domain check

- The model applies EUR 7.67 per meal, one subsidised meal per working day (S11). Present it as an illustrative German example until a tax adviser confirms:
  - **Benefit in kind or cash wages:** whether an employer contribution paid directly to the merchant in digital euro qualifies as a benefit in kind (meal-voucher treatment) at all, or counts as cash wages. If it is cash wages, the EUR 7.67 framing does not apply.
  - **Qualifying days:** the per-day conditions (no subsidy on leave, sick or travel days with a per-diem allowance). The model treats every calendar day as a working day.
  - **Taxable benefit:** the employee co-payment rule. The benefit is tax-free only if the employee pays at least the Sachbezugswert. The reference case (EUR 8) passes, but the policy does not check it.
  - **Amounts:** the 2026 values (EUR 4.57 Sachbezugswert + EUR 3.10).

## Planned

- **Fees on returns.** Returns give back the amount, not the payer fee, and `outstandingCents`/recovery reporting counts only leg amounts, so an unreturned fee is invisible in the trace. Decide whether a return after a partial failure should also return the fee, and how recovery reporting should surface unreturned fees.
- **ECB adapter.** Implements `SettlementBackend`; must pass `test/contract/settlement-backend.contract.ts`. Replaces `MockBackend` behind the same calls, tags events `ECB_API`. Keep it in a separate private repository or module: it will use test-environment specifications covered by the ECB contract's confidentiality clause (Annex 1, clause 8).
- **Per-leg reject reasons in trace events.** The backend `submit` event omits per-leg reject reasons, so S04 and S12 produce identical trace digests — distinct failure modes yield indistinguishable evidence. Carry the reason in the event detail.
- **Property-test coverage.** Extend the op generator in `test/invariants.property.test.ts`: `cancel`, `reviseInstruction`, multiple concurrent purchases (ledger contention), and `proposeSplit` purchases are not yet generated.
- **Complete group after a transient resolution failure.** If `resolveAccounts` throws when an assembled group completes (an account deleted mid-assembly), the group stays in `assembling` but nothing re-triggers completion — a dedupe retry returns the recorded outcome and `status` only expires, so the group can only fail `group_incomplete` even if the account is restored within the window. Fail-closed and deadline-bounded; decide whether a retried submission should re-attempt completion.
- **Benefit day across a pending midnight.** A benefit reservation is booked under the day it was made and consumed under that day, but `resubmit`'s recheck evaluates `benefitNow` — and therefore daily usage — on the *current* day. A purchase pending across midnight can be falsely blocked by another purchase's new-day draw (fail-closed, resolves on group expiry) or record consumption on a different day than the recheck examined. Decide whether the recheck should evaluate the reservation's day.
- **AI presenter demo**: clickable mock on top of the coordinator, see the presenter trace in [experiment-protocol.md](experiment-protocol.md#ai-presenter-artifact). Agents never call approval or submission functions.
- **Type checking.** No type checker runs today (zero dev dependencies). Adding `typescript` as a dev dependency for `tsc --noEmit` in CI needs approval.
