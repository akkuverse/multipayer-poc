// Signed standing employee terms (employee mandate, spec §3): publication is
// the trust decision — only the employee can replace their terms, a failed
// write preserves the accepted record, and returned records are detached so
// callers cannot mutate accepted signed data. The employer registry's
// unverified-publication pattern does not apply here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPayload } from '../src/core/signing.ts';
import type { Signed } from '../src/core/signing.ts';
import type { EmployeeMandate } from '../src/core/types.ts';
import { approvalCents, approvalFeeCents } from '../src/core/coordinator.ts';
import {
  world,
  lunch,
  approveAs,
  advance,
  updateEmployeeMandate,
  EMPLOYEE,
  COLLEAGUE_1,
  EMPLOYER,
  MERCHANT_A,
  MERCHANT_C,
} from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';

// The complete default terms from spec §12.
const TERMS: EmployeeMandate = {
  mandateRef: 'employee-mandate-1',
  employeeId: EMPLOYEE,
  version: 1,
  autoPayMaxCents: 600,
  maxCents: 1_000,
  autoPayMonthlyCents: 3_000,
  trustedMerchants: [MERCHANT_A],
  blockedMerchants: [],
  validUntil: 1_000,
  revoked: false,
};

const terms = (over: Partial<EmployeeMandate> = {}): EmployeeMandate => ({ ...TERMS, ...over });

// Sign with the employee's own fixture key and publish through the coordinator.
const publish = (w: World, t: EmployeeMandate): void =>
  w.coordinator.publishEmployeeMandate(signPayload(t, w.signers.get(t.employeeId)!));

const rejectedEvents = (w: World) => w.trace.events.filter((e) => e.event === 'employee_mandate_rejected');

test('an employee with no published record reads as absent, not a mandate', () => {
  const w = world({}, {}, { employeeMandate: null });
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE), undefined);
});

test('the initial publication must be version 1', () => {
  const w = world({}, {}, { employeeMandate: null });
  assert.throws(() => publish(w, terms({ version: 2 })), /employee_mandate_rejected/);
  assert.equal(rejectedEvents(w)[0].detail?.reason, 'version_not_next');
  assert.equal(rejectedEvents(w)[0].detail?.version, 2);
  assert.equal(rejectedEvents(w)[0].detail?.now, 10, 'the rejection records simulated time');
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE), undefined);
  // A fresh employee's first record likewise starts at 1.
  assert.throws(
    () =>
      w.coordinator.publishEmployeeMandate(
        signPayload(terms({ mandateRef: 'employee-mandate-2', employeeId: COLLEAGUE_1, version: 2 }), w.signers.get(COLLEAGUE_1)!),
      ),
    /employee_mandate_rejected/,
  );
  assert.equal(rejectedEvents(w)[1].detail?.version, 2);
});

test('publication stores the verified terms and logs one LOCAL event', () => {
  const w = world({}, {}, { employeeMandate: null });
  const signed = signPayload(terms(), w.signers.get(EMPLOYEE)!);
  w.coordinator.publishEmployeeMandate(signed);
  assert.deepEqual(w.coordinator.employeeMandate(EMPLOYEE), signed);
  const published = w.trace.events.filter((e) => e.event === 'employee_mandate_published');
  assert.equal(published.length, 1);
  assert.equal(published[0].origin, 'LOCAL');
  assert.equal(published[0].detail?.employeeId, EMPLOYEE);
  assert.equal(published[0].detail?.mandateRef, 'employee-mandate-1');
  assert.equal(published[0].detail?.version, 1);
  assert.equal(published[0].detail?.now, 10, 'the publication records simulated time');
});

test('the next version replaces the accepted terms', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  publish(w, terms({ version: 2, maxCents: 1_200, revoked: true }));
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(current.payload.version, 2);
  assert.equal(current.payload.maxCents, 1_200);
  assert.equal(current.payload.revoked, true);
});

