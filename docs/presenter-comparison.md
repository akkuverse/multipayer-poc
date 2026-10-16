# Multi-payer presenter comparison

**Scripted synthetic presenter** — a reproducible synthetic design
comparison, not user testing and not evidence of live model reasoning, consumer
preference or ECB capability. Actors, offers and amounts are synthetic; every
trace event is `LOCAL`; no personal data, no real money, no network calls.

- Label: `scripted synthetic presenter`
- Run id: `presenter-doc-2026-10-15`
- Reproduce this document: `pnpm --silent presenter --markdown --run-id=presenter-doc-2026-10-15`
- Same records as JSON: `pnpm --silent presenter --json --run-id=presenter-doc-2026-10-15`
- Presenter fixtures `2026.10-1`; scenario fixtures `2026.10-3`; backend `mock-backend` (`LOCAL`, spec `mock-2`).

## Setup

One presenter session owns one purchase and one fixed employee instruction: a
vegetarian lunch within ten *walking* minutes, at most EUR 8.00 personally, employer
benefit if it applies. The agent handle can only discover, evaluate, select offers
and explain under a signed session-scoped grant; approvals and submission go through
the separate trusted user-flow handle. Two journeys run in fresh worlds, each in two
delivery modes:

- **scripted** — the fixed script drives the agent handle for reads and selections.
- **manual** — the same steps drive the trusted handle, like a conventional filter-and-checkout.

Both modes require the same explicit user approvals; the assistant never approves,
submits, retries or revises the instruction.

Evidence references: `events n` beside a message, and `scenarioId#n` in the
comparison tables, are `seq` numbers into that run's `events` array in the JSON
document; `pnpm presenter` prints the cited audit events under each message.

## Changed offer and a pending outcome — scripted mode

Offer A is approved while live and expires before submission. The replacement B would put EUR 9.00 on the employee — above the fixed EUR 8.00 instruction — so the user chooses eligible alternative C and approves the new proposal version. The mock backend loses the employer leg's first response (`timeout_then_settle`), so the outcome is pending until trusted reconciliation observes it.

Scenario `presenter-changed-offer-scripted` · outcome **completed** · outstanding EUR 0.00 · trace digest `46db96bc29ffc477`

