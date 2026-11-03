# Initiation model (mock hypothesis)

Status: **14 October 2026, updated 3 November 2026.** This describes what the mock assumes, not ECB behaviour. Every statement below is a hypothesis to test in the ECB test environment.

## Question

In the digital euro, each payer's PSP initiates that payer's payment. When two payers use different PSPs, who submits which leg, and how can a backend settle the legs as one transaction?

## What the mock assumes

Implemented in `src/settlement/psp.ts` (`SimulatedPsp`) and `src/settlement/mock-backend.ts` (`assemble`, `expire`):

1. Each payer's PSP submits only its own payer's leg, tagged with the purchase's group reference.
2. In atomic mode, each request carries `assembly: { size, assembleBy }`. The backend holds the legs that have arrived as `unknown` until all `size` legs are there, then settles or rejects the whole group at once.
3. If the group is still incomplete at `assembleBy` (backend clock), every leg that arrived is rejected (`group_incomplete`). An expired group is tombstoned: a leg arriving after the deadline is rejected (`group_expired`) rather than opening a new assembly window.
4. PSPs that submitted early learn the outcome only by a status query. The coordinator reconciles every leg through that payer's own PSP.
5. A PSP that refuses to forward a leg has conclusively not submitted it: a leg that never reached the backend is `rejected: psp_unavailable`. A refused retry of a leg already submitted keeps its last known status — the earlier submission still stands — and its outcome is learned by status query. A retry with the same idempotency key can still join the group if the deadline has not passed. Any other mid-forward failure is indistinguishable from a lost response, so the leg is `unknown`, never a fabricated terminal status.
6. The submission is frozen at admission into an immutable descriptor: group reference, settlement mode, request legs (payer, payee, amount, fee, idempotency key), the kind of authority funding each leg, the original assembly size and deadline, and for mandate-funded legs the UTC booking month. A replay sends exactly those values (D7): never fresh terms, fresh keys or a new assembly window, so a retried leg can never settle outside its group. `resubmit` runs only while the purchase is `pending` or `completed`.
7. Whether a leg may have been handed off is tracked per leg, independently of any returned `executionRef` — a lost response hides the reference without undoing the handoff. A `forwarded` leg stays potentially submitted: its replay reuses the frozen authorization and never needs new employee approval to discover the original outcome. A leg conclusively refused before forwarding (`refused` — `PspUnavailableError`, `RequestRefusedError`, or the coordinator's own first-handoff check) was never submitted: replaying it is again a first handoff, revalidated against current authority immediately before its route call, including a first handoff inside `resubmit`.
8. If a still-unsent leg loses authority after another leg may have moved — a revoked employer or employee mandate, a superseded employee revision, a now-blocked merchant, an expired offer — only that leg is refused; the purchase outcome is derived from all leg statuses, never whole-purchase failure. A mandate-funded leg's recheck counts monthly automatic usage in its frozen booking month, not the retry's month. Restoring Auto eligibility under a new revision does not revive the older grant for a first handoff. A throwing pre-route check records `auth_recheck_failed` and leaves the leg `refused`, so later retries must validate it again.
9. The same dispatch discipline applies to returns: a refund call that may have been handed off is preserved per leg (`returnForwarded`), and the mock's refund is not idempotent after a completed return — a blind retry could debit the payee again. Before another refund call, the leg's same execution reference is queried through `status()`: `returned` confirms the return, `settled` permits a fresh attempt, `unknown` or an unreachable route keeps the request unresolved.
10. In independent mode there is no group: each PSP's leg is a separate payment (the two-payment baseline).

Employer legs retain a detached signed mandate in the submission descriptor. It is captured at admission and refreshed against verified current terms before a deferred first handoff, then preserved once forwarded. Employer registry replacement cannot rewrite the evidence for a payment already handed off. Signed authority remains internal to the coordinator; backend requests and recipient projections do not receive this snapshot.

## Who signs what

Every coordinator call that starts or ends a purchase arrives as a signed request naming its caller: the signature is verified against the caller's registered key and bound to the purchase and proposal version, and the signer must belong to the call's authorised set. A refusal — `bad_signature`, `stale_version`, `not_authorized` or `proposer_not_a_payer` — is logged as `request_refused` with the kind, caller and reason (S30–S34). This is the mock's caller model, a hypothesis about who may initiate each step, not observed ECB behaviour.

| Call | Who may sign | Notes |
| --- | --- | --- |
| `propose` | The employee, or an agent under the employee's signed delegation grant | The grant is verified end to end: signed by the employee, naming the agent, scoped to the purchase, carrying the `propose` capability, unexpired |
| `proposeSplit` | A payer named in `shares[]` | `amountsFrom: 'proposer'` lets the proposer's signature double as approval of their own shares; `equal_split` waits for every payer |
| `changeOffer` | The merchant of record, the current proposer or the employee | Bound to the committed version; a superseded version is refused `stale_version` |
| `approve` | The payer whose share it funds | An existing `Signed<PayerApproval>`, unchanged — device or one-off exception basis, never a lifecycle request |
| `cancel` | Any payer of the purchase | Pre-submission only |
| `refund` | Any payee of the purchase | A paying signer is refused and pointed at `dispute()` (S33) |
| `submit` under `on_request` | Any payer of the purchase | Required: the signed request triggers the send (`trigger: 'request'`, logged `by`) |
| `submit` under `on_ready` | No caller — the coordinator self-fires | Fired once at the ready transition (`trigger: 'auto'`, S29); a request-less caller `submit()` is refused `request_required` as under `on_request`, while a payer's signed request is still honoured, e.g. after a pre-dispatch rollback |
| `dispute` | The session employee | Unchanged: the authenticated principal, not a signed request |
| `reconcile` / `resubmit` / `recover` | Nobody — the coordinator's own post-failure work | Take no caller signature |

## Alternatives not implemented

- One initiating PSP collects authorisations from the other payers' PSPs and submits the group.
- The application initiates each leg through each payer's PSP interface.
- The backend issues a group token that later legs must quote.

## To establish in the ECB test environment

- Can legs from different PSPs join one multi-payer transaction, and how are they linked (group reference, token, something else)?
- Is there an assembly deadline? Who sets it, and what happens to legs that have already arrived?
- How does a PSP that submitted early learn the group's outcome (status query, notification)?
- Can a leg be resubmitted with the same idempotency key into a pending group?
- Who can cancel an incomplete group?

## Evidence

S04 (group assembled), S13 (group expired) and S14 (independent baseline). Their findings rows show `not tested` for the ECB column until adapter runs observe the real behaviour.