test('a replayed signed record is rejected and preserves the accepted terms', () => {
  const w = world({}, {}, { employeeMandate: null });
  const signed = signPayload(terms(), w.signers.get(EMPLOYEE)!);
  w.coordinator.publishEmployeeMandate(signed);
  const before = w.coordinator.employeeMandate(EMPLOYEE);
  // Replaying the identical signed record is a stale version, not a no-op.
  assert.throws(() => w.coordinator.publishEmployeeMandate(signed), /employee_mandate_rejected/);
  assert.deepEqual(w.coordinator.employeeMandate(EMPLOYEE), before);
});

test('mutating the caller-held signed record cannot alter stored terms', () => {
  const w = world({}, {}, { employeeMandate: null });
  const signed = signPayload(terms(), w.signers.get(EMPLOYEE)!);
  w.coordinator.publishEmployeeMandate(signed);
  signed.payload.maxCents = 999_999;
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)!.payload.maxCents, 1_000);
});

test('a returned record is detached: mutating it changes nothing stored', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  const read = w.coordinator.employeeMandate(EMPLOYEE)!;
  read.payload.maxCents = 999_999;
  read.payload.blockedMerchants.push(MERCHANT_C);
  read.signature = 'tampered';
  const again = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(again.payload.maxCents, 1_000);
  assert.deepEqual(again.payload.blockedMerchants, []);
});

test('a stale or skipped version is rejected and preserves the accepted record', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  publish(w, terms({ version: 2 }));
  // Older than the accepted record.
  const stale = signPayload(terms(), w.signers.get(EMPLOYEE)!);
  assert.throws(() => w.coordinator.publishEmployeeMandate(stale), /employee_mandate_rejected/);
  // Jumping past the next version is not a replacement either.
  assert.throws(() => publish(w, terms({ version: 4 })), /employee_mandate_rejected/);
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(current.payload.version, 2);
  // Each rejection reports the proposed revision, not the accepted one.
  assert.deepEqual(
    rejectedEvents(w).map((e) => [e.detail?.reason, e.detail?.version]),
    [
      ['version_not_next', 1],
      ['version_not_next', 4],
    ],
  );
});

test('a mandate reference cannot be taken by another employee', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  // Correctly signed by colleague-1 for themselves — but the reference was
  // bound to employee-1 by its first publication.
  const foreign = signPayload(terms({ employeeId: COLLEAGUE_1 }), w.signers.get(COLLEAGUE_1)!);
  assert.throws(() => w.coordinator.publishEmployeeMandate(foreign), /employee_mandate_rejected/);
  assert.equal(rejectedEvents(w)[0].detail?.reason, 'ref_owned_by_another_employee');
  assert.equal(w.coordinator.employeeMandate(COLLEAGUE_1), undefined);
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)!.payload.mandateRef, 'employee-mandate-1');
});

test('an employee mandate reference cannot reuse the employer mandate reference', () => {
  const w = world({}, {}, { employeeMandate: null });
  // The employer registry already holds 'mandate-1'. An employee record under
  // that reference would leave a mandate share citing ambiguous authority.
  assert.throws(() => publish(w, terms({ mandateRef: w.mandate.mandateRef })), /employee_mandate_rejected/);
  assert.equal(rejectedEvents(w)[0].detail?.reason, 'ref_owned_by_employer');
  assert.equal(rejectedEvents(w)[0].detail?.mandateRef, 'mandate-1');
  assert.equal(rejectedEvents(w)[0].detail?.version, 1);
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE), undefined);
});

