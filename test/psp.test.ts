// Per-payer provider initiation (docs/initiation-model.md): each payer's
// provider reserves and commits its own leg, holds carry an expiry, and an
// unavailable provider parks the leg it cannot reach.
// Tests of the retired SettlementBackend/PSP adapter internals moved to
// Task 6: the lost-response/unknown-leg safety they pinned is exercised
// here through provider-level faults instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  world, lunch, approveAs, refundAs, submitAs, advance, ASSEMBLY_WINDOW,
  EMPLOYEE, EMPLOYER, MERCHANT_A,
  payerDeCents, payerBankCents, payeeBankCents,
  settlementOf, legChildKey, deGroupKey, coordinatorFor,
} from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';

const perPsp = () => world({}, {}, { initiation: 'per_payer_psp' });

// Legs with a confirmed commit under the purchase's recorded intent.
const committedLegs = (w: World, purchaseId = 'purchase-1'): number =>
  settlementOf(w, purchaseId)?.legs.filter((l) => l.committedCents !== undefined).length ?? 0;
// Legs whose reserve ever reached a provider.
const reservedLegs = (w: World, purchaseId = 'purchase-1'): number =>
  settlementOf(w, purchaseId)?.legs.filter((l) => l.reserve !== undefined).length ?? 0;

test('a provider that comes back can complete an assembling group with the same keys', async () => {
  const w = perPsp();
  w.providers.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  // The group commit waits on every reserve: an unreachable sibling holds
  // back the whole commit phase — no leg reports committed.
  assert.equal(committedLegs(w), 0);
  w.providers.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(committedLegs(w), 2, 'one execution per key');
});

test('a refused retry does not mark an in-flight leg rejected; reconcile still learns its outcome', async () => {
  const w = perPsp();
  // Employer provider down: the employee leg settles, the employer leg
  // stays open — an unreachable provider is never a conclusive refusal.
  w.providers.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.legs[0].status, 'unknown');
  assert.equal(p.legs[1].status, 'unknown');
  // Flip availability and retry: the employer leg settles and the employee
  // leg's pending reserve resolves through its provider's status route —
  // an unreachable call path never fabricates 'rejected' for in-flight work.
  w.providers.get(EMPLOYER)!.available = true;
  w.providers.get(EMPLOYEE)!.available = false;
  await w.coordinator.resubmit(p.purchaseId);
  // The employer leg is confirmed settled; the employee leg's commit is
  // recorded but its destination credit cannot be confirmed while its
  // provider is unreachable — committed-unconfirmed reads 'unknown',
  // never 'settled'.
  assert.deepEqual(p.legs.map((l) => l.status), ['unknown', 'settled']);
  // The purchase honestly stays pending, never 'failed'.
  assert.equal(p.state, 'pending');
  w.providers.get(EMPLOYEE)!.available = true;
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(payerBankCents(w, EMPLOYER), 100_000 - 500);
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000 - 800);
});

test('a leg that arrives after the hold deadline fails the whole group', async () => {
  const w = perPsp();
  w.providers.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  // The employee leg's digital-euro hold expires while the employer leg
  // waits: the intent unwinds — the employee's money goes back untouched.
  advance(w, 10 + ASSEMBLY_WINDOW + 1);
  w.providers.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  await w.coordinator.reconcile(p.purchaseId);
  // The employer leg committed on the retry while the expired digital-euro
  // hold refused the group commit — compensation returned that commitment.
  assert.equal(p.state, 'compensated');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('a refund through an unavailable provider keeps what was returned and completes on retry', async () => {
  const w = perPsp();
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  w.providers.get(EMPLOYER)!.available = false;
  await refundAs(w, p, MERCHANT_A);
  assert.deepEqual(p.legs.map((l) => l.status), ['returned', 'settled']);
  assert.equal(p.returnStatus, 'partial');
  w.providers.get(EMPLOYER)!.available = true;
  await refundAs(w, p, MERCHANT_A);
  assert.equal(p.returnStatus, 'completed');
  assert.deepEqual(p.legs.map((l) => l.status), ['returned', 'returned']);
  assert.equal(payerBankCents(w, EMPLOYER), 100_000);
});

test('a refused retry keeps a conclusive provider rejection instead of downgrading it', async () => {
  const w = perPsp();
  // The employer leg's pay credit is conclusively refused; the employee
  // leg's group commit outcome is lost. Under independent settlement the
  // purchase stays pending until the lost commit resolves.
  w.providers.get(EMPLOYER)!.setFault(
    legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a'),
    'credit',
    'reject_before_effect',
  );
  w.digitalEuro.setFault(deGroupKey('purchase-1', 1, ['employee']), 'commit', 'lose_response_after_effect');
  const p = lunch(w, 1_300, MERCHANT_A, { settlementMode: 'independent' });
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.deepEqual(p.legs.map((l) => l.status), ['settled', 'rejected']);
  assert.equal(p.legs[1].rejectReason, 'credit_rejected');
  assert.equal(p.state, 'recovery_required', 'committed money at risk holds the purchase in recovery');
  // The employer provider now cannot answer, but the recorded rejection
  // already stands and resubmit is not the recovery route.
  w.providers.get(EMPLOYER)!.available = false;
  await assert.rejects(() => w.coordinator.resubmit(p.purchaseId), /cannot resubmit in state recovery_required/);
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'credit_rejected', 'unreachable route cannot downgrade a conclusive outcome');
  // Recovery returns the committed employee share; the rejection persists.
  w.providers.get(EMPLOYER)!.available = true;
  await w.coordinator.recover(p.purchaseId);
  assert.equal(p.state, 'cancelled');
  assert.equal(p.legs[1].rejectReason, 'credit_rejected');
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000);
});

