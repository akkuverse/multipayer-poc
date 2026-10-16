# Initiation model (mock hypothesis)

Status: **14 October 2026.** This describes what the mock assumes, not ECB behaviour. Every statement below is a hypothesis to test in the ECB test environment.

## Question

In the digital euro, each payer's PSP initiates that payer's payment. When two payers use different PSPs, who submits which leg, and how can a backend settle the legs as one transaction?

## What the mock assumes

Implemented in `src/settlement/psp.ts` (`SimulatedPsp`) and `src/settlement/mock-backend.ts` (`assemble`, `expire`):

1. Each payer's PSP submits only its own payer's leg, tagged with the purchase's group reference.
2. In atomic mode, each request carries `assembly: { size, assembleBy }`. The backend holds the legs that have arrived as `unknown` until all `size` legs are there, then settles or rejects the whole group at once.
3. If the group is still incomplete at `assembleBy` (backend clock), every leg that arrived is rejected (`group_incomplete`). An expired group is tombstoned: a leg arriving after the deadline is rejected (`group_expired`) rather than opening a new assembly window.
4. PSPs that submitted early learn the outcome only by a status query. The coordinator reconciles every leg through that payer's own PSP.
5. A PSP that refuses to forward a leg has conclusively not submitted it: a leg that never reached the backend is `rejected: psp_unavailable`. A refused retry of a leg already submitted keeps its last known status — the earlier submission still stands — and its outcome is learned by status query. A retry with the same idempotency key can still join the group if the deadline has not passed. Any other mid-forward failure is indistinguishable from a lost response, so the leg is `unknown`, never a fabricated terminal status.
6. Retries reuse the original settlement mode (D7), so a retried leg can never settle outside its group. `resubmit` runs only while the purchase is `pending` or `completed`; a leg that carries no `executionRef` was never submitted, so resubmitting it is its first initiation and re-runs the same authority recheck as `submit`.
7. In independent mode there is no group: each PSP's leg is a separate payment (the two-payment baseline).

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

S16 (group assembled), S17 (group expired) and S18 (independent baseline). Their findings rows show `not tested` for the ECB column until adapter runs observe the real behaviour.