test('a second employee publishes and revises their own terms alongside the first', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  // Each employee owns a separate record and version sequence: colleague-1's
  // first publication is version 1 under a fresh reference.
  w.coordinator.publishEmployeeMandate(
    signPayload(terms({ mandateRef: 'employee-mandate-2', employeeId: COLLEAGUE_1 }), w.signers.get(COLLEAGUE_1)!),
  );
  // Updating one employee's terms leaves the other's untouched.
  updateEmployeeMandate(w, { maxCents: 1_500 }, COLLEAGUE_1);
  const colleague = w.coordinator.employeeMandate(COLLEAGUE_1)!;
  assert.equal(colleague.payload.mandateRef, 'employee-mandate-2');
  assert.equal(colleague.payload.version, 2);
  assert.equal(colleague.payload.maxCents, 1_500);
  const first = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(first.payload.mandateRef, 'employee-mandate-1');
  assert.equal(first.payload.version, 1);
  assert.equal(first.payload.maxCents, 1_000);
});

test('the employee can move their terms to a new reference only in sequence', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  // A reference change is a replacement of the standing record, not a fresh
  // start: it must carry the next version.
  publish(w, terms({ mandateRef: 'employee-mandate-2', version: 2 }));
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)!.payload.mandateRef, 'employee-mandate-2');
  // A new reference with version 1 would reset the standing record: refused.
  assert.throws(() => publish(w, terms({ mandateRef: 'employee-mandate-3', version: 1 })), /employee_mandate_rejected/);
  // And the abandoned reference stays bound to employee-1.
  const takeover = signPayload(terms({ mandateRef: 'employee-mandate-1', employeeId: COLLEAGUE_1 }), w.signers.get(COLLEAGUE_1)!);
  assert.throws(() => w.coordinator.publishEmployeeMandate(takeover), /employee_mandate_rejected/);
});

test('terms signed by someone other than the employee are rejected', () => {
  const w = world({}, {}, { employeeMandate: null });
  const forged = signPayload(terms(), w.signers.get(EMPLOYER)!);
  assert.throws(() => w.coordinator.publishEmployeeMandate(forged), /employee_mandate_rejected/);
  assert.equal(rejectedEvents(w)[0].detail?.reason, 'signature_invalid');
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE), undefined);
});

test('a payload modified after signing is rejected and preserves the record', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  const tampered = signPayload(terms({ version: 2 }), w.signers.get(EMPLOYEE)!);
  tampered.payload.maxCents = 999_999;
  assert.throws(() => w.coordinator.publishEmployeeMandate(tampered), /employee_mandate_rejected/);
  assert.equal(rejectedEvents(w)[0].detail?.reason, 'signature_invalid');
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)!.payload.maxCents, 1_000);
});

test('malformed terms are rejected and never displace the accepted record', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  const before = w.coordinator.employeeMandate(EMPLOYEE);
  const bad: unknown[] = [
    null,
    'terms',
    {},
    { payload: null, keyId: 'key', signature: 'sig' },
    terms({ mandateRef: '' }),
    terms({ employeeId: '' }),
    terms({ version: 0 }),
    terms({ version: -3 }),
    terms({ version: 1.5 }),
    terms({ maxCents: -1 }),
    terms({ maxCents: 1_000.5 }),
    terms({ autoPayMaxCents: -1 }),
    // The automatic limit may equal, never exceed, the confirmation maximum.
    terms({ autoPayMaxCents: 1_001 }),
    terms({ autoPayMonthlyCents: -1 }),
    terms({ validUntil: -1 }),
    terms({ validUntil: Number.POSITIVE_INFINITY }),
    terms({ validUntil: Number.NaN }),
    terms({ revoked: undefined as unknown as boolean }),
    terms({ revoked: 1 as unknown as boolean }),
    terms({ trustedMerchants: 'merchant-a' as unknown as string[] }),
    terms({ trustedMerchants: [MERCHANT_A, MERCHANT_A] }),
    terms({ trustedMerchants: [''] }),
    terms({ trustedMerchants: [7 as unknown as string] }),
    terms({ blockedMerchants: [MERCHANT_C, MERCHANT_C] }),
  ];
  for (const b of bad) {
    const signed = signPayload(b, w.signers.get(EMPLOYEE)!) as Signed<EmployeeMandate>;
    assert.throws(() => w.coordinator.publishEmployeeMandate(signed), /employee_mandate_rejected/, JSON.stringify(b));
    assert.deepEqual(w.coordinator.employeeMandate(EMPLOYEE), before, JSON.stringify(b));
  }
  assert.equal(rejectedEvents(w).length, bad.length, 'every rejection is logged exactly once');
});

