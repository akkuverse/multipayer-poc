# Readiness Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the multi-payer mock so it shows technical readiness for the ECB innovation call: known defects fixed, a backend port that an ECB adapter can drop into, run evidence and a generated findings table, N-payer and multi-payee use cases, per-party data views, per-payer PSP initiation, signed authority, randomised invariant tests, sequence diagrams and CI.

**Architecture:** The coordinator stays the single deterministic decision point. A `SettlementBackend` interface (async) separates it from settlement; `MockBackend`, a `SimulatedPsp` decorator and a future private ECB adapter implement it. Proposals become a list of `Share`s (payer, payee, amount, authority kind), so the employer-benefit flow, bill splits and multi-payee orders share one submission, state-derivation and recovery path.

**Tech Stack:** Node.js >= 23.6 with native TypeScript type stripping, `node:test`, `node:assert/strict`, `node:crypto`. No dependencies.

**Spec:** The improvement list agreed in conversation on 14 October 2026 (seven areas plus the S11 domain check), read together with [docs/backlog.md](../../backlog.md), [docs/experiment-protocol.md](../../experiment-protocol.md) and the call text in [docs/references/](../../references/README.md) (evaluation criteria "Use case relevance" and "Technical readiness"; scope note: participants act as simulated PSPs, PSP-to-backend only).

## Global Constraints

- Zero runtime and dev dependencies. Only `node:` built-ins. Ask before adding anything.
- Node.js >= 23.6 type stripping, no build step. Type stripping rejects TypeScript that needs a transform: **no `enum`, no `namespace`, no constructor parameter properties (`constructor(readonly x: T)`)**. Type-only imports must use `import type`.
- There is no type checker. Tests are the only check, so run `pnpm test` after every step that says so.
- All amounts are integer euro cents.
- Every trace event carries its origin. This code only ever writes `LOCAL`. Never report a local pass as an ECB capability.
- Safety invariants, each covered by tests: never complete a purchase unless every leg settled; never shift a failed or expired share onto another payer; never retry with new idempotency keys; never treat a timeout as failure.
- AI code never calls approval or submission functions. Deterministic code decides amounts and eligibility.
- No ECB adapter code in this repository. No text that implies ECB affiliation or endorsement.
- Synthetic data only. No personal data, no real money, no network calls.
- No LICENSE file.
- Use `pnpm` (`pnpm test`, `pnpm scenarios`).
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Decisions taken in this plan (review before executing)

| # | Decision | Why | Alternative |
|---|---|---|---|
| D1 | **Confirmed.** **B1: model payer fees, zero in every fixture.** A fee is paid by a payer to their own PSP on top of their share. It is bound in the approval, counts against the employee's instruction, is never part of the merchant total and never moves to another payer. Returns give back the amount, not the fee (open question) | Basic digital euro payments are free for individuals, so fees are zero today; modelling them means a non-zero fee is handled correctly instead of throwing | Remove the fee field |
| D2 | **Benefit model: one subsidised meal per working day** (`maxPurchasesPerDay: 1`), keeping the cents cap as a second limit. S11 becomes "second lunch on the same day gets no employer share" | Backlog domain check: EUR 7.67 applies per meal, not as a daily budget. **Still needs tax/legal confirmation before presenting** (open questions recorded in the backlog, Task 4) | Keep the daily cents budget and the old S11 |
| D3 | **Confirmed.** **`SettlementBackend` is async** (Promises). Coordinator operations that reach the backend become `async` | A real adapter makes network calls. A sync port would make "drop-in adapter" untrue | Keep it sync and convert later |
| D4 | **Split purchases are never repriced.** Changing a split means proposing again | No policy exists to recompute peer shares, and silently re-splitting would shift shares between payers | Proportional reprice |
| D5 | **Confirmed, documented.** **Per-PSP initiation semantics (mock hypothesis):** in atomic mode each PSP submits its own leg and the backend assembles the group by a deadline, rejecting it if incomplete. A PSP that refuses to forward counts as conclusive non-submission (`rejected: psp_unavailable`) | Makes the open "who initiates which leg" question concrete and testable. Documented as a hypothesis in `docs/initiation-model.md` (Task 13), with the questions for the ECB test environment | Model only single-PSP initiation |
| D6 | **Signing is mandatory**, Ed25519 via `node:crypto`. Keys come from fixed synthetic seeds, so traces stay reproducible | Unsigned authority is the main gap against AP2. Fixed seeds keep trace digests stable | Optional signing |
| D7 | **`resubmit(p)` reuses the mode stored at `submit`** (no mode argument) | Resubmitting a new leg in a different mode could settle one leg of an atomic group on its own | Keep the argument and validate it |

Not in this plan: a type checker (would need `typescript` as a dev dependency, so ask first) and the AI presenter demo (separate backlog item).

## Review Focus

1. **An approval from someone with no approval share** (a stranger, or the employer, which pays under its mandate) must be rejected and leave the purchase in `awaiting_approvals`. Test in Task 10.
2. **Malformed split input** (duplicate roles, zero, negative or fractional cents) must be refused at `proposeSplit`, before any approval exists. Test in Task 11.
3. **Benefit use across a day boundary.** A purchase proposed on day 0 and submitted on day 1 must be rechecked against day 1's usage, not day 0's. Test in Task 5.
4. **A mandate re-published under another employer's identity** must not be accepted, even when it is validly signed by the new key holder. Test in Task 14.
5. **A refund through an unavailable PSP** must keep the legs already returned, leave the purchase retryable, and complete on retry once the PSP is back. Test in Task 13.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/types.ts` | modify | Domain types. `Share`, `PayerApproval` and `BenefitTerms` replace the fixed two-payer fields |
| `src/policy.ts` | modify | Benefit evaluation (beneficiary, per-day purchase count) and `equalShares` |
| `src/ledger.ts` | create | Per-mandate, per-day benefit reservations (B2) |
| `src/backend.ts` | create | `SettlementBackend` port and its request/response types |
| `src/mock-backend.ts` | modify | Implements the port. Per-leg payee, per-payer group funding, group assembly |
| `src/psp.ts` | create | `SimulatedPsp` decorator and `PspUnavailableError` |
| `src/signing.ts` | create | Canonical JSON, Ed25519 sign/verify, seeded keys |
| `src/authority.ts` | create | `MandateRegistry`, which holds the latest signed mandate per ref |
| `src/coordinator.ts` | modify | Shares, N approvals, split proposals, recheck, ledger, initiation routing, signature checks |
| `src/views.ts` | create | Payer, payee and sponsor projections |
| `src/run-record.ts` | create | Run records and trace digest |
| `src/findings.ts` | create | Findings table generated from runs |
| `src/mermaid.ts` | create | Trace to Mermaid sequence diagram |
| `src/scenarios.ts` | modify | Fixtures and helpers (`approveAs`, `updateMandate`, `advance`), S01–S18 with findings metadata |
| `src/cli.ts` | modify | `--json`, `--findings`, `--mermaid` |
| `test/defects.test.ts` | create | B1–B5 regressions |
| `test/backend-port.test.ts` | create | Coordinator against a fake backend |
| `test/contract/settlement-backend.contract.ts` | create | Reusable backend contract (not matched by the test glob on purpose) |
| `test/mock-backend.contract.test.ts` | create | Runs the contract on `MockBackend` |
| `test/run-record.test.ts`, `test/findings.test.ts`, `test/shares.test.ts`, `test/split.test.ts`, `test/views.test.ts`, `test/psp.test.ts`, `test/signing.test.ts`, `test/invariants.property.test.ts`, `test/mermaid.test.ts` | create | One file per feature |
| `test/scenarios.test.ts` | modify | One test per scenario |
| `docs/field-map.md` | create | Field to purpose to recipient map |
| `.github/workflows/ci.yml` | create | CI on Node 23.6.0 and 24 |
| `README.md`, `docs/backlog.md`, `docs/experiment-protocol.md`, `package.json` | modify | Kept current task by task |

## Before you start

- [ ] Create a branch: `git checkout -b readiness-extensions`
- [ ] Baseline: `pnpm test`. Expected: `tests 14`, `pass 14`.

---

## Phase 1: Correctness (backlog defects and domain check)

### Task 1: B1, model payer fees (zero by default)

**Files:**
- Modify: `src/types.ts` (Leg), `src/policy.ts` (BenefitInput, evaluateBenefit)
- Modify: `src/mock-backend.ts` (LegRequest, Execution, canFund/settle, `FEE_COLLECTOR`)
- Modify: `src/coordinator.ts` (reprice, submit, send, leg)
- Modify: `src/scenarios.ts` (fee-collector account, `lunch` fee option)
- Modify: `docs/experiment-protocol.md`, `docs/backlog.md`
- Create: `test/defects.test.ts`

**Fee model (D1):** a payer fee is what a payer pays their own PSP for the payment, on top of their share. It is:
- never part of the merchant total, and never moved onto another payer;
- bound in the payer's approval;
- counted against the employee's spending limit (their instruction).

In the mock it goes to one `FEE_COLLECTOR` account, standing in for the payers' PSPs. Every fixture uses zero, because basic digital euro payments are free for individuals; the model exists so a non-zero fee is handled correctly rather than throwing. Returns give back the amount, not the fee (an open question, recorded in the backlog).

**Interfaces:**
- Produces:
  - `LegRequest.feeCents: Cents` and `Leg.feeCents: Cents`. The employee leg carries `proposal.feesCents`; the employer leg carries 0.
  - `BenefitInput.employeeFeeCents: Cents`.
  - `FEE_COLLECTOR = 'psp-fees'` (exported from `src/mock-backend.ts`).
  - `lunch(w, total, merchantId, extra: { usedTodayCents?: number; feesCents?: number })`.
  - `test/defects.test.ts`, with a local `run(id)` helper that later tasks append to.
  - `Proposal.feesCents` and `EmployeeApproval.feesCents` stay. `ProposeInput.feesCents` stays optional with default 0.

- [x] **Step 1: Write the failing tests**

Create `test/defects.test.ts`:

```ts
// Regression tests for the defects listed in docs/backlog.md (B1–B5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, world, lunch, EMPLOYEE, EMPLOYER, MERCHANT_A } from '../src/scenarios.ts';
import { FEE_COLLECTOR } from '../src/mock-backend.ts';

const run = (id: string) => {
  const s = scenarios.find((x) => x.id.startsWith(id));
  if (!s) throw new Error(`no scenario ${id}`);
  return s.run();
};

test('B1 fees default to zero and are bound in the approval', () => {
  const { p } = run('S01');
  assert.equal(p.proposal.feesCents, 0);
  assert.equal(p.approval?.feesCents, 0);
  assert.deepEqual(p.legs.map((l) => l.feeCents), [0, 0]);
});

test('B1 a non-zero fee is paid by the employee on top of the total and counts against their instruction', () => {
  const w = world();
  const p = lunch(w, 1_300, MERCHANT_A, { feesCents: 20 });
  // EUR 8 share + EUR 0.20 fee is above the EUR 8 instruction.
  assert.equal(p.state, 'draft');
  assert.equal(p.reason, 'employee_share_exceeds_instruction');
  w.coordinator.reviseInstruction(p, 820);
  w.coordinator.approveCurrent(p);
  w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300, 'the merchant receives exactly the total');
  assert.equal(w.backend.account(FEE_COLLECTOR).linkedBankCents, 20);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000 - 820);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000 - 500, 'the employer never pays the employee fee');
});
```

- [x] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/defects.test.ts`
Expected: FAIL. `FEE_COLLECTOR` is not exported, and `submit` throws `contributions do not reconcile` for any non-zero fee.

- [x] **Step 3: Carry the fee through policy and coordinator**

`src/types.ts`:
- Above `export interface Proposal`, add:

```ts
// feesCents is the payer fee the employee pays their own PSP, on top of their
// share: never part of the merchant total, never moved onto another payer.
// Zero in every fixture (basic digital euro payments are free for individuals).
```

- In `Leg`, after `amountCents`, add:

```ts
  // Payer fee on top of amountCents, paid to the payer's PSP.
  feeCents: Cents;
```

`src/policy.ts`, `BenefitInput`, after `employeeMaxCents`:

```ts
  // Fee the employee pays on top of their share; counts against the instruction.
  employeeFeeCents: Cents;
```

In `evaluateBenefit`: `withinInstruction: employeeCents + input.employeeFeeCents <= input.employeeMaxCents,`

`src/coordinator.ts`:
- `reprice`: add `employeeFeeCents: p.proposal.feesCents,` to the `evaluateBenefit` input.
- `leg(...)`: add a `feeCents: Cents` parameter after `amountCents` and include `feeCents,` in the returned object.
- `submit`: build the legs and check them like this:

```ts
    p.legs = [];
    // The employee leg exists if they pay anything, share or fee.
    if (q.employeeCents > 0 || q.feesCents > 0) {
      p.legs.push(this.leg(p, 'employee', p.employeeId, q.employeeCents, q.feesCents, p.approval.approvalRef));
    }
    if (q.employerCents > 0) {
      p.legs.push(this.leg(p, 'employer', p.mandate.employerId, q.employerCents, 0, p.mandate.mandateRef));
    }
    // The merchant receives exactly the total; fees travel separately to the
    // payers' PSPs and must match what was approved.
    const sum = p.legs.reduce((s, l) => s + l.amountCents, 0);
    const fees = p.legs.reduce((s, l) => s + l.feeCents, 0);
    if (sum !== q.totalCents || fees !== q.feesCents) throw new Error('contributions do not reconcile to merchant total and fees');
```

- `send`: map each leg to `{ payerId: l.payerId, amountCents: l.amountCents, feeCents: l.feeCents, idempotencyKey: l.idempotencyKey }`.

- [x] **Step 4: Route the fee in the mock backend**

`src/mock-backend.ts`:
- Below the imports:

```ts
// Stands in for the payers' PSPs as receivers of payer fees.
export const FEE_COLLECTOR = 'psp-fees';
```

- `LegRequest` and `Execution`: add `feeCents: Cents;` after `amountCents`. In `submit`, set `feeCents: l.feeCents,` when building an `Execution`.
- `rejection`: `if (!this.canFund(this.account(req.payerId), req.amountCents + req.feeCents)) return 'insufficient_funds';`
- `settle`:

```ts
  private settle(e: Execution): void {
    this.debit(this.account(e.payerId), e.amountCents + e.feeCents);
    this.credit(this.account(e.merchantId), e.amountCents);
    if (e.feeCents > 0) this.credit(this.account(FEE_COLLECTOR), e.feeCents);
    e.status = 'settled';
  }
```

- `refund`: unchanged. Add the comment `// Returns the amount, not the payer fee: whether fees are refunded is open (see backlog).`

`src/scenarios.ts`:
- Import `FEE_COLLECTOR` from `./mock-backend.ts` and add it to the business-account loop list (balance 0).
- `lunch`: change the type of `extra` to `{ usedTodayCents?: number; feesCents?: number }`. It is already spread into the `propose` input.

- [x] **Step 5: Update the docs**

`docs/experiment-protocol.md` line 31: after `Employee approval binds merchant, purchase version, amount and fees.` add ` Fees are modelled per payer, on top of the merchant total, and are zero in every fixture.`

`docs/backlog.md`: delete the B1 row. Add under Planned: `- **Fees on returns.** Returns give back the amount, not the payer fee. Decide whether a return after a partial failure should also return the fee.`

- [x] **Step 6: Run all tests**

Run: `pnpm test`
Expected: PASS, 16 tests. Existing traces are unchanged, because every fixture fee is 0.

- [ ] **Step 7: Commit**

```bash
git add src/ test/defects.test.ts docs/experiment-protocol.md docs/backlog.md
git commit -m "Model payer fees, zero by default (B1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: B3, check the mandate's beneficiary

**Files:**
- Modify: `src/policy.ts` (mandateProblem, BenefitInput, evaluateBenefit)
- Modify: `src/coordinator.ts` (reprice, submit)
- Modify: `src/types.ts:74-75` (remove the B3 note)
- Modify: `src/scenarios.ts` (add `updateMandate`)
- Test: `test/defects.test.ts`

**Interfaces:**
- Produces: `mandateProblem(m: EmployerMandate, merchantId: string, beneficiaryId: string, now: number): string | undefined`, which can return `'beneficiary_mismatch'`. `BenefitInput.beneficiaryId: string`. `updateMandate(w: World, changes: Partial<EmployerMandate>): void` in `src/scenarios.ts`. Every later test changes mandate terms through this helper only.

- [ ] **Step 1: Write the failing tests**

Append to `test/defects.test.ts` and add `updateMandate` to the import from `../src/scenarios.ts`:

```ts
test('B3 a mandate granted to another employee funds nothing', () => {
  const w = world({}, { beneficiaryRef: 'employee-2' });
  const p = lunch(w);
  assert.equal(p.proposal.employerCents, 0);
  assert.equal(p.state, 'draft', 'EUR 13 alone exceeds the EUR 8 instruction');
  const proposal = w.trace.events.find((e) => e.event === 'proposal');
  assert.equal(proposal?.detail?.ineligibleReason, 'beneficiary_mismatch');
});

