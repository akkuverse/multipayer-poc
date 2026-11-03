# Payer-Provider Initiation by Default Plan

> **For agentic workers:** Use an available task-by-task execution workflow when implementation is requested. Steps use checkbox (`- [ ]`) syntax for tracking. This plan does not authorize implementation, delegation, commits or publication by itself.

**Goal:** Every money operation (submit, status, refund) goes through the payer's provider by default. `world()` defaults to `initiation: 'per_payer_psp'`; direct initiation survives only as an explicit, guarded mode — `coordinator_as_psp` (a licensed provider serving every payer of the purchase) or `test_bypass_psp` (a test fixture that skips the guard). A cross-provider single-request submission is not realistic: only licensed PSPs reach the settlement layer, each sending only its own customer's payment.

**Architecture:** The coordinator's `initiation` option becomes a tagged union (`src/core/coordinator.ts`): `per_payer_psp` (existing `pspFor` + `assemblyWindow`) or `direct` (`providerFor` + `allowMixedProviders`). `send()`'s direct branch gains the mixed-provider guard; its per-payer branch gains same-moment assembly resolution. `world()` (`src/scenarios.ts`) defaults to per-payer providers, groups `SimulatedPsp` adapters by a new `providerFor` membership option, and stamps every trace with `initiation_mode`.

**Tech Stack:** Existing Node.js >= 23.6, native TypeScript stripping, `node:test`, pnpm; no new dependencies, build step, network or real data.

**Source of truth:** The user-supplied spec "Make payer providers the default and demote direct initiation to a guarded mode" (reproduced as the Decisions section below), plus the decisions taken while planning, recorded under Contract choices.

**Status:** In progress.

---

## Execution rules and dependency order

Four tasks in strict order. Task 1 changes the coordinator seam but keeps today's call sites compiling (an untagged `{ pspFor, assemblyWindow }` literal still satisfies the per-payer branch at runtime). Task 2 flips the `world()` default and lands the S04 redesign; Task 3 migrates every remaining call site and repairs test fallout. Task 4 is docs and regenerated digests.

```text
1. Coordinator initiation seam: tagged union + direct guard + same-moment resolution
2. world() default, provider membership, initiation_mode event, S04 redesign
3. Test-suite migration and fallout
4. Docs: initiation model, decision record, backlog, regenerated digests
```

Use `rtk` for shell commands. Each task must leave `rtk pnpm test` and `rtk pnpm scenarios` green. No new dependencies; no ECB adapter code; trace events stay `LOCAL` and never imply ECB capability.

## File ownership

| File | Intended responsibility |
| --- | --- |
| `src/core/coordinator.ts` | Tagged `initiation` union, `route()`, the `assembly` gate, `direct_initiation_mixed_psps` guard, same-moment status resolution in `send()`. |
| `src/scenarios.ts` | `WorldOptions.initiation` union + default, `providerFor`, `psps` grouping, `initiation_mode` event, `FIXTURE_VERSION` bump, S04 redesign, title/responsibility updates. |
| `test/` | Rename `'coordinator'` literals, tag `initiation` object literals, rework the per-PSP two-step presenter test, repair fallout. |
| `docs/initiation-model.md` | Describe the three modes, the guard and same-moment resolution. |
| `docs/decisions/2026-11-03-payer-providers-default.md` | New decision record. |
| `docs/backlog.md` | One entry recording the change and the expected digest shift. |
| `docs/presenter-comparison.md` | Regenerated in task 4. |

## Contract choices used by the tasks

1. **Initiation union.** `CoordinatorOptions.initiation` becomes:
   ```ts
   initiation?:
     | { kind: 'per_payer_psp'; pspFor: (payerId: string) => SettlementBackend; assemblyWindow: number }
     | { kind: 'direct'; providerFor: (payerId: string) => string; allowMixedProviders: boolean };
   ```
   `undefined` stays the raw unguarded-direct seam for coordinators constructed directly in tests — `world()` always passes a mode. `route(payerId)` returns `pspFor(payerId)` only under `kind: 'per_payer_psp'`; every status query and refund therefore flows through the payer's PSP whenever the world's default is in use.
