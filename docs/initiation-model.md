# Initiation model (mock hypothesis)

Status: **14 October 2026, updated 4 November 2026.** This describes what the mock assumes, not ECB behaviour. Every statement below is a hypothesis to test in the ECB test environment.

## Question

In the digital euro, each payer's PSP initiates that payer's payment. When two payers use different PSPs, who submits which leg, and how can the legs share one purchase outcome when no single system holds both funds?

## What the mock assumes

Implemented in `src/settlement/provider.ts` (`PayerProvider`, `ShopProvider`), `src/settlement/orchestrator.ts` (`SettlementOrchestrator`) and the coordinator's `initiation` option, on top of the shared `DigitalEuroLedger` and `InterbankTransfer` modules:

1. Each payer's provider initiates only its own payer's leg: `reserve`, `commit`, `release`, `status` and `refund` are provider operations keyed to that leg's identity. The settlement orchestrator inside the coordinator's set drives every provider — a payer's provider never sees another payer's leg. That per-provider initiation is the `world()` default: `initiation: 'per_payer_psp'`. Direct initiation survives as two explicit modes: `coordinator_as_psp`, where the coordinator acts as the licensed provider for every payer of the purchase and a submit whose payers span more than one provider is refused before dispatch (`request_refused { reason: 'direct_initiation_mixed_psps' }`), and `test_bypass_psp`, the same routing with the guard off — explicitly a test fixture. Direct is not the default because a cross-provider single-request submission is not realistic: only licensed PSPs reach the settlement layer, and each sends only its own customer's payment. `providerFor` is the fixture's provider-membership data (default `psp-<payerId>`): it groups payers onto shared `PayerProvider` instances — a shared provider holds both customers' books, and conflicting capability flags on it fail loudly — and feeds the direct-mode guard. Every `world()` trace opens with `initiation_mode { mode }` (actor `world`) so a recorded run says which mode produced it.
2. In atomic mode the orchestrator reserves every leg's hold first — a digital-euro hold under the payer's pseudonym on the shared ledger, a bank hold on the payer provider's own book — each expiring `0.5` simulated minutes (thirty seconds) after reserve. Once every reserve is confirmed it commits bank legs in frozen proposal order, then the digital-euro legs as one same-ledger group keyed to the frozen member list. `atomic` is reserve-all with compensation across the two ledgers, not a cross-ledger atomic step: a conclusive leg failure unwinds holds and funding and compensates whatever already committed.
3. A hold past its deadline refuses commit; expiry is lazy and the tombstone is preserved. An accepted provider hold guarantees the exact authorized debit until expiry even if authority is revoked later; a leg that never reached its provider is conclusively unreserved and its first-handoff recheck runs against current authority at the next attempt.
4. A provider that is unavailable parks the leg it cannot reach: the reserve stays open — never a fabricated terminal status — and its outcome is learned by status query when the provider returns. A conclusive refusal (`hold_rejected`, `foreign_provider`, an expired or non-active hold) stops new work; the orchestrator then unwinds holds, restores funding effects and reports the purchase failed only once cleanup confirms.
5. The submission is frozen at admission into an immutable intent: purchase identity, settlement mode, frozen legs (payer, payee, rail, principal, fee, authority kind, routing) and admitted budget metadata. Every provider and ledger operation keys off `(purchaseId, proposalVersion, role)` plus a stage and destination, so a replay always reuses the original keys — never fresh terms or fresh keys — and a lost response stays reconcilable by status under the original key.
6. Whether a leg may have been handed off is tracked in the intent's world, independently of any returned reference — a lost response hides the outcome without undoing the handoff. An uncertain reserve first queries status and reuses its retained acceptance evidence; a conclusively unstarted reserve rechecks live authority before first acceptance, including a first handoff inside `resubmit`.
7. If a still-unreserved leg loses authority after another leg may have moved — a revoked employer or employee mandate, a superseded employee revision, a now-blocked merchant, an expired offer — only that leg is refused; the purchase outcome is derived from the settlement snapshot, never whole-purchase failure. A mandate-funded leg's recheck counts monthly automatic usage in its frozen booking month, not the retry's month.
8. The same dispatch discipline applies to returns: a refund call that may have been handed off is preserved under its original return key, and a provider's refund is not idempotent after a completed return — a blind retry could debit the payee again. Before another refund call the same operation is queried through the provider's `status()`: a completed return confirms it, an unresolved one keeps the request open, a settled-not-returned execution permits a fresh attempt.
9. A bank debit is transit, not a completed payment: a leg is settled only when its destination credit is confirmed — for a zero-holding business destination, that includes the paired defunding transit out of digital euro into the shop's bank book. Partial settlement stays tracked at every child stage so compensation can cancel uncredited transit or return already credited funds.
10. In independent mode there is no group: each provider's leg reserves and commits separately, a settled leg survives a sibling's failure, and the explicit recovery path returns it (the two-payment baseline).

Employer legs retain a detached signed mandate in the submission descriptor. It is captured at admission and refreshed against verified current terms before a deferred first handoff, then preserved once a hold is accepted. Employer registry replacement cannot rewrite the evidence for a payment already accepted. Signed authority remains internal to the coordinator; provider requests and recipient projections do not receive this snapshot.

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
- The application initiates each leg through each payer's PSP interface directly, with no orchestrating participant.
- A settlement participant issues a group token that later legs must quote.

## To establish in the ECB test environment

- Can legs from different PSPs share one multi-payer outcome, and how are they linked (group reference, token, something else)?
- Does the environment offer a hold/reserve primitive, and what are its guarantees and expiry?
- Is there a same-ledger atomic group, or does reserve-all with compensation remain an application concern?
- How does a provider that handed off early learn the group's outcome (status query, notification)?
- Can an operation be resubmitted under its original identity while its group is still open?
- Who can release or compensate an incomplete group?

## Evidence

S04 (provider down, hold waits), S13 (hold released after conclusive refusal), S14 (independent baseline), S35 (hold expiry) and S36 (cross-ledger divergence compensated). Their findings rows show `not tested` for the ECB column until adapter runs observe the real behaviour.