test('a merchant may appear in both trust and block lists', () => {
  const w = world({}, {}, { employeeMandate: null });
  // Overlap is legal; block precedence is applied at assessment time, not by
  // rejecting the publication.
  publish(w, terms({ trustedMerchants: [MERCHANT_A, MERCHANT_C], blockedMerchants: [MERCHANT_C] }));
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.deepEqual(current.payload.trustedMerchants, [MERCHANT_A, MERCHANT_C]);
  assert.deepEqual(current.payload.blockedMerchants, [MERCHANT_C]);
});

test('a revoked revision emits employee_mandate_revoked, not a second published event', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  updateEmployeeMandate(w, { revoked: true });
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(current.payload.version, 2);
  assert.equal(current.payload.revoked, true);
  const revoked = w.trace.events.filter((e) => e.event === 'employee_mandate_revoked');
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].origin, 'LOCAL');
  assert.equal(revoked[0].detail?.version, 2);
  assert.equal(revoked[0].detail?.now, 10, 'the revocation records simulated time');
  assert.equal(w.trace.events.filter((e) => e.event === 'employee_mandate_published').length, 1);
});

test('a first-ever revoked publication emits employee_mandate_revoked, not published', () => {
  const w = world({}, {}, { employeeMandate: null });
  // Revocation is an accepted revision kind, not a failed write: even as the
  // employee's first record it logs the revocation event exactly once.
  publish(w, terms({ revoked: true }));
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(current.payload.version, 1);
  assert.equal(current.payload.revoked, true);
  const revoked = w.trace.events.filter((e) => e.event === 'employee_mandate_revoked');
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].origin, 'LOCAL');
  assert.equal(revoked[0].detail?.version, 1);
  assert.equal(w.trace.events.filter((e) => e.event === 'employee_mandate_published').length, 0);
});

test('retained terms that no longer verify fail closed, distinctly from absence', () => {
  const w = world({}, {}, { employeeMandate: null });
  const signed = signPayload(terms(), w.signers.get(EMPLOYEE)!);
  w.coordinator.publishEmployeeMandate(signed);
  // Corrupt the coordinator's trust base: the retained record can no longer
  // be verified, which is invalid data — not a missing mandate.
  w.keys.delete(signed.keyId);
  assert.throws(() => w.coordinator.employeeMandate(EMPLOYEE), /employee_mandate_invalid/);
});

test('updateEmployeeMandate merges editable terms, bumps the version and re-signs', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  updateEmployeeMandate(w, { maxCents: 1_500, trustedMerchants: [MERCHANT_A, MERCHANT_C] });
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(current.payload.version, 2);
  assert.equal(current.payload.maxCents, 1_500);
  assert.deepEqual(current.payload.trustedMerchants, [MERCHANT_A, MERCHANT_C]);
  assert.equal(current.payload.employeeId, EMPLOYEE);
  assert.equal(current.payload.mandateRef, 'employee-mandate-1');
});

test('updateEmployeeMandate cannot override identity or version', () => {
  const w = world({}, {}, { employeeMandate: null });
  publish(w, terms());
  updateEmployeeMandate(w, { employeeId: 'mallory', version: 99 });
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(current.payload.version, 2);
  assert.equal(current.payload.employeeId, EMPLOYEE);
});

test('updateEmployeeMandate requires a published record', () => {
  const w = world({}, {}, { employeeMandate: null });
  assert.throws(() => updateEmployeeMandate(w, { maxCents: 1_500 }), /no published employee mandate/);
});