2. **Direct-mode guard.** In `send()`'s direct branch, before any dispatch: `new Set(sub.legs.map(l => init.providerFor(l.payerId))).size > 1 && !init.allowMixedProviders` → log `request_refused { kind: 'submit', purchaseId, reason: 'direct_initiation_mixed_psps', providers, now }` and throw `Error('direct_initiation_mixed_psps')`. The throw is pre-dispatch: `runSubmission`'s catch rolls back what the attempt owns and rethrows; the purchase stays `ready`. Applies to `resubmit` replays identically (the frozen legs carry the same payers).
3. **Same-moment assembly resolution.** After the per-leg loop in `send()`'s per-payer branch: in atomic mode, when any collected outcome carries `executionRef` and `status` `settled` or `rejected`, the group resolved while this send ran — an `unknown` still standing on a sibling leg is a stale report, not an open question. For every submission leg whose latest outcome is `unknown` (or missing while its recorded status is `unknown`) and that holds an `executionRef`, query `route(payerId).status(executionRef)`; a `settled`/`rejected` answer replaces or appends the outcome, anything else (`unknown`, `returned`, a thrown `PspUnavailableError` or other error) leaves it. Coordinator-side refusals (`psp_unavailable`, first-handoff) carry no `executionRef` and cannot trigger the pass, and a fully deferred (timeout) group shows no conclusive outcome — both stay `pending` for `reconcile()`.
4. **`world()` defaults.** `WorldOptions.initiation?: 'per_payer_psp' | 'coordinator_as_psp' | 'test_bypass_psp'`, default `'per_payer_psp'`. `coordinator_as_psp` maps to `{ kind: 'direct', providerFor, allowMixedProviders: false }`; `test_bypass_psp` to `allowMixedProviders: true`. `WorldOptions.providerFor?: (payerId: string) => string` defaults to `id => 'psp-' + id` — fixture membership data used (a) to group payers onto shared `SimulatedPsp` adapters under per-payer mode and (b) by the guard under `coordinator_as_psp`. `World.psps` stays `Map<payerId, SimulatedPsp>` (the provider serving that payer); it is populated only under per-payer mode, and a shared provider gets one adapter instance. Two payers sharing a provider with conflicting `supportsMandatePayments` flags is a contradictory fixture: fail loudly.
5. **`initiation_mode` event.** `world()` emits `trace.add('LOCAL', 'world', 'initiation_mode', { mode })` as the trace's first event so recorded runs and tools can label provider-bypassing runs. `FIXTURE_VERSION` bumps to `2026.11-3` with a note.
6. **S04 redesign.** Its distinguishing condition becomes "payments arrive at different times": the default world, employer PSP `available = false` for the first submit (employee leg waits `unknown`, employer leg refused), then `available = true` + `resubmit` + `reconcile`. Check unchanged: `completed` and a `pending` state in history. Title and responsibility updated to say so. S13/S14 drop the now-redundant `initiation: 'per_payer_psp'` option; their availability overrides stay.
7. **Mode names in tests.** `'coordinator'` literals become `'test_bypass_psp'` (the scenarios/tests that exercise direct mode have mixed-provider purchases, so the guarded name would refuse); `initiation: { pspFor, assemblyWindow }` literals gain `kind: 'per_payer_psp'`. `test/presenter-autopay.test.ts`'s per-PSP two-step test keeps its pending→completed shape by deferring the group outcome (`timeout_then_settle` on a leg — no conclusive sibling, no same-moment resolution), preserving its coverage of reconcile-through-own-PSP.
8. **Docs.** `initiation-model.md` describes all three modes, the guard and same-moment resolution (the "PSPs that submitted early learn the outcome only by a status query" bullet is amended: a group that resolves during the same send is picked up immediately; early submitters see `unknown` only when legs genuinely arrive at different times). New decision record under `docs/decisions/`. Backlog entry records the change and notes the expected trace-digest shift. `docs/presenter-comparison.md` regenerated with the same `--run-id=employee-mandate-v1` command.

## Task 1: Coordinator initiation seam

**Files:** Modify `src/core/coordinator.ts` only.

**Contract protected:** Per contract 1, `route()` still selects per-payer routes only under `kind: 'per_payer_psp'`; an untagged `{ pspFor, assemblyWindow }` literal existing tests pass still runs the per-payer path at runtime (its `kind` is `undefined`, which is neither `'direct'` nor — strictly — `'per_payer_psp'`; implement the discrimination so an object literal with `pspFor` present keeps working: check `kind === 'direct'` for the direct branch and treat everything else with a `pspFor` member as per-payer, or simply update the two test literals in this task — pick the cleaner of the two, preferring the explicit union and updating the literals here).

