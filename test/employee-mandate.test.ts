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
import {
  world,
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
  const w = world();
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE), undefined);
});

test('the initial publication must be version 1', () => {
  const w = world();
  assert.throws(() => publish(w, terms({ version: 2 })), /employee_mandate_rejected/);
  assert.equal(rejectedEvents(w)[0].detail?.reason, 'version_not_next');
  assert.equal(rejectedEvents(w)[0].detail?.version, 2);
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
  const w = world();
  const signed = signPayload(terms(), w.signers.get(EMPLOYEE)!);
  w.coordinator.publishEmployeeMandate(signed);
  assert.deepEqual(w.coordinator.employeeMandate(EMPLOYEE), signed);
  const published = w.trace.events.filter((e) => e.event === 'employee_mandate_published');
  assert.equal(published.length, 1);
  assert.equal(published[0].origin, 'LOCAL');
  assert.equal(published[0].detail?.employeeId, EMPLOYEE);
  assert.equal(published[0].detail?.mandateRef, 'employee-mandate-1');
  assert.equal(published[0].detail?.version, 1);
});

test('the next version replaces the accepted terms', () => {
  const w = world();
  publish(w, terms());
  publish(w, terms({ version: 2, maxCents: 1_200, revoked: true }));
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(current.payload.version, 2);
  assert.equal(current.payload.maxCents, 1_200);
  assert.equal(current.payload.revoked, true);
});

test('a replayed signed record is rejected and preserves the accepted terms', () => {
  const w = world();
  const signed = signPayload(terms(), w.signers.get(EMPLOYEE)!);
  w.coordinator.publishEmployeeMandate(signed);
  const before = w.coordinator.employeeMandate(EMPLOYEE);
  // Replaying the identical signed record is a stale version, not a no-op.
  assert.throws(() => w.coordinator.publishEmployeeMandate(signed), /employee_mandate_rejected/);
  assert.deepEqual(w.coordinator.employeeMandate(EMPLOYEE), before);
});

test('mutating the caller-held signed record cannot alter stored terms', () => {
  const w = world();
  const signed = signPayload(terms(), w.signers.get(EMPLOYEE)!);
  w.coordinator.publishEmployeeMandate(signed);
  signed.payload.maxCents = 999_999;
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)!.payload.maxCents, 1_000);
});

test('a returned record is detached: mutating it changes nothing stored', () => {
  const w = world();
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
  const w = world();
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
  const w = world();
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
  const w = world();
  // The employer registry already holds 'mandate-1'. An employee record under
  // that reference would leave a mandate share citing ambiguous authority.
  assert.throws(() => publish(w, terms({ mandateRef: w.mandate.mandateRef })), /employee_mandate_rejected/);
  assert.equal(rejectedEvents(w)[0].detail?.reason, 'ref_owned_by_employer');
  assert.equal(rejectedEvents(w)[0].detail?.mandateRef, 'mandate-1');
  assert.equal(rejectedEvents(w)[0].detail?.version, 1);
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE), undefined);
});

test('a second employee publishes and revises their own terms alongside the first', () => {
  const w = world();
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
  const w = world();
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
  const w = world();
  const forged = signPayload(terms(), w.signers.get(EMPLOYER)!);
  assert.throws(() => w.coordinator.publishEmployeeMandate(forged), /employee_mandate_rejected/);
  assert.equal(rejectedEvents(w)[0].detail?.reason, 'signature_invalid');
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE), undefined);
});

test('a payload modified after signing is rejected and preserves the record', () => {
  const w = world();
  publish(w, terms());
  const tampered = signPayload(terms({ version: 2 }), w.signers.get(EMPLOYEE)!);
  tampered.payload.maxCents = 999_999;
  assert.throws(() => w.coordinator.publishEmployeeMandate(tampered), /employee_mandate_rejected/);
  assert.equal(rejectedEvents(w)[0].detail?.reason, 'signature_invalid');
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)!.payload.maxCents, 1_000);
});

test('malformed terms are rejected and never displace the accepted record', () => {
  const w = world();
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
  const w = world();
  // Overlap is legal; block precedence is applied at assessment time, not by
  // rejecting the publication.
  publish(w, terms({ trustedMerchants: [MERCHANT_A, MERCHANT_C], blockedMerchants: [MERCHANT_C] }));
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.deepEqual(current.payload.trustedMerchants, [MERCHANT_A, MERCHANT_C]);
  assert.deepEqual(current.payload.blockedMerchants, [MERCHANT_C]);
});

test('a revoked revision emits employee_mandate_revoked, not a second published event', () => {
  const w = world();
  publish(w, terms());
  updateEmployeeMandate(w, { revoked: true });
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(current.payload.version, 2);
  assert.equal(current.payload.revoked, true);
  const revoked = w.trace.events.filter((e) => e.event === 'employee_mandate_revoked');
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].origin, 'LOCAL');
  assert.equal(revoked[0].detail?.version, 2);
  assert.equal(w.trace.events.filter((e) => e.event === 'employee_mandate_published').length, 1);
});

test('a first-ever revoked publication emits employee_mandate_revoked, not published', () => {
  const w = world();
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
  const w = world();
  const signed = signPayload(terms(), w.signers.get(EMPLOYEE)!);
  w.coordinator.publishEmployeeMandate(signed);
  // Corrupt the coordinator's trust base: the retained record can no longer
  // be verified, which is invalid data — not a missing mandate.
  w.keys.delete(signed.keyId);
  assert.throws(() => w.coordinator.employeeMandate(EMPLOYEE), /employee_mandate_invalid/);
});

test('updateEmployeeMandate merges editable terms, bumps the version and re-signs', () => {
  const w = world();
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
  const w = world();
  publish(w, terms());
  updateEmployeeMandate(w, { employeeId: 'mallory', version: 99 });
  const current = w.coordinator.employeeMandate(EMPLOYEE)!;
  assert.equal(current.payload.version, 2);
  assert.equal(current.payload.employeeId, EMPLOYEE);
});

test('updateEmployeeMandate requires a published record', () => {
  const w = world();
  assert.throws(() => updateEmployeeMandate(w, { maxCents: 1_500 }), /no published employee mandate/);
});

test('explicit employee fixture terms are published at world setup', () => {
  const w = world({}, {}, { employeeMandate: terms() });
  assert.equal(w.coordinator.employeeMandate(EMPLOYEE)!.payload.version, 1);
  // A plain world still has no employee mandate until Task 4's manual defaults.
  assert.equal(world().coordinator.employeeMandate(EMPLOYEE), undefined);
});
