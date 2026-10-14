# Backlog

Known defects and planned work, from the 14 October 2026 review. Highest value first.

## Defects

None open.

## Domain check

- The model applies EUR 7.67 per meal, one subsidised meal per working day (S11). Present it as an illustrative German example until a tax adviser confirms:
  - **Benefit in kind or cash wages:** whether an employer contribution paid directly to the merchant in digital euro qualifies as a benefit in kind (meal-voucher treatment) at all, or counts as cash wages. If it is cash wages, the EUR 7.67 framing does not apply.
  - **Qualifying days:** the per-day conditions (no subsidy on leave, sick or travel days with a per-diem allowance). The model treats every calendar day as a working day.
  - **Taxable benefit:** the employee co-payment rule. The benefit is tax-free only if the employee pays at least the Sachbezugswert. The reference case (EUR 8) passes, but the policy does not check it.
  - **Amounts:** the 2026 values (EUR 4.57 Sachbezugswert + EUR 3.10).

## Planned

- **Fees on returns.** Returns give back the amount, not the payer fee, and `outstandingCents`/recovery reporting counts only leg amounts, so an unreturned fee is invisible in the trace. Decide whether a return after a partial failure should also return the fee, and how recovery reporting should surface unreturned fees.
- **Signed mandates.** Sign `PayerApproval` and `EmployerMandate` with Ed25519 (`node:crypto`, no dependency) and verify before submission. Closes the gap that authority is an unsigned in-memory object, and aligns with AP2's signed mandates. Real SD-JWT format is not needed for the mock.
- **Initiation model.** Modelled as a hypothesis: each payer's simulated PSP submits its own leg and the backend assembles atomic groups by a deadline (S16–S18, [initiation-model.md](initiation-model.md)). Which initiation the real environment supports is an open question for the ECB adapter; the adapter's interface is a finding, not a given.
- **ECB adapter.** Replaces `MockBackend` behind the same calls, tags events `ECB_API`. Keep it in a separate private repository or module: it will use test-environment specifications covered by the ECB contract's confidentiality clause (Annex 1, clause 8).
- **Per-leg reject reasons in trace events.** The backend `submit` event omits per-leg reject reasons, so S04 and S12 produce identical trace digests — distinct failure modes yield indistinguishable evidence. Carry the reason in the event detail.
- **Zero-amount proposals.** `propose` with `totalCents: 0` produces no legs, and a vacuous all-settled check marks it `completed` without any settlement. Refuse non-positive totals at proposal time.
- **Findings table columns.** docs/experiment-protocol.md lists a `Design implication` column the generated table omits (the plan prescribes the current header). Reconcile code or doc in the documentation sweep.
- **AI presenter demo**: clickable mock on top of the coordinator, see the presenter trace in [experiment-protocol.md](experiment-protocol.md#ai-presenter-artifact). Agents never call approval or submission functions.