- [x] `CoordinatorOptions.initiation` becomes the tagged union per contract 1; field declaration and comments updated.
- [x] `route()` routes per-payer only under `kind: 'per_payer_psp'` (or the untagged-literal tolerance chosen above).
- [x] The submission `assembly` descriptor is still produced only under per-payer atomic (`init?.kind === 'per_payer_psp'` or the `pspFor` check).
- [x] `send()`'s direct branch gains the contract-2 guard before any dispatch; `request_refused` logged, purchase left `ready`.
- [x] `send()`'s per-payer branch gains contract-3 same-moment resolution after the leg loop.
- [x] Update the two `initiation: { pspFor, assemblyWindow }` object literals in `test/defects.test.ts` and `test/autopay.test.ts` with the chosen `kind`.
- [x] `rtk pnpm test` green (the `'coordinator'` string literals in tests still pass at runtime — `world()` only checks `=== 'per_payer_psp'` today, so they take the direct path as before; they are renamed in task 3).

## Task 2: world() default, provider membership, S04

**Files:** Modify `src/scenarios.ts` only.

**Contract protected:** Contracts 4–6. With the default now per-payer, every scenario that submits through `world()` routes through PSPs; same-moment resolution keeps S01 pending-free, and S04's staggered PSP keeps its pending observation.

- [x] `WorldOptions.initiation` union per contract 4 with doc comment naming what each mode means; default `'per_payer_psp'`.
- [x] `WorldOptions.providerFor` per contract 4; `psps` built grouped by provider id with the conflicting-capability loud check.
- [x] `initiation_mode` trace event per contract 5; `FIXTURE_VERSION` bump.
- [x] Coordinator construction maps the mode to the tagged union per contract 4.
- [x] S04 redesign per contract 6 (title, responsibility, run body); S13/S14 drop the redundant initiation option.
- [x] `rtk pnpm scenarios S01` completes with no `pending` in its state history; `rtk pnpm scenarios S04` passes through `pending` then completes; `rtk pnpm scenarios` — every scenario still satisfies its `check` (run the findings/`--json` output or the scenario tests).
- [x] `rtk pnpm test` — note (do not yet fix) fallout for task 3; the scenario tests should already pass.

## Task 3: Test-suite migration and fallout

**Files:** `test/**` only.

**Contract protected:** Contract 7. No test changes meaning — renamed modes and adjusted fixtures only.

- [ ] `'coordinator'` initiation literals → `'test_bypass_psp'` (`test/coordinator-concurrency.test.ts`, `test/invariants.property.test.ts`, `test/presenter-autopay.test.ts` option type).
- [ ] The presenter-autopay per-PSP two-step test reworked per contract 7.
- [ ] Repair any fallout found in task 2 (assertions on event counts/actors/seqs that legitimately shifted; behaviour-level failures are plan bugs — return `BLOCKED:` rather than weakening an assertion to hide a regression).
- [ ] `rtk pnpm test` green; `rtk pnpm scenarios` all checks pass.

## Task 4: Docs and digests

**Files:** `docs/initiation-model.md`, `docs/decisions/2026-11-03-payer-providers-default.md` (new), `docs/backlog.md`, `docs/presenter-comparison.md`.

- [ ] `initiation-model.md` updated per contract 8 (three modes, guard, same-moment resolution, status-query wording).
- [ ] Decision record per contract 8 — "Direct initiation is a test or licensed-provider mode, not the default, because cross-provider single-request atomic settlement is not realistic."
- [ ] Backlog entry per contract 8 noting the expected digest shift.
- [ ] `rtk pnpm --silent presenter --markdown --run-id=employee-mandate-v1 > docs/presenter-comparison.md` regenerated; spot-check the new digests render.
- [ ] `rtk pnpm test`, `rtk pnpm scenarios`, `rtk pnpm findings` all green.

## Acceptance mapping

- Default world: no trace contains a backend `submit` that wasn't preceded by a provider `forward` — enforceable in a scenario/test assertion (every `backend`-actor `submit` event's leg keys appear in earlier `forward` events) — add it as an invariant in task 2 or 3.
- S01 completes without pending; S04 passes through pending.
- `coordinator_as_psp` with default (distinct) provider membership refuses a multi-payer submit with `request_refused { reason: 'direct_initiation_mixed_psps' }`; `test_bypass_psp` submits the same purchase; `coordinator_as_psp` with a shared `providerFor` submits — covered by a focused test in task 3.
- All scenario checks pass; digests regenerated and the shift recorded.
