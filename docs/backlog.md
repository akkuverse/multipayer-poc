# Backlog

Known defects and planned work. Defects B1–B5 from the 14 October 2026 review are fixed; see git history.

## Defects

None open. Fixed since the review:

- **B6 (fixed).** `reconcile` on a purchase that was never submitted derived `completed` from a vacuous all-settled check on zero legs — a status query alone could complete a purchase with no money moved. `reconcile` now refuses with `nothing to reconcile` when the purchase has no legs. Found by `test/invariants.property.test.ts` (seed 1); regression in `test/defects.test.ts`. The sibling path — a zero-amount proposal completing vacuously — is also closed: `propose`/`changeOffer` refuse non-positive or non-integer totals.
- **B7 (fixed).** `resubmit` had no state guard and no authority recheck, so a leg refused before reaching the backend (no `executionRef`) got its *first* initiation on retry — it could settle under a revoked mandate and could reopen `failed`, `cancelled` or `recovery_required` purchases after the benefit reservation was released or money was returned. `resubmit` now runs only in `pending` (or `completed`, where the backend dedupes) and re-runs the initiation recheck — approval signature and expiry, or the employer mandate via `benefitNow` — for every leg that was never forwarded. Found by the plan's integrative review; regression in `test/defects.test.ts`.

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
- **AI presenter demo**: clickable mock on top of the coordinator, see the presenter trace in [experiment-protocol.md](experiment-protocol.md#ai-presenter-artifact). Agents never call approval or submission functions.
- **Type checking.** No type checker runs today (zero dev dependencies). Adding `typescript` as a dev dependency for `tsc --noEmit` in CI needs approval.