test('world() publishes manual-only terms by default; null opts out', () => {
  const w = world();
  const m = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(m.payload.version, 1);
  assert.equal(m.payload.maxCents, 800);
  assert.equal(m.payload.autoPayMaxCents, 0);
  assert.equal(m.payload.autoPayMonthlyCents, 0);
  assert.equal(world({}, {}, { employeeMandate: null }).coordinator.employeeMandate(EMPLOYEE), undefined);
  const w2 = world({}, {}, { employeeMandate: terms() });
  assert.equal(w2.coordinator.employeeMandate(EMPLOYEE)!.payload.autoPayMaxCents, 600);
});

// --- Task 4: exception basis, revision invalidation and blocks -------------

test('an over-limit proposal accepts only a signed exception acknowledgment', async () => {
  const w = world();
  // EUR 14 total: EUR 5 employer + EUR 9 personal, above the standing EUR 8.
  const p = lunch(w, 1_400);
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.employeeAssessment?.authZone, 'Exception');
  // A plain device signature is not authority here; nothing is recorded.
  assert.throws(() => approveAs(w, p), /does not match/);
  assert.equal(p.authorizations.length, 0);
  assert.equal(w.trace.events.at(-1)?.detail?.reason, 'exceeds_mandate');
  // A signed exception binds the mandate revision, maximum and exact overage.
  approveAs(w, p, EMPLOYEE, { exception: true });
  assert.equal(p.authorizations[0]?.basis, 'exception');
  assert.equal(p.state, 'ready');
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
});

test('a tampered or wrongly valued exception acknowledgment is rejected', () => {
  const w = world();
  const p = lunch(w, 1_400); // EUR 9 personal: EUR 1 over the maximum
  const q = p.proposal;
  const m = w.coordinator.employeeMandate(EMPLOYEE)!.payload;
  const base = {
    approvalRef: 'forged-exception',
    purchaseId: p.purchaseId,
    payerId: EMPLOYEE,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, EMPLOYEE),
    feeCents: approvalFeeCents(q, EMPLOYEE),
    expiresAt: q.expiresAt,
    basis: 'exception' as const,
    exception: true as const,
    mandateRef: m.mandateRef,
    mandateVersion: m.version,
    maxCents: m.maxCents,
    overByCents: 100,
  };
  // A valid signature over wrong acknowledgment fields: terms_mismatch.
  assert.throws(
    () => w.coordinator.approve(p, signPayload({ ...base, overByCents: 1 }, w.signers.get(EMPLOYEE)!)),
    /does not match/,
  );
  // Sign the correct payload, then change only its exception fields: the
  // signature no longer verifies.
  const signed = signPayload(base, w.signers.get(EMPLOYEE)!);
  assert.throws(
    () => w.coordinator.approve(p, { payload: { ...signed.payload, overByCents: 1 }, keyId: signed.keyId, signature: signed.signature }),
    /does not match/,
  );
  const rejected = w.trace.events.filter((e) => e.event === 'approval_rejected');
  assert.deepEqual(rejected.map((e) => e.detail?.reason), ['terms_mismatch', 'signature_invalid']);
  assert.equal(p.authorizations.length, 0);
});

test('an exception acknowledgment has no force inside the standing maximum', () => {
  const w = world();
  const p = lunch(w); // EUR 8 personal: Confirm, not Exception
  assert.equal(p.employeeAssessment?.authZone, 'Confirm');
  assert.throws(() => approveAs(w, p, EMPLOYEE, { exception: true }), /does not match/);
  assert.equal(p.authorizations.length, 0);
});

