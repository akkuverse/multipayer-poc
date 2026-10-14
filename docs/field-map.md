# Field map

Status: **14 October 2026.** Which party may legitimately see which purchase field, and why. `src/views.ts` implements the three party columns as projections — currently a subset of what the map permits (for example, a payer's own approval reference is permitted but not yet surfaced). Tests in `test/views.test.ts` pin the employer and payee projections. "Backend" is what `SettlementBackend.submit` receives.

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
