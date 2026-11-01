# Multi-payer presenter comparison

**Scripted synthetic presenter** — a reproducible synthetic design
comparison, not user testing and not evidence of live model reasoning, consumer
preference or ECB capability. Actors, offers and amounts are synthetic; every
trace event is `LOCAL`; no personal data, no real money, no network calls.

- Label: `scripted synthetic presenter`
- Run id: `employee-mandate-v1`
- Reproduce this document: `pnpm --silent presenter --markdown --run-id=employee-mandate-v1`
- Same records as JSON: `pnpm --silent presenter --json --run-id=employee-mandate-v1`
- Presenter fixtures `2026.10-3`; scenario fixtures `2026.11-1`; backend `mock-backend` (`LOCAL`, spec `mock-3`).

## Setup

One presenter session owns one purchase under the employee's signed standing terms: a
vegetarian lunch within ten *walking* minutes, at most EUR 8.00 personally, employer
benefit if it applies. The agent handle can only discover, evaluate, select offers
and explain under a signed session-scoped grant; approvals and submission go through
the separate trusted user-flow handle. Two journeys run in fresh worlds, each in two
delivery modes:

- **scripted** — the fixed script drives the agent handle for reads and selections.
- **manual** — the same steps drive the trusted handle, like a conventional filter-and-checkout.

Both modes require the same explicit user approvals; the assistant never approves,
submits, retries or publishes new standing terms.

Evidence references: `events n` beside a message, and `scenarioId#n` in the
comparison tables, are `seq` numbers into that run's `events` array in the JSON
document; `pnpm presenter` prints the cited audit events under each message.

## Changed offer and a pending outcome — scripted mode

Offer A is approved while live and expires before submission. The replacement B would put EUR 9.00 on the employee — above the standing EUR 8.00 maximum, so only a signed exception or a lasting terms edit could pay it — and the user instead chooses eligible alternative C and approves the new proposal version. The mock backend loses the employer leg's first response (`timeout_then_settle`), so the outcome is pending until trusted reconciliation observes it.

Scenario `presenter-changed-offer-scripted` · outcome **completed** · outstanding EUR 0.00 · trace digest `09a631636dc48be2`