test('revision invalidates exceptions, keeps in-range device approvals, and a block voids all', async () => {
  const w = world();
  const p = lunch(w, 1_400); // EUR 9 personal
  approveAs(w, p, EMPLOYEE, { exception: true });
  assert.equal(p.state, 'ready');
  // Any revision invalidates the signed exception, even one that would have
  // permitted the same debit.
  updateEmployeeMandate(w, { maxCents: 1_400 });
  assert.equal(p.employeeAssessment?.authZone, 'Confirm');
  assert.equal(p.authorizations.length, 0);
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.employeeAssessment?.authZone, 'Confirm');
  // An ordinary approval within the new maximum survives a compatible
  // revision of the same employee's terms.
  approveAs(w, p);
  updateEmployeeMandate(w, { maxCents: 1_500 });
  assert.equal(p.state, 'ready');
  assert.equal(p.authorizations.length, 1);
  // A block leaves the open purchase draft and invalidates every record.
  updateEmployeeMandate(w, { blockedMerchants: [MERCHANT_A] });
  assert.equal(p.state, 'draft');
  assert.equal(p.reason, 'blocked_merchant');
  assert.equal(p.authorizations.length, 0);
  await assert.rejects(() => w.coordinator.submit(p, 'atomic'), /cannot submit/);
});

// An Auto-zone proposal acquires standing authority as coordinator-recorded
// mandate evidence (spec §5): the verified signed mandate snapshot bound to
// this proposal version and the exact debit — never a fabricated per-purchase
// signature. The monthly budget is admitted atomically at submission (§7–§8).
test('an Auto-zone proposal records mandate evidence and submits without a tap', async () => {
  // Auto-eligible terms with the monthly cap equal to exactly this debit —
  // EUR 9 lunch is EUR 4 employee at a trusted merchant — so the reservation
  // surfaces as monthly_cap on the next assessment.
  const w = world(
    {},
    { maxPerDayCents: 10_000, maxPurchasesPerDay: 10 },
    { supportsMandatePayments: true, employeeMandate: terms({ autoPayMonthlyCents: 400 }) },
  );
  const p = lunch(w, 900);
  assert.equal(p.employeeAssessment?.authZone, 'Auto');
  assert.equal(p.state, 'ready');
  const auth = p.authorizations[0];
  assert.equal(auth?.basis, 'mandate');
  if (auth?.basis !== 'mandate') throw new Error('unreachable');
  // The record binds the verified mandate snapshot, the proposal version and
  // the exact debit — it is the same signed record, not a new signature.
  assert.deepEqual(auth.mandate, w.coordinator.employeeMandate(EMPLOYEE));
  assert.equal(auth.payerId, EMPLOYEE);
  assert.equal(auth.proposalVersion, 1);
  assert.equal(auth.employeeDebitCents, 400);
  const recorded = w.trace.events.filter((e) => e.event === 'approval_recorded');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].detail?.basis, 'mandate');
  assert.equal(recorded[0].detail?.keyId, undefined, 'no fabricated signature identity');
  assert.equal(recorded[0].detail?.mandateVersion, 1);
  assert.equal(recorded[0].detail?.now, 10, 'the recorded evidence carries simulated time');
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
  // The monthly cap was exactly this debit: the whole month is now consumed.
  const second = lunch(w, 900, MERCHANT_A, { purchaseId: 'purchase-2' });
  assert.equal(second.employeeAssessment?.autoPayBlockedReason, 'monthly_cap');
  assert.equal(second.state, 'awaiting_approvals');
});

test('a mandate revision replaces Auto evidence; the new revision funds the purchase', async () => {
  const w = world({}, {}, { supportsMandatePayments: true, employeeMandate: terms() });
  const p = lunch(w, 900);
  assert.equal(p.authorizations[0]?.basis, 'mandate');
  // A revision that still permits Auto invalidates the old evidence and
  // records a fresh snapshot bound to the new version.
  updateEmployeeMandate(w, { autoPayMaxCents: 700 });
  const auth = p.authorizations[0];
  assert.equal(auth?.basis, 'mandate');
  if (auth?.basis !== 'mandate') throw new Error('unreachable');
  assert.equal(auth.mandate.payload.version, 2);
  const invalidated = w.trace.events.filter((e) => e.event === 'approval_invalidated');
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0].detail?.basis, 'mandate');
  assert.equal(invalidated[0].detail?.mandateVersion, 1);
  assert.equal(invalidated[0].detail?.now, 10, 'the invalidation records simulated time');
  const recorded = w.trace.events.filter((e) => e.event === 'approval_recorded');
  assert.equal(recorded.length, 2);
  assert.equal(recorded[1].detail?.mandateVersion, 2);
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
});

