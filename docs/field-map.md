# Field map

Status: **22 October 2026.** Which party may legitimately see which purchase field, and why. `src/core/views.ts` implements the three party columns as projections — currently a subset of what the map permits (for example, the employee's own mandate *reference* is permitted but deliberately withheld; only the observed revision is surfaced). Tests in `test/views.test.ts` pin the employer and payee projections. "Backend" is what `SettlementBackend.submit` receives.

| Field | Purpose | Payer | Payee (merchant) | Employer (sponsor) | Backend |
|---|---|---|---|---|---|
| purchaseId | Group the contributions of one purchase | yes | yes | yes | yes, as groupRef |
| state | Completion, pending, recovery | yes | yes | no; own leg status only | no |
| merchantId | Eligibility and display | yes | itself | yes, eligibility evidence | yes, as payeeId per leg |
| totalCents | Check that the shares add up | yes | as the sum of its own legs | no | no |
| Own share | What this party pays or contributes | yes | no | yes | amountCents per leg |
| Payer fee | Paid to the payer's own PSP, bound in the approval; part of the fee-inclusive employee debit | own only | no | no | feeCents per leg |
| Other payers' shares | Check that the total is covered | combined only | no | no | amountCents per leg |
| Payer identities | Debit the right account | own only | no | no | payerId per leg |
| Employee standing terms | Ordinary maximum, automatic per-purchase/monthly limits, trusted/blocked merchants, expiry, revocation | own only — limits, lists and revision, never the mandate reference or signature | no | no | no |
| Employee assessment | The current authorization answer for this purchase: zone (`Blocked`/`Auto`/`Confirm`/`Exception`), fee-inclusive debit, reason it is not Auto | own only | no | no | no |
| Authorization basis + reference | Which authority funded this payer's shares: device signature (approvalRef), signed one-off exception (approvalRef) or standing terms (no reference surfaced) | own only | no | no | no |
| Employer mandate reference | Authority evidence | no | no | own mandate | no |
| executionRef | Status queries and returns | own legs | own legs | no | yes |
| idempotencyKey | Safe retries | no | no | no | yes |
| Benefit eligibility and usage | Decide the employer share | no | no | own mandate's usage | no |
| Automatic-payment usage | The employee's monthly reserved/consumed automatic budget | own only; not yet surfaced as a raw figure — visible today only through the assessment's `monthly_cap` reason | no | no | no |
| Return outcome | Return status plus confirmed returned principal, kept separate from settlement | own legs | own legs' contribution status | own contribution's returned status | yes, as the refund result |
| Unreturned fee | The charged fee a principal-only return never gives back — reported separately so "principal returned; fee retained" is not folded into returned principal | own only | no | no | no |
| Auto receipt | The one receipt a mandate-authorized completed purchase earns: observation time, original amounts, used terms revision, fixed dispute deadline | own only (time, deadline, used mandate version — not the mandate reference) | no | no | no |
| Dispute case | The employee's accepted dispute and its return-request outcome (`opened`/`unresolved`/`unsupported`/`returned`) | own only | no | no | no |

Finding: the backend needs no benefit or authority information to settle, so benefit conditions stay in the application. The employer never sees the purchase total, the employee's share, the employee's standing terms or automatic budget, or other purchases.

## Presenter projections

The scripted synthetic presenter (`src/presenter/session.ts`) adds a further-reduced projection for the employee-side recipient and the agent handle. These fields are *safe eligibility results* — the outcome of policy and assessment evaluation — not the underlying policy, mandate or usage data behind them.

| Field | Content | Agent handle | Employee recipient |
|---|---|---|---|
| OfferView | Sourced catalog fields (offer reference, title, tags, price, availability, source, walking time) plus retrieval time | yes | yes |
| QuoteView amounts | Deterministic split from `Coordinator.quote`: own share, combined other contributions, own fee | yes | yes |
| QuoteView assessment | Current `authZone` and `autoPayBlockedReason`, the standing maximum (absent means never published — never an infinite limit), the observed mandate version | yes | yes |
| reasons | Safe eligibility result, allowlist only: `benefit_unavailable`, `merchant_ineligible`, `merchant_blocked`, `personal_limit_exceeded`, `offer_expired`, `approval_expired` | yes | yes |
| PresenterView | Payer view plus selected offer, proposal version/expiry, observed assessment and recorded authorizations | yes | yes |
| RecordedAuthorizationView | Basis (`device`, `exception`, `mandate`), the employee's own approvalRef for signed bases or the cited standing-terms revision for mandate basis, proposal version, whether it binds the current proposal and is currently valid — never the signature or key | yes | yes |
| EmployeeTermsView | The employee's own standing terms: limits, merchant lists, expiry, revocation, revision — never the mandate reference, signature or key | no — trusted user flow only | yes |
| eventSeqs | Observation references into the audit trace; they grant no access to the raw records behind them | yes | yes |

Session observation events retain detached copies of the safe projections, with the assessment and, for discovery, the applied preferences. Agent results reference only these observation events. Trusted user-flow results may additionally reference coordinator/backend audit events for evaluator use. The trusted `snapshot()` export remains a detached raw purchase for run recording; it is never exposed as an agent observation. A third trusted handle, `runner`, advances the session purchase deterministically; it is never offered as an agent tool.

Never surfaced through recipient projections: mandate references (employee or employer), other payers' identities, signatures and keys, raw ledger usage, idempotency keys or unfiltered backend errors. Neither handle exposes the coordinator, the live purchase or the raw trace. The employee's standing terms and monthly automatic usage are visible to the employee's own surfaces only — the employer's minimisation above is unchanged: it still sees its own contribution and eligibility evidence, never the purchase total, the employee's share or other purchases.