test('a payer with no provider fails loudly before any leg is forwarded', async () => {
  const w = perPsp();
  w.providers.delete(EMPLOYER);
  const p = lunch(w);
  approveAs(w, p);
  await assert.rejects(() => submitAs(w, p, EMPLOYEE), /unroutable_payer|unknown_provider|no provider/);
  assert.equal(reservedLegs(w), 0, 'nothing reached a provider');
  assert.equal(p.state, 'ready');
});

test('a lost response through the provider route keeps the purchase pending and the replay dedupes', async () => {
  const w = perPsp();
  const p = lunch(w);
  approveAs(w, p);
  // The employer leg's pay credit applies at the payee's provider but its
  // response never arrives: the leg is 'unknown' with no execution
  // reference — handed off, yet unresolvable until status answers.
  w.providers.get(EMPLOYER)!.setFault(
    legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a'),
    'credit',
    'lose_response_after_effect',
  );
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  assert.equal(p.legs[1].status, 'unknown');
  assert.equal(committedLegs(w), 0, 'the snapshot cannot claim the unconfirmed credit');
  // The same-key replay is deduplicated: it discovers the original execution
  // instead of creating a second payment.
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(committedLegs(w), 2, 'no extra executions');
  assert.equal(payeeBankCents(w, MERCHANT_A), 1_300);
});

test('a replay of a handed-off leg uses its frozen authorization, not the current one', async () => {
  const w = perPsp();
  const p = lunch(w);
  approveAs(w, p);
  // The employee leg's group commit applied but its response was lost:
  // the leg was handed off, so absence of an executionRef is not absence
  // of dispatch — the replay is not a new initiation needing live authority.
  w.digitalEuro.setFault(deGroupKey('purchase-1', 1, ['employee']), 'commit', 'lose_response_after_effect');
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  // The employee approval has expired since dispatch — the replay under
  // the frozen authorization still settles.
  advance(w, p.proposal.expiresAt + 1);
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(committedLegs(w), 2);
});

test('a refused replay never overwrites a settled leg', async () => {
  const w = perPsp();
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  // Both providers cannot answer the replay's status checks, but the legs
  // were already recorded settled: an unreachable route cannot downgrade
  // their recorded outcomes.
  w.providers.get(EMPLOYEE)!.available = false;
  w.providers.get(EMPLOYER)!.available = false;
  await w.coordinator.resubmit(p.purchaseId);
  assert.deepEqual(p.legs.map((l) => l.status), ['settled', 'settled']);
  assert.equal(p.state, 'completed');
});

test('coordinator_as_psp refuses a purchase whose payers belong to different providers', async () => {
  // The default fixture gives every payer its own provider, so a direct
  // one-call submission would be a cross-provider request — refused before
  // dispatch, logged, thrown, and the purchase stays repairable.
  const w = world({}, {}, { initiation: 'coordinator_as_psp' });
  const p = lunch(w);
  approveAs(w, p);
  await assert.rejects(() => submitAs(w, p, EMPLOYEE), /direct_initiation_mixed_psps/);
  const refused = w.trace.events.find((e) => e.event === 'request_refused');
  assert.equal(refused?.detail?.kind, 'submit');
  assert.equal(refused?.detail?.reason, 'direct_initiation_mixed_psps');
  assert.deepEqual(refused?.detail?.providers, ['psp-employee-1', 'psp-employer-1']);
  assert.equal(p.state, 'ready');
  assert.equal(reservedLegs(w), 0, 'nothing reached a provider');
});