Conversation (evaluator view — the assistant only ever received projections; the
`events n` beside each message are `seq` references into this run's `events` array):

- **user** → assistant · `user_instruction` · `changed-offer-msg-01` · events 2
  > I want a vegetarian lunch within 10 minutes, paying at most EUR 8.00 myself; use the employer benefit if it applies.
- **assistant** → employee · `information_only` · `changed-offer-msg-02` · events 2
  > I read "within 10 minutes" as walking time. Matching offers: Vegetarian lunch bowl at EUR 13.00, 5 minutes on foot; Vegetarian soup and salad at EUR 13.00, 9 minutes on foot; Vegetarian lunch plate at EUR 14.00, 8 minutes on foot.
- **assistant** → employee · `information_only` · `changed-offer-msg-03` · events 5
  > Vegetarian lunch bowl totals EUR 13.00: EUR 5.00 employer benefit and EUR 8.00 from you — within your EUR 8.00 limit.
- **assistant** → employee · `information_only` · `changed-offer-msg-04` · events 9
  > Proposal v1: Vegetarian lunch bowl at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This version needs your explicit approval.
- **user** → assistant · `user_approval` · `changed-offer-msg-05` · events 11, 12
  > I approve proposal v1: EUR 8.00 from me.
- **assistant** → employee · `information_only` · `changed-offer-msg-06` · events 14
  > Vegetarian lunch bowl is no longer available: the offer expired, so the earlier approval cannot be used.
- **assistant** → employee · `information_only` · `changed-offer-msg-07` · events 19
  > The replacement Vegetarian lunch plate totals EUR 14.00: with EUR 5.00 employer benefit, EUR 9.00 would fall to you — above your EUR 8.00 limit. An ordinary approval cannot pay it: you could allow it once as a signed exception, or change your standing terms for good.
- **user** → assistant · `user_instruction` · `changed-offer-msg-08` · events 23
  > I choose Vegetarian soup and salad instead.
- **assistant** → employee · `information_only` · `changed-offer-msg-09` · events 23
  > Proposal v3: Vegetarian soup and salad at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This new version needs your renewed approval.
- **user** → assistant · `user_approval` · `changed-offer-msg-10` · events 26, 27
  > I approve proposal v3: EUR 8.00 from me.
- **user** → assistant · `user_instruction` · `changed-offer-msg-11` · events 29, 30, 31, 32, 33
  > Confirm the payment.
- **assistant** → employee · `status_report` · `changed-offer-msg-12` · events 29, 30, 31, 32, 33, 35
  > The payment was sent but the outcome is not confirmed yet: it is pending — neither completed nor failed. I will not retry it or start a replacement payment; a trusted status check has to confirm it first.
- **assistant** → employee · `status_report` · `changed-offer-msg-13` · events 37, 38, 39, 40, 41, 42, 43
  > The status check confirmed the payment completed: EUR 8.00 from you and EUR 5.00 from the employer benefit.

| Aspect | Observation (manual assessment) | Evidence |
|---|---|---|
| preferences | Both modes applied the same fixed scripted preferences (tags vegetarian, at most 10 walking minutes, EUR 8.00 personal limit). Fixed scripted preferences are not evidence of natural-language understanding. | `presenter-changed-offer-scripted#2` |
| user_decisions | 5 explicit user decision events (instructions and approvals). Scripted mode required the same explicit approvals as the manual checkout; the assistant never approved on the employee's behalf. | `presenter-changed-offer-scripted#3,13,24,28,34` |
| authority_preservation | Every approval and the submission went through the trusted user-flow handle on the 'user' channel; the agent handle was used only for information and proposal operations and cannot approve or submit. | `presenter-changed-offer-scripted#11,12,26,27,29,30,31,32,33,37,38,39,40,41,42,43` |
| changed_terms | The expired offer and the replacement produced new proposal versions; the recorded v1 approval was invalidated and only renewed approval of the chosen offer's version could execute. | `presenter-changed-offer-scripted#19,23` |
| unsupported_assertions | The pending message claimed neither completion nor failure and recommended no speculative replacement payment; completion was reported only after the trusted reconciliation event. | `presenter-changed-offer-scripted#36,37,38,39,40,41,42,43` |

## Changed offer and a pending outcome — manual mode

Offer A is approved while live and expires before submission. The replacement B would put EUR 9.00 on the employee — above the standing EUR 8.00 maximum, so only a signed exception or a lasting terms edit could pay it — and the user instead chooses eligible alternative C and approves the new proposal version. The mock backend loses the employer leg's first response (`timeout_then_settle`), so the outcome is pending until trusted reconciliation observes it.
Same fixed script and identical conversation as scripted mode; the trace digest differs because reads ran on the trusted channel and carry no agent grant attribution.

Scenario `presenter-changed-offer-manual` · outcome **completed** · outstanding EUR 0.00 · trace digest `c722fc5febfadd01`

Conversation (evaluator view — the assistant only ever received projections; the
`events n` beside each message are `seq` references into this run's `events` array):

- **user** → assistant · `user_instruction` · `changed-offer-msg-01` · events 2
  > I want a vegetarian lunch within 10 minutes, paying at most EUR 8.00 myself; use the employer benefit if it applies.
- **assistant** → employee · `information_only` · `changed-offer-msg-02` · events 2
  > I read "within 10 minutes" as walking time. Matching offers: Vegetarian lunch bowl at EUR 13.00, 5 minutes on foot; Vegetarian soup and salad at EUR 13.00, 9 minutes on foot; Vegetarian lunch plate at EUR 14.00, 8 minutes on foot.
- **assistant** → employee · `information_only` · `changed-offer-msg-03` · events 5
  > Vegetarian lunch bowl totals EUR 13.00: EUR 5.00 employer benefit and EUR 8.00 from you — within your EUR 8.00 limit.
- **assistant** → employee · `information_only` · `changed-offer-msg-04` · events 7, 8, 9
  > Proposal v1: Vegetarian lunch bowl at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This version needs your explicit approval.
- **user** → assistant · `user_approval` · `changed-offer-msg-05` · events 11, 12
  > I approve proposal v1: EUR 8.00 from me.
- **assistant** → employee · `information_only` · `changed-offer-msg-06` · events 14
  > Vegetarian lunch bowl is no longer available: the offer expired, so the earlier approval cannot be used.
- **assistant** → employee · `information_only` · `changed-offer-msg-07` · events 16, 17, 18, 19
  > The replacement Vegetarian lunch plate totals EUR 14.00: with EUR 5.00 employer benefit, EUR 9.00 would fall to you — above your EUR 8.00 limit. An ordinary approval cannot pay it: you could allow it once as a signed exception, or change your standing terms for good.
- **user** → assistant · `user_instruction` · `changed-offer-msg-08` · events 21, 22, 23
  > I choose Vegetarian soup and salad instead.
- **assistant** → employee · `information_only` · `changed-offer-msg-09` · events 21, 22, 23
  > Proposal v3: Vegetarian soup and salad at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This new version needs your renewed approval.
- **user** → assistant · `user_approval` · `changed-offer-msg-10` · events 26, 27
  > I approve proposal v3: EUR 8.00 from me.
- **user** → assistant · `user_instruction` · `changed-offer-msg-11` · events 29, 30, 31, 32, 33
  > Confirm the payment.
- **assistant** → employee · `status_report` · `changed-offer-msg-12` · events 29, 30, 31, 32, 33, 35
  > The payment was sent but the outcome is not confirmed yet: it is pending — neither completed nor failed. I will not retry it or start a replacement payment; a trusted status check has to confirm it first.
- **assistant** → employee · `status_report` · `changed-offer-msg-13` · events 37, 38, 39, 40, 41, 42, 43
  > The status check confirmed the payment completed: EUR 8.00 from you and EUR 5.00 from the employer benefit.

| Aspect | Observation (manual assessment) | Evidence |
|---|---|---|
| preferences | Both modes applied the same fixed scripted preferences (tags vegetarian, at most 10 walking minutes, EUR 8.00 personal limit). Fixed scripted preferences are not evidence of natural-language understanding. | `presenter-changed-offer-manual#2` |
| user_decisions | 5 explicit user decision events (instructions and approvals). Scripted mode required the same explicit approvals as the manual checkout; the assistant never approved on the employee's behalf. | `presenter-changed-offer-manual#3,13,24,28,34` |
| authority_preservation | Every approval and the submission went through the trusted user-flow handle on the 'user' channel; no agent handle was used in manual mode: all information and proposal operations also used the trusted handle. | `presenter-changed-offer-manual#11,12,26,27,29,30,31,32,33,37,38,39,40,41,42,43` |
| changed_terms | The expired offer and the replacement produced new proposal versions; the recorded v1 approval was invalidated and only renewed approval of the chosen offer's version could execute. | `presenter-changed-offer-manual#16,17,18,19,21,22,23` |
| unsupported_assertions | The pending message claimed neither completion nor failure and recommended no speculative replacement payment; completion was reported only after the trusted reconciliation event. | `presenter-changed-offer-manual#36,37,38,39,40,41,42,43` |

## Lost employer contribution — scripted mode

Offer A is approved while live, then the employer mandate is revoked between approval and initiation. Submission must fail without charging the employee more than the approved EUR 8.00 share.

Scenario `presenter-funding-loss-scripted` · outcome **failed** (`employer_authority_invalid:mandate_revoked`) · outstanding EUR 0.00 · trace digest `fae43a6f036fe6dc`

Conversation (evaluator view — the assistant only ever received projections; the
`events n` beside each message are `seq` references into this run's `events` array):

- **user** → assistant · `user_instruction` · `funding-loss-msg-01` · events 2
  > I want a vegetarian lunch within 10 minutes, paying at most EUR 8.00 myself; use the employer benefit if it applies.
- **assistant** → employee · `information_only` · `funding-loss-msg-02` · events 2
  > I read "within 10 minutes" as walking time. Matching offers: Vegetarian lunch bowl at EUR 13.00, 5 minutes on foot; Vegetarian soup and salad at EUR 13.00, 9 minutes on foot; Vegetarian lunch plate at EUR 14.00, 8 minutes on foot.
- **assistant** → employee · `information_only` · `funding-loss-msg-03` · events 5
  > Vegetarian lunch bowl totals EUR 13.00: EUR 5.00 employer benefit and EUR 8.00 from you — within your EUR 8.00 limit.
- **assistant** → employee · `information_only` · `funding-loss-msg-04` · events 9
  > Proposal v1: Vegetarian lunch bowl at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This version needs your explicit approval.
- **user** → assistant · `user_approval` · `funding-loss-msg-05` · events 11, 12
  > I approve proposal v1: EUR 8.00 from me.
- **user** → assistant · `user_instruction` · `funding-loss-msg-06` · events 14, 15
  > Confirm the payment.
- **assistant** → employee · `status_report` · `funding-loss-msg-07` · events 14, 15
  > The payment failed: the employer contribution lost its authority before initiation, so nothing was charged. Your recorded approval of EUR 8.00 stands unchanged and was not executed.
- **assistant** → employee · `information_only` · `funding-loss-msg-08` · events 18
  > Paying the full EUR 13.00 yourself would need a one-off signed exception or a higher standing maximum than your EUR 8.00 limit — plus a fresh approval from you. I have not changed either.

| Aspect | Observation (manual assessment) | Evidence |
|---|---|---|
| preferences | Both modes applied the same fixed scripted preferences (tags vegetarian, at most 10 walking minutes, EUR 8.00 personal limit). Fixed scripted preferences are not evidence of natural-language understanding. | `presenter-funding-loss-scripted#2` |
| user_decisions | 3 explicit user decision events (instructions and approvals). Scripted mode required the same explicit approvals as the manual checkout; the assistant never approved on the employee's behalf. | `presenter-funding-loss-scripted#3,13,16` |
| authority_preservation | Every approval and the submission went through the trusted user-flow handle on the 'user' channel; the agent handle was used only for information and proposal operations and cannot approve or submit. | `presenter-funding-loss-scripted#11,12,14,15` |
| funding_loss | With the mandate revoked, initiation failed the purchase: zero executions and the employee's approved EUR 8.00 share unchanged — the lost employer share never moved onto them. | `presenter-funding-loss-scripted#14,15` |
| unsupported_assertions | Full personal payment was explained as needing a new instruction and a fresh approval; the branch was described, not performed, and no message implied the approved share had grown. | `presenter-funding-loss-scripted#18` |

## Lost employer contribution — manual mode

Offer A is approved while live, then the employer mandate is revoked between approval and initiation. Submission must fail without charging the employee more than the approved EUR 8.00 share.
Same fixed script and identical conversation as scripted mode; the trace digest differs because reads ran on the trusted channel and carry no agent grant attribution.

Scenario `presenter-funding-loss-manual` · outcome **failed** (`employer_authority_invalid:mandate_revoked`) · outstanding EUR 0.00 · trace digest `8d36ffa8c9ada268`

Conversation (evaluator view — the assistant only ever received projections; the
`events n` beside each message are `seq` references into this run's `events` array):

- **user** → assistant · `user_instruction` · `funding-loss-msg-01` · events 2
  > I want a vegetarian lunch within 10 minutes, paying at most EUR 8.00 myself; use the employer benefit if it applies.
- **assistant** → employee · `information_only` · `funding-loss-msg-02` · events 2
  > I read "within 10 minutes" as walking time. Matching offers: Vegetarian lunch bowl at EUR 13.00, 5 minutes on foot; Vegetarian soup and salad at EUR 13.00, 9 minutes on foot; Vegetarian lunch plate at EUR 14.00, 8 minutes on foot.
- **assistant** → employee · `information_only` · `funding-loss-msg-03` · events 5
  > Vegetarian lunch bowl totals EUR 13.00: EUR 5.00 employer benefit and EUR 8.00 from you — within your EUR 8.00 limit.
- **assistant** → employee · `information_only` · `funding-loss-msg-04` · events 7, 8, 9
  > Proposal v1: Vegetarian lunch bowl at EUR 13.00 — EUR 5.00 employer benefit, EUR 8.00 from you. This version needs your explicit approval.
- **user** → assistant · `user_approval` · `funding-loss-msg-05` · events 11, 12
  > I approve proposal v1: EUR 8.00 from me.
- **user** → assistant · `user_instruction` · `funding-loss-msg-06` · events 14, 15
  > Confirm the payment.
- **assistant** → employee · `status_report` · `funding-loss-msg-07` · events 14, 15
  > The payment failed: the employer contribution lost its authority before initiation, so nothing was charged. Your recorded approval of EUR 8.00 stands unchanged and was not executed.
- **assistant** → employee · `information_only` · `funding-loss-msg-08` · events 18
  > Paying the full EUR 13.00 yourself would need a one-off signed exception or a higher standing maximum than your EUR 8.00 limit — plus a fresh approval from you. I have not changed either.

| Aspect | Observation (manual assessment) | Evidence |
|---|---|---|
| preferences | Both modes applied the same fixed scripted preferences (tags vegetarian, at most 10 walking minutes, EUR 8.00 personal limit). Fixed scripted preferences are not evidence of natural-language understanding. | `presenter-funding-loss-manual#2` |
| user_decisions | 3 explicit user decision events (instructions and approvals). Scripted mode required the same explicit approvals as the manual checkout; the assistant never approved on the employee's behalf. | `presenter-funding-loss-manual#3,13,16` |
| authority_preservation | Every approval and the submission went through the trusted user-flow handle on the 'user' channel; no agent handle was used in manual mode: all information and proposal operations also used the trusted handle. | `presenter-funding-loss-manual#11,12,14,15` |
| funding_loss | With the mandate revoked, initiation failed the purchase: zero executions and the employee's approved EUR 8.00 share unchanged — the lost employer share never moved onto them. | `presenter-funding-loss-manual#14,15` |
| unsupported_assertions | Full personal payment was explained as needing a new instruction and a fresh approval; the branch was described, not performed, and no message implied the approved share had grown. | `presenter-funding-loss-manual#18` |

## Limits

- The script is fixed: fixed preferences are not natural-language understanding,
  and identical conversations in both modes are a property of the fixtures, not a
  measured benefit of an agent design.
- Pending was explained as neither completed nor failed, and completion was
  reported only after trusted reconciliation observed it. A lost employer
  contribution failed the purchase without charging the employee more.
- All observations are `manual_assessment` rows over LOCAL mock-backend events.
