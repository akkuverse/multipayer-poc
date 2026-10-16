# Field map

Status: **14 October 2026.** Which party may legitimately see which purchase field, and why. `src/core/views.ts` implements the three party columns as projections — currently a subset of what the map permits (for example, a payer's own approval reference is permitted but not yet surfaced). Tests in `test/views.test.ts` pin the employer and payee projections. "Backend" is what `SettlementBackend.submit` receives.

| Field | Purpose | Payer | Payee (merchant) | Employer (sponsor) | Backend |
|---|---|---|---|---|---|
| purchaseId | Group the contributions of one purchase | yes | yes | yes | yes, as groupRef |
| state | Completion, pending, recovery | yes | yes | no; own leg status only | no |
| merchantId | Eligibility and display | yes | itself | yes, eligibility evidence | yes, as payeeId per leg |
| totalCents | Check that the shares add up | yes | as the sum of its own legs | no | no |
| Own share | What this party pays or contributes | yes | no | yes | amountCents per leg |
| Payer fee | Paid to the payer's own PSP, bound in the approval | own only | no | no | feeCents per leg |
| Other payers' shares | Check that the total is covered | combined only | no | no | amountCents per leg |
| Payer identities | Debit the right account | own only | no | no | payerId per leg |
| Employee instruction (max share) | Keep the employee's share within their limit | own only | no | no | no |
| Approval reference | Authority evidence | own only | no | no | no |
| Mandate reference | Authority evidence | no | no | own mandate | no |
| executionRef | Status queries and returns | own legs | own legs | no | yes |
| idempotencyKey | Safe retries | no | no | no | yes |
| Benefit eligibility and usage | Decide the employer share | no | no | own mandate's usage | no |

Finding: the backend needs no benefit or authority information to settle, so benefit conditions stay in the application. The employer never sees the purchase total, the employee's share or other purchases.

## Presenter projections

The scripted synthetic presenter (`src/presenter/session.ts`) adds a further-reduced projection for the employee-side recipient and the agent handle. These fields are *safe eligibility results* — the outcome of policy evaluation — not the underlying policy, mandate or usage data behind them.

| Field | Content | Agent handle | Employee recipient |
|---|---|---|---|
| OfferView | Sourced catalog fields (offer reference, title, tags, price, availability, source, walking time) plus retrieval time | yes | yes |
| QuoteView amounts | Deterministic split from `Coordinator.quote`: own share, combined other contributions, own fee | yes | yes |
| withinInstruction | Whether the quote fits the fixed personal limit | yes | yes |
| reasons | Safe eligibility result, allowlist only: `benefit_unavailable`, `merchant_ineligible`, `personal_limit_exceeded`, `offer_expired`, `approval_expired` | yes | yes |
| PresenterView | Payer view plus selected offer, proposal version/expiry, fixed personal limit, recorded approvals | yes | yes |
| RecordedApprovalView | Approval reference, payer id (the employee's own), proposal version, expiry, whether it binds the current proposal and is currently valid — never the signature or key | yes | yes |
| eventSeqs | Observation references into the audit trace; they grant no access to the raw records behind them | yes | yes |

Session observation events retain detached copies of the safe projections, with the fixed personal limit and, for discovery, the applied preferences. Agent results reference only these observation events. Trusted user-flow results may additionally reference coordinator/backend audit events for evaluator use. The trusted `snapshot()` export remains a detached raw purchase for run recording; it is never exposed as an agent observation.

Never surfaced through recipient projections: mandate references, other payers' identities, signatures and keys, ledger usage, idempotency keys or unfiltered backend errors. Neither handle exposes the coordinator, the live purchase or the raw trace. The employee's maximum share is visible to the employee's own presenter surface only — the employer's minimisation above is unchanged: it still sees its own contribution and eligibility evidence, never the purchase total, the employee's share or other purchases.