test('the direct modes differ only on mixed providers: bypass submits, shared provider submits', async () => {
  // test_bypass_psp lifts the guard: the same mixed-provider purchase goes
  // out in one request — the fixture this file's guarded sibling refuses.
  const bypass = world({}, {}, { initiation: 'test_bypass_psp' });
  const bp = lunch(bypass);
  approveAs(bypass, bp);
  await submitAs(bypass, bp, EMPLOYEE);
  assert.equal(bp.state, 'completed');
  assert.equal(payeeBankCents(bypass, MERCHANT_A), 1_300);
  // coordinator_as_psp is honest when the fixture puts every payer of the
  // purchase on the coordinator's own provider: one provider, one request.
  const shared = world({}, {}, { initiation: 'coordinator_as_psp', providerFor: () => 'psp-shared' });
  const sp = lunch(shared);
  approveAs(shared, sp);
  await submitAs(shared, sp, EMPLOYEE);
  assert.equal(sp.state, 'completed');
  assert.equal(payeeBankCents(shared, MERCHANT_A), 1_300);
});

test('the initiation_mode event stamps the trace first with the resolved mode', () => {
  for (const mode of ['per_payer_psp', 'coordinator_as_psp', 'test_bypass_psp'] as const) {
    const w = world({}, {}, { initiation: mode });
    const first = w.trace.events[0];
    assert.equal(first.event, 'initiation_mode');
    assert.equal(first.actor, 'world');
    assert.equal(first.origin, 'LOCAL');
    assert.equal(first.detail?.mode, mode);
  }
  // An absent option resolves to the default and is labelled as such.
  assert.equal(world().trace.events[0].detail?.mode, 'per_payer_psp');
});

test('contradictory and unrecognized initiation fixtures fail loudly', () => {
  // A stale mode string is a fixture bug, not a mode — never silently
  // assigned one.
  assert.throws(() => world({}, {}, { initiation: 'coordinator' as never }), /unknown initiation mode/);
  // Two payers on one provider cannot disagree about mandate capability.
  assert.throws(
    () =>
      world({}, {}, {
        providerFor: () => 'psp-shared',
        supportsMandatePayments: (id) => id === EMPLOYEE,
      }),
    /conflicting supportsMandatePayments for shared provider/,
  );
  // An unrecognized initiation kind never reaches a route — the kind check
  // throws before the settlement factory is even invoked.
  const w = world();
  assert.throws(() => coordinatorFor(w, { initiation: { kind: 'typo' } as never }), /unknown initiation kind/);
});

test('a deferred group outcome produces no same-moment resolution and stays pending for reconcile', async () => {
  const w = perPsp();
  // The employer leg's pay credit applies but its response is lost: no leg
  // reports the group's conclusive result, so the send must not manufacture
  // a status — a genuinely unresolved operation stays pending until
  // reconcile() asks through each leg's own route.
  w.providers.get(EMPLOYER)!.setFault(
    legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a'),
    'credit',
    'lose_response_after_effect',
  );
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  assert.equal(p.legs[1].status, 'unknown');
  assert.equal(p.legs[0].status, 'unknown');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
});

test('a deferred digital-euro group resolves every member on its authoritative outcome', async () => {
  const w = perPsp();
  // The employee leg's group commit parks deferred: the replay sees the
  // pending record and never re-dispatches; only an explicit deferred
  // resolution gives the group its conclusive outcome.
  w.digitalEuro.setFault(deGroupKey('purchase-1', 1, ['employee']), 'commit', 'defer');
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  w.digitalEuro.resolveDeferred(deGroupKey('purchase-1', 1, ['employee']), 'succeed');
  await w.coordinator.reconcile(p.purchaseId);
  assert.equal(p.state, 'completed');
  assert.equal(payerBankCents(w, EMPLOYER), 100_000 - 500);
  assert.equal(payerDeCents(w, EMPLOYEE), 2_000 - 800);
});