test('a stale Auto decision falling to Exception invalidates its record and waits', async () => {
  const w = world({}, {}, { supportsMandatePayments: true, employeeMandate: terms() });
  const p = lunch(w, 900);
  assert.equal(p.state, 'ready');
  // The standing maximum drops below the debit: Exception, never automatic.
  updateEmployeeMandate(w, { maxCents: 300, autoPayMaxCents: 300 });
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(p.employeeAssessment?.authZone, 'Exception');
  assert.equal(p.authorizations.length, 0);
  await assert.rejects(() => w.coordinator.submit(p, 'atomic'), /cannot submit/);
  assert.equal(w.backend.executionCount(), 0);
  // A signed one-off exception is the only way forward.
  approveAs(w, p, EMPLOYEE, { exception: true });
  assert.equal(p.state, 'ready');
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'completed');
});

test('an expired offer fails an automatic initiation without a send', async () => {
  const w = world({}, {}, { supportsMandatePayments: true, employeeMandate: terms() });
  const p = lunch(w, 900, MERCHANT_A, { expiresAt: 20 });
  assert.equal(p.state, 'ready');
  advance(w, 30);
  // Mandate evidence carries no expiry of its own; the dead offer fails
  // initiation before any reservation or send.
  await w.coordinator.submit(p, 'atomic');
  assert.equal(p.state, 'failed');
  assert.equal(p.reason, 'offer_expired');
  assert.equal(w.backend.executionCount(), 0);
  const next = lunch(w, 900, MERCHANT_A, { purchaseId: 'purchase-2' });
  assert.equal(next.employeeAssessment?.authZone, 'Auto', 'no budget was ever held');
});

test('assess() reports the current zone detached, mutating and logging nothing', () => {
  const w = world();
  const p = lunch(w);
  const traceLen = w.trace.events.length;
  const before = structuredClone(p);
  const a = w.coordinator.assess(p);
  assert.deepEqual(a, {
    authZone: 'Confirm',
    employeeDebitCents: 800,
    mandate: { mandateRef: 'employee-mandate-1', version: 1, maxCents: 800 },
    autoPayBlockedReason: 'auto_off',
  });
  // Read-only: the purchase and the trace are exactly as they were.
  assert.deepEqual(p, before);
  assert.equal(w.trace.events.length, traceLen);
  // Detached: scribbling on the answer corrupts nothing stored.
  a.authZone = 'Auto';
  a.mandate!.maxCents = 1;
  assert.equal(w.coordinator.assess(p).authZone, 'Confirm');
  assert.equal(w.coordinator.assess(p).mandate?.maxCents, 800);
  // The answer is current, not the stored point-in-time record: once the
  // clock passes the terms' expiry the stored assessment still says
  // 'auto_off' while assess() already reports mandate_expired.
  advance(w, 1_001);
  assert.equal(p.employeeAssessment?.autoPayBlockedReason, 'auto_off');
  assert.equal(w.coordinator.assess(p).autoPayBlockedReason, 'mandate_expired');
  // A split purchase has no employee terms to assess.
  const split = w.coordinator.proposeSplit({
    purchaseId: 'split-1',
    merchantId: MERCHANT_A,
    shares: [{ role: 'a', payerId: EMPLOYEE, amountCents: 100 }],
    expiresAt: 100,
  });
  assert.throws(() => w.coordinator.assess(split), /split purchases/);
});
