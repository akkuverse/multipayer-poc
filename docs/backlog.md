# Backlog

Known defects and planned work, from the 14 October 2026 review. Highest value first.

## Defects

| # | Issue | Where | Effect |
|---|---|---|---|
| B2 | Daily cap is not stateful. `usedTodayCents` is caller input and never updated after a completed purchase | `src/policy.ts`, `src/coordinator.ts` | Two concurrent purchases each get the full daily cap. Needs a per-mandate usage ledger, reserved at submission and released on failure or return |
| B4 | The approval's `expiresAt` is not part of the binding check | `src/coordinator.ts` `approve` | A caller-supplied approval can carry a longer expiry than the proposal |
| B5 | The authority recheck at initiation covers validity, revocation and merchant only, not per-purchase or daily caps | `src/coordinator.ts` `submit` | A cap change between proposal and initiation is not caught. Fix together with B2 |

## Domain check

- The German EUR 7.67 (Sachbezugswert EUR 4.57 + EUR 3.10, 2026) applies per meal, for one meal per working day, not as a daily budget split across purchases. S11 ("benefit partly used today") models a split that the tax rule may not support. Confirm with tax/legal before presenting it; consider modelling "one subsidised meal per working day" instead.

## Planned

- **Fees on returns.** Returns give back the amount, not the payer fee, and `outstandingCents`/recovery reporting counts only leg amounts, so an unreturned fee is invisible in the trace. Decide whether a return after a partial failure should also return the fee, and how recovery reporting should surface unreturned fees.
- **Signed mandates.** Sign `EmployeeApproval` and `EmployerMandate` with Ed25519 (`node:crypto`, no dependency) and verify before submission. Closes the gap that authority is an unsigned in-memory object, and aligns with AP2's signed mandates. Real SD-JWT format is not needed for the mock.
- **Initiation model.** In the digital euro, each payer's PSP initiates its payment. Make explicit which party submits the employer leg (employer's PSP, employee's PSP, app) instead of one coordinator submitting both legs to one backend. The ECB adapter's interface is a finding, not a given.
- **ECB adapter.** Replaces `MockBackend` behind the same calls, tags events `ECB_API`. Keep it in a separate private repository or module: it will use test-environment specifications covered by the ECB contract's confidentiality clause (Annex 1, clause 8).
- **Peer bill split** as an optional scenario: symmetric special case of split authority.
- **AI presenter demo**: clickable mock on top of the coordinator, see the presenter trace in [experiment-protocol.md](experiment-protocol.md#ai-presenter-artifact). Agents never call approval or submission functions.