test('B3 the beneficiary is rechecked at initiation', () => {
  const w = world();
  const p = lunch(w);
  w.coordinator.approveCurrent(p);
  updateMandate(w, { beneficiaryRef: 'employee-2' });
  w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'failed');
  assert.equal(p.reason, 'employer_authority_invalid:beneficiary_mismatch');
  assert.equal(w.backend.executionCount(), 0);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/defects.test.ts`
Expected: FAIL. `updateMandate` is not exported, and once it is, employerCents is 500.

- [ ] **Step 3: Implement**

`src/policy.ts`: replace `mandateProblem` and remove the B3 note above it:

```ts
// Why the mandate cannot fund this purchase right now, or undefined when it
// can. Checked both at proposal time and again at initiation.
export function mandateProblem(m: EmployerMandate, merchantId: string, beneficiaryId: string, now: number): string | undefined {
  if (m.revoked) return 'mandate_revoked';
  if (now < m.validFrom || now > m.validUntil) return 'mandate_expired';
  if (m.beneficiaryRef !== beneficiaryId) return 'beneficiary_mismatch';
  if (!m.eligibleMerchants.includes(merchantId)) return 'merchant_not_eligible';
  return undefined;
}
```

In `BenefitInput`, add after `merchantId`:

```ts
  // Whose purchase this is; must be the mandate's beneficiary.
  beneficiaryId: string;
```

In `evaluateBenefit`: `const problem = mandateProblem(input.mandate, input.merchantId, input.beneficiaryId, input.now);`

`src/coordinator.ts`: in `reprice`, add `beneficiaryId: p.employeeId,` to the `evaluateBenefit` input. In `submit`: `const problem = mandateProblem(p.mandate, q.merchantId, p.employeeId, this.now);`

`src/types.ts`: replace the two-line B3 note above `beneficiaryRef` with `// Who may benefit from the mandate; checked against the purchase's employee.`

`src/scenarios.ts`: add after `world()`:

```ts
// The employer changes its mandate terms (cap, beneficiary, revocation). Tests
// and scenarios go through this helper so that how mandates are issued can
// change in one place.
export function updateMandate(w: World, changes: Partial<EmployerMandate>): void {
  Object.assign(w.mandate, changes);
}
```

- [ ] **Step 4: Run all tests**

Run: `pnpm test`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

`docs/backlog.md`: delete the B3 row.

```bash
git add src/policy.ts src/coordinator.ts src/types.ts src/scenarios.ts test/defects.test.ts docs/backlog.md
git commit -m "Check the mandate beneficiary at proposal and initiation (B3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: B4, bind the approval's expiry

**Files:**
- Modify: `src/coordinator.ts` (approve)
- Modify: `src/types.ts:55` (remove the B4 note)
- Test: `test/defects.test.ts`

**Interfaces:**
- Produces: `approve` rejects an approval whose `expiresAt` is later than the proposal's, or that has already expired (`now > approval.expiresAt`). The error message is unchanged: `approval does not match the current proposal`.

- [ ] **Step 1: Write the failing tests**

Append to `test/defects.test.ts`:

```ts
test('B4 an approval cannot outlive the proposal it binds to', () => {
  const w = world();
  const p = lunch(w);
  const q = p.proposal;
  const approval = {
    approvalRef: 'appr-long',
    purchaseId: p.purchaseId,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    feesCents: q.feesCents,
    employeeCents: q.employeeCents,
    expiresAt: q.expiresAt + 1_000,
  };
  assert.throws(() => w.coordinator.approve(p, approval), /does not match/);
  assert.equal(p.state, 'awaiting_approvals');
});

test('B4 an approval that has already expired is rejected', () => {
  const w = world();
  const p = lunch(w);
  w.coordinator.now = p.proposal.expiresAt + 1;
  assert.throws(() => w.coordinator.approveCurrent(p), /does not match/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/defects.test.ts`
Expected: FAIL. Both approvals are accepted.

- [ ] **Step 3: Implement**

In `approve`, replace the binding comment's B4 note and the condition with:

```ts
    const binds =
      approval.purchaseId === p.purchaseId &&
      approval.proposalVersion === q.version &&
      approval.merchantId === q.merchantId &&
      approval.totalCents === q.totalCents &&
      approval.employeeCents === q.employeeCents &&
      // An approval may expire before the offer does, never after it.
      approval.expiresAt <= q.expiresAt;
    const live = this.now <= approval.expiresAt;
    if (p.state !== 'awaiting_approvals' || !binds || !live) {
```

`src/types.ts`: delete the line `// (Backlog B4: expiresAt is not yet part of that binding check.)`.

- [ ] **Step 4: Run all tests**

Run: `pnpm test`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

`docs/backlog.md`: delete the B4 row.

```bash
git add src/coordinator.ts src/types.ts test/defects.test.ts docs/backlog.md
git commit -m "Bind approval expiry to the proposal (B4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: B2, a stateful benefit ledger and one subsidised meal per day

**Files:**
- Create: `src/ledger.ts`
- Modify: `src/types.ts` (EmployerMandate, Purchase)
- Modify: `src/policy.ts` (BenefitInput, evaluateBenefit)
- Modify: `src/coordinator.ts` (constructor, ProposeInput, propose, reprice, submit, derive, refund)
- Modify: `src/scenarios.ts` (constants, world, lunch, S11)
- Modify: `test/scenarios.test.ts` (S11 test), `README.md`, `docs/backlog.md`
- Test: `test/defects.test.ts`

**Interfaces:**
- Produces:
  - `src/ledger.ts`: `MINUTES_PER_DAY = 1_440`, `dayOf(now: number): number`, `interface DailyUsage { cents: Cents; purchases: number }`, `class BenefitLedger` with `usage(mandateRef, day, excludePurchaseId?): DailyUsage`, `reserve(purchaseId, mandateRef, day, cents): void`, `consume(purchaseId): void`, `release(purchaseId): void`, `state(purchaseId): 'reserved' | 'consumed' | undefined`.
  - `EmployerMandate.maxPurchasesPerDay: number`.
  - `BenefitInput.usedToday: DailyUsage` (replaces `usedTodayCents`). New `ineligibleReason`: `'daily_purchase_limit_reached'`.
  - `interface CoordinatorOptions { now?: number; ledger?: BenefitLedger }`, `new Coordinator(backend, opts?)`, `coordinator.ledger` (readonly, public).
  - `Purchase` and `ProposeInput` lose `usedTodayCents`.
  - `lunch(w, total = 1_300, merchantId = MERCHANT_A, opts: { purchaseId?: string; expiresAt?: number; feesCents?: number } = {})`.
  - `MEAL_BENEFIT_CAP = 767` replaces `DAILY_BENEFIT_CAP`.
  - Trace event `benefit_reserved` `{ mandateRef, cents }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/defects.test.ts`. Add `MERCHANT_C` to the scenarios import, and add `import { MINUTES_PER_DAY } from '../src/ledger.ts';`:

```ts
test('B2 a completed purchase uses up the day\'s subsidised meal', () => {
  const w = world();
  const a = lunch(w);
  w.coordinator.approveCurrent(a);
  w.coordinator.submit(a, 'atomic');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'consumed');
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(b.proposal.employerCents, 0);
});

test('B2 a failed purchase releases its reservation', () => {
  const w = world();
  w.backend.faults.set(EMPLOYER, 'decline');
  const a = lunch(w);
  w.coordinator.approveCurrent(a);
  w.coordinator.submit(a, 'atomic');
  assert.equal(a.state, 'failed');
  assert.equal(w.coordinator.ledger.state('purchase-1'), undefined);
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(b.proposal.employerCents, 500);
});

test('B2 a pending purchase keeps its reservation', () => {
  const w = world();
  w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
  const a = lunch(w);
  w.coordinator.approveCurrent(a);
  w.coordinator.submit(a, 'atomic');
  assert.equal(a.state, 'pending');
  assert.equal(w.coordinator.ledger.state('purchase-1'), 'reserved');
});

test('B2 a full refund gives the meal benefit back', () => {
  const { w } = run('S10');
  assert.equal(w.coordinator.ledger.state('purchase-1'), undefined);
});

test('B2 the benefit renews on the next working day', () => {
  const w = world({}, { validUntil: 10 * MINUTES_PER_DAY });
  const a = lunch(w);
  w.coordinator.approveCurrent(a);
  w.coordinator.submit(a, 'atomic');
  w.coordinator.now = MINUTES_PER_DAY + 10;
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(b.proposal.employerCents, 500);
});
```

In `test/scenarios.test.ts`, replace the S11 test with:

```ts
test('S11 second lunch on the same working day gets no employer share', () => {
  const { w, p } = run('S11');
  assert.equal(p.proposal.employerCents, 0);
  assert.equal(p.proposal.employeeCents, 1_300);
  assert.equal(p.state, 'draft');
  const proposal = w.trace.events.filter((e) => e.event === 'proposal').at(-1);
  assert.equal(proposal?.detail?.ineligibleReason, 'daily_purchase_limit_reached');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test`
Expected: FAIL. `src/ledger.ts` does not exist.

- [ ] **Step 3: Create the ledger**

Create `src/ledger.ts`:

```ts
// Per-mandate record of employer benefit drawn per day. A purchase reserves
// its employer share at submission, consumes it on completion and releases it
// when nothing stays committed (failed, cancelled, fully returned). Pending
// and recovering purchases keep their reservation, so two purchases in flight
// can never both draw the same benefit.

import type { Cents } from './types.ts';

// The coordinator clock counts minutes; a benefit day is 1,440 of them.
export const MINUTES_PER_DAY = 1_440;
export const dayOf = (now: number): number => Math.floor(now / MINUTES_PER_DAY);

export interface DailyUsage {
  cents: Cents;
  purchases: number;
}

interface Entry {
  mandateRef: string;
  day: number;
  cents: Cents;
  state: 'reserved' | 'consumed';
}

export class BenefitLedger {
  private readonly entries = new Map<string, Entry>(); // keyed by purchaseId

  // Reserved and consumed entries both count. A purchase never counts
  // against itself, so it can be re-evaluated at initiation.
  usage(mandateRef: string, day: number, excludePurchaseId?: string): DailyUsage {
    let cents = 0;
    let purchases = 0;
    for (const [purchaseId, e] of this.entries) {
      if (purchaseId === excludePurchaseId || e.mandateRef !== mandateRef || e.day !== day) continue;
      cents += e.cents;
      purchases += 1;
    }
    return { cents, purchases };
  }

  // Idempotent: a retried submission keeps its original reservation.
  reserve(purchaseId: string, mandateRef: string, day: number, cents: Cents): void {
    if (!this.entries.has(purchaseId)) this.entries.set(purchaseId, { mandateRef, day, cents, state: 'reserved' });
  }

  consume(purchaseId: string): void {
    const e = this.entries.get(purchaseId);
    if (e) e.state = 'consumed';
  }

  release(purchaseId: string): void {
    this.entries.delete(purchaseId);
  }

  state(purchaseId: string): Entry['state'] | undefined {
    return this.entries.get(purchaseId)?.state;
  }
}
```

- [ ] **Step 4: Wire it in**

`src/types.ts`:
- In `EmployerMandate`, after `maxPerDayCents: Cents;` add:

```ts
  // Subsidised purchases allowed per day. The German meal benefit allows one
  // meal per working day (pending tax/legal confirmation, see backlog).
  maxPurchasesPerDay: number;
```

- In `Purchase`, delete `usedTodayCents` and its comment.

`src/policy.ts`:
- `import type { DailyUsage } from './ledger.ts';`
- In `BenefitInput`, replace `usedTodayCents` and its comment with:

```ts
  // Employer benefit other purchases already hold or used today (ledger).
  usedToday: DailyUsage;
```

- Replace the body of `evaluateBenefit` with:

```ts
  const problem = mandateProblem(input.mandate, input.merchantId, input.beneficiaryId, input.now);
  const limitReached = input.usedToday.purchases >= input.mandate.maxPurchasesPerDay;
  const remainingToday = Math.max(0, input.mandate.maxPerDayCents - input.usedToday.cents);
  // The employer share is the tightest of the per-purchase cap, the remaining
  // daily budget and the purchase total. A mandate problem or a used-up daily
  // purchase zeroes it rather than falling back to a partial contribution.
  const employerCents =
    problem || limitReached ? 0 : Math.min(input.mandate.maxPerPurchaseCents, remainingToday, input.totalCents);
  // The employee always covers the remainder; nothing about the employer's
  // answer changes the total owed.
  const employeeCents = input.totalCents - employerCents;
  return {
    employerCents,
    employeeCents,
    // False leaves the purchase in draft: the decision to pay more belongs to
    // the employee, not to this function.
    withinInstruction: employeeCents + input.employeeFeeCents <= input.employeeMaxCents,
    ineligibleReason:
      problem ?? (limitReached ? 'daily_purchase_limit_reached' : employerCents === 0 ? 'daily_cap_used' : undefined),
  };
```

`src/coordinator.ts`:
- `import { BenefitLedger, dayOf } from './ledger.ts';`
- Delete `usedTodayCents` from `ProposeInput` and from the object built in `propose`.
- Add above the class:

```ts
export interface CoordinatorOptions {
  now?: number;
  ledger?: BenefitLedger;
}
```

- Replace the fields and constructor with:

```ts
  private readonly backend: MockBackend;
  private readonly trace: Trace;
  // Shared across purchases: the per-mandate record of benefit already drawn.
  readonly ledger: BenefitLedger;
  now: number;

  constructor(backend: MockBackend, opts: CoordinatorOptions = {}) {
    this.backend = backend;
    this.trace = backend.trace;
    this.now = opts.now ?? 0;
    this.ledger = opts.ledger ?? new BenefitLedger();
  }
```

- In `reprice`, replace `usedTodayCents: p.usedTodayCents,` with `usedToday: this.ledger.usage(p.mandate.mandateRef, dayOf(this.now), p.purchaseId),`.
- In `submit`, insert right before `this.log('submit', ...)`:

```ts
    // Hold the employer's benefit before any money moves, so a concurrent
    // purchase cannot draw the same benefit.
    if (q.employerCents > 0) {
      this.ledger.reserve(p.purchaseId, p.mandate.mandateRef, dayOf(this.now), q.employerCents);
      this.log('benefit_reserved', { mandateRef: p.mandate.mandateRef, cents: q.employerCents });
    }
```

- In `derive`, insert after the state `if/else` chain and before the transition log:

```ts
    // The benefit is used once the purchase completes and handed back once
    // nothing is committed; pending and recovering purchases keep it reserved.
    if (p.state === 'completed') this.ledger.consume(p.purchaseId);
    else if (p.state === 'failed' || p.state === 'cancelled') this.ledger.release(p.purchaseId);
```

- Replace the last line of `refund` with:

```ts
    if (p.returnStatus === 'completed') {
      // A returned purchase gives the benefit back.
      this.ledger.release(p.purchaseId);
      this.log('refund_completed', { legs: p.legs.map((l) => `${l.leg}:${l.status}`) });
    }
```

`src/scenarios.ts`:
- Replace the `DAILY_BENEFIT_CAP` constant and its comment with:

```ts
// 2026 German ceiling per subsidised meal (Sachbezugswert EUR 4.57 + EUR 3.10),
// one meal per working day. Pending tax/legal confirmation (see backlog).
export const MEAL_BENEFIT_CAP = 767;
```

- In `world()`, set `maxPerDayCents: MEAL_BENEFIT_CAP,` and add `maxPurchasesPerDay: 1,`. Update the mandate comment to `// Default mandate: up to EUR 5 per purchase, one subsidised meal per day, at any of the three merchants, valid for the whole scenario clock.`
- Construct the coordinator as `new Coordinator(backend, { now: 10 })`.
- Replace `lunch` with:

```ts
export function lunch(
  w: World,
  total = 1_300,
  merchantId = MERCHANT_A,
  opts: { purchaseId?: string; expiresAt?: number; feesCents?: number } = {},
): Purchase {
  return w.coordinator.propose({
    purchaseId: opts.purchaseId ?? 'purchase-1',
    employeeId: EMPLOYEE,
    employeeMaxCents: 800,
    merchantId,
    totalCents: total,
    feesCents: opts.feesCents,
    mandate: w.mandate,
    expiresAt: opts.expiresAt ?? 100,
  });
}
```

- Replace the S11 entry with:

```ts
  {
    id: 'S11-second-meal-same-day',
    title: 'Second lunch on the same working day: no employer share, employee share exceeds instruction',
    run: () => {
      const w = world();
      // The first lunch completes and uses the day's subsidised meal.
      const first = lunch(w);
      w.coordinator.approveCurrent(first);
      w.coordinator.submit(first, 'atomic');
      // A second lunch the same day gets no employer share; EUR 13 is above
      // the EUR 8 instruction, so it stays in draft.
      const p = lunch(w, 1_300, MERCHANT_A, { purchaseId: 'purchase-2' });
      return { w, p };
    },
  },
```

- [ ] **Step 5: Update the docs**

`README.md`:
- S11 row: `| S11 | Second lunch on the same working day | No employer share; EUR 13 exceeds the EUR 8 instruction, so draft |`
- Fixture values paragraph: replace the first sentence with `Fixture values: the employer cap of EUR 7.67 is the 2026 German ceiling for a tax-advantaged meal subsidy (Sachbezugswert EUR 4.57 + EUR 3.10), modelled as one subsidised meal per working day.`

`docs/backlog.md`: delete the B2 row. Replace the "Domain check" paragraph with:

```markdown
- The model applies EUR 7.67 per meal, one subsidised meal per working day (S11). Present it as an illustrative German example until a tax adviser confirms:
  - **Benefit in kind or cash wages:** whether an employer contribution paid directly to the merchant in digital euro qualifies as a benefit in kind (meal-voucher treatment) at all, or counts as cash wages. If it is cash wages, the EUR 7.67 framing does not apply.
  - **Qualifying days:** the per-day conditions (no subsidy on leave, sick or travel days with a per-diem allowance). The model treats every calendar day as a working day.
  - **Taxable benefit:** the employee co-payment rule. The benefit is tax-free only if the employee pays at least the Sachbezugswert. The reference case (EUR 8) passes, but the policy does not check it.
  - **Amounts:** the 2026 values (EUR 4.57 Sachbezugswert + EUR 3.10).
```

- [ ] **Step 6: Run all tests**

Run: `pnpm test`
Expected: PASS, 25 tests.

- [ ] **Step 7: Commit**

```bash
git add src/ledger.ts src/types.ts src/policy.ts src/coordinator.ts src/scenarios.ts test/defects.test.ts test/scenarios.test.ts README.md docs/backlog.md
git commit -m "Track benefit use per mandate and day (B2); one subsidised meal per day" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: B5, full authority recheck at initiation

**Files:**
- Modify: `src/coordinator.ts` (new `benefitNow`, reprice, submit)
- Modify: `src/types.ts`, `src/policy.ts` (remove the B5 notes if present)
- Test: `test/defects.test.ts`

**Interfaces:**
- Consumes: `BenefitLedger.usage`, `dayOf` (Task 4), `updateMandate` (Task 2).
- Produces: `private benefitNow(p: Purchase, merchantId: string, totalCents: Cents): BenefitResult`, used by both `reprice` and `submit`. Failure reasons `employer_authority_invalid:<ineligibleReason>` or `employer_authority_invalid:cap_exceeded`.

- [ ] **Step 1: Write the failing tests**

Append to `test/defects.test.ts`:

```ts
test('B5 two purchases in flight cannot both draw the day\'s benefit', () => {
  const w = world();
  const a = lunch(w);
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  assert.equal(b.proposal.employerCents, 500, 'both proposals see the benefit before either submits');
  w.coordinator.approveCurrent(a);
  w.coordinator.approveCurrent(b);
  w.coordinator.submit(a, 'atomic');
  w.coordinator.submit(b, 'atomic');
  assert.equal(a.state, 'completed');
  assert.equal(b.state, 'failed');
  assert.equal(b.reason, 'employer_authority_invalid:daily_purchase_limit_reached');
  assert.equal(b.proposal.employeeCents, 800, 'the employee share did not grow');
});

test('B5 a per-purchase cap lowered after approval stops initiation', () => {
  const w = world();
  const p = lunch(w);
  w.coordinator.approveCurrent(p);
  updateMandate(w, { maxPerPurchaseCents: 300 });
  w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'failed');
  assert.equal(p.reason, 'employer_authority_invalid:cap_exceeded');
  assert.equal(p.proposal.employeeCents, 800);
  assert.equal(w.backend.executionCount(), 0);
});

test('B5 the recheck counts usage on the day of initiation, not of the proposal', () => {
  const w = world({}, { validUntil: 10 * MINUTES_PER_DAY });
  const expiresAt = 10 * MINUTES_PER_DAY;
  // Proposed and approved on day 0, submitted on day 1.
  const late = lunch(w, 1_300, MERCHANT_A, { expiresAt });
  w.coordinator.approveCurrent(late);
  w.coordinator.now = MINUTES_PER_DAY + 10;
  // Day 1's subsidised meal is used by another purchase first.
  const other = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2', expiresAt });
  w.coordinator.approveCurrent(other);
  w.coordinator.submit(other, 'atomic');
  w.coordinator.submit(late, 'atomic');
  assert.equal(other.state, 'completed');
  assert.equal(late.state, 'failed');
  assert.equal(late.reason, 'employer_authority_invalid:daily_purchase_limit_reached');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/defects.test.ts`
Expected: FAIL. `b`, `p` and `late` all complete.

- [ ] **Step 3: Implement**

`src/coordinator.ts`:
- Imports: `import type { BenefitResult } from './policy.ts';` and `import { evaluateBenefit } from './policy.ts';` (drop `mandateProblem`).
- Add before `reprice`:

```ts
  // Deterministic split as of now, counting benefit other purchases already
  // hold today. Used at proposal time and again at initiation.
  private benefitNow(p: Purchase, merchantId: string, totalCents: Cents): BenefitResult {
    return evaluateBenefit({
      totalCents,
      merchantId,
      beneficiaryId: p.employeeId,
      mandate: p.mandate,
      now: this.now,
      usedToday: this.ledger.usage(p.mandate.mandateRef, dayOf(this.now), p.purchaseId),
      employeeMaxCents: p.employeeMaxCents,
      employeeFeeCents: p.proposal.feesCents,
    });
  }
```

- In `reprice`, replace the whole `evaluateBenefit({...})` call with `const b = this.benefitNow(p, merchantId, totalCents);`.
- In `submit`, replace the employer recheck block (comment plus `if (q.employerCents > 0) { const problem = ... }`) with:

```ts
    // Recheck employer authority at initiation: validity, revocation,
    // beneficiary, merchant and both caps, against today's usage. If the
    // employer can no longer fund its full approved share, stop: the gap must
    // never move onto the employee.
    if (q.employerCents > 0) {
      const b = this.benefitNow(p, q.merchantId, q.totalCents);
      if (b.employerCents < q.employerCents) {
        this.fail(p, `employer_authority_invalid:${b.ineligibleReason ?? 'cap_exceeded'}`);
        return;
      }
    }
```

- Remove every remaining "Backlog B5" comment (`grep -n "B5" src/`).

- [ ] **Step 4: Run all tests**

Run: `pnpm test`
Expected: PASS, 28 tests. S06 still matches `/employer_authority_invalid/` (now `employer_authority_invalid:mandate_expired`).

- [ ] **Step 5: Commit**

`docs/backlog.md`: delete the B5 row. The Defects table is now empty, so replace it with `None open.`

```bash
git add src/coordinator.ts src/types.ts src/policy.ts test/defects.test.ts docs/backlog.md
git commit -m "Recheck caps and daily usage at initiation (B5)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase 2: Adapter readiness

### Task 6: `SettlementBackend` port, made async

**Files:**
- Create: `src/backend.ts`
- Modify: `src/mock-backend.ts` (types moved out, implements the port, async, per-leg payee)
- Modify: `src/coordinator.ts` (port type, trace injected, async operations)
- Modify: `src/scenarios.ts`, `src/cli.ts`, `test/scenarios.test.ts`, `test/defects.test.ts` (await)
- Create: `test/backend-port.test.ts`

**Interfaces:**
- Produces (`src/backend.ts`):

```ts
export interface LegRequest { payerId: string; payeeId: string; amountCents: Cents; feeCents: Cents; idempotencyKey: string }
export interface LegResponse { idempotencyKey: string; executionRef: string; status: 'settled' | 'rejected' | 'unknown'; reason?: string }
export type ExecutionStatus = 'settled' | 'rejected' | 'unknown' | 'returned';
export interface SubmitRequest { groupRef: string; mode: SettlementMode; legs: LegRequest[] }
export interface SettlementBackend {
  readonly name: string; readonly origin: Origin; readonly specVersion: string;
  submit(req: SubmitRequest): Promise<LegResponse[]>;
  status(executionRef: string): Promise<ExecutionStatus>;
  refund(executionRef: string): Promise<'returned' | 'unsupported'>;
}
```

  - `new Coordinator(backend: SettlementBackend, trace: Trace, opts?: CoordinatorOptions)`. `submit`, `resubmit`, `reconcile`, `recover` and `refund` return `Promise<void>`. `propose`, `approve`, `approveCurrent`, `changeOffer`, `reviseInstruction` and `cancel` stay synchronous.
  - `MockBackend`: `name = 'mock-backend'`, `origin = 'LOCAL'`, `specVersion = 'mock-1'`.
  - `Scenario.run: () => Promise<{ w: World; p: Purchase }>`.

- [ ] **Step 1: Write the failing test**

Create `test/backend-port.test.ts`:

```ts
// The coordinator must work against any SettlementBackend, not just the mock.
// This fake answers every leg 'unknown' and settles on the first status query,
// like a backend whose responses are slow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionStatus, LegResponse, SettlementBackend, SubmitRequest } from '../src/backend.ts';
import { Coordinator } from '../src/coordinator.ts';
import { Trace } from '../src/trace.ts';
import { world, EMPLOYEE, MERCHANT_A } from '../src/scenarios.ts';

class SlowBackend implements SettlementBackend {
  readonly name = 'slow-fake';
  readonly origin = 'LOCAL' as const;
  readonly specVersion = 'test';
  readonly requests: SubmitRequest[] = [];

  async submit(req: SubmitRequest): Promise<LegResponse[]> {
    this.requests.push(req);
    return req.legs.map((l, i) => ({ idempotencyKey: l.idempotencyKey, executionRef: `slow-${i}`, status: 'unknown' }));
  }

  async status(): Promise<ExecutionStatus> {
    return 'settled';
  }

  async refund(): Promise<'returned' | 'unsupported'> {
    return 'unsupported';
  }
}

test('the coordinator drives any SettlementBackend through the port', async () => {
  const w = world(); // fixtures only: the mandate
  const backend = new SlowBackend();
  const c = new Coordinator(backend, new Trace(), { now: 10 });
  const p = c.propose({
    purchaseId: 'purchase-1',
    employeeId: EMPLOYEE,
    employeeMaxCents: 800,
    merchantId: MERCHANT_A,
    totalCents: 1_300,
    mandate: w.mandate,
    expiresAt: 100,
  });
  c.approveCurrent(p);
  await c.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  assert.deepEqual(
    backend.requests[0].legs.map((l) => [l.payerId, l.payeeId, l.amountCents]),
    [['employee-1', 'merchant-a', 800], ['employer-1', 'merchant-a', 500]],
  );
  await c.reconcile(p);
  assert.equal(p.state, 'completed');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test test/backend-port.test.ts`
Expected: FAIL. `src/backend.ts` does not exist.

- [ ] **Step 3: Create the port**

Create `src/backend.ts`:

```ts
// The seam between the coordinator and whatever settles money. MockBackend
// implements it here; the ECB adapter, kept outside this repository, will
// implement the same interface and tag its events ECB_API.

import type { Cents, Origin, SettlementMode } from './types.ts';

export interface LegRequest {
  payerId: string;
  // Usually the merchant; differs per leg in multi-payee purchases.
  payeeId: string;
  amountCents: Cents;
  // Payer fee on top of amountCents, paid to the payer's PSP. Zero in every fixture.
  feeCents: Cents;
  idempotencyKey: string;
}

export interface LegResponse {
  idempotencyKey: string;
  executionRef: string;
  status: 'settled' | 'rejected' | 'unknown';
  reason?: string;
}

export type ExecutionStatus = 'settled' | 'rejected' | 'unknown' | 'returned';

export interface SubmitRequest {
  // Application grouping of the legs of one purchase. Not proof of atomicity.
  groupRef: string;
  mode: SettlementMode;
  legs: LegRequest[];
}

export interface SettlementBackend {
  readonly name: string;
  // Evidence origin of this backend's events: LOCAL for the mock.
  readonly origin: Origin;
  // The semantics version this backend implements: the mock's assumption set,
  // or the ECB specification version for an adapter. Recorded with every run.
  readonly specVersion: string;
  submit(req: SubmitRequest): Promise<LegResponse[]>;
  // Authoritative status; resolves outcomes whose response was lost.
  status(executionRef: string): Promise<ExecutionStatus>;
  // Return a settled leg to its original payer, or report the operation unsupported.
  refund(executionRef: string): Promise<'returned' | 'unsupported'>;
}
```

- [ ] **Step 4: Make `MockBackend` implement the port**

`src/mock-backend.ts`:
- Delete the `LegRequest` and `LegResponse` interfaces. Import instead: `import type { ExecutionStatus, LegRequest, LegResponse, SettlementBackend, SubmitRequest } from './backend.ts';`
- `Execution`: rename `merchantId` to `payeeId` (comment: `// Who receives this leg.`) and type `status` as `ExecutionStatus`.
- Class header and identity fields:

```ts
export class MockBackend implements SettlementBackend {
  readonly name = 'mock-backend';
  readonly origin = 'LOCAL' as const;
  // Names the assumption set this mock encodes. Bump it when backend semantics
  // change, so recorded runs say which assumptions they ran against.
  readonly specVersion = 'mock-1';
```

- `settle`: replace `e.merchantId` with `e.payeeId`. The fee lines from Task 1 stay.
- `submit` becomes:

```ts
  async submit(req: SubmitRequest): Promise<LegResponse[]> {
    const { groupRef, mode, legs } = req;
```

  Keep the body unchanged, except that the execution is built with `payeeId: l.payeeId,` instead of `merchantId,`.
- `async status(executionRef: string): Promise<ExecutionStatus>` (body unchanged).
- `async refund(executionRef: string): Promise<'returned' | 'unsupported'>`. In the body, `this.debit(this.account(e.payeeId), e.amountCents);`.

- [ ] **Step 5: Make the coordinator async and inject the trace**

`src/coordinator.ts`:
- Replace `import type { LegResponse, MockBackend } from './mock-backend.ts';` with `import type { LegResponse, SettlementBackend } from './backend.ts';`
- Fields and constructor:

```ts
  private readonly backend: SettlementBackend;
  private readonly trace: Trace;
  readonly ledger: BenefitLedger;
  now: number;

  constructor(backend: SettlementBackend, trace: Trace, opts: CoordinatorOptions = {}) {
    this.backend = backend;
    this.trace = trace;
    this.now = opts.now ?? 0;
    this.ledger = opts.ledger ?? new BenefitLedger();
  }
```

- `async submit(p: Purchase, mode: SettlementMode): Promise<void>`. Its last line becomes `this.apply(p, await this.send(p, mode));`.
- `async resubmit(p: Purchase, mode: SettlementMode): Promise<void>`, with the same `await`.
- `send`:

```ts
  private send(p: Purchase, mode: SettlementMode): Promise<LegResponse[]> {
    return this.backend.submit({
      groupRef: p.purchaseId,
      mode,
      legs: p.legs.map((l) => ({
        payerId: l.payerId,
        payeeId: p.proposal.merchantId,
        amountCents: l.amountCents,
        feeCents: l.feeCents,
        idempotencyKey: l.idempotencyKey,
      })),
    });
  }
```

- `async reconcile(p: Purchase): Promise<void>`, with `const s = await this.backend.status(l.executionRef);`.
- `async recover(p: Purchase): Promise<void>`, with `await this.returnSettledLegs(p);`.
- `async refund(p: Purchase): Promise<void>`, with `await this.returnSettledLegs(p);`.
- `private async returnSettledLegs(p: Purchase): Promise<void>`, with `if ((await this.backend.refund(l.executionRef)) === 'unsupported') {`.

- [ ] **Step 6: Await in scenarios, CLI and tests**

`src/scenarios.ts`: build the coordinator with `new Coordinator(backend, trace, { now: 10 })`. Change the `Scenario` interface to `run: () => Promise<{ w: World; p: Purchase }>;`. Then:

```bash
sed -i -E 's/run: \(\) => \{/run: async () => {/; s/^(\s+)(w\.coordinator\.(submit|resubmit|reconcile|recover|refund)\()/\1await \2/' src/scenarios.ts
```

`src/cli.ts`: `const { w, p } = await s.run();`

Tests:

```bash
sed -i -E "s/, \(\) => \{$/, async () => {/; s/= run\(/= await run(/; s/= s\.run\(\)/= await s.run()/; s/^(\s+)(w\.coordinator\.(submit|resubmit|reconcile|recover|refund)\()/\1await \2/" test/scenarios.test.ts test/defects.test.ts
```

Then fix one line by hand in `test/scenarios.test.ts` (S07 stale-approval test). Replace `assert.throws(() => w.coordinator.submit(p, 'atomic'));` with `await assert.rejects(() => w.coordinator.submit(p, 'atomic'));`.

Check: `grep -nE "coordinator\.(submit|resubmit|reconcile|recover|refund)\(" src/scenarios.ts test/*.ts | grep -v await | grep -v rejects`. Expected: no output.

- [ ] **Step 7: Run all tests**

Run: `pnpm test` and `pnpm scenarios S01`
Expected: PASS, 29 tests. The S01 trace prints as before.

- [ ] **Step 8: Commit**

```bash
git add src/backend.ts src/mock-backend.ts src/coordinator.ts src/scenarios.ts src/cli.ts test/
git commit -m "Introduce the async SettlementBackend port" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Reusable backend contract suite

**Files:**
- Create: `test/contract/settlement-backend.contract.ts`
- Create: `test/mock-backend.contract.test.ts`
- Modify: `README.md` (new "Backend adapters" section)

**Interfaces:**
- Consumes: `SettlementBackend`, `SubmitRequest`, `LegRequest` (Task 6).
- Produces: `interface ContractFixture { backend; payeeId; payers: [string, string]; decline?; loseResponse?; disableRefunds? }` and `settlementBackendContract(name: string, make: () => ContractFixture): void`.

- [ ] **Step 1: Write the contract**

Create `test/contract/settlement-backend.contract.ts`. The name does not end in `.test.ts`, so the test glob does not run it directly:

```ts
// Behaviour every SettlementBackend must show for the coordinator's safety
// rules to hold. The mock runs it in test/mock-backend.contract.test.ts; the
// ECB adapter, kept outside this repository, imports this file and runs it
// against the test environment. A case whose fault control the fixture cannot
// provide is skipped and reads as 'not tested', never as a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LegRequest, SettlementBackend, SubmitRequest } from '../../src/backend.ts';
import type { SettlementMode } from '../../src/types.ts';

export interface ContractFixture {
  backend: SettlementBackend;
  payeeId: string;
  // Two payers, each able to fund EUR 10 on their own.
  payers: [string, string];
  decline?: (payerId: string) => void;
  loseResponse?: (payerId: string, outcome: 'settle' | 'reject') => void;
  disableRefunds?: () => void;
}

export function settlementBackendContract(name: string, make: () => ContractFixture): void {
  const caps = make();
  const needs = (control: 'decline' | 'loseResponse' | 'disableRefunds'): false | string =>
    caps[control] ? false : `fixture has no ${control} control`;
  let n = 0;
  const request = (f: ContractFixture, mode: SettlementMode): SubmitRequest => {
    n += 1;
    const legs: LegRequest[] = f.payers.map((payerId, i) => ({
      payerId,
      payeeId: f.payeeId,
      amountCents: 500 + 300 * i,
      feeCents: 0,
      idempotencyKey: `contract-${n}-${i}`,
    }));
    return { groupRef: `contract-group-${n}`, mode, legs };
  };
  const statuses = (rs: { status: string }[]): string[] => rs.map((r) => r.status);

  test(`${name}: an atomic group settles every leg`, async () => {
    const f = make();
    const res = await f.backend.submit(request(f, 'atomic'));
    assert.deepEqual(statuses(res), ['settled', 'settled']);
    for (const r of res) assert.equal(await f.backend.status(r.executionRef), 'settled');
  });

  test(`${name}: a retry with the same keys returns the original executions`, async () => {
    const f = make();
    const req = request(f, 'atomic');
    const first = await f.backend.submit(req);
    const again = await f.backend.submit(req);
    assert.deepEqual(again.map((r) => r.executionRef), first.map((r) => r.executionRef));
    assert.deepEqual(statuses(again), statuses(first));
  });

  test(`${name}: one declined leg rejects the whole atomic group`, { skip: needs('decline') }, async () => {
    const f = make();
    f.decline!(f.payers[1]);
    const res = await f.backend.submit(request(f, 'atomic'));
    assert.deepEqual(statuses(res), ['rejected', 'rejected']);
  });

  test(`${name}: independent legs settle or fail on their own`, { skip: needs('decline') }, async () => {
    const f = make();
    f.decline!(f.payers[1]);
    const res = await f.backend.submit(request(f, 'independent'));
    assert.deepEqual(statuses(res), ['settled', 'rejected']);
  });

  test(`${name}: a lost response stays unknown until a status query resolves it`, { skip: needs('loseResponse') }, async () => {
    const f = make();
    f.loseResponse!(f.payers[0], 'settle');
    const req = request(f, 'independent');
    const res = await f.backend.submit(req);
    assert.equal(res[0].status, 'unknown');
    const retry = await f.backend.submit(req);
    assert.equal(retry[0].executionRef, res[0].executionRef, 'a retry while unknown is deduplicated');
    assert.equal(await f.backend.status(res[0].executionRef), 'settled');
  });

  test(`${name}: a refund returns a settled leg and keeps the execution`, async () => {
    const f = make();
    const [leg] = await f.backend.submit(request(f, 'atomic'));
    assert.equal(await f.backend.refund(leg.executionRef), 'returned');
    assert.equal(await f.backend.status(leg.executionRef), 'returned');
  });

  test(`${name}: a rejected leg cannot be refunded`, { skip: needs('decline') }, async () => {
    const f = make();
    f.decline!(f.payers[0]);
    const [leg] = await f.backend.submit(request(f, 'independent'));
    await assert.rejects(() => f.backend.refund(leg.executionRef));
  });

  test(`${name}: a backend without returns says so instead of failing silently`, { skip: needs('disableRefunds') }, async () => {
    const f = make();
    f.disableRefunds!();
    const [leg] = await f.backend.submit(request(f, 'atomic'));
    assert.equal(await f.backend.refund(leg.executionRef), 'unsupported');
    assert.equal(await f.backend.status(leg.executionRef), 'settled');
  });
}
```

- [ ] **Step 2: Run the contract on the mock**

Create `test/mock-backend.contract.test.ts`:

```ts
import { settlementBackendContract } from './contract/settlement-backend.contract.ts';
import { world, EMPLOYEE, EMPLOYER, MERCHANT_A } from '../src/scenarios.ts';

settlementBackendContract('MockBackend', () => {
  const w = world();
  return {
    backend: w.backend,
    payeeId: MERCHANT_A,
    payers: [EMPLOYEE, EMPLOYER],
    decline: (id) => w.backend.faults.set(id, 'decline'),
    loseResponse: (id, outcome) => w.backend.faults.set(id, outcome === 'settle' ? 'timeout_then_settle' : 'timeout_then_reject'),
    disableRefunds: () => {
      w.backend.refundsSupported = false;
    },
  };
});
```

Run: `node --test test/mock-backend.contract.test.ts`
Expected: PASS, 8 tests, 0 skipped. If a case fails, the mock is wrong, not the contract. Stop and diagnose with superpowers:systematic-debugging.

- [ ] **Step 3: Check that skipping works**

Temporarily delete the `decline:` line from the fixture and run again. Expected: 3 skipped, each with the message `fixture has no decline control`. Restore the line.

- [ ] **Step 4: Document it**

`README.md`: add a section before "Limits and next steps":

```markdown
## Backend adapters

The coordinator reaches settlement only through `SettlementBackend` (`src/backend.ts`): `submit`, `status` and `refund`, all async. `MockBackend` implements it here. An ECB adapter implements the same interface in a separate private repository, tags its events `ECB_API`, and proves itself with the same contract suite the mock passes:

    import { settlementBackendContract } from '<path to this repo>/test/contract/settlement-backend.contract.ts';
    settlementBackendContract('ECB adapter', () => ({ backend, payeeId, payers, /* fault controls if the environment offers them */ }));

Cases that need a fault control the environment lacks are skipped and reported as `not tested`.
```

- [ ] **Step 5: Run all tests and commit**

Run: `pnpm test`
Expected: PASS, 37 tests.

```bash
git add test/contract/ test/mock-backend.contract.test.ts README.md
git commit -m "Add a reusable SettlementBackend contract suite" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase 3: Evidence

### Task 8: Run records, trace digest and `--json` export

**Files:**
- Create: `src/run-record.ts`
- Modify: `src/scenarios.ts` (add `FIXTURE_VERSION`), `src/cli.ts`, `README.md`
- Create: `test/run-record.test.ts`

**Interfaces:**
- Produces: `FIXTURE_VERSION: string` (in `src/scenarios.ts`), `traceDigest(events: TraceEvent[]): string` (16 hex chars), `interface RunRecord`, `recordRun(runId: string, scenarioId: string, w: World, p: Purchase): RunRecord`. CLI flags: `pnpm scenarios [filter] --json`.

- [ ] **Step 1: Write the failing tests**

Create `test/run-record.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, FIXTURE_VERSION } from '../src/scenarios.ts';
import { recordRun, traceDigest } from '../src/run-record.ts';

const byId = (id: string) => scenarios.find((s) => s.id.startsWith(id))!;

test('the same scenario gives the same trace digest on every run', async () => {
  const a = await byId('S01').run();
  const b = await byId('S01').run();
  assert.equal(traceDigest(a.w.trace.events), traceDigest(b.w.trace.events));
});

test('different scenarios give different digests', async () => {
  const a = await byId('S01').run();
  const b = await byId('S04').run();
  assert.notEqual(traceDigest(a.w.trace.events), traceDigest(b.w.trace.events));
});

test('a run record names its fixtures, backend and outcome', async () => {
  const { w, p } = await byId('S09').run();
  const r = recordRun('run-test', 'S09-timeout-unknown', w, p);
  assert.equal(r.fixtureVersion, FIXTURE_VERSION);
  assert.deepEqual(r.backend, { name: 'mock-backend', origin: 'LOCAL', specVersion: 'mock-1' });
  assert.equal(r.result.state, 'completed');
  assert.match(r.traceDigest, /^[0-9a-f]{16}$/);
  assert.equal(r.events.length, w.trace.events.length);
});

test('no local run records an ECB_API event', async () => {
  for (const s of scenarios) {
    const { w } = await s.run();
    assert.ok(w.trace.events.every((e) => e.origin === 'LOCAL'), s.id);
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/run-record.test.ts`
Expected: FAIL. `src/run-record.ts` does not exist.

- [ ] **Step 3: Implement**

`src/scenarios.ts`: add below the account id constants:

```ts
// Bump whenever a fixture value below changes, so recorded runs say which
// fixtures produced them.
export const FIXTURE_VERSION = '2026.10-1';
```

Create `src/run-record.ts`:

```ts
// One scenario run as retained evidence: run identifier, fixture version,
// backend identity and specification version, outcome, and the full trace.
// docs/experiment-protocol.md requires all of these for every result.

import { createHash } from 'node:crypto';
import { FIXTURE_VERSION } from './scenarios.ts';
import type { World } from './scenarios.ts';
import type { Cents, Origin, Purchase, TraceEvent } from './types.ts';

export interface RunRecord {
  runId: string;
  scenarioId: string;
  fixtureVersion: string;
  backend: { name: string; origin: Origin; specVersion: string };
  result: { state: Purchase['state']; reason?: string; returnStatus: Purchase['returnStatus']; outstandingCents: Cents };
  traceDigest: string;
  events: TraceEvent[];
}

// SHA-256 over the event list, first 16 hex characters. The same fixtures and
// code give the same digest, so a reader can check a run was reproduced.
export function traceDigest(events: TraceEvent[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex').slice(0, 16);
}

export function recordRun(runId: string, scenarioId: string, w: World, p: Purchase): RunRecord {
  return {
    runId,
    scenarioId,
    fixtureVersion: FIXTURE_VERSION,
    backend: { name: w.backend.name, origin: w.backend.origin, specVersion: w.backend.specVersion },
    result: {
      state: p.state,
      reason: p.reason,
      returnStatus: p.returnStatus,
      outstandingCents: w.coordinator.outstandingCents(p),
    },
    traceDigest: traceDigest(w.trace.events),
    events: w.trace.events,
  };
}
```

Replace `src/cli.ts` with:

```ts
// Run every scenario (or those whose id contains the filter argument).
//   pnpm scenarios [filter]          trace and final balances
//   pnpm scenarios [filter] --json   one run record per scenario, as JSON

import { scenarios, EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_C } from './scenarios.ts';
import { recordRun, traceDigest } from './run-record.ts';
import type { RunRecord } from './run-record.ts';
import { euro } from './trace.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
// Substring match on the scenario id: 'S03' runs one, 'S0' runs nine.
const filter = args.find((a) => !a.startsWith('--')) ?? '';
const selected = scenarios.filter((x) => x.id.includes(filter));
// One identifier for the whole invocation; each record also names its scenario.
const runId = `run-${new Date().toISOString().replace(/[-:.]/g, '')}`;

if (flags.has('--json')) {
  const records: RunRecord[] = [];
  for (const s of selected) {
    const { w, p } = await s.run();
    records.push(recordRun(runId, s.id, w, p));
  }
  console.log(JSON.stringify(records, null, 2));
} else {
  for (const s of selected) {
    const { w, p } = await s.run();
    console.log(`\n=== ${s.id}: ${s.title}`);
    console.log(w.trace.format());
    // Summary line: derived state, return status and money still committed,
    // then the balance of every relevant account, holdings and linked bank.
    const outstanding = w.coordinator.outstandingCents(p);
    console.log(
      `--> state=${p.state}${p.reason ? ` (${p.reason})` : ''} returns=${p.returnStatus} outstanding=${euro(outstanding)}`,
    );
    console.log(`    ${runId} trace ${traceDigest(w.trace.events)}`);
    for (const id of [EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_C]) {
      const a = w.backend.account(id);
      console.log(`    ${id.padEnd(11)} digital euro ${euro(a.deCents).padStart(12)}   linked bank ${euro(a.linkedBankCents).padStart(12)}`);
    }
  }
}
```

`README.md`, Run block: add `pnpm scenarios --json > runs.json   # run records: run id, fixture and spec version, trace digest, events`.

- [ ] **Step 4: Run all tests and the CLI**

Run: `pnpm test`, then `pnpm scenarios S01 --json | head -20`
Expected: PASS, 41 tests. The JSON array starts with `"runId": "run-...`.

- [ ] **Step 5: Commit**

```bash
git add src/run-record.ts src/scenarios.ts src/cli.ts test/run-record.test.ts README.md
git commit -m "Record runs with fixture version, spec version and trace digest" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Findings table generated from runs

**Files:**
- Modify: `src/scenarios.ts` (Scenario metadata: `question`, `responsibility`, `check`)
- Create: `src/findings.ts`, `test/findings.test.ts`
- Modify: `src/cli.ts`, `package.json`, `README.md`

**Interfaces:**
- Consumes: `recordRun` (Task 8).
- Produces: `QUESTIONS` and `QuestionId` (`'Q1' | 'Q2' | 'Q3'`), `Scenario.question: QuestionId`, `Scenario.responsibility: string` (must not contain `|`), `Scenario.check(r: { w: World; p: Purchase }): string | undefined`, `expectState(p, state)`, `findingsTable(runId: string): Promise<string>`, script `pnpm findings`.

- [ ] **Step 1: Write the failing tests**

Create `test/findings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../src/scenarios.ts';
import { findingsTable } from '../src/findings.ts';

test('every scenario shows its expected observation locally', async () => {
  for (const s of scenarios) assert.equal(s.check(await s.run()), undefined, s.id);
});

test('the findings table never claims an ECB result from a local run', async () => {
  const table = await findingsTable('run-test');
  const rows = table.split('\n').filter((l) => l.startsWith('| S'));
  assert.equal(rows.length, scenarios.length);
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    assert.match(cells[3], /^observed\/pass/, cells[1]);
    assert.equal(cells[4], 'not tested', cells[1]);
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/findings.test.ts`
Expected: FAIL. `src/findings.ts` does not exist.

- [ ] **Step 3: Add the scenario metadata**

`src/scenarios.ts`: extend the types import with `PurchaseState`, then replace the `Scenario` interface with:

```ts
// The research questions of docs/experiment-protocol.md.
export const QUESTIONS = {
  Q1: 'Unambiguous completion state',
  Q2: 'One contribution fails, expires or loses authority',
  Q3: 'References for reconciliation and returns',
} as const;
export type QuestionId = keyof typeof QUESTIONS;

// Each run() builds a fresh world, drives one purchase through its success or
// failure path, and returns both so the CLI can print the trace and tests can
// assert on final balances. check() states the observation the scenario must
// show; the findings table reports it as observed/pass or observed/fail.
export interface Scenario {
  id: string;
  title: string;
  question: QuestionId;
  // What application code had to do, as shown by the local run.
  responsibility: string;
  check: (r: { w: World; p: Purchase }) => string | undefined;
  run: () => Promise<{ w: World; p: Purchase }>;
}

export const expectState = (p: Purchase, state: PurchaseState): string | undefined =>
  p.state === state ? undefined : `state ${p.state}, expected ${state}`;
const stateHistory = (w: World): unknown[] => w.trace.events.filter((e) => e.event === 'state').map((e) => e.detail?.to);
```

Add these three properties to each scenario object, after `title`:

```ts
// S01
    question: 'Q1',
    responsibility: 'Bind the approval to the proposal version; derive completion only from every leg settled',
    check: ({ p }) => expectState(p, 'completed'),
// S02
    question: 'Q1',
    responsibility: 'None beyond S01: the reverse waterfall is a backend funding feature',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (w.trace.events.some((e) => e.event === 'reverse_waterfall' && e.detail?.account === EMPLOYEE) ? undefined : 'no reverse waterfall'),
// S03
    question: 'Q2',
    responsibility: 'Detect partial success, keep the EUR 5 outstanding visible, return it to the employer before cancelling',
    check: ({ w, p }) => expectState(p, 'cancelled') ?? (stateHistory(w).includes('recovery_required') ? undefined : 'never entered recovery'),
// S04
    question: 'Q2',
    responsibility: 'None: atomic settlement leaves nothing committed to recover',
    check: ({ w, p }) => expectState(p, 'failed') ?? (w.coordinator.outstandingCents(p) === 0 ? undefined : 'money outstanding'),
// S05
    question: 'Q2',
    responsibility: 'Keep the purchase in recovery with the outstanding amount visible when no return operation exists',
    check: ({ w, p }) => expectState(p, 'recovery_required') ?? (w.coordinator.outstandingCents(p) === 500 ? undefined : 'outstanding is not EUR 5'),
// S06
    question: 'Q2',
    responsibility: 'Recheck employer authority at initiation and stop without raising the employee share',
    check: ({ w, p }) =>
      expectState(p, 'failed') ??
      (w.backend.executionCount() === 0 && p.proposal.employeeCents === 800 ? undefined : 'executed or share changed'),
// S07
    question: 'Q2',
    responsibility: 'Version proposals, invalidate approvals on any change, require renewed approval',
    check: ({ p }) => expectState(p, 'completed') ?? (p.proposal.version === 3 ? undefined : `version ${p.proposal.version}`),
// S08
    question: 'Q3',
    responsibility: 'Keep idempotency keys stable across retries; never mint new keys to retry',
    check: ({ w, p }) => expectState(p, 'completed') ?? (w.backend.executionCount() === 2 ? undefined : 'duplicate execution'),
// S09
    question: 'Q3',
    responsibility: 'Treat a lost response as pending; resolve it only through status queries',
    check: ({ w, p }) => expectState(p, 'completed') ?? (stateHistory(w)[0] === 'pending' ? undefined : 'not pending first'),
// S10
    question: 'Q3',
    responsibility: 'Keep one execution reference per contribution to return each share to its own payer',
    check: ({ p }) => (p.returnStatus === 'completed' ? undefined : `returns ${p.returnStatus}`),
// S11
    question: 'Q2',
    responsibility: 'Track benefit use per mandate and day; leave the decision to pay more with the employee',
    check: ({ p }) => expectState(p, 'draft') ?? (p.proposal.employerCents === 0 ? undefined : 'employer still contributes'),
// S12
    question: 'Q2',
    responsibility: 'Never re-split a declined employer share onto the employee',
    check: ({ w, p }) => expectState(p, 'failed') ?? (w.backend.account(EMPLOYEE).deCents === 2_000 ? undefined : 'employee charged'),
```

- [ ] **Step 4: Generate the table**

Create `src/findings.ts`:

```ts
// The findings table of docs/experiment-protocol.md, generated from actual
// runs. Local results only ever fill the local column; the ECB column stays
// 'not tested' until an adapter run records ECB_API evidence.

import { scenarios, QUESTIONS, FIXTURE_VERSION } from './scenarios.ts';
import { recordRun } from './run-record.ts';

const HEADER = [
  '| Scenario | Question | Local mock | ECB test environment | Run reference | Application responsibility | Infrastructure gap | Limitation |',
  '|---|---|---|---|---|---|---|---|',
];

export async function findingsTable(runId: string): Promise<string> {
  const rows = [...HEADER];
  for (const s of scenarios) {
    const result = await s.run();
    const problem = s.check(result);
    const r = recordRun(runId, s.id, result.w, result.p);
    const local = `${problem ? `observed/fail (${problem})` : 'observed/pass'}, ${r.backend.name} ${r.backend.specVersion}`;
    rows.push(
      `| ${s.id} | ${s.question} ${QUESTIONS[s.question]} | ${local} | not tested | ${r.runId} ${r.traceDigest} | ${s.responsibility} | unknown until tested | Local mock semantics are assumptions |`,
    );
  }
  return `Findings ${runId}, fixtures ${FIXTURE_VERSION}\n\n${rows.join('\n')}`;
}
```

`src/cli.ts`:
- Add `import { findingsTable } from './findings.ts';`
- Add `//   pnpm findings                    findings table (Markdown)` to the header comment.
- Make the top of the `if` chain:

```ts
if (flags.has('--findings')) {
  console.log(await findingsTable(runId));
} else if (flags.has('--json')) {
```

`package.json` scripts: add `"findings": "node src/cli.ts --findings"`.
`README.md` Run block: add `pnpm findings          # findings table from fresh runs (ECB column: not tested)`.

- [ ] **Step 5: Run all tests and the command**

Run: `pnpm test`, then `pnpm findings`
Expected: PASS, 43 tests. The table has 12 rows, all `observed/pass` and `not tested`.

- [ ] **Step 6: Commit**

```bash
git add src/scenarios.ts src/findings.ts src/cli.ts package.json test/findings.test.ts README.md
git commit -m "Generate the findings table from scenario runs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase 4: Generalised model and use cases

### Task 10: Shares and per-payer approvals (refactor, no behaviour change)

**Files:**
- Modify: `src/types.ts` (Share, Proposal, PayerApproval, BenefitTerms, Purchase, Leg)
- Rewrite: `src/coordinator.ts` (full listing below)
- Modify: `src/scenarios.ts` (`approveAs`), every test file that calls `approveCurrent` or reads `employeeCents`/`employerCents`
- Create: `test/shares.test.ts`

**Interfaces:**
- Produces:

```ts
export type AuthorityKind = 'approval' | 'mandate';
export interface Share { role: string; payerId: string; payeeId: string; amountCents: Cents; feeCents: Cents; authority: AuthorityKind }
export interface Proposal { version: number; merchantId: string; totalCents: Cents; shares: Share[]; expiresAt: number }
export interface PayerApproval { approvalRef: string; purchaseId: string; payerId: string; proposalVersion: number; merchantId: string; totalCents: Cents; amountCents: Cents; feeCents: Cents; expiresAt: number }
export interface BenefitTerms { employeeId: string; employeeMaxCents: Cents; employeeFeeCents: Cents; mandate: EmployerMandate }
export interface Purchase { purchaseId; state; reason?; benefit?: BenefitTerms; proposal: Proposal; approvals: PayerApproval[]; legs: Leg[]; returnStatus }
// Leg gains payeeId: string; Leg.leg is the share's role (string)
```

  - In `src/coordinator.ts`: `shareCents(q: Proposal, role: string): Cents`, `approvalCents(q: Proposal, payerId: string): Cents`, `approvalFeeCents(q: Proposal, payerId: string): Cents`, and `approve(p: Purchase, a: PayerApproval): void`. `approveCurrent` is removed.
  - In `src/scenarios.ts`: `approveAs(w: Pick<World, 'coordinator'>, p: Purchase, payerId = EMPLOYEE): PayerApproval`.
  - Removed: `EmployeeApproval`, `LegName`, `Proposal.employeeCents/employerCents`, `Purchase.employeeId/employeeMaxCents/mandate/approval`.

- [ ] **Step 1: Write the failing tests**

Create `test/shares.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, lunch, approveAs, EMPLOYER } from '../src/scenarios.ts';
import { shareCents } from '../src/coordinator.ts';

test('a zero employee share still needs the employee\'s approval', async () => {
  const w = world();
  const p = lunch(w, 400);
  assert.equal(shareCents(p.proposal, 'employee'), 0);
  assert.equal(p.state, 'awaiting_approvals');
  await assert.rejects(() => w.coordinator.submit(p, 'atomic'), /cannot submit/);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
  assert.deepEqual(p.legs.map((l) => [l.leg, l.amountCents]), [['employer', 400]]);
});

test('an approval from a payer with no approval share is rejected', () => {
  const w = world();
  const p = lunch(w);
  // The employer pays under its mandate, not by approving; a stranger has no share.
  assert.throws(() => approveAs(w, p, EMPLOYER), /does not match/);
  assert.throws(() => approveAs(w, p, 'stranger-1'), /does not match/);
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.approvals.length, 0);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/shares.test.ts`
Expected: FAIL. `approveAs` and `shareCents` are not exported.

- [ ] **Step 3: Update the types**

`src/types.ts`:
- Delete `export type LegName = ...` and its comment.
- Replace `Proposal`, `EmployeeApproval` and `Purchase`, and edit `Leg`, as follows (delete the Task 1 `feesCents` comment above `Proposal`: fees now live on each share):

```ts
// 'approval': the payer approves this exact share. 'mandate': funded under a
// standing, bounded authority that is rechecked at initiation.
export type AuthorityKind = 'approval' | 'mandate';

// One payer's part of a proposal.
export interface Share {
  // Unique within the proposal: 'employee', 'employer', 'diner-1', ...
  role: string;
  payerId: string;
  // Usually the merchant; differs in multi-payee purchases.
  payeeId: string;
  amountCents: Cents;
  // Payer fee on top of amountCents, paid to the payer's PSP; zero in every fixture.
  feeCents: Cents;
  authority: AuthorityKind;
}

// The current offer and how it is funded. The version bumps on every change
// and is what approvals bind to, so a changed offer can never be executed
// under a stale approval.
export interface Proposal {
  version: number;
  // Merchant of record: eligibility and display.
  merchantId: string;
  totalCents: Cents;
  shares: Share[];
  // Both the offer and any approval of it die here (coordinator clock).
  expiresAt: number;
}

// One payer's approval, bound to one proposal version and its exact terms:
// every field is part of the binding checked in approve().
export interface PayerApproval {
  approvalRef: string;
  purchaseId: string;
  payerId: string;
  proposalVersion: number;
  merchantId: string;
  totalCents: Cents;
  // The payer's own amount: the sum of their approval-backed shares. It must
  // never silently grow when another contribution fails or shrinks.
  amountCents: Cents;
  // The payer's own fee, bound like the amount.
  feeCents: Cents;
  // May be earlier than the proposal's expiry, never later.
  expiresAt: number;
}

// Present on employer-benefit purchases only.
export interface BenefitTerms {
  employeeId: string;
  // The employee's standing instruction: the most they will personally pay.
  // A person sets it, deterministic code enforces it; no AI may raise it.
  employeeMaxCents: Cents;
  // Fee the employee pays their PSP on top of their share (zero in fixtures).
  employeeFeeCents: Cents;
  mandate: EmployerMandate;
}

export interface Purchase {
  purchaseId: string;
  // Derived, never asserted: recomputed from leg statuses after every backend
  // interaction (see Coordinator.derive).
  state: PurchaseState;
  // Why the purchase sits in 'draft' or 'failed', for display.
  reason?: string;
  benefit?: BenefitTerms;
  proposal: Proposal;
  // Approvals that still bind the current proposal version, one per payer.
  approvals: PayerApproval[];
  legs: Leg[];
  returnStatus: ReturnStatus;
}
```

In `Leg`: change `leg: LegName;` to

```ts
  // The share's role this leg pays for.
  leg: string;
```

and add after `payerId: string;`:

```ts
  payeeId: string;
```

Update the `Leg` comment's last sentence to: `Which authority paid for it is recorded in authorityRef (the payer's approvalRef, or the employer's mandateRef), so every euro traces back to a specific grant of authority.`

- [ ] **Step 4: Rewrite the coordinator**

Replace `src/coordinator.ts` with:

```ts
// Deterministic multi-payer coordinator. It records each payer's authority
// (an approval of one exact proposal, or an employer mandate for a bounded
// contribution), submits contributions, and derives the purchase state only
// from authoritative backend status. It never retries with new keys, never
// shifts a failed share onto another payer, and never reports completion
// from a partial result.

import type { BenefitTerms, Cents, EmployerMandate, Leg, PayerApproval, Proposal, Purchase, PurchaseState, SettlementMode, Share } from './types.ts';
import type { BenefitResult } from './policy.ts';
import { evaluateBenefit } from './policy.ts';
import { BenefitLedger, dayOf } from './ledger.ts';
import type { LegResponse, SettlementBackend } from './backend.ts';
import type { Trace } from './trace.ts';

export interface ProposeInput {
  purchaseId: string;
  employeeId: string;
  // The employee's standing instruction: the most they will personally pay.
  employeeMaxCents: Cents;
  merchantId: string;
  totalCents: Cents;
  // Payer fee the employee pays their PSP on top of their share; zero for
  // basic digital euro payments.
  feesCents?: Cents;
  mandate: EmployerMandate;
  expiresAt: number;
}

export interface CoordinatorOptions {
  now?: number;
  ledger?: BenefitLedger;
}

// Cents one role holds in a proposal.
export const shareCents = (q: Proposal, role: string): Cents =>
  q.shares.filter((s) => s.role === role).reduce((t, s) => t + s.amountCents, 0);

// What one payer approves: the sum of their approval-backed shares.
export const approvalCents = (q: Proposal, payerId: string): Cents =>
  q.shares.filter((s) => s.payerId === payerId && s.authority === 'approval').reduce((t, s) => t + s.amountCents, 0);

// The fees that payer approves alongside their amount.
export const approvalFeeCents = (q: Proposal, payerId: string): Cents =>
  q.shares.filter((s) => s.payerId === payerId && s.authority === 'approval').reduce((t, s) => t + s.feeCents, 0);

// Payers whose approval the proposal needs, once each, in share order.
const approvers = (q: Proposal): string[] => [
  ...new Set(q.shares.filter((s) => s.authority === 'approval').map((s) => s.payerId)),
];

// Terms can change, and the purchase can be cancelled, only before submission.
const OPEN: PurchaseState[] = ['draft', 'awaiting_approvals', 'ready'];

export class Coordinator {
  private readonly backend: SettlementBackend;
  private readonly trace: Trace;
  // Shared across purchases: the per-mandate record of benefit already drawn.
  readonly ledger: BenefitLedger;
  now: number;

  constructor(backend: SettlementBackend, trace: Trace, opts: CoordinatorOptions = {}) {
    this.backend = backend;
    this.trace = trace;
    this.now = opts.now ?? 0;
    this.ledger = opts.ledger ?? new BenefitLedger();
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.trace.add('LOCAL', 'coordinator', event, detail);
  }

  // An employer-benefit purchase: the policy splits the total between the
  // employee and the employer's mandate.
  propose(input: ProposeInput): Purchase {
    const p: Purchase = {
      purchaseId: input.purchaseId,
      state: 'draft',
      benefit: { employeeId: input.employeeId, employeeMaxCents: input.employeeMaxCents, employeeFeeCents: input.feesCents ?? 0, mandate: input.mandate },
      proposal: { version: 0, merchantId: input.merchantId, totalCents: input.totalCents, shares: [], expiresAt: input.expiresAt },
      approvals: [],
      legs: [],
      returnStatus: 'none',
    };
    // The first reprice turns the skeleton into proposal version 1: the
    // version counter, not object identity, is what approvals bind to.
    this.reprice(p, input.merchantId, input.totalCents, input.expiresAt);
    return p;
  }

  private benefitTerms(p: Purchase): BenefitTerms {
    if (!p.benefit) throw new Error('split purchases cannot be repriced; propose again');
    return p.benefit;
  }

  // Deterministic split as of now, counting benefit other purchases already
  // hold today. Used at proposal time and again at initiation.
  private benefitNow(p: Purchase, merchantId: string, totalCents: Cents): BenefitResult {
    const t = this.benefitTerms(p);
    return evaluateBenefit({
      totalCents,
      merchantId,
      beneficiaryId: t.employeeId,
      mandate: t.mandate,
      now: this.now,
      usedToday: this.ledger.usage(t.mandate.mandateRef, dayOf(this.now), p.purchaseId),
      employeeMaxCents: t.employeeMaxCents,
      employeeFeeCents: t.employeeFeeCents,
    });
  }

  // Bumps the proposal version and invalidates every earlier approval.
  private reprice(p: Purchase, merchantId: string, totalCents: Cents, expiresAt: number): void {
    const t = this.benefitTerms(p);
    const b = this.benefitNow(p, merchantId, totalCents);
    // The employee share is listed even at zero: the employee still approves
    // the purchase. Zero shares never become legs.
    const shares: Share[] = [
      { role: 'employee', payerId: t.employeeId, payeeId: merchantId, amountCents: b.employeeCents, feeCents: t.employeeFeeCents, authority: 'approval' },
      { role: 'employer', payerId: t.mandate.employerId, payeeId: merchantId, amountCents: b.employerCents, feeCents: 0, authority: 'mandate' },
    ];
    p.proposal = { version: p.proposal.version + 1, merchantId, totalCents, shares, expiresAt };
    // Approvals bind to the old version's exact terms, so none can authorise
    // this new offer.
    for (const a of p.approvals) this.log('approval_invalidated', { approvalRef: a.approvalRef });
    p.approvals = [];
    // A share above the employee's instruction keeps the purchase in draft
    // rather than charging them more than they allowed.
    if (b.withinInstruction) {
      p.state = 'awaiting_approvals';
      p.reason = undefined;
    } else {
      p.state = 'draft';
      p.reason = 'employee_share_exceeds_instruction';
    }
    this.log('proposal', {
      version: p.proposal.version,
      merchantId,
      totalCents,
      shares: shares.map((s) => `${s.role}:${s.amountCents}`),
      ineligibleReason: b.ineligibleReason,
      state: p.state,
    });
  }

  // The offer changed before submission (expired, new price, new merchant).
  changeOffer(p: Purchase, offer: { merchantId: string; totalCents: Cents; expiresAt: number }): void {
    // Terms are locked once money may have moved; after submission the only
    // paths are reconcile, recover or refund.
    if (!OPEN.includes(p.state)) throw new Error(`cannot change offer in state ${p.state}; reconcile or recover first`);
    this.reprice(p, offer.merchantId, offer.totalCents, offer.expiresAt);
  }

  // The employee raises their own limit. This is a new instruction, not an AI decision.
  reviseInstruction(p: Purchase, employeeMaxCents: Cents): void {
    if (!OPEN.includes(p.state)) throw new Error(`cannot revise instruction in state ${p.state}`);
    this.benefitTerms(p).employeeMaxCents = employeeMaxCents;
    this.reprice(p, p.proposal.merchantId, p.proposal.totalCents, p.proposal.expiresAt);
  }

  approve(p: Purchase, a: PayerApproval): void {
    const q = p.proposal;
    // The approval must come from a payer with an approval share and echo
    // every term of the current proposal. A stale approval, bound to an
    // earlier version, fails the version comparison and is rejected here
    // rather than silently applied to changed terms.
    const binds =
      approvers(q).includes(a.payerId) &&
      a.purchaseId === p.purchaseId &&
      a.proposalVersion === q.version &&
      a.merchantId === q.merchantId &&
      a.totalCents === q.totalCents &&
      a.amountCents === approvalCents(q, a.payerId) &&
      a.feeCents === approvalFeeCents(q, a.payerId) &&
      // An approval may expire before the offer does, never after it.
      a.expiresAt <= q.expiresAt;
    const live = this.now <= a.expiresAt;
    if (p.state !== 'awaiting_approvals' || !binds || !live) {
      this.log('approval_rejected', { approvalRef: a.approvalRef, payerId: a.payerId, state: p.state });
      throw new Error('approval does not match the current proposal');
    }
    // A payer may approve again; the newer approval replaces theirs.
    p.approvals = [...p.approvals.filter((x) => x.payerId !== a.payerId), a];
    this.log('approval_recorded', { approvalRef: a.approvalRef, payerId: a.payerId, version: q.version });
    if (approvers(q).every((id) => p.approvals.some((x) => x.payerId === id))) p.state = 'ready';
  }

  async submit(p: Purchase, mode: SettlementMode): Promise<void> {
    if (p.state !== 'ready') throw new Error(`cannot submit in state ${p.state}`);
    const q = p.proposal;

    // Expiry is rechecked at initiation, not only when the approval was
    // recorded: authority is evaluated at the moment money would move.
    const expired = p.approvals.find((a) => this.now > a.expiresAt);
    if (expired) {
      this.fail(p, `approval_expired:${expired.payerId}`);
      return;
    }
    // Recheck employer authority at initiation: validity, revocation,
    // beneficiary, merchant and both caps, against today's usage. If the
    // employer can no longer fund its full approved share, stop: the gap must
    // never move onto the employee.
    const employerCents = shareCents(q, 'employer');
    if (p.benefit && employerCents > 0) {
      const b = this.benefitNow(p, q.merchantId, q.totalCents);
      if (b.employerCents < employerCents) {
        this.fail(p, `employer_authority_invalid:${b.ineligibleReason ?? 'cap_exceeded'}`);
        return;
      }
    }

    // Only shares with something to pay (amount or fee) become legs; each
    // carries the reference of the authority that funds it.
    p.legs = q.shares.filter((s) => s.amountCents + s.feeCents > 0).map((s) => this.leg(p, s));
    // The legs must add up to exactly what the merchant was promised.
    const sum = p.legs.reduce((s, l) => s + l.amountCents, 0);
    if (sum !== q.totalCents) throw new Error('contributions do not reconcile to merchant total');

    // Hold the employer's benefit before any money moves, so a concurrent
    // purchase cannot draw the same benefit.
    if (p.benefit && employerCents > 0) {
      const ref = p.benefit.mandate.mandateRef;
      this.ledger.reserve(p.purchaseId, ref, dayOf(this.now), employerCents);
      this.log('benefit_reserved', { mandateRef: ref, cents: employerCents });
    }

    this.log('submit', { mode, legs: p.legs.map((l) => `${l.leg}:${l.amountCents}`) });
    this.apply(p, await this.send(p, mode));
  }

  // Simulates a network retry of the same submission (same idempotency keys).
  async resubmit(p: Purchase, mode: SettlementMode): Promise<void> {
    if (p.legs.length === 0) throw new Error('nothing to resubmit');
    this.log('resubmit_same_keys');
    this.apply(p, await this.send(p, mode));
  }

  private send(p: Purchase, mode: SettlementMode): Promise<LegResponse[]> {
    return this.backend.submit({
      groupRef: p.purchaseId,
      mode,
      legs: p.legs.map((l) => ({ payerId: l.payerId, payeeId: l.payeeId, amountCents: l.amountCents, feeCents: l.feeCents, idempotencyKey: l.idempotencyKey })),
    });
  }

  private authorityRef(p: Purchase, s: Share): string {
    if (s.authority === 'mandate') return this.benefitTerms(p).mandate.mandateRef;
    return p.approvals.find((a) => a.payerId === s.payerId)!.approvalRef;
  }

  private leg(p: Purchase, s: Share): Leg {
    return {
      leg: s.role,
      payerId: s.payerId,
      payeeId: s.payeeId,
      amountCents: s.amountCents,
      feeCents: s.feeCents,
      authorityRef: this.authorityRef(p, s),
      // Keyed by purchase, proposal version and role: a retry of the same
      // submission reuses the key and is deduped by the backend, while a
      // changed proposal produces new keys only after renewed approval. The
      // coordinator never mints a fresh key just to retry.
      idempotencyKey: `${p.purchaseId}:v${p.proposal.version}:${s.role}`,
      status: 'planned',
    };
  }

  private apply(p: Purchase, responses: LegResponse[]): void {
    for (const r of responses) {
      const l = p.legs.find((x) => x.idempotencyKey === r.idempotencyKey)!;
      // A leg already returned keeps that record: a late duplicate response
      // must not overwrite the return with the original settlement.
      if (l.status === 'returned') continue;
      // executionRef is kept for later status queries and returns.
      l.executionRef = r.executionRef;
      l.status = r.status;
      l.rejectReason = r.reason;
    }
    this.derive(p);
  }

  // Ask the backend for authoritative status of every unresolved leg. Only
  // 'unknown' legs are queried (settled and rejected are final) and the
  // backend's answer is taken as truth.
  async reconcile(p: Purchase): Promise<void> {
    for (const l of p.legs) {
      if (l.status === 'unknown' && l.executionRef) l.status = await this.backend.status(l.executionRef);
    }
    this.log('reconciled', { legs: p.legs.map((l) => `${l.leg}:${l.status}`) });
    this.derive(p);
  }

  // The purchase state is derived from leg statuses alone. It cannot be
  // asserted by a caller, and there is no path to 'completed' that skips a leg.
  //   any unknown                → pending (a timeout is not a failure)
  //   all settled                → completed
  //   all rejected               → failed (nothing committed, nothing to undo)
  //   some settled, some not     → recovery_required (committed money visible)
  //   only rejected and returned → cancelled (every obligation resolved)
  private derive(p: Purchase): void {
    const st = p.legs.map((l) => l.status);
    const before = p.state;
    if (st.some((s) => s === 'unknown')) p.state = 'pending';
    else if (st.every((s) => s === 'settled')) p.state = 'completed';
    else if (st.every((s) => s === 'rejected')) p.state = 'failed';
    else if (st.some((s) => s === 'settled')) p.state = 'recovery_required';
    else if (st.every((s) => s === 'rejected' || s === 'returned')) p.state = 'cancelled';
    // The benefit is used once the purchase completes and handed back once
    // nothing is committed; pending and recovering purchases keep it reserved.
    if (p.state === 'completed') this.ledger.consume(p.purchaseId);
    else if (p.state === 'failed' || p.state === 'cancelled') this.ledger.release(p.purchaseId);
    // Log every transition, and keep re-logging the outstanding amount while
    // in recovery so money at risk stays visible in the trace.
    if (p.state !== before || p.state === 'recovery_required') {
      this.log('state', { from: before, to: p.state, outstandingCents: this.outstandingCents(p) });
    }
  }

  // Money committed by a payer that is neither part of a completed purchase nor returned.
  outstandingCents(p: Purchase): Cents {
    if (p.state === 'completed') return 0;
    return p.legs.filter((l) => l.status === 'settled').reduce((s, l) => s + l.amountCents, 0);
  }

  // Return every settled leg of an incomplete purchase to its original payer.
  // This is the only way out of 'recovery_required': never a speculative
  // second payment, and never shifting the failed share onto another payer.
  async recover(p: Purchase): Promise<void> {
    if (p.state !== 'recovery_required') throw new Error(`nothing to recover in state ${p.state}`);
    await this.returnSettledLegs(p);
    // A backend without returns is a finding, not a dead end: the purchase
    // stays 'recovery_required' and the outstanding amount stays visible.
    if (p.returnStatus === 'unsupported') {
      this.log('recovery_unsupported', { outstandingCents: this.outstandingCents(p) });
      return;
    }
    this.derive(p);
  }

  // Full refund after completion, each share back to whoever paid it. The
  // purchase stays 'completed'; the return is recorded separately in
  // returnStatus and the legs' 'returned' status.
  async refund(p: Purchase): Promise<void> {
    if (p.state !== 'completed') throw new Error(`cannot refund in state ${p.state}`);
    await this.returnSettledLegs(p);
    if (p.returnStatus === 'completed') {
      // A returned purchase gives the benefit back.
      this.ledger.release(p.purchaseId);
      this.log('refund_completed', { legs: p.legs.map((l) => `${l.leg}:${l.status}`) });
    }
  }

  private async returnSettledLegs(p: Purchase): Promise<void> {
    for (const l of p.legs) {
      if (l.status !== 'settled' || !l.executionRef) continue;
      // Bail on the first unsupported return: legs already returned keep their
      // 'returned' status, so the operation is safe to attempt again.
      if ((await this.backend.refund(l.executionRef)) === 'unsupported') {
        p.returnStatus = 'unsupported';
        return;
      }
      l.status = 'returned';
    }
    p.returnStatus = 'completed';
  }

  cancel(p: Purchase): void {
    // Cancellation is only meaningful before money moves; afterwards the path
    // is reconcile, then recover (or refund after completion).
    if (!OPEN.includes(p.state)) throw new Error(`cannot cancel in state ${p.state}; reconcile, recover or refund instead`);
    p.state = 'cancelled';
    this.log('cancelled_before_submission');
  }

  // Terminal failure before submission: nothing was committed, so there is
  // nothing to recover. The shares are logged to show none of them grew.
  private fail(p: Purchase, reason: string): void {
    p.state = 'failed';
    p.reason = reason;
    this.log('state', { to: 'failed', reason, shares: p.proposal.shares.map((s) => `${s.role}:${s.amountCents}`) });
  }
}
```

- [ ] **Step 5: Add `approveAs` and update the callers**

`src/scenarios.ts`: extend the types import with `PayerApproval`, add `import { approvalCents, approvalFeeCents } from './coordinator.ts';` (next to the existing `Coordinator` import), then add after `updateMandate`:

```ts
// The payer approves exactly the terms shown to them. In a real flow this
// happens on the payer's own device, never in the coordinator.
export function approveAs(w: Pick<World, 'coordinator'>, p: Purchase, payerId = EMPLOYEE): PayerApproval {
  const q = p.proposal;
  const a: PayerApproval = {
    approvalRef: `appr-${p.purchaseId}-v${q.version}-${payerId}`,
    purchaseId: p.purchaseId,
    payerId,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, payerId),
    feeCents: approvalFeeCents(q, payerId),
    expiresAt: q.expiresAt,
  };
  w.coordinator.approve(p, a);
  return a;
}
```

Mechanical replacements:

```bash
sed -i -E 's/w\.coordinator\.approveCurrent\(([a-z]+)\)/approveAs(w, \1)/g' src/scenarios.ts test/*.ts
sed -i -E "s/([a-z]+)\.proposal\.(employee|employer)Cents/shareCents(\1.proposal, '\2')/g" src/scenarios.ts test/*.ts
```

Hand edits:
- `src/scenarios.ts`: `import { Coordinator, approvalCents, approvalFeeCents, shareCents } from './coordinator.ts';` (S06 and S11 checks now call `shareCents`).
- `test/scenarios.test.ts`: import `approveAs` from scenarios and `shareCents` from `../src/coordinator.ts`. In the S07 test, replace `p.approval?.proposalVersion` with `p.approvals[0]?.proposalVersion`.
- `test/defects.test.ts`: import `approveAs` from scenarios, and `shareCents`, `approvalCents`, `approvalFeeCents` from `../src/coordinator.ts`. In the first B1 test, replace `assert.equal(p.proposal.feesCents, 0);` with `assert.ok(p.proposal.shares.every((s) => s.feeCents === 0));` and `p.approval?.feesCents` with `p.approvals[0]?.feeCents`. In the first B4 test, replace the approval object with:

```ts
  const approval = {
    approvalRef: 'appr-long',
    purchaseId: p.purchaseId,
    payerId: EMPLOYEE,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, EMPLOYEE),
    feeCents: approvalFeeCents(q, EMPLOYEE),
    expiresAt: q.expiresAt + 1_000,
  };
```

- `test/backend-port.test.ts`: import `approveAs` from scenarios and replace `c.approveCurrent(p);` with `approveAs({ coordinator: c }, p);`.

Check: `grep -rnE "approveCurrent|\.approval\b|(employee|employer)Cents|LegName|EmployeeApproval" src test`. Expected: matches only in `src/policy.ts` (`BenefitResult` keeps `employeeCents`/`employerCents`) and in `src/coordinator.ts`, where `b.employerCents` and `b.ineligibleReason` read the policy result.

- [ ] **Step 6: Run all tests**

Run: `pnpm test`
Expected: PASS, 45 tests. `pnpm findings` still shows 12 × `observed/pass`.

- [ ] **Step 7: Commit**

```bash
git add src/ test/
git commit -m "Model proposals as shares with per-payer approvals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Split purchases: bill split, group gift, multi-payee (S13–S15)

**Files:**
- Modify: `src/policy.ts` (add `equalShares`)
- Modify: `src/coordinator.ts` (add `SplitInput`, `proposeSplit`)
- Modify: `src/mock-backend.ts` (per-payer funding check in atomic groups)
- Modify: `src/scenarios.ts` (accounts, S13–S15), `test/scenarios.test.ts`, `README.md`
- Create: `test/split.test.ts`

**Interfaces:**
- Consumes: `Share`, `approveAs`, `approvalCents` (Task 10).
- Produces: `equalShares(totalCents: Cents, n: number): Cents[]`, `interface SplitInput { purchaseId; merchantId; shares: { role; payerId; payeeId?; amountCents }[]; expiresAt }`, `Coordinator.proposeSplit(input: SplitInput): Purchase`. Constants `COLLEAGUE_1 = 'colleague-1'`, `COLLEAGUE_2 = 'colleague-2'`, `PLATFORM = 'platform-1'`.

- [ ] **Step 1: Write the failing tests**

Create `test/split.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, approveAs, EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2, MERCHANT_A, MERCHANT_B, PLATFORM } from '../src/scenarios.ts';
import { equalShares } from '../src/policy.ts';

const split = (w: ReturnType<typeof world>, shares: { role: string; payerId: string; payeeId?: string; amountCents: number; feeCents?: number }[]) =>
  w.coordinator.proposeSplit({ purchaseId: 'purchase-1', merchantId: MERCHANT_B, expiresAt: 100, shares });

test('equal shares are integer cents, sum exactly, and give the remainder to the first payers', () => {
  assert.deepEqual(equalShares(4_000, 3), [1_334, 1_333, 1_333]);
  assert.deepEqual(equalShares(1_000, 4), [250, 250, 250, 250]);
  assert.deepEqual(equalShares(2, 3), [1, 1, 0]);
});

test('malformed split input is refused before any approval exists', () => {
  const w = world();
  assert.throws(() => split(w, []), /distinct roles/);
  assert.throws(() => split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: 500 }, { role: 'a', payerId: COLLEAGUE_1, amountCents: 500 }]), /distinct roles/);
  assert.throws(() => split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: 0 }]), /positive integer/);
  assert.throws(() => split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: -100 }]), /positive integer/);
  assert.throws(() => split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: 10.5 }]), /positive integer/);
  assert.throws(() => split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: 500, feeCents: -1 }]), /fees must be/);
});

test('a split is never repriced; changing it means proposing again', () => {
  const w = world();
  const p = split(w, [{ role: 'a', payerId: EMPLOYEE, amountCents: 500 }, { role: 'b', payerId: COLLEAGUE_1, amountCents: 500 }]);
  assert.throws(() => w.coordinator.changeOffer(p, { merchantId: MERCHANT_B, totalCents: 1_200, expiresAt: 100 }), /cannot be repriced/);
});

test('a split stays awaiting approvals until every payer approved', async () => {
  const w = world();
  const p = split(w, [
    { role: 'a', payerId: EMPLOYEE, amountCents: 500 },
    { role: 'b', payerId: COLLEAGUE_1, amountCents: 500 },
    { role: 'c', payerId: COLLEAGUE_2, amountCents: 500 },
  ]);
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, COLLEAGUE_1);
  assert.equal(p.state, 'awaiting_approvals');
  await assert.rejects(() => w.coordinator.submit(p, 'atomic'), /cannot submit/);
  approveAs(w, p, COLLEAGUE_2);
  assert.equal(p.state, 'ready');
});

test('one payer with two legs in an atomic group is funded for their total', async () => {
  const w = world({ deCents: 1_000, reverseWaterfall: false });
  const p = w.coordinator.proposeSplit({
    purchaseId: 'purchase-1',
    merchantId: MERCHANT_A,
    expiresAt: 100,
    shares: [
      { role: 'restaurant', payerId: EMPLOYEE, payeeId: MERCHANT_A, amountCents: 800 },
      { role: 'delivery', payerId: EMPLOYEE, payeeId: PLATFORM, amountCents: 400 },
    ],
  });
  approveAs(w, p, EMPLOYEE);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_000);
});
```

Append to `test/scenarios.test.ts` (extend the scenarios import with `COLLEAGUE_1, COLLEAGUE_2, MERCHANT_B, PLATFORM`):

```ts
test('S13 bill split: three shares in integer cents settle as one transaction', async () => {
  const { w, p } = await run('S13');
  assert.equal(p.state, 'completed');
  assert.deepEqual(p.legs.map((l) => l.amountCents), [1_334, 1_333, 1_333]);
  assert.equal(w.backend.account(MERCHANT_B).linkedBankCents, 4_000);
});

test('S14 group gift: a declined share is not re-split across the others', async () => {
  const { w, p } = await run('S14');
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(COLLEAGUE_1).deCents, 2_000);
  assert.ok(p.legs.every((l) => l.rejectReason?.startsWith('group_rejected')));
});

test('S15 multi-payee: one approval, one leg per payee, each with its own reference', async () => {
  const { w, p } = await run('S15');
  assert.equal(p.state, 'completed');
  assert.equal(p.approvals.length, 1);
  assert.deepEqual(p.legs.map((l) => [l.payeeId, l.amountCents]), [[MERCHANT_A, 1_250], [PLATFORM, 250]]);
  assert.equal(new Set(p.legs.map((l) => l.executionRef)).size, 2);
  assert.equal(w.backend.account(PLATFORM).linkedBankCents, 250);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test`
Expected: FAIL. `equalShares`, `proposeSplit`, the new constants and the scenarios do not exist.

- [ ] **Step 3: Implement the policy and coordinator parts**

`src/policy.ts`, append:

```ts
// Equal split in integer cents. The remainder goes one cent at a time to the
// first payers in the order given, so the split is deterministic and sums
// exactly to the total.
export function equalShares(totalCents: Cents, n: number): Cents[] {
  const base = Math.floor(totalCents / n);
  const rest = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}
```

`src/coordinator.ts`, add after `CoordinatorOptions`:

```ts
export interface SplitInput {
  purchaseId: string;
  // Merchant of record: eligibility and display. Each share may pay a
  // different payee (multi-payee).
  merchantId: string;
  // feeCents: payer fee on top of the share, default 0.
  shares: { role: string; payerId: string; payeeId?: string; amountCents: Cents; feeCents?: Cents }[];
  expiresAt: number;
}
```

Add after `propose`:

```ts
  // A purchase every payer approves for their own share: a bill split, a group
  // purchase, or one payer paying several payees. No benefit policy applies,
  // so the shares are taken as given and change only by proposing again.
  proposeSplit(input: SplitInput): Purchase {
    if (input.shares.length === 0 || new Set(input.shares.map((s) => s.role)).size !== input.shares.length) {
      throw new Error('split shares need distinct roles');
    }
    if (input.shares.some((s) => !Number.isInteger(s.amountCents) || s.amountCents <= 0)) {
      throw new Error('split shares must be positive integer cents');
    }
    if (input.shares.some((s) => s.feeCents !== undefined && (!Number.isInteger(s.feeCents) || s.feeCents < 0))) {
      throw new Error('split fees must be non-negative integer cents');
    }
    const shares: Share[] = input.shares.map((s) => ({
      role: s.role,
      payerId: s.payerId,
      payeeId: s.payeeId ?? input.merchantId,
      amountCents: s.amountCents,
      feeCents: s.feeCents ?? 0,
      authority: 'approval',
    }));
    const totalCents = shares.reduce((t, s) => t + s.amountCents, 0);
    const p: Purchase = {
      purchaseId: input.purchaseId,
      state: 'awaiting_approvals',
      proposal: { version: 1, merchantId: input.merchantId, totalCents, shares, expiresAt: input.expiresAt },
      approvals: [],
      legs: [],
      returnStatus: 'none',
    };
    this.log('proposal', {
      version: 1,
      merchantId: input.merchantId,
      totalCents,
      shares: shares.map((s) => `${s.role}:${s.amountCents}`),
      state: p.state,
    });
    return p;
  }
```

- [ ] **Step 4: Fund-check per payer in atomic groups**

`src/mock-backend.ts`: replace `rejection` with the two methods below, and in `submitAtomic` replace the `reasons` line with `const reasons = this.groupRejections(legs);`:

```ts
  // Why would this leg be rejected right now, if at all? Faults simulate the
  // payer's PSP; funding is checked against holdings plus reverse waterfall,
  // on top of what the same payer already commits in this group.
  private rejection(req: LegRequest, alreadyCommitted: Cents = 0): string | undefined {
    if (this.faults.get(req.payerId) === 'decline') return 'declined_by_payer_psp';
    if (!this.canFund(this.account(req.payerId), alreadyCommitted + req.amountCents + req.feeCents)) return 'insufficient_funds';
    return undefined;
  }

  // One payer may hold several legs in a group (multi-payee): check their
  // running total, not each leg alone.
  private groupRejections(legs: LegRequest[]): string[] {
    const committed = new Map<string, Cents>();
    const reasons: string[] = [];
    for (const l of legs) {
      const before = committed.get(l.payerId) ?? 0;
      const reason = this.rejection(l, before);
      if (reason) reasons.push(reason);
      committed.set(l.payerId, before + l.amountCents + l.feeCents);
    }
    return reasons;
  }
```

- [ ] **Step 5: Add accounts and scenarios**

`src/scenarios.ts`:
- Constants after `MERCHANT_C`:

```ts
export const COLLEAGUE_1 = 'colleague-1';
export const COLLEAGUE_2 = 'colleague-2';
// Delivery platform: the second payee in the multi-payee scenario.
export const PLATFORM = 'platform-1';
```

- `import { equalShares } from './policy.ts';`
- In `world()`, after the employee account:

```ts
  // Colleagues for split purchases: same funding as the default employee.
  for (const id of [COLLEAGUE_1, COLLEAGUE_2]) {
    backend.addAccount({ id, kind: 'individual', deCents: 2_000, holdingLimitCents: HOLDING_LIMIT, linkedBankCents: 50_000, reverseWaterfall: true });
  }
```

  and add `PLATFORM` to the business-account loop list.
- Bump `FIXTURE_VERSION` to `'2026.10-2'` (accounts added).
- Append to `scenarios`:

```ts
  {
    id: 'S13-bill-split',
    title: 'Three colleagues split a EUR 40 dinner: EUR 13.34 + 13.33 + 13.33 settle as one transaction',
    question: 'Q1',
    responsibility: 'Split in integer cents with a fixed remainder rule; complete only when every payer approved and every leg settled',
    check: ({ p }) => expectState(p, 'completed'),
    run: async () => {
      const w = world();
      const payers = [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2];
      const amounts = equalShares(4_000, payers.length);
      const p = w.coordinator.proposeSplit({
        purchaseId: 'purchase-1',
        merchantId: MERCHANT_B,
        expiresAt: 100,
        shares: payers.map((payerId, i) => ({ role: `diner-${i + 1}`, payerId, amountCents: amounts[i] })),
      });
      for (const id of payers) approveAs(w, p, id);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S14-group-gift-decline',
    title: "Group gift EUR 25: one colleague's PSP declines; the atomic group is rejected and nobody covers the missing EUR 5",
    question: 'Q2',
    responsibility: 'Never re-split a declined share across the remaining payers; a new split needs a new proposal and approvals',
    check: ({ w, p }) =>
      expectState(p, 'failed') ??
      (w.backend.account(EMPLOYEE).deCents === 2_000 && w.backend.account(COLLEAGUE_1).deCents === 2_000 ? undefined : 'a remaining payer was charged'),
    run: async () => {
      const w = world();
      w.backend.faults.set(COLLEAGUE_2, 'decline');
      const givers = [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2];
      const p = w.coordinator.proposeSplit({
        purchaseId: 'purchase-1',
        merchantId: MERCHANT_C,
        expiresAt: 100,
        shares: [
          { role: 'giver-1', payerId: EMPLOYEE, amountCents: 1_000 },
          { role: 'giver-2', payerId: COLLEAGUE_1, amountCents: 1_000 },
          { role: 'giver-3', payerId: COLLEAGUE_2, amountCents: 500 },
        ],
      });
      for (const id of givers) approveAs(w, p, id);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
  {
    id: 'S15-multi-payee',
    title: 'One payer, two payees: a EUR 15 order pays EUR 12.50 to the restaurant and EUR 2.50 to the delivery platform',
    question: 'Q3',
    responsibility: 'Approve one total; keep one execution reference per payee leg so each can be reconciled and returned on its own',
    check: ({ w, p }) => expectState(p, 'completed') ?? (w.backend.account(PLATFORM).linkedBankCents === 250 ? undefined : 'platform not paid'),
    run: async () => {
      const w = world();
      const p = w.coordinator.proposeSplit({
        purchaseId: 'purchase-1',
        merchantId: MERCHANT_A,
        expiresAt: 100,
        shares: [
          { role: 'restaurant', payerId: EMPLOYEE, payeeId: MERCHANT_A, amountCents: 1_250 },
          { role: 'delivery', payerId: EMPLOYEE, payeeId: PLATFORM, amountCents: 250 },
        ],
      });
      approveAs(w, p, EMPLOYEE);
      await w.coordinator.submit(p, 'atomic');
      return { w, p };
    },
  },
```

`README.md`:
- Scenario table, add:

```markdown
| S13 | Bill split, three colleagues, EUR 40 | EUR 13.34 + 13.33 + 13.33 settle as one transaction |
| S14 | Group gift, one colleague's PSP declines | Atomic group rejected; nobody covers the missing share |
| S15 | One payer, two payees (restaurant + delivery platform) | One approval, two payee legs with their own references |
```

- First paragraph: add the sentence `The same coordinator also runs peer bill splits, group purchases and one-payer, multi-payee orders (S13–S15).`

- [ ] **Step 6: Run all tests**

Run: `pnpm test`
Expected: PASS, 53 tests.

- [ ] **Step 7: Commit**

```bash
git add src/ test/ README.md
git commit -m "Add split purchases: bill split, group gift and multi-payee (S13-S15)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Party views and the field map

**Files:**
- Create: `src/views.ts`, `test/views.test.ts`, `docs/field-map.md`
- Modify: `README.md` (Docs table)

**Interfaces:**
- Consumes: `Purchase`, `Share`, `Leg.payeeId` (Task 10).
- Produces: `payerView(p: Purchase, payerId: string): PayerView`, `payeeView(p: Purchase, payeeId: string): PayeeView`, `sponsorView(p: Purchase): SponsorView` (throws on split purchases). `SponsorView` keys are exactly `mandateRef, purchaseId, merchantId, contributionCents, status`.

- [ ] **Step 1: Write the failing tests**

Create `test/views.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, EMPLOYEE, EMPLOYER, COLLEAGUE_1, MERCHANT_A, PLATFORM } from '../src/scenarios.ts';
import { payerView, payeeView, sponsorView } from '../src/views.ts';

const run = (id: string) => scenarios.find((s) => s.id.startsWith(id))!.run();

test('the employer sees its own contribution and nothing else', async () => {
  const { p } = await run('S01');
  const v = sponsorView(p);
  assert.deepEqual(Object.keys(v).sort(), ['contributionCents', 'merchantId', 'mandateRef', 'purchaseId', 'status']);
  assert.equal(v.contributionCents, 500);
  assert.equal(v.status, 'settled');
});

test('the employer sees a returned contribution as returned', async () => {
  const { p } = await run('S03');
  assert.equal(sponsorView(p).status, 'returned');
});

test('the merchant sees what it received, not who paid', async () => {
  const { p } = await run('S01');
  const v = payeeView(p, MERCHANT_A);
  assert.equal(v.receivedCents, 1_300);
  assert.equal(v.contributions.length, 2);
  const json = JSON.stringify(v);
  assert.equal(json.includes(EMPLOYEE), false);
  assert.equal(json.includes(EMPLOYER), false);
});

test('each payee in a multi-payee purchase sees only its own legs', async () => {
  const { p } = await run('S15');
  assert.equal(payeeView(p, PLATFORM).receivedCents, 250);
  assert.equal(payeeView(p, PLATFORM).contributions.length, 1);
  assert.equal(payeeView(p, MERCHANT_A).receivedCents, 1_250);
});

test('a payer sees their own share and the others only combined', async () => {
  const { p } = await run('S13');
  const v = payerView(p, COLLEAGUE_1);
  assert.equal(v.ownCents, 1_333);
  assert.equal(v.othersCents, 2_667);
  assert.equal(v.ownLegs.length, 1);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/views.test.ts`
Expected: FAIL. `src/views.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/views.ts`:

```ts
// What each party may see of a purchase: projections, not copies. Every field
// here is one its recipient needs (docs/field-map.md). The employer sees its
// own contribution and the merchant it went to, never the purchase total or
// the employee's share; a payee sees what it received, not who paid it.

import type { Cents, LegStatus, Purchase, PurchaseState } from './types.ts';

export interface PayerView {
  purchaseId: string;
  state: PurchaseState;
  merchantId: string;
  totalCents: Cents;
  ownCents: Cents;
  // Payer fees on top of the own share.
  ownFeeCents: Cents;
  // Everyone else's contributions combined, so the payer can check the total.
  othersCents: Cents;
  ownLegs: { executionRef?: string; payeeId: string; amountCents: Cents; status: LegStatus }[];
}

export interface PayeeView {
  purchaseId: string;
  state: PurchaseState;
  // Settled legs paid to this payee and not returned.
  receivedCents: Cents;
  contributions: { executionRef?: string; amountCents: Cents; status: LegStatus }[];
}

export interface SponsorView {
  mandateRef: string;
  purchaseId: string;
  // Eligibility evidence: the employer can check it against its own list.
  merchantId: string;
  contributionCents: Cents;
  status: LegStatus | 'not_submitted';
}

export function payerView(p: Purchase, payerId: string): PayerView {
  const ownCents = p.proposal.shares.filter((s) => s.payerId === payerId).reduce((t, s) => t + s.amountCents, 0);
  return {
    purchaseId: p.purchaseId,
    state: p.state,
    merchantId: p.proposal.merchantId,
    totalCents: p.proposal.totalCents,
    ownCents,
    ownFeeCents: p.proposal.shares.filter((s) => s.payerId === payerId).reduce((t, s) => t + s.feeCents, 0),
    othersCents: p.proposal.totalCents - ownCents,
    ownLegs: p.legs
      .filter((l) => l.payerId === payerId)
      .map((l) => ({ executionRef: l.executionRef, payeeId: l.payeeId, amountCents: l.amountCents, status: l.status })),
  };
}

export function payeeView(p: Purchase, payeeId: string): PayeeView {
  const legs = p.legs.filter((l) => l.payeeId === payeeId);
  return {
    purchaseId: p.purchaseId,
    state: p.state,
    receivedCents: legs.filter((l) => l.status === 'settled').reduce((t, l) => t + l.amountCents, 0),
    contributions: legs.map((l) => ({ executionRef: l.executionRef, amountCents: l.amountCents, status: l.status })),
  };
}

export function sponsorView(p: Purchase): SponsorView {
  if (!p.benefit) throw new Error('only benefit purchases have a sponsor');
  const leg = p.legs.find((l) => l.leg === 'employer');
  return {
    mandateRef: p.benefit.mandate.mandateRef,
    purchaseId: p.purchaseId,
    merchantId: p.proposal.merchantId,
    contributionCents: p.proposal.shares.find((s) => s.role === 'employer')?.amountCents ?? 0,
    status: leg?.status ?? 'not_submitted',
  };
}
```

Create `docs/field-map.md`:

```markdown
# Field map

Status: **14 October 2026.** Which party sees which purchase field, and why. `src/views.ts` implements the three party columns; tests in `test/views.test.ts` pin the employer and payee projections. "Backend" is what `SettlementBackend.submit` receives.

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
```

`README.md` Docs table: add `| [docs/field-map.md](docs/field-map.md) | Which party sees which field, and why |`.

- [ ] **Step 4: Run all tests**

Run: `pnpm test`
Expected: PASS, 58 tests.

- [ ] **Step 5: Commit**

```bash
git add src/views.ts test/views.test.ts docs/field-map.md README.md
git commit -m "Add payer, payee and sponsor views with a field map" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Per-payer PSP initiation (S16–S18)

**Files:**
- Create: `src/psp.ts`, `test/psp.test.ts`, `docs/initiation-model.md`
- Modify: `src/backend.ts` (`SubmitRequest.assembly`)
- Modify: `src/mock-backend.ts` (clock, group assembly, expiry)
- Modify: `src/types.ts` (`Purchase.mode`)
- Modify: `src/coordinator.ts` (initiation option, routing, `resubmit(p)`)
- Modify: `src/scenarios.ts` (world options, `psps`, `advance`, S16–S18), `test/scenarios.test.ts`, `README.md`

**Interfaces:**
- Consumes: `SettlementBackend` (Task 6).
- Produces:
  - `SubmitRequest.assembly?: { size: number; assembleBy: number }`
  - `MockBackend.now: number`
  - `class SimulatedPsp implements SettlementBackend` with `constructor(pspId: string, backend: SettlementBackend, trace: Trace)` and `available: boolean`
  - `class PspUnavailableError extends Error`
  - `CoordinatorOptions.initiation?: { pspFor: (payerId: string) => SettlementBackend; assemblyWindow: number }`
  - `Coordinator.resubmit(p: Purchase): Promise<void>` (mode argument removed, D7) and `Purchase.mode?: SettlementMode`
  - `world(employee?, mandate?, opts?: { initiation?: 'coordinator' | 'per_payer_psp' })`, `World.psps: Map<string, SimulatedPsp>`, `ASSEMBLY_WINDOW = 5`, `advance(w: World, t: number): void`
  - Trace events: `forward` and `psp_unavailable` (actor = pspId); `group_assembled` and `group_expired` (backend)

- [ ] **Step 1: Write the failing tests**

Create `test/psp.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, lunch, approveAs, advance, ASSEMBLY_WINDOW, EMPLOYEE, EMPLOYER } from '../src/scenarios.ts';
import { PspUnavailableError } from '../src/psp.ts';

const perPsp = () => world({}, {}, { initiation: 'per_payer_psp' });

test('a PSP that comes back can complete an assembling group with the same keys', async () => {
  const w = perPsp();
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'pending');
  assert.equal(w.backend.executionCount(), 1);
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p);
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'completed');
  assert.equal(w.backend.executionCount(), 2, 'one execution per key');
});

test('a leg that arrives after the assembly deadline fails the whole group', async () => {
  const w = perPsp();
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p);
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'failed');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});

test('a refund through an unavailable PSP keeps what was returned and completes on retry', async () => {
  const w = perPsp();
  const p = lunch(w);
  approveAs(w, p);
  await w.coordinator.submit(p, 'atomic');
  await w.coordinator.reconcile(p);
  assert.equal(p.state, 'completed');
  w.psps.get(EMPLOYER)!.available = false;
  await assert.rejects(() => w.coordinator.refund(p), PspUnavailableError);
  assert.deepEqual(p.legs.map((l) => l.status), ['returned', 'settled']);
  assert.equal(p.returnStatus, 'none');
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.refund(p);
  assert.equal(p.returnStatus, 'completed');
  assert.deepEqual(p.legs.map((l) => l.status), ['returned', 'returned']);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
});
```

Append to `test/scenarios.test.ts`:

```ts
test('S16 per-PSP atomic: the first PSP sees pending until the group completes', async () => {
  const { w, p } = await run('S16');
  const states = w.trace.events.filter((e) => e.event === 'state').map((e) => e.detail?.to);
  assert.deepEqual(states, ['pending', 'completed']);
  assert.ok(w.trace.events.some((e) => e.event === 'group_assembled'));
  assert.deepEqual(w.trace.events.filter((e) => e.event === 'forward').map((e) => e.actor), ['psp-employee-1', 'psp-employer-1']);
});

test('S17 per-PSP atomic, employer PSP down: the group expires and no money moves', async () => {
  const { w, p } = await run('S17');
  assert.equal(p.state, 'failed');
  assert.ok(w.trace.events.some((e) => e.event === 'group_expired'));
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
});

test('S18 per-PSP independent, employer PSP down: the employee leg is returned, never topped up', async () => {
  const { w, p } = await run('S18');
  const states = w.trace.events.filter((e) => e.event === 'state').map((e) => e.detail?.to);
  assert.deepEqual(states, ['recovery_required', 'cancelled']);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.executionCount(), 1);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test`
Expected: FAIL. `src/psp.ts`, `advance` and the S16–S18 scenarios do not exist.

- [ ] **Step 3: Extend the port and the mock**

`src/backend.ts`, in `SubmitRequest` after `legs`:

```ts
  // Set when each payer's PSP submits its own leg of an atomic group (one leg
  // per request). The backend holds the legs until `size` have arrived and
  // rejects the whole group if that has not happened by `assembleBy` on the
  // backend clock. Mock hypothesis; ECB behaviour unknown.
  assembly?: { size: number; assembleBy: number };
```

`src/mock-backend.ts`:
- Fields, after `refundsSupported`:

```ts
  // Backend clock, for group assembly deadlines. Scenarios move it with advance().
  now = 0;
  // Atomic groups being assembled from per-PSP submissions, keyed by groupRef.
  private readonly assembling = new Map<string, { size: number; assembleBy: number; legs: LegRequest[]; execs: Execution[] }>();
```

- In `submit`, replace the `if (mode === 'atomic') ... else ...` dispatch with:

```ts
    if (mode === 'atomic' && req.assembly) this.assemble(groupRef, req.assembly, legs, execs);
    else if (mode === 'atomic') this.submitAtomic(legs, execs);
    else this.submitIndependent(legs, execs);
```

- Add after `submitIndependent`:

```ts
  // Collect one PSP's legs into its group. Once every leg has arrived, settle
  // the group atomically. Earlier submitters see 'unknown' and learn the
  // outcome by status query. A leg arriving after the deadline fails the group.
  private assemble(groupRef: string, assembly: { size: number; assembleBy: number }, legs: LegRequest[], execs: Execution[]): void {
    const g = this.assembling.get(groupRef) ?? { size: assembly.size, assembleBy: assembly.assembleBy, legs: [], execs: [] };
    this.assembling.set(groupRef, g);
    g.legs.push(...legs);
    g.execs.push(...execs);
    if (this.now > g.assembleBy) {
      this.expire(groupRef);
      return;
    }
    if (g.execs.length < g.size) return;
    this.assembling.delete(groupRef);
    this.trace.add('LOCAL', 'backend', 'group_assembled', { groupRef, legs: g.execs.length });
    this.submitAtomic(g.legs, g.execs);
  }

  // An incomplete group past its deadline: every leg that arrived is rejected,
  // so nothing settles without the rest of the group.
  private expire(groupRef: string): void {
    const g = this.assembling.get(groupRef)!;
    this.assembling.delete(groupRef);
    for (const e of g.execs) this.reject(e, 'group_incomplete');
    this.trace.add('LOCAL', 'backend', 'group_expired', { groupRef, arrived: g.execs.length, size: g.size });
  }
```

- In `status`, insert right after the unknown-execution check:

```ts
    const g = this.assembling.get(e.groupRef);
    if (e.status === 'unknown' && g && this.now > g.assembleBy) this.expire(e.groupRef);
```

- [ ] **Step 4: Create the simulated PSP**

Create `src/psp.ts`:

```ts
// A payer's PSP as the coordinator reaches it under per-payer initiation. In
// the ECB test environment every participant acts as a simulated PSP; this
// makes explicit which PSP initiates which leg. It forwards to the backend and
// can be switched off to model an unavailable PSP.

import type { ExecutionStatus, LegResponse, SettlementBackend, SubmitRequest } from './backend.ts';
import type { Trace } from './trace.ts';
import type { Origin } from './types.ts';

// The PSP refused before forwarding anything: conclusively not submitted.
export class PspUnavailableError extends Error {
  constructor(pspId: string) {
    super(`psp ${pspId} unavailable`);
  }
}

export class SimulatedPsp implements SettlementBackend {
  readonly pspId: string;
  private readonly backend: SettlementBackend;
  private readonly trace: Trace;
  available = true;

  constructor(pspId: string, backend: SettlementBackend, trace: Trace) {
    this.pspId = pspId;
    this.backend = backend;
    this.trace = trace;
  }

  get name(): string {
    return this.pspId;
  }

  get origin(): Origin {
    return this.backend.origin;
  }

  get specVersion(): string {
    return this.backend.specVersion;
  }

  private check(op: string): void {
    if (this.available) return;
    this.trace.add('LOCAL', this.pspId, 'psp_unavailable', { op });
    throw new PspUnavailableError(this.pspId);
  }

  async submit(req: SubmitRequest): Promise<LegResponse[]> {
    this.check('submit');
    this.trace.add('LOCAL', this.pspId, 'forward', { groupRef: req.groupRef, keys: req.legs.map((l) => l.idempotencyKey) });
    return this.backend.submit(req);
  }

  async status(executionRef: string): Promise<ExecutionStatus> {
    this.check('status');
    return this.backend.status(executionRef);
  }

  async refund(executionRef: string): Promise<'returned' | 'unsupported'> {
    this.check('refund');
    return this.backend.refund(executionRef);
  }
}
```

- [ ] **Step 5: Route through PSPs in the coordinator**

`src/types.ts`, in `Purchase` after `legs`:

```ts
  // Settlement mode of the submission. Retries reuse it, so a retried leg can
  // never settle outside its atomic group.
  mode?: SettlementMode;
```

`src/coordinator.ts`:
- `import { PspUnavailableError } from './psp.ts';`
- In `CoordinatorOptions`, add:

```ts
  // Per-payer initiation: each payer's PSP submits that payer's legs, and
  // status queries and returns go through the same PSP. Without it the
  // coordinator submits every leg to the backend in one call.
  initiation?: { pspFor: (payerId: string) => SettlementBackend; assemblyWindow: number };
```

- Field `private readonly initiation?: CoordinatorOptions['initiation'];`, and in the constructor `this.initiation = opts.initiation;`.
- Below the helper constants at the top of the file:

```ts
// A submission outcome. executionRef is absent when a PSP refused the leg
// before it reached the backend.
type Outcome = Omit<LegResponse, 'executionRef'> & { executionRef?: string };
```

- Add after `log`:

```ts
  // Which backend handles a payer's leg: their PSP, or the backend directly.
  private route(payerId: string): SettlementBackend {
    return this.initiation ? this.initiation.pspFor(payerId) : this.backend;
  }
```

- In `submit`, replace the last two lines with:

```ts
    p.mode = mode;
    this.log('submit', { mode, legs: p.legs.map((l) => `${l.leg}:${l.amountCents}`) });
    this.apply(p, await this.send(p, mode));
```

- Replace `resubmit` and `send` with:

```ts
  // Simulates a network retry of the same submission: same idempotency keys,
  // same settlement mode.
  async resubmit(p: Purchase): Promise<void> {
    if (p.legs.length === 0 || !p.mode) throw new Error('nothing to resubmit');
    this.log('resubmit_same_keys');
    this.apply(p, await this.send(p, p.mode));
  }

  private async send(p: Purchase, mode: SettlementMode): Promise<Outcome[]> {
    const legs = p.legs.map((l) => ({ payerId: l.payerId, payeeId: l.payeeId, amountCents: l.amountCents, feeCents: l.feeCents, idempotencyKey: l.idempotencyKey }));
    if (!this.initiation) return this.backend.submit({ groupRef: p.purchaseId, mode, legs });
    // Each PSP submits only its own payer's leg. In atomic mode the backend
    // assembles the group by a deadline; independent legs are separate payments.
    const assembly = mode === 'atomic' ? { size: legs.length, assembleBy: this.now + this.initiation.assemblyWindow } : undefined;
    const out: Outcome[] = [];
    for (const leg of legs) {
      try {
        out.push(...(await this.route(leg.payerId).submit({ groupRef: p.purchaseId, mode, legs: [leg], assembly })));
      } catch (err) {
        if (!(err instanceof PspUnavailableError)) throw err;
        out.push({ idempotencyKey: leg.idempotencyKey, status: 'rejected', reason: 'psp_unavailable' });
      }
    }
    return out;
  }
```

- `apply(p: Purchase, responses: Outcome[])`, with `l.executionRef = r.executionRef ?? l.executionRef;`.
- `reconcile`: `l.status = await this.route(l.payerId).status(l.executionRef);`
- `returnSettledLegs`: `if ((await this.route(l.payerId).refund(l.executionRef)) === 'unsupported') {`

Retries now reuse the stored mode:

```bash
sed -i -E "s/resubmit\(p, '(atomic|independent)'\)/resubmit(p)/g" src/scenarios.ts test/*.ts
```

- [ ] **Step 6: World options and scenarios**

`src/scenarios.ts`:
- `import { SimulatedPsp } from './psp.ts';`
- Constants:

```ts
// Minutes the backend waits for every PSP's leg of an atomic group.
export const ASSEMBLY_WINDOW = 5;

export interface WorldOptions {
  // 'coordinator' (default): one call with every leg. 'per_payer_psp': each
  // payer's PSP submits its own leg.
  initiation?: 'coordinator' | 'per_payer_psp';
}
```

- `World` gains `psps: Map<string, SimulatedPsp>;`.
- `world(employee: Partial<Account> = {}, mandate: Partial<EmployerMandate> = {}, opts: WorldOptions = {}): World`. Replace the final `return` with:

```ts
  const psps = new Map<string, SimulatedPsp>();
  if (opts.initiation === 'per_payer_psp') {
    for (const id of [EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2]) psps.set(id, new SimulatedPsp(`psp-${id}`, backend, trace));
  }
  // The coordinator and backend clocks start at t=10 so scenarios can expire
  // authority or assembly deadlines by advancing them (see S06, S17).
  backend.now = 10;
  const coordinator = new Coordinator(backend, trace, {
    now: 10,
    initiation: psps.size > 0 ? { pspFor: (id) => psps.get(id)!, assemblyWindow: ASSEMBLY_WINDOW } : undefined,
  });
  return { trace, backend, coordinator, mandate: m, psps };
```

- After `approveAs`:

```ts
// Move both clocks together.
export function advance(w: World, t: number): void {
  w.coordinator.now = t;
  w.backend.now = t;
}
```

- Append the scenarios:

```ts
  {
    id: 'S16-per-psp-atomic',
    title: "Each payer's PSP submits its own leg; the backend assembles the atomic group; the first PSP learns completion by status query",
    question: 'Q1',
    responsibility: 'Expect early submitters to see an unknown outcome; reconcile every leg through its own PSP before reporting completion',
    check: ({ w, p }) => expectState(p, 'completed') ?? (stateHistory(w)[0] === 'pending' ? undefined : 'not pending first'),
    run: async () => {
      const w = world({}, {}, { initiation: 'per_payer_psp' });
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      await w.coordinator.reconcile(p);
      return { w, p };
    },
  },
  {
    id: 'S17-per-psp-employer-psp-down',
    title: "Employer's PSP is unavailable: the employee leg waits in the group, the deadline passes, nothing settles",
    question: 'Q2',
    responsibility: 'Wait for the assembly deadline instead of charging the employee alone; treat the expired group as failed with nothing committed',
    check: ({ w, p }) => expectState(p, 'failed') ?? (w.backend.account(EMPLOYEE).deCents === 2_000 ? undefined : 'employee charged'),
    run: async () => {
      const w = world({}, {}, { initiation: 'per_payer_psp' });
      w.psps.get(EMPLOYER)!.available = false;
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'atomic');
      advance(w, 10 + ASSEMBLY_WINDOW + 1);
      await w.coordinator.reconcile(p);
      return { w, p };
    },
  },
  {
    id: 'S18-per-psp-independent-down',
    title: "Two-payment baseline with the employer's PSP unavailable: the employee's EUR 8 settles alone and is returned",
    question: 'Q2',
    responsibility: 'Return the settled employee leg; never ask the employee to cover the employer share',
    check: ({ w, p }) =>
      expectState(p, 'cancelled') ??
      (stateHistory(w).includes('recovery_required') && w.backend.account(EMPLOYEE).deCents === 2_000 ? undefined : 'employee not made whole'),
    run: async () => {
      const w = world({}, {}, { initiation: 'per_payer_psp' });
      w.psps.get(EMPLOYER)!.available = false;
      const p = lunch(w);
      approveAs(w, p);
      await w.coordinator.submit(p, 'independent');
      await w.coordinator.recover(p);
      return { w, p };
    },
  },
```

`README.md`:
- Scenario table, add:

```markdown
| S16 | Each payer's PSP submits its own leg (atomic) | Backend assembles the group; first PSP sees pending, then completed |
| S17 | Employer's PSP unavailable (atomic, per PSP) | Group expires at the deadline; nothing settles |
| S18 | Employer's PSP unavailable (two-payment baseline) | EUR 8 settles alone, `recovery_required`, returned, `cancelled` |
```

- "What it models" table, add `| PSPs | src/psp.ts | Per-payer initiation: each payer's simulated PSP forwards its own leg; group assembly with a deadline is a mock hypothesis |`.

- [ ] **Step 7: Document the initiation hypothesis**

Create `docs/initiation-model.md`:

```markdown
# Initiation model (mock hypothesis)

Status: **14 October 2026.** This describes what the mock assumes, not ECB behaviour. Every statement below is a hypothesis to test in the ECB test environment.

## Question

In the digital euro, each payer's PSP initiates that payer's payment. When two payers use different PSPs, who submits which leg, and how can a backend settle the legs as one transaction?

## What the mock assumes

Implemented in `src/psp.ts` (`SimulatedPsp`) and `src/mock-backend.ts` (`assemble`, `expire`):

1. Each payer's PSP submits only its own payer's leg, tagged with the purchase's group reference.
2. In atomic mode, each request carries `assembly: { size, assembleBy }`. The backend holds the legs that have arrived as `unknown` until all `size` legs are there, then settles or rejects the whole group at once.
3. If the group is still incomplete at `assembleBy` (backend clock), every leg that arrived is rejected (`group_incomplete`). A leg arriving after the deadline fails the group too.
4. PSPs that submitted early learn the outcome only by a status query. The coordinator reconciles every leg through that payer's own PSP.
5. A PSP that refuses to forward a leg has conclusively not submitted it: the leg is `rejected: psp_unavailable`. A retry with the same idempotency key can still join the group if the deadline has not passed.
6. Retries reuse the original settlement mode (D7), so a retried leg can never settle outside its group.
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
```

`README.md` Docs table: add `| [docs/initiation-model.md](docs/initiation-model.md) | Per-payer PSP initiation: mock hypothesis and questions for the ECB test environment |`. In `docs/experiment-protocol.md`, after the paragraph that cites the call on PSP-to-backend testing, add: `The per-payer initiation assumed by the mock is documented as a hypothesis in [initiation-model.md](initiation-model.md).`

- [ ] **Step 8: Run all tests**

Run: `pnpm test`
Expected: PASS, 64 tests.

- [ ] **Step 9: Commit**

```bash
git add src/ test/ README.md docs/initiation-model.md docs/experiment-protocol.md
git commit -m "Model per-payer PSP initiation with atomic group assembly (S16-S18)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase 5: Assurance

### Task 14: Signed approvals and mandates (Ed25519)

**Files:**
- Create: `src/signing.ts`, `src/authority.ts`, `test/signing.test.ts`
- Modify: `src/types.ts` (`BenefitTerms.mandateRef`, `Purchase.approvals`)
- Modify: `src/coordinator.ts` (options, mandate resolution, signature checks)
- Modify: `src/views.ts` (`sponsorView`)
- Modify: `src/scenarios.ts` (keys, registry, `updateMandate`, `approveAs`, `lunch`)
- Modify: `test/backend-port.test.ts`, `test/defects.test.ts`, `test/scenarios.test.ts`, `README.md`, `docs/backlog.md`

**Interfaces:**
- Produces:
  - `src/signing.ts`: `canonicalJson(v: unknown): string`, `interface KeyPair { keyId; privateKey: KeyObject; publicKey: KeyObject }`, `keyPairFromSeed(keyId: string, seed: string): KeyPair`, `interface Signed<T> { payload: T; keyId: string; signature: string }`, `type KeyRegistry = ReadonlyMap<string, { publicKey: KeyObject; holder: string }>`, `signPayload<T>(payload: T, key: KeyPair): Signed<T>`, `verifyPayload<T>(s: Signed<T>, keys: KeyRegistry, holder: string): boolean`
  - `src/authority.ts`: `class MandateRegistry { publish(m: Signed<EmployerMandate>): void; current(ref: string): Signed<EmployerMandate> | undefined }`
  - `CoordinatorOptions.keys: KeyRegistry` and `CoordinatorOptions.mandates: MandateRegistry` (both required). `ProposeInput.mandateRef: string` replaces `mandate`. `approve(p, signed: Signed<PayerApproval>)`.
  - `World.keys`, `World.signers: Map<string, KeyPair>`, `World.mandates`. `approveAs(w: Pick<World, 'coordinator' | 'signers'>, p, payerId = EMPLOYEE): Signed<PayerApproval>`.
  - New reasons: `mandate_unknown`, `mandate_signature_invalid`, `approval_signature_invalid:<payerId>`.

- [ ] **Step 1: Write the failing tests**

Create `test/signing.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, keyPairFromSeed, signPayload, verifyPayload } from '../src/signing.ts';
import { world, lunch, approveAs, EMPLOYEE, EMPLOYER } from '../src/scenarios.ts';
import { approvalCents, approvalFeeCents, shareCents } from '../src/coordinator.ts';

test('canonical JSON ignores key order', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test('a signature verifies only for the holder its key is registered to', () => {
  const k = keyPairFromSeed('k1', 'seed-1');
  const keys = new Map([['k1', { publicKey: k.publicKey, holder: 'alice' }]]);
  const s = signPayload({ x: 1 }, k);
  assert.equal(verifyPayload(s, keys, 'alice'), true);
  assert.equal(verifyPayload(s, keys, 'bob'), false);
  assert.equal(verifyPayload({ ...s, payload: { x: 2 } }, keys, 'alice'), false);
});

test('fixed seeds give fixed signatures, so traces stay reproducible', () => {
  const a = signPayload({ x: 1 }, keyPairFromSeed('k', 'same-seed'));
  const b = signPayload({ x: 1 }, keyPairFromSeed('k', 'same-seed'));
  assert.equal(a.signature, b.signature);
});

test('a tampered mandate stops initiation', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p);
  w.mandates.current('mandate-1')!.payload.maxPerPurchaseCents = 1_300;
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'failed');
  assert.equal(p.reason, 'employer_authority_invalid:mandate_signature_invalid');
  assert.equal(w.backend.executionCount(), 0);
});

test('an approval signed by someone other than the payer is rejected', () => {
  const w = world();
  const p = lunch(w);
  const q = p.proposal;
  const forged = signPayload(
    {
      approvalRef: 'appr-forged',
      purchaseId: p.purchaseId,
      payerId: EMPLOYEE,
      proposalVersion: q.version,
      merchantId: q.merchantId,
      totalCents: q.totalCents,
      amountCents: approvalCents(q, EMPLOYEE),
      feeCents: approvalFeeCents(q, EMPLOYEE),
      expiresAt: q.expiresAt,
    },
    w.signers.get(EMPLOYER)!,
  );
  assert.throws(() => w.coordinator.approve(p, forged), /does not match/);
});

test("a mandate signed with a key that is not the employer's funds nothing", () => {
  const w = world();
  w.mandates.publish(signPayload({ ...w.mandate, maxPerPurchaseCents: 1_300 }, w.signers.get(EMPLOYEE)!));
  const p = lunch(w);
  assert.equal(shareCents(p.proposal, 'employer'), 0);
  const proposal = w.trace.events.find((e) => e.event === 'proposal');
  assert.equal(proposal?.detail?.ineligibleReason, 'mandate_signature_invalid');
});

test('a mandate cannot be re-published under another employer', () => {
  const w = world();
  assert.throws(
    () => w.mandates.publish(signPayload({ ...w.mandate, employerId: EMPLOYEE }, w.signers.get(EMPLOYEE)!)),
    /belongs to employer-1/,
  );
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/signing.test.ts`
Expected: FAIL. `src/signing.ts` does not exist.

- [ ] **Step 3: Signing primitives and the mandate registry**

Create `src/signing.ts`:

```ts
// Signed authority objects. Ed25519 via node:crypto over canonical JSON, the
// same idea as AP2's signed mandates without the SD-JWT format. Synthetic
// fixtures derive keys from fixed seeds so traces stay reproducible.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface KeyPair {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function keyPairFromSeed(keyId: string, seed: string): KeyPair {
  const raw = createHash('sha256').update(seed).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: 'der', type: 'pkcs8' });
  return { keyId, privateKey, publicKey: createPublicKey(privateKey) };
}

// JSON with object keys sorted at every level and undefined fields dropped,
// so the same payload always produces the same bytes.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface Signed<T> {
  payload: T;
  keyId: string;
  // base64url Ed25519 signature over canonicalJson(payload).
  signature: string;
}

// Public keys the coordinator trusts, each bound to the party that holds it.
export type KeyRegistry = ReadonlyMap<string, { publicKey: KeyObject; holder: string }>;

export function signPayload<T>(payload: T, key: KeyPair): Signed<T> {
  const signature = sign(null, Buffer.from(canonicalJson(payload)), key.privateKey).toString('base64url');
  // A copy, so later edits to the caller's object cannot alter what was signed.
  return { payload: structuredClone(payload), keyId: key.keyId, signature };
}

// True only if the key is registered to `holder` and the signature matches.
export function verifyPayload<T>(s: Signed<T>, keys: KeyRegistry, holder: string): boolean {
  const k = keys.get(s.keyId);
  if (!k || k.holder !== holder) return false;
  return verify(null, Buffer.from(canonicalJson(s.payload)), k.publicKey, Buffer.from(s.signature, 'base64url'));
}
```

Create `src/authority.ts`:

```ts
// Where the coordinator finds an employer's current mandate. The employer
// publishes a new signed version to change terms or revoke; the coordinator
// checks the latest one at proposal and again at initiation. A mandate ref
// stays bound to the employer that first published it.

import type { Signed } from './signing.ts';
import type { EmployerMandate } from './types.ts';

export class MandateRegistry {
  private readonly latest = new Map<string, Signed<EmployerMandate>>();

  publish(m: Signed<EmployerMandate>): void {
    const prev = this.latest.get(m.payload.mandateRef);
    if (prev && prev.payload.employerId !== m.payload.employerId) {
      throw new Error(`mandate ${m.payload.mandateRef} belongs to ${prev.payload.employerId}`);
    }
    this.latest.set(m.payload.mandateRef, m);
  }

  current(mandateRef: string): Signed<EmployerMandate> | undefined {
    return this.latest.get(mandateRef);
  }
}
```

- [ ] **Step 4: Verify authority in the coordinator**

`src/types.ts`:
- `import type { Signed } from './signing.ts';`
- In `BenefitTerms`, replace `mandate: EmployerMandate;` with

```ts
  // Resolved through the MandateRegistry, so a re-published (changed or
  // revoked) mandate takes effect at initiation.
  mandateRef: string;
```

- In `Purchase`: `approvals: Signed<PayerApproval>[];`

`src/coordinator.ts`:
- Imports: `import { verifyPayload } from './signing.ts';`, `import type { KeyRegistry, Signed } from './signing.ts';`, `import type { MandateRegistry } from './authority.ts';`. Remove `EmployerMandate` from the type import if nothing else uses it.
- `ProposeInput`: replace `mandate: EmployerMandate;` with `mandateRef: string;`.
- `CoordinatorOptions`: add

```ts
  // Public keys of payers and employers, bound to their holders.
  keys: KeyRegistry;
  mandates: MandateRegistry;
```

  and change the constructor signature to `constructor(backend: SettlementBackend, trace: Trace, opts: CoordinatorOptions)`. Store `this.keys = opts.keys; this.mandates = opts.mandates;` in two new `private readonly` fields.
- `propose`: `benefit: { employeeId: input.employeeId, employeeMaxCents: input.employeeMaxCents, employeeFeeCents: input.feesCents ?? 0, mandateRef: input.mandateRef },`
- Add before `benefitNow`:

```ts
  // The latest published mandate, if its signature verifies against the key
  // registered to the employer it names.
  private mandate(ref: string): { mandate?: EmployerMandate; problem?: string } {
    const s = this.mandates.current(ref);
    if (!s) return { problem: 'mandate_unknown' };
    if (!verifyPayload(s, this.keys, s.payload.employerId)) return { problem: 'mandate_signature_invalid' };
    return { mandate: s.payload };
  }
```

- Replace `benefitNow` with:

```ts
  private benefitNow(p: Purchase, merchantId: string, totalCents: Cents): BenefitResult {
    const t = this.benefitTerms(p);
    const { mandate, problem } = this.mandate(t.mandateRef);
    if (!mandate) {
      // No usable authority: the employer contributes nothing, and the
      // employee decides whether to pay it all.
      return { employerCents: 0, employeeCents: totalCents, withinInstruction: totalCents <= t.employeeMaxCents, ineligibleReason: problem };
    }
    return evaluateBenefit({
      totalCents,
      merchantId,
      beneficiaryId: t.employeeId,
      mandate,
      now: this.now,
      usedToday: this.ledger.usage(t.mandateRef, dayOf(this.now), p.purchaseId),
      employeeMaxCents: t.employeeMaxCents,
      employeeFeeCents: t.employeeFeeCents,
    });
  }
```

- In `reprice`, replace the `shares` construction with:

```ts
    // The employee share is listed even at zero: the employee still approves
    // the purchase. Zero shares never become legs. Without a usable mandate
    // there is no employer share at all.
    const shares: Share[] = [
      { role: 'employee', payerId: t.employeeId, payeeId: merchantId, amountCents: b.employeeCents, feeCents: t.employeeFeeCents, authority: 'approval' },
    ];
    const employer = this.mandate(t.mandateRef).mandate;
    if (employer) {
      shares.push({ role: 'employer', payerId: employer.employerId, payeeId: merchantId, amountCents: b.employerCents, feeCents: 0, authority: 'mandate' });
    }
```

  and replace the invalidation loop with `for (const a of p.approvals) this.log('approval_invalidated', { approvalRef: a.payload.approvalRef });`.
- Replace `approve` with:

```ts
  approve(p: Purchase, signed: Signed<PayerApproval>): void {
    const q = p.proposal;
    const a = signed.payload;
    // The approval must be signed by the payer it names, come from a payer
    // with an approval share, and echo every term of the current proposal. A
    // stale approval, bound to an earlier version, fails the version
    // comparison and is rejected here rather than silently applied.
    const binds =
      verifyPayload(signed, this.keys, a.payerId) &&
      approvers(q).includes(a.payerId) &&
      a.purchaseId === p.purchaseId &&
      a.proposalVersion === q.version &&
      a.merchantId === q.merchantId &&
      a.totalCents === q.totalCents &&
      a.amountCents === approvalCents(q, a.payerId) &&
      a.feeCents === approvalFeeCents(q, a.payerId) &&
      // An approval may expire before the offer does, never after it.
      a.expiresAt <= q.expiresAt;
    const live = this.now <= a.expiresAt;
    if (p.state !== 'awaiting_approvals' || !binds || !live) {
      this.log('approval_rejected', { approvalRef: a.approvalRef, payerId: a.payerId, state: p.state });
      throw new Error('approval does not match the current proposal');
    }
    // A payer may approve again; the newer approval replaces theirs.
    p.approvals = [...p.approvals.filter((x) => x.payload.payerId !== a.payerId), signed];
    this.log('approval_recorded', { approvalRef: a.approvalRef, payerId: a.payerId, keyId: signed.keyId, version: q.version });
    if (approvers(q).every((id) => p.approvals.some((x) => x.payload.payerId === id))) p.state = 'ready';
  }
```

- In `submit`, replace the expiry block with:

```ts
    // Authority is evaluated at the moment money would move: every approval
    // must still verify and still be within its expiry.
    const unverified = p.approvals.find((s) => !verifyPayload(s, this.keys, s.payload.payerId));
    if (unverified) {
      this.fail(p, `approval_signature_invalid:${unverified.payload.payerId}`);
      return;
    }
    const expired = p.approvals.find((s) => this.now > s.payload.expiresAt);
    if (expired) {
      this.fail(p, `approval_expired:${expired.payload.payerId}`);
      return;
    }
```

  and in the reservation block use `const ref = p.benefit.mandateRef;`.
- `authorityRef`:

```ts
  private authorityRef(p: Purchase, s: Share): string {
    if (s.authority === 'mandate') return this.benefitTerms(p).mandateRef;
    return p.approvals.find((a) => a.payload.payerId === s.payerId)!.payload.approvalRef;
  }
```

`src/views.ts`, in `sponsorView`: `mandateRef: p.benefit.mandateRef,`.

- [ ] **Step 5: Keys and registry in the fixtures**

`src/scenarios.ts`:
- Imports: `import { keyPairFromSeed, signPayload } from './signing.ts';`, `import type { KeyPair, Signed } from './signing.ts';`, `import { MandateRegistry } from './authority.ts';`.
- `World` gains `keys: Map<string, { publicKey: KeyPair['publicKey']; holder: string }>; signers: Map<string, KeyPair>; mandates: MandateRegistry;`.
- In `world()`, after the mandate `m` is built and before the PSP block:

```ts
  // Synthetic signing keys from fixed seeds, one per payer and the employer.
  // Private keys stay with their holder (the device); the coordinator only
  // sees the public half, bound to its holder in the key registry.
  const signers = new Map<string, KeyPair>();
  const keys = new Map<string, { publicKey: KeyPair['publicKey']; holder: string }>();
  for (const id of [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2, EMPLOYER]) {
    const k = keyPairFromSeed(`key-${id}`, `synthetic-seed-${id}`);
    signers.set(id, k);
    keys.set(k.keyId, { publicKey: k.publicKey, holder: id });
  }
  const mandates = new MandateRegistry();
  mandates.publish(signPayload(m, signers.get(EMPLOYER)!));
```

  Add `keys, mandates,` to the `Coordinator` options, and `keys, signers, mandates` to the returned object.
- Bump `FIXTURE_VERSION` to `'2026.10-3'` (signing keys).
- Replace `updateMandate` with:

```ts
// The employer changes its mandate terms (cap, beneficiary, revocation) by
// signing and publishing a new version.
export function updateMandate(w: World, changes: Partial<EmployerMandate>): void {
  w.mandate = { ...w.mandate, ...changes };
  w.mandates.publish(signPayload(w.mandate, w.signers.get(EMPLOYER)!));
}
```

- Replace `approveAs` with:

```ts
// The payer approves exactly the terms shown to them and signs on their own
// device. A payer without a registered key signs with an unregistered one,
// which the coordinator rejects.
export function approveAs(w: Pick<World, 'coordinator' | 'signers'>, p: Purchase, payerId = EMPLOYEE): Signed<PayerApproval> {
  const q = p.proposal;
  const a: PayerApproval = {
    approvalRef: `appr-${p.purchaseId}-v${q.version}-${payerId}`,
    purchaseId: p.purchaseId,
    payerId,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, payerId),
    feeCents: approvalFeeCents(q, payerId),
    expiresAt: q.expiresAt,
  };
  const key = w.signers.get(payerId) ?? keyPairFromSeed(`unregistered-${payerId}`, payerId);
  const signed = signPayload(a, key);
  w.coordinator.approve(p, signed);
  return signed;
}
```

- In `lunch`: `mandateRef: w.mandate.mandateRef,`.

Test updates:
- `test/backend-port.test.ts`: `const c = new Coordinator(backend, new Trace(), { now: 10, keys: w.keys, mandates: w.mandates });`, `mandateRef: w.mandate.mandateRef,` in `propose`, and `approveAs({ coordinator: c, signers: w.signers }, p);`.
- `test/scenarios.test.ts` (S07): `p.approvals[0]?.payload.proposalVersion`.
- `test/defects.test.ts`: In the first B1 test, `p.approvals[0]?.feeCents` becomes `p.approvals[0]?.payload.feeCents`. In the first B4 test, add `import { signPayload } from '../src/signing.ts';` and change the call to `w.coordinator.approve(p, signPayload(approval, w.signers.get(EMPLOYEE)!))`.

Check: `grep -rn "\.mandate\b\|mandate:" src/coordinator.ts src/views.ts`. Expected: no reads of `p.benefit.mandate`.

- [ ] **Step 6: Run all tests**

Run: `pnpm test`
Expected: PASS, 71 tests. The run-record digest tests still pass (signatures are deterministic).

- [ ] **Step 7: Commit**

`docs/backlog.md`: remove the "Signed mandates" planned item. `README.md` mapping table, first row's Gap column: replace `here it is an unsigned object` with `signed with Ed25519 over canonical JSON; not SD-JWT`.

```bash
git add src/ test/ README.md docs/backlog.md
git commit -m "Sign approvals and mandates with Ed25519 and verify before submission" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Randomised invariant tests

**Files:**
- Create: `test/invariants.property.test.ts`
- Modify: `README.md` (Run section note)

**Interfaces:**
- Consumes: `world` with `initiation`, `lunch`, `approveAs`, `updateMandate`, `advance`, `World.psps`, `PspUnavailableError`, `Purchase.approvals` (signed), `resubmit(p)`.

- [ ] **Step 1: Write the property test**

Create `test/invariants.property.test.ts`:

```ts
// Randomised check of the safety rules in AGENTS.md. Each seed builds a
// fixture with random funding, faults, return support and initiation model,
// then applies a random sequence of operations. After every step the
// invariants must hold. A failure names the seed and the operations so the
// case can be replayed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, lunch, approveAs, updateMandate, advance, EMPLOYEE, EMPLOYER } from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';
import type { Fault } from '../src/mock-backend.ts';
import type { Purchase, SettlementMode } from '../src/types.ts';
import { PspUnavailableError } from '../src/psp.ts';

const SEEDS = 300;
const STEPS = 12;

// mulberry32: small, fast, deterministic.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

const FAULTS: Fault[] = ['none', 'decline', 'timeout_then_settle', 'timeout_then_reject'];
const MODES: SettlementMode[] = ['atomic', 'independent'];
// Approve and submit appear twice so runs reach the backend often.
const ACTIONS = [
  'approve', 'approve', 'submit', 'submit', 'resubmit', 'reconcile', 'reconcile',
  'recover', 'refund', 'advance', 'reprice', 'revoke', 'lowerCap', 'pspFlip',
] as const;
type Action = (typeof ACTIONS)[number];

// Errors the coordinator raises on purpose when an operation is not allowed
// in the current state. Anything else is a bug.
const REFUSALS = /^(cannot |approval does not match|nothing to |split purchases cannot)/;

const totalMoney = (w: World): number =>
  [...w.backend.accounts.values()].reduce((s, a) => s + a.deCents + a.linkedBankCents, 0);

interface Ctx {
  money: number;
  keys: Set<string>;
}

function checkInvariants(w: World, p: Purchase, ctx: Ctx): void {
  assert.equal(totalMoney(w), ctx.money, 'money is neither created nor destroyed');
  assert.ok(w.trace.events.every((e) => e.origin === 'LOCAL'), 'local runs only produce LOCAL evidence');
  for (const l of p.legs) ctx.keys.add(l.idempotencyKey);
  assert.ok(w.backend.executionCount() <= ctx.keys.size, 'at most one execution per idempotency key');
  if (p.state === 'completed') {
    assert.equal(p.legs.reduce((s, l) => s + l.amountCents, 0), p.proposal.totalCents, 'completed legs add up to the total');
    assert.ok(p.legs.every((l) => l.status === 'settled' || l.status === 'returned'), 'completed only when every leg settled');
  }
  if (p.legs.some((l) => l.status === 'unknown')) assert.equal(p.state, 'pending', 'an unknown outcome is pending, not failed');
  if (p.state === 'recovery_required') assert.ok(w.coordinator.outstandingCents(p) > 0, 'recovery keeps the outstanding amount visible');
  const employeeLeg = p.legs.find((l) => l.leg === 'employee');
  if (employeeLeg) {
    const approval = p.approvals.find((a) => a.payload.payerId === EMPLOYEE);
    assert.ok(approval, 'an employee leg exists only with an employee approval');
    assert.equal(employeeLeg.amountCents, approval.payload.amountCents, 'the employee pays exactly what they approved');
    assert.equal(employeeLeg.feeCents, approval.payload.feeCents, 'and exactly the fee they approved');
  }
}

async function step(r: () => number, w: World, p: Purchase, action: Action): Promise<void> {
  const c = w.coordinator;
  switch (action) {
    case 'approve':
      approveAs(w, p);
      break;
    case 'submit':
      await c.submit(p, pick(r, MODES));
      break;
    case 'resubmit':
      await c.resubmit(p);
      break;
    case 'reconcile':
      await c.reconcile(p);
      break;
    case 'recover':
      await c.recover(p);
      break;
    case 'refund':
      await c.refund(p);
      break;
    case 'advance':
      advance(w, c.now + Math.floor(r() * 40));
      break;
    case 'reprice':
      c.changeOffer(p, { merchantId: p.proposal.merchantId, totalCents: 300 + Math.floor(r() * 1_300), expiresAt: 100 });
      break;
    case 'revoke':
      updateMandate(w, { revoked: true });
      break;
    case 'lowerCap':
      updateMandate(w, { maxPerPurchaseCents: Math.floor(r() * 500) });
      break;
    case 'pspFlip':
      for (const psp of w.psps.values()) psp.available = r() < 0.5;
      break;
  }
}

test(`safety invariants hold across ${SEEDS} random runs`, async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const w = world(
      { deCents: Math.floor(r() * 2_000), reverseWaterfall: r() < 0.5 },
      {},
      { initiation: r() < 0.3 ? 'per_payer_psp' : 'coordinator' },
    );
    w.backend.faults.set(EMPLOYEE, pick(r, FAULTS));
    w.backend.faults.set(EMPLOYER, pick(r, FAULTS));
    w.backend.refundsSupported = r() < 0.7;
    const p = lunch(w);
    const ctx: Ctx = { money: totalMoney(w), keys: new Set() };
    const done: Action[] = [];
    for (let i = 0; i < STEPS; i++) {
      const action = pick(r, ACTIONS);
      done.push(action);
      try {
        await step(r, w, p, action);
      } catch (err) {
        const refused = err instanceof PspUnavailableError || (err instanceof Error && REFUSALS.test(err.message));
        if (!refused) throw new Error(`seed ${seed} after ${done.join(' > ')}: ${String(err)}`);
      }
      try {
        checkInvariants(w, p, ctx);
      } catch (err) {
        throw new Error(`seed ${seed} after ${done.join(' > ')}: ${(err as Error).message}`);
      }
    }
  }
});
```

- [ ] **Step 2: Run it**

Run: `node --test test/invariants.property.test.ts`
Expected: PASS, in a few seconds.

**If it fails, that is a real defect, not a test problem.** Do not weaken an invariant or widen `REFUSALS` to make it pass. Replay the seed and action list from the message, then use superpowers:systematic-debugging. Add a focused regression test in the owning test file, fix the code, and record the defect and fix in `docs/backlog.md`. Then re-run.

- [ ] **Step 3: Check that it catches a broken rule**

Temporarily break a rule: in `src/coordinator.ts` `derive`, change `st.every((s) => s === 'settled')` to `st.some((s) => s === 'settled')`. Run the property test. Expected: FAIL with a `seed N after ...: completed only when every leg settled` message (or another invariant). Revert the change and confirm `git diff src/` is empty.

- [ ] **Step 4: Run all tests and commit**

`README.md`, Run block: add `# test/invariants.property.test.ts checks the safety rules over 300 seeded random runs`.

Run: `pnpm test`
Expected: PASS, 72 tests.

```bash
git add test/invariants.property.test.ts README.md
git commit -m "Check safety invariants over seeded random operation sequences" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Phase 6: Presentation

### Task 16: Mermaid sequence diagrams from traces

**Files:**
- Create: `src/mermaid.ts`, `test/mermaid.test.ts`
- Modify: `src/cli.ts`, `README.md`

**Interfaces:**
- Consumes: `TraceEvent`.
- Produces: `toMermaid(events: TraceEvent[]): string` and the CLI flag `pnpm scenarios [filter] --mermaid`.

- [ ] **Step 1: Write the failing tests**

Create `test/mermaid.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../src/scenarios.ts';
import { toMermaid } from '../src/mermaid.ts';

const run = (id: string) => scenarios.find((s) => s.id.startsWith(id))!.run();

test('a trace becomes a sequence diagram with one line per event', async () => {
  const { w } = await run('S01');
  const lines = toMermaid(w.trace.events).split('\n');
  assert.equal(lines[0], 'sequenceDiagram');
  assert.ok(lines.includes('  participant coordinator as coordinator'));
  assert.ok(lines.includes('  participant backend as backend'));
  assert.ok(lines.some((l) => l.startsWith('  coordinator->>backend: [LOCAL] submit')));
  assert.ok(lines.some((l) => l.startsWith('  backend-->>coordinator: [LOCAL] submit')));
  const participants = lines.filter((l) => l.startsWith('  participant')).length;
  assert.equal(lines.length, 1 + participants + w.trace.events.length);
});

test('labels avoid characters Mermaid treats specially, and PSP forwards are arrows', async () => {
  const { w } = await run('S16');
  const text = toMermaid(w.trace.events);
  for (const line of text.split('\n').slice(1)) assert.doesNotMatch(line.split(': ').slice(1).join(': '), /[;#<>]/);
  assert.ok(text.includes('participant psp_employee_1 as psp-employee-1'));
  assert.ok(text.includes('psp_employee_1->>backend: [LOCAL] forward'));
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/mermaid.test.ts`
Expected: FAIL. `src/mermaid.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/mermaid.ts`:

```ts
// A trace as a Mermaid sequence diagram, for slides and GitHub. Backend events
// are replies to the coordinator, PSP events are forwards to the backend, a
// direct submission is an arrow from the coordinator, and every other
// coordinator event is a note. Each label keeps its evidence origin.

import type { TraceEvent } from './types.ts';

const id = (actor: string): string => actor.replace(/[^A-Za-z0-9_]/g, '_');

// Mermaid treats ';', '#', '<' and '>' specially in message text.
function label(e: TraceEvent): string {
  const detail = Object.entries(e.detail ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
  return `[${e.origin}] ${e.event}${detail ? ` ${detail}` : ''}`.replace(/[;#<>]/g, ' ');
}

export function toMermaid(events: TraceEvent[]): string {
  const actors = [...new Set(['coordinator', 'backend', ...events.map((e) => e.actor)])];
  const viaPsp = actors.some((a) => a.startsWith('psp-'));
  const lines = ['sequenceDiagram', ...actors.map((a) => `  participant ${id(a)} as ${a}`)];
  for (const e of events) {
    if (e.actor === 'backend') lines.push(`  backend-->>coordinator: ${label(e)}`);
    else if (e.actor.startsWith('psp-')) lines.push(`  ${id(e.actor)}->>backend: ${label(e)}`);
    else if (!viaPsp && (e.event === 'submit' || e.event === 'resubmit_same_keys')) lines.push(`  coordinator->>backend: ${label(e)}`);
    else lines.push(`  Note over ${id(e.actor)}: ${label(e)}`);
  }
  return lines.join('\n');
}
```

`src/cli.ts`:
- `import { toMermaid } from './mermaid.ts';`
- Header comment: `//   pnpm scenarios [filter] --mermaid  sequence diagrams (Markdown)`
- Add a branch before the default `else`:

```ts
} else if (flags.has('--mermaid')) {
  const fence = '`'.repeat(3);
  for (const s of selected) {
    const { w } = await s.run();
    console.log(`\n### ${s.id}: ${s.title}\n\n${fence}mermaid\n${toMermaid(w.trace.events)}\n${fence}`);
  }
```

`README.md`, Run block: add `pnpm scenarios S03 --mermaid   # sequence diagram for slides or GitHub`.

- [ ] **Step 4: Run all tests and render one**

Run: `pnpm test`, then `pnpm scenarios S16 --mermaid`
Expected: PASS, 74 tests. Paste the S16 output into https://mermaid.live by hand (do not script any network call) and check that it renders.

- [ ] **Step 5: Commit**

```bash
git add src/mermaid.ts src/cli.ts test/mermaid.test.ts README.md
git commit -m "Render scenario traces as Mermaid sequence diagrams" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: CI, documentation sweep and backlog close-out

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`, `docs/backlog.md`, `docs/experiment-protocol.md`

**Interfaces:**
- Consumes: `pnpm test`, `pnpm scenarios`, `pnpm findings`.

- [ ] **Step 1: Add the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        # 23.6.0 is the declared floor (native type stripping); 24 is current LTS.
        node: ['23.6.0', '24']
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: pnpm test
      - run: pnpm scenarios > /dev/null
      - run: pnpm findings
```

- [ ] **Step 2: Check the floor version locally if possible**

If a Node version manager is available (`fnm`, `nvm` or `volta`), run `pnpm test` under Node 23.6.0. Otherwise note in the PR that CI is the first run on 23.6.0. Expected: PASS. A failure means a feature newer than 23.6 slipped in. Replace it with an older API rather than raising the engines floor without asking.

- [ ] **Step 3: README sweep**

- Top, under the title: `[![ci](https://github.com/akkuverse/multipayer-poc/actions/workflows/ci.yml/badge.svg)](https://github.com/akkuverse/multipayer-poc/actions/workflows/ci.yml)`. The badge only renders publicly once the repository is public.
- "What it models" table: keep the existing rows (update the Coordinator row to `Proposal versions as shares, per-payer approval binding, authority recheck at initiation, idempotent submission, state derivation, reconciliation, recovery, refunds`) and add:

```markdown
| Backend port | `src/backend.ts` | `SettlementBackend`: the async seam the mock and a future ECB adapter implement; contract suite in `test/contract/` |
| Benefit ledger | `src/ledger.ts` | Per-mandate, per-day reservations: reserved at submission, consumed on completion, released on failure or return |
| Signed authority | `src/signing.ts`, `src/authority.ts` | Ed25519 over canonical JSON for approvals and mandates; latest signed mandate per ref, bound to its employer |
| Party views | `src/views.ts` | What payer, payee and employer may see ([field map](docs/field-map.md)) |
| Evidence | `src/run-record.ts`, `src/findings.ts` | Run records with fixture and spec version and a trace digest; findings table generated from runs |
| Diagrams | `src/mermaid.ts` | Trace to Mermaid sequence diagram |
```
- "Scenarios" table: S01–S18 present, S11 reworded (Task 4).
- "Limits and next steps": replace the first bullet with `- Backend semantics are assumptions (spec version \`mock-1\`). Group assembly for per-PSP initiation is a mock hypothesis. The real multi-payer API, its atomicity, expiry, retry and return behaviour are unknown until the ECB test environment is available. The ECB adapter implements \`SettlementBackend\`, passes the contract suite and tags its events \`ECB_API\`.`
- Run `grep -n "approveCurrent\|usedToday\|DAILY_BENEFIT_CAP" README.md docs/*.md`. Expected: no output.

- [ ] **Step 4: Backlog and protocol close-out**

`docs/backlog.md`:
- Header line: `Known defects and planned work. Defects B1–B5 from the 14 October 2026 review are fixed; see git history.`
- Planned: remove the "Initiation model" and "Peer bill split" items (done in Tasks 13 and 11). Keep "ECB adapter" (add `Implements SettlementBackend; must pass test/contract/settlement-backend.contract.ts.`) and "AI presenter demo".
- Add under Planned: `- **Type checking.** No type checker runs today (zero dev dependencies). Adding \`typescript\` as a dev dependency for \`tsc --noEmit\` in CI needs approval.`
- Domain check: keep the tax/legal confirmation line from Task 4.

`docs/experiment-protocol.md`, "Minimum deliverable and boundaries": add the bullet `- Run evidence: \`pnpm scenarios --json\` records run id, fixture version, backend spec version and a trace digest per scenario; \`pnpm findings\` generates the findings table below from fresh runs, with the ECB column \`not tested\` until adapter runs exist.`

- [ ] **Step 5: Final verification**

Run: `pnpm test && pnpm scenarios > /dev/null && pnpm findings | tail -3`
Expected: 74 tests pass. The findings table has 18 rows, all `observed/pass` and `not tested`.

Run: `grep -rn "ECB_API" src/ | grep -v "^src/types.ts" | grep -v "^src/backend.ts"`
Expected: only comments, never a `trace.add('ECB_API'`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml README.md docs/backlog.md docs/experiment-protocol.md
git commit -m "Add CI and bring docs and backlog up to date" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand off**

Do not push without the user's go-ahead. Once approved, push the branch and watch the run with `gh run watch`. Then use superpowers:finishing-a-development-branch.

## Outside this plan

- **Tax/legal confirmation of D2** (one subsidised meal per working day) before S11 is presented.
- **Type checking** needs a dev-dependency decision (see backlog).
- **AI presenter demo** stays a separate backlog item.