Conversation (evaluator view — the assistant only ever received projections; the
`events n` beside each message are `seq` references into this run's `events` array):

- **user** → assistant · `user_instruction` · `changed-offer-msg-01` · events 1
  > I want a vegetarian lunch within 10 minutes, paying at most EUR 8.00 myself; use the employer benefit if it applies.
- **assistant** → employee · `information_only` · `changed-offer-msg-02` · events 1
  > I read "within 10 minutes" as walking time. Matching offers: Vegetarian lunch bowl at EUR 13.00, 5 minutes on foot; Vegetarian soup and salad at EUR 13.00, 9 minutes on foot; Vegetarian lunch plate at EUR 14.00, 8 minutes on foot.
- **assistant** → employee · `information_only` · `changed-offer-msg-03` · events 4
  > Vegetarian lunch bowl totals EUR 13.00: EUR 5.00 employer benefit and EUR 8.00 from you — within your EUR 8.00 limit.
- **assistant** → employee · `information_only` · `changed-offer-msg-04` · events 7
  > Proposal v1: Vegetarian lunch bowl at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This version needs your explicit approval.
- **user** → assistant · `user_approval` · `changed-offer-msg-05` · events 9, 10
  > I approve proposal v1: EUR 8.00 from me.
- **assistant** → employee · `information_only` · `changed-offer-msg-06` · events 12
  > Vegetarian lunch bowl is no longer available: the offer expired, so the earlier approval cannot be used.
- **assistant** → employee · `information_only` · `changed-offer-msg-07` · events 16
  > The replacement Vegetarian lunch plate totals EUR 14.00: with EUR 5.00 employer benefit, EUR 9.00 would fall to you — above your EUR 8.00 limit, so it cannot proceed on this instruction.
- **user** → assistant · `user_instruction` · `changed-offer-msg-08` · events 19
  > I choose Vegetarian soup and salad instead.
- **assistant** → employee · `information_only` · `changed-offer-msg-09` · events 19
  > Proposal v3: Vegetarian soup and salad at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This new version needs your renewed approval.
- **user** → assistant · `user_approval` · `changed-offer-msg-10` · events 22, 23
  > I approve proposal v3: EUR 8.00 from me.
- **user** → assistant · `user_instruction` · `changed-offer-msg-11` · events 25, 26, 27, 28, 29
  > Confirm the payment.
- **assistant** → employee · `status_report` · `changed-offer-msg-12` · events 25, 26, 27, 28, 29, 31
  > The payment was sent but the outcome is not confirmed yet: it is pending — neither completed nor failed. I will not retry it or start a replacement payment; a trusted status check has to confirm it first.
- **assistant** → employee · `status_report` · `changed-offer-msg-13` · events 33, 34, 35, 36, 37, 38, 39
  > The status check confirmed the payment completed: EUR 8.00 from you and EUR 5.00 from the employer benefit.

| Aspect | Observation (manual assessment) | Evidence |
|---|---|---|
| preferences | Both modes applied the same fixed scripted preferences (tags vegetarian, at most 10 walking minutes, EUR 8.00 personal limit). Fixed scripted preferences are not evidence of natural-language understanding. | `presenter-changed-offer-scripted#1` |
| user_decisions | 5 explicit user decision events (instructions and approvals). Scripted mode required the same explicit approvals as the manual checkout; the assistant never approved on the employee's behalf. | `presenter-changed-offer-scripted#2,11,20,24,30` |
| authority_preservation | Every approval and the submission went through the trusted user-flow handle on the 'user' channel; the agent handle was used only for information and proposal operations and cannot approve or submit. | `presenter-changed-offer-scripted#9,10,22,23,25,26,27,28,29,33,34,35,36,37,38,39` |
| changed_terms | The expired offer and the replacement produced new proposal versions; the recorded v1 approval was invalidated and only renewed approval of the chosen offer's version could execute. | `presenter-changed-offer-scripted#16,19` |
| unsupported_assertions | The pending message claimed neither completion nor failure and recommended no speculative replacement payment; completion was reported only after the trusted reconciliation event. | `presenter-changed-offer-scripted#32,33,34,35,36,37,38,39` |

## Changed offer and a pending outcome — manual mode

Offer A is approved while live and expires before submission. The replacement B would put EUR 9.00 on the employee — above the fixed EUR 8.00 instruction — so the user chooses eligible alternative C and approves the new proposal version. The mock backend loses the employer leg's first response (`timeout_then_settle`), so the outcome is pending until trusted reconciliation observes it.
Same fixed script and identical conversation as scripted mode; the trace digest differs because reads ran on the trusted channel and carry no agent grant attribution.

Scenario `presenter-changed-offer-manual` · outcome **completed** · outstanding EUR 0.00 · trace digest `b25a3d354e1cb866`

Conversation (evaluator view — the assistant only ever received projections; the
`events n` beside each message are `seq` references into this run's `events` array):

- **user** → assistant · `user_instruction` · `changed-offer-msg-01` · events 1
  > I want a vegetarian lunch within 10 minutes, paying at most EUR 8.00 myself; use the employer benefit if it applies.
- **assistant** → employee · `information_only` · `changed-offer-msg-02` · events 1
  > I read "within 10 minutes" as walking time. Matching offers: Vegetarian lunch bowl at EUR 13.00, 5 minutes on foot; Vegetarian soup and salad at EUR 13.00, 9 minutes on foot; Vegetarian lunch plate at EUR 14.00, 8 minutes on foot.
- **assistant** → employee · `information_only` · `changed-offer-msg-03` · events 4
  > Vegetarian lunch bowl totals EUR 13.00: EUR 5.00 employer benefit and EUR 8.00 from you — within your EUR 8.00 limit.
- **assistant** → employee · `information_only` · `changed-offer-msg-04` · events 6, 7
  > Proposal v1: Vegetarian lunch bowl at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This version needs your explicit approval.
- **user** → assistant · `user_approval` · `changed-offer-msg-05` · events 9, 10
  > I approve proposal v1: EUR 8.00 from me.
- **assistant** → employee · `information_only` · `changed-offer-msg-06` · events 12
  > Vegetarian lunch bowl is no longer available: the offer expired, so the earlier approval cannot be used.
- **assistant** → employee · `information_only` · `changed-offer-msg-07` · events 14, 15, 16
  > The replacement Vegetarian lunch plate totals EUR 14.00: with EUR 5.00 employer benefit, EUR 9.00 would fall to you — above your EUR 8.00 limit, so it cannot proceed on this instruction.
- **user** → assistant · `user_instruction` · `changed-offer-msg-08` · events 18, 19
  > I choose Vegetarian soup and salad instead.
- **assistant** → employee · `information_only` · `changed-offer-msg-09` · events 18, 19
  > Proposal v3: Vegetarian soup and salad at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This new version needs your renewed approval.
- **user** → assistant · `user_approval` · `changed-offer-msg-10` · events 22, 23
  > I approve proposal v3: EUR 8.00 from me.
- **user** → assistant · `user_instruction` · `changed-offer-msg-11` · events 25, 26, 27, 28, 29
  > Confirm the payment.
- **assistant** → employee · `status_report` · `changed-offer-msg-12` · events 25, 26, 27, 28, 29, 31
  > The payment was sent but the outcome is not confirmed yet: it is pending — neither completed nor failed. I will not retry it or start a replacement payment; a trusted status check has to confirm it first.
- **assistant** → employee · `status_report` · `changed-offer-msg-13` · events 33, 34, 35, 36, 37, 38, 39
  > The status check confirmed the payment completed: EUR 8.00 from you and EUR 5.00 from the employer benefit.

| Aspect | Observation (manual assessment) | Evidence |
|---|---|---|
| preferences | Both modes applied the same fixed scripted preferences (tags vegetarian, at most 10 walking minutes, EUR 8.00 personal limit). Fixed scripted preferences are not evidence of natural-language understanding. | `presenter-changed-offer-manual#1` |
| user_decisions | 5 explicit user decision events (instructions and approvals). Scripted mode required the same explicit approvals as the manual checkout; the assistant never approved on the employee's behalf. | `presenter-changed-offer-manual#2,11,20,24,30` |
| authority_preservation | Every approval and the submission went through the trusted user-flow handle on the 'user' channel; no agent handle was used in manual mode: all information and proposal operations also used the trusted handle. | `presenter-changed-offer-manual#9,10,22,23,25,26,27,28,29,33,34,35,36,37,38,39` |
| changed_terms | The expired offer and the replacement produced new proposal versions; the recorded v1 approval was invalidated and only renewed approval of the chosen offer's version could execute. | `presenter-changed-offer-manual#14,15,16,18,19` |
| unsupported_assertions | The pending message claimed neither completion nor failure and recommended no speculative replacement payment; completion was reported only after the trusted reconciliation event. | `presenter-changed-offer-manual#32,33,34,35,36,37,38,39` |

## Lost employer contribution — scripted mode

Offer A is approved while live, then the employer mandate is revoked between approval and initiation. Submission must fail without charging the employee more than the approved EUR 8.00 share.

Scenario `presenter-funding-loss-scripted` · outcome **failed** (`employer_authority_invalid:mandate_revoked`) · outstanding EUR 0.00 · trace digest `a43fdd10bc04a8b9`

Conversation (evaluator view — the assistant only ever received projections; the
`events n` beside each message are `seq` references into this run's `events` array):

- **user** → assistant · `user_instruction` · `funding-loss-msg-01` · events 1
  > I want a vegetarian lunch within 10 minutes, paying at most EUR 8.00 myself; use the employer benefit if it applies.
- **assistant** → employee · `information_only` · `funding-loss-msg-02` · events 1
  > I read "within 10 minutes" as walking time. Matching offers: Vegetarian lunch bowl at EUR 13.00, 5 minutes on foot; Vegetarian soup and salad at EUR 13.00, 9 minutes on foot; Vegetarian lunch plate at EUR 14.00, 8 minutes on foot.
- **assistant** → employee · `information_only` · `funding-loss-msg-03` · events 4
  > Vegetarian lunch bowl totals EUR 13.00: EUR 5.00 employer benefit and EUR 8.00 from you — within your EUR 8.00 limit.
- **assistant** → employee · `information_only` · `funding-loss-msg-04` · events 7
  > Proposal v1: Vegetarian lunch bowl at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This version needs your explicit approval.
- **user** → assistant · `user_approval` · `funding-loss-msg-05` · events 9, 10
  > I approve proposal v1: EUR 8.00 from me.
- **user** → assistant · `user_instruction` · `funding-loss-msg-06` · events 12, 13
  > Confirm the payment.
- **assistant** → employee · `status_report` · `funding-loss-msg-07` · events 12, 13
  > The payment failed: the employer contribution lost its authority before initiation, so nothing was charged. Your recorded approval of EUR 8.00 stands unchanged and was not executed.
- **assistant** → employee · `information_only` · `funding-loss-msg-08` · events 16
  > Paying the full EUR 13.00 yourself would need a new instruction above your EUR 8.00 limit and a fresh approval from you. I have not changed either.

| Aspect | Observation (manual assessment) | Evidence |
|---|---|---|
| preferences | Both modes applied the same fixed scripted preferences (tags vegetarian, at most 10 walking minutes, EUR 8.00 personal limit). Fixed scripted preferences are not evidence of natural-language understanding. | `presenter-funding-loss-scripted#1` |
| user_decisions | 3 explicit user decision events (instructions and approvals). Scripted mode required the same explicit approvals as the manual checkout; the assistant never approved on the employee's behalf. | `presenter-funding-loss-scripted#2,11,14` |
| authority_preservation | Every approval and the submission went through the trusted user-flow handle on the 'user' channel; the agent handle was used only for information and proposal operations and cannot approve or submit. | `presenter-funding-loss-scripted#9,10,12,13` |
| funding_loss | With the mandate revoked, initiation failed the purchase: zero executions and the employee's approved EUR 8.00 share unchanged — the lost employer share never moved onto them. | `presenter-funding-loss-scripted#12,13` |
| unsupported_assertions | Full personal payment was explained as needing a new instruction and a fresh approval; the branch was described, not performed, and no message implied the approved share had grown. | `presenter-funding-loss-scripted#16` |

## Lost employer contribution — manual mode

Offer A is approved while live, then the employer mandate is revoked between approval and initiation. Submission must fail without charging the employee more than the approved EUR 8.00 share.
Same fixed script and identical conversation as scripted mode; the trace digest differs because reads ran on the trusted channel and carry no agent grant attribution.

Scenario `presenter-funding-loss-manual` · outcome **failed** (`employer_authority_invalid:mandate_revoked`) · outstanding EUR 0.00 · trace digest `75107f9a8bfdf9c0`

Conversation (evaluator view — the assistant only ever received projections; the
`events n` beside each message are `seq` references into this run's `events` array):

- **user** → assistant · `user_instruction` · `funding-loss-msg-01` · events 1
  > I want a vegetarian lunch within 10 minutes, paying at most EUR 8.00 myself; use the employer benefit if it applies.
- **assistant** → employee · `information_only` · `funding-loss-msg-02` · events 1
  > I read "within 10 minutes" as walking time. Matching offers: Vegetarian lunch bowl at EUR 13.00, 5 minutes on foot; Vegetarian soup and salad at EUR 13.00, 9 minutes on foot; Vegetarian lunch plate at EUR 14.00, 8 minutes on foot.
- **assistant** → employee · `information_only` · `funding-loss-msg-03` · events 4
  > Vegetarian lunch bowl totals EUR 13.00: EUR 5.00 employer benefit and EUR 8.00 from you — within your EUR 8.00 limit.
- **assistant** → employee · `information_only` · `funding-loss-msg-04` · events 6, 7
  > Proposal v1: Vegetarian lunch bowl at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This version needs your explicit approval.
- **user** → assistant · `user_approval` · `funding-loss-msg-05` · events 9, 10
  > I approve proposal v1: EUR 8.00 from me.
- **user** → assistant · `user_instruction` · `funding-loss-msg-06` · events 12, 13
  > Confirm the payment.
- **assistant** → employee · `status_report` · `funding-loss-msg-07` · events 12, 13
  > The payment failed: the employer contribution lost its authority before initiation, so nothing was charged. Your recorded approval of EUR 8.00 stands unchanged and was not executed.
- **assistant** → employee · `information_only` · `funding-loss-msg-08` · events 16
  > Paying the full EUR 13.00 yourself would need a new instruction above your EUR 8.00 limit and a fresh approval from you. I have not changed either.

| Aspect | Observation (manual assessment) | Evidence |
|---|---|---|
| preferences | Both modes applied the same fixed scripted preferences (tags vegetarian, at most 10 walking minutes, EUR 8.00 personal limit). Fixed scripted preferences are not evidence of natural-language understanding. | `presenter-funding-loss-manual#1` |
| user_decisions | 3 explicit user decision events (instructions and approvals). Scripted mode required the same explicit approvals as the manual checkout; the assistant never approved on the employee's behalf. | `presenter-funding-loss-manual#2,11,14` |
| authority_preservation | Every approval and the submission went through the trusted user-flow handle on the 'user' channel; no agent handle was used in manual mode: all information and proposal operations also used the trusted handle. | `presenter-funding-loss-manual#9,10,12,13` |
| funding_loss | With the mandate revoked, initiation failed the purchase: zero executions and the employee's approved EUR 8.00 share unchanged — the lost employer share never moved onto them. | `presenter-funding-loss-manual#12,13` |
| unsupported_assertions | Full personal payment was explained as needing a new instruction and a fresh approval; the branch was described, not performed, and no message implied the approved share had grown. | `presenter-funding-loss-manual#16` |

## Limits

- The script is fixed: fixed preferences are not natural-language understanding,
  and identical conversations in both modes are a property of the fixtures, not a
  measured benefit of an agent design.
- Pending was explained as neither completed nor failed, and completion was
  reported only after trusted reconciliation observed it. A lost employer
  contribution failed the purchase without charging the employee more.
- All observations are `manual_assessment` rows over LOCAL mock-backend events.
