# Per-payer provider initiation is the default; direct initiation is guarded

Date: 3 November 2026 · Status: accepted

## Context

Only licensed PSPs reach the settlement layer, and each provider sends only
its own customer's payment. A single request carrying legs from different
providers cannot exist — no real participant could produce it. The mock's
`world()` nevertheless used to submit every leg through one direct backend
call, so the default fixture modelled a submission shape nothing in the
system can actually send.

## Decision

`world()` defaults to `initiation: 'per_payer_psp'`: each payer's
`SimulatedPsp` submits only its own legs, and every status query and refund
goes through the payer's own PSP. `providerFor` is the fixture's
provider-membership data, grouping payers onto shared PSP adapters and
feeding the direct-mode guard. Direct initiation is demoted to two guarded
modes: `coordinator_as_psp` (the coordinator is the licensed provider for
every payer of the purchase) and `test_bypass_psp` (a test fixture with the
guard off). Under per-payer atomic initiation, same-moment resolution keeps
same-moment sends pending-free: once a send sees a conclusive group outcome,
still-`unknown` siblings resolve immediately through their own route
(`group_outcome_observed`).

## Consequences

- Every `world()` trace opens with `initiation_mode { mode }`, so recorded
  runs say which mode produced them; trace digests shift by design and were
  regenerated.
- A `coordinator_as_psp` submit whose payers span more than one provider is
  refused before dispatch with `request_refused` /
  `direct_initiation_mixed_psps`; the purchase stays `ready`.
- S04's distinguishing condition is now payments arriving at different
  times — a down employer PSP — rather than the coordinator splitting one
  call into legs.

## Rejected alternative

Keep coordinator-submits-everything as the default — rejected because it
models a submission shape no real participant can produce, and it would let
recorded runs keep implying a capability that has to be tested in the ECB
environment, not assumed.
