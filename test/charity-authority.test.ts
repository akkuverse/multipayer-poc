// Donor allowances and oracle attestations (spec §3.1): publication to the
// authority registry is the trust decision — only the first donor can
// revise an allowance under its reference, only the class's configured
// attestor can issue its attestations, and a rejected write never displaces
// the accepted record. Acceptance-time owner/class/issuer/version facts
// live outside the mutable retained records, so corrupting retained data
// fails closed at the next verified read. The registry audits
// publish/reject events itself (actor 'registry', origin LOCAL).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPayload } from '../src/core/signing.ts';
import type { Signed } from '../src/core/signing.ts';
import type { AllowanceMandate, EligibilityAttestation } from '../src/core/types.ts';
import { AuthorityRegistry } from '../src/core/authority.ts';
import { VerifiedAuthority } from '../src/core/verified-authority.ts';
import {
  world,
  publishAllowanceAs,
  publishAttestationAs,
  updateEmployeeMandate,
  updateMandate,
  EMPLOYER,
  EMPLOYEE,
  DONOR_1,
  DONOR_2,
  ORACLE_1,
  RESIDENT_1,
  RESIDENT_2,
  IN_NEED,
  CHARITY_1,
} from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';

// A complete, valid donor allowance for the in_need class.
const ALLOWANCE: AllowanceMandate = {
  allowanceRef: 'allowance-1',
  donorId: DONOR_1,
  version: 1,
  beneficiaryClass: IN_NEED,
  maxPerPurchaseCents: 1_000,
  maxPerDayCents: 2_000,
  maxPurchasesPerDay: 2,
  totalEndowmentCents: 10_000,
  eligibleMerchants: [CHARITY_1],
  validFrom: 0,
  validUntil: 1_000,
  revoked: false,
  privacyProfile: 'anonymous_donation_v1',
};

const allowance = (over: Partial<AllowanceMandate> = {}): AllowanceMandate => ({ ...ALLOWANCE, ...over });

// A complete, valid attestation of resident-1 into in_need by oracle-1.
const ATTESTATION: EligibilityAttestation = {
  attestorId: ORACLE_1,
  subjectId: RESIDENT_1,
  classId: IN_NEED,
  validFrom: 0,
  validUntil: 1_000,
  version: 1,
  revoked: false,
};

const attestation = (over: Partial<EligibilityAttestation> = {}): EligibilityAttestation => ({ ...ATTESTATION, ...over });

const scope = (w: World) => new VerifiedAuthority(w.authority, w.keys);

const allowanceRejected = (w: World) => w.trace.events.filter((e) => e.event === 'allowance_mandate_rejected');
const attestationRejected = (w: World) => w.trace.events.filter((e) => e.event === 'eligibility_attestation_rejected');

test('a valid allowance publishes, enumerates and verifies at use', () => {
  const w = world();
  const signed = publishAllowanceAs(w, allowance());
  assert.deepEqual(w.authority.allowanceRefs(), ['allowance-1']);
  const published = w.trace.events.filter((e) => e.event === 'allowance_mandate_published');
  assert.equal(published.length, 1);
  assert.equal(published[0].origin, 'LOCAL');
  assert.equal(published[0].actor, 'registry');
  assert.equal(published[0].detail?.donorId, DONOR_1);
  assert.equal(published[0].detail?.allowanceRef, 'allowance-1');
  assert.equal(published[0].detail?.version, 1);
  assert.equal(published[0].detail?.now, 10, 'the publication records simulated time');
  const resolved = scope(w).allowance('allowance-1');
  assert.equal(resolved.problem, undefined);
  assert.deepEqual(resolved.signed, signed);
});

test('an allowance reference cannot alias the employer mandate or employee terms', () => {
  const w = world();
  // 'mandate-1' is the world's accepted employer reference.
  assert.throws(() => publishAllowanceAs(w, allowance({ allowanceRef: 'mandate-1' })), /allowance_mandate_rejected:ref_owned_by_employer/);
  // 'employee-mandate-1' is bound to the employee's standing terms.
  assert.throws(() => publishAllowanceAs(w, allowance({ allowanceRef: 'employee-mandate-1' })), /allowance_mandate_rejected:ref_owned_by_employee/);
  assert.equal(w.authority.allowanceRefs().length, 0);
});

test('employer and employee publications cannot alias an allowance reference', () => {
  const w = world();
  publishAllowanceAs(w, allowance());
  // A fresh employer reference under the taken name is refused on the
  // employer's own publish path.
  assert.throws(
    () =>
      w.authority.publishEmployerMandate(
        signPayload({ ...w.mandate, mandateRef: 'allowance-1', version: 1 }, w.signers.get(EMPLOYER)!),
      ),
    /employer_mandate_rejected:ref_owned_by_allowance/,
  );
  // The employee's first publication under that reference is refused too.
  const w2 = world({}, {}, { employeeMandate: null });
  publishAllowanceAs(w2, allowance());
  assert.throws(
    () =>
      w2.authority.publishEmployeeMandate(
        signPayload(
          {
            mandateRef: 'allowance-1',
            employeeId: EMPLOYEE,
            version: 1,
            autoPayMaxCents: 0,
            maxCents: 800,
            autoPayMonthlyCents: 0,
            trustedMerchants: [],
            blockedMerchants: [],
            allowedRails: ['digital_euro'],
            validUntil: 1_000,
            revoked: false,
          },
          w2.signers.get(EMPLOYEE)!,
        ),
      ),
    /employee_mandate_rejected:ref_owned_by_allowance/,
  );
});

test('an employee reference change cannot alias an allowance reference', () => {
  const w = world();
  publishAllowanceAs(w, allowance());
  // Moving the standing terms onto the taken reference hits the same
  // exclusivity check as a first publication.
  assert.throws(() => updateEmployeeMandate(w, { mandateRef: 'allowance-1' }), /employee_mandate_rejected:ref_owned_by_allowance/);
  assert.equal(w.authority.employeeMandate(EMPLOYEE)!.payload.mandateRef, 'employee-mandate-1');
});

test('the first allowance version must be 1, then exactly next — a rejected update preserves the accepted record', () => {
  const w = world();
  assert.throws(() => publishAllowanceAs(w, allowance({ version: 2 })), /allowance_mandate_rejected:version_not_next/);
  publishAllowanceAs(w, allowance());
  // Skipping ahead and replaying the accepted revision are both refused.
  assert.throws(() => publishAllowanceAs(w, allowance({ version: 3 })), /allowance_mandate_rejected:version_not_next/);
  assert.throws(() => publishAllowanceAs(w, allowance()), /allowance_mandate_rejected:version_not_next/);
  // A malformed revision is refused the same way: nothing displaces v1.
  assert.throws(
    () => publishAllowanceAs(w, allowance({ version: 2, maxPerPurchaseCents: -1 })),
    /allowance_mandate_rejected:malformed/,
  );
  assert.equal(w.authority.allowanceMandate('allowance-1')!.signed.payload.version, 1);
  assert.equal(w.authority.allowanceMandate('allowance-1')!.signed.payload.maxPerPurchaseCents, 1_000);
  assert.equal(scope(w).allowance('allowance-1').allowance!.version, 1);
});

test('allowance revisions keep the first donor and beneficiary class', () => {
  const w = world();
  publishAllowanceAs(w, allowance());
  // Another donor's correctly signed takeover of the same reference.
  assert.throws(
    () => publishAllowanceAs(w, allowance({ donorId: DONOR_2, version: 2 })),
    /allowance_mandate_rejected:ref_owned_by_another_donor/,
  );
  // The same donor cannot move the reference to another class.
  assert.throws(
    () => publishAllowanceAs(w, allowance({ beneficiaryClass: 'other_class', version: 2 })),
    /allowance_mandate_rejected:beneficiary_class_changed/,
  );
  // A revision naming the owner but signed under another donor's key.
  assert.throws(
    () => w.authority.publishAllowanceMandate(signPayload(allowance({ version: 2 }), w.signers.get(DONOR_2)!)),
    /allowance_mandate_rejected:signature_invalid/,
  );
  // The accepted record is untouched.
  const retained = w.authority.allowanceMandate('allowance-1')!.signed.payload;
  assert.equal(retained.version, 1);
  assert.equal(retained.donorId, DONOR_1);
  assert.equal(retained.beneficiaryClass, IN_NEED);
});

test('a donor may revise terms and revoke through the next version', () => {
  const w = world();
  publishAllowanceAs(w, allowance());
  publishAllowanceAs(w, allowance({ version: 2, maxPerDayCents: 1_500 }));
  assert.equal(w.authority.allowanceMandate('allowance-1')!.signed.payload.maxPerDayCents, 1_500);
  publishAllowanceAs(w, allowance({ version: 3, maxPerDayCents: 1_500, revoked: true }));
  const retained = w.authority.allowanceMandate('allowance-1')!.signed.payload;
  assert.equal(retained.version, 3);
  assert.equal(retained.revoked, true);
  // Revocation is an accepted revision, audited as its own LOCAL event.
  const revoked = w.trace.events.filter((e) => e.event === 'allowance_mandate_revoked');
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].origin, 'LOCAL');
  assert.equal(revoked[0].actor, 'registry');
  assert.equal(revoked[0].detail?.version, 3);
  assert.equal(w.trace.events.filter((e) => e.event === 'allowance_mandate_published').length, 2);
  // A revoked record still resolves: revocation is temporal policy input
  // for the caller, not signature absence or corruption.
  const resolved = scope(w).allowance('allowance-1');
  assert.equal(resolved.problem, undefined);
  assert.equal(resolved.allowance!.revoked, true);
});

test('signed malformed allowances are rejected without displacing the accepted record', () => {
  const w = world();
  publishAllowanceAs(w, allowance());
  const before = w.authority.allowanceMandate('allowance-1')!.signed;
  const bad: unknown[] = [
    null,
    'allowance',
    {},
    { payload: null, keyId: 'key', signature: 'sig' },
    allowance({ allowanceRef: '' }),
    allowance({ donorId: '' }),
    allowance({ beneficiaryClass: '' }),
    allowance({ version: 0 }),
    allowance({ version: 1.5 }),
    allowance({ maxPerPurchaseCents: -1 }),
    allowance({ maxPerPurchaseCents: 1_000.5 }),
    allowance({ maxPerDayCents: -1 }),
    allowance({ maxPurchasesPerDay: -1 }),
    allowance({ maxPurchasesPerDay: 1.5 }),
    allowance({ totalEndowmentCents: -1 }),
    allowance({ totalEndowmentCents: 1.5 as unknown as number }),
    allowance({ eligibleMerchants: 'charity-1' as unknown as string[] }),
    allowance({ eligibleMerchants: [CHARITY_1, CHARITY_1] }),
    allowance({ eligibleMerchants: [''] }),
    allowance({ validFrom: -1 }),
    allowance({ validFrom: Number.NaN }),
    allowance({ validUntil: Number.POSITIVE_INFINITY }),
    // A window that never opens is malformed, not merely expired.
    allowance({ validFrom: 500, validUntil: 100 }),
    allowance({ revoked: 1 as unknown as boolean }),
    allowance({ privacyProfile: undefined as unknown as AllowanceMandate['privacyProfile'] }),
    // A cross-arrangement profile is malformed — a signed record without
    // the recognized profile can never authorize new work.
    allowance({ privacyProfile: 'employer_benefit_v1' as unknown as AllowanceMandate['privacyProfile'] }),
    allowance({ privacyProfile: 'split_bill_v1' as unknown as AllowanceMandate['privacyProfile'] }),
  ];
  for (const b of bad) {
    const signed = signPayload(b, w.signers.get(DONOR_1)!) as Signed<AllowanceMandate>;
    assert.throws(() => w.authority.publishAllowanceMandate(signed), /allowance_mandate_rejected/, JSON.stringify(b));
    assert.equal(w.authority.allowanceMandate('allowance-1')!.signed, before, JSON.stringify(b));
  }
  assert.equal(allowanceRejected(w).length, bad.length, 'every rejection is logged exactly once');
});

test('a retained allowance corrupted after acceptance fails closed at use', () => {
  const w = world();
  publishAllowanceAs(w, allowance());
  const stored = w.authority.allowanceMandate('allowance-1')!.signed;
  // Corrupt a signed field in place: the next verified read sees new
  // content and the signature check fails — never 'allowance_unknown'.
  stored.payload.maxPerPurchaseCents = 999_999;
  assert.equal(scope(w).allowance('allowance-1').problem, 'allowance_signature_invalid');
  // Corruption into a schema-invalid shape is its own problem, distinct
  // from a broken signature or a swapped binding.
  stored.payload.version = 0;
  assert.equal(scope(w).allowance('allowance-1').problem, 'allowance_malformed');
  // A fault-injected field outside the signed domain — a BigInt the
  // schema check does not name — makes canonicalisation throw during
  // verification: malformed retained authority, never a raw TypeError.
  const w2 = world();
  publishAllowanceAs(w2, allowance());
  const injected = w2.authority.allowanceMandate('allowance-1')!.signed.payload as Record<string, unknown>;
  injected.extra = 10n;
  assert.equal(scope(w2).allowance('allowance-1').problem, 'allowance_malformed');
});

test('a retained record swapped for a differently bound signed record fails closed', () => {
  const w = world();
  publishAllowanceAs(w, allowance());
  publishAllowanceAs(w, allowance({ allowanceRef: 'allowance-2' }));
  const stored = w.authority.allowanceMandate('allowance-1')!.signed;
  // Inject allowance-2's correctly signed record into allowance-1's slot:
  // the signature verifies under the same donor, so only the lookup and
  // acceptance-time binding distinguish it — invalid, not absent.
  const other = w.authority.allowanceMandate('allowance-2')!.signed;
  stored.payload = structuredClone(other.payload);
  stored.keyId = other.keyId;
  stored.signature = other.signature;
  assert.equal(scope(w).allowance('allowance-1').problem, 'allowance_binding_invalid');
  // A swapped-in record naming the first reference's class but the wrong
  // donor is caught the same way.
  const w2 = world();
  publishAllowanceAs(w2, allowance());
  publishAllowanceAs(w2, allowance({ allowanceRef: 'allowance-9', donorId: DONOR_2 }));
  const first = w2.authority.allowanceMandate('allowance-1')!.signed;
  const foreign = w2.authority.allowanceMandate('allowance-9')!.signed;
  first.payload = structuredClone(foreign.payload);
  first.keyId = foreign.keyId;
  first.signature = foreign.signature;
  assert.equal(scope(w2).allowance('allowance-1').problem, 'allowance_binding_invalid');
});

test('a buyer cannot attest itself', () => {
  const w = world();
  // Claiming to be its own attestor: the class maps to oracle-1 alone —
  // the resident's registered key confers no attestation privilege.
  assert.throws(() => publishAttestationAs(w, attestation({ attestorId: RESIDENT_1 })), /eligibility_attestation_rejected:attestor_not_trusted/);
  // Claiming the oracle's identity under the buyer's own key: the issuer
  // is trusted, but the signature is not the oracle's.
  assert.throws(
    () => w.authority.publishEligibilityAttestation(signPayload(attestation(), w.signers.get(RESIDENT_1)!)),
    /eligibility_attestation_rejected:signature_invalid/,
  );
  assert.equal(w.authority.eligibilityAttestation(RESIDENT_1, IN_NEED), undefined);
});

test('a registered wrong issuer cannot attest', () => {
  const w = world();
  // Another registered key holder as the claimed issuer.
  assert.throws(() => publishAttestationAs(w, attestation({ attestorId: RESIDENT_2 })), /eligibility_attestation_rejected:attestor_not_trusted/);
  // The trusted attestor named, but signed under a different registered key.
  assert.throws(
    () => w.authority.publishEligibilityAttestation(signPayload(attestation(), w.signers.get(EMPLOYER)!)),
    /eligibility_attestation_rejected:signature_invalid/,
  );
  // An unconfigured class accepts nothing, even from the oracle.
  assert.throws(() => publishAttestationAs(w, attestation({ classId: 'other_class' })), /eligibility_attestation_rejected:attestor_not_trusted/);
});

test('a world with an empty trust map admits no attestations', () => {
  const w = world({}, {}, { trustedAttestors: new Map() });
  assert.throws(() => publishAttestationAs(w, attestation()), /eligibility_attestation_rejected:attestor_not_trusted/);
});

test('external mutation of the constructor trust map has no effect', () => {
  const w = world();
  const trusted = new Map([[IN_NEED, ORACLE_1]]);
  const registry = new AuthorityRegistry(w.keys, w.trace, () => 10, trusted);
  // Retarget and extend the caller's map after construction.
  trusted.set(IN_NEED, RESIDENT_1);
  trusted.set('other_class', RESIDENT_2);
  // The detached configuration still governs: oracle-1 for in_need.
  registry.publishEligibilityAttestation(signPayload(attestation(), w.signers.get(ORACLE_1)!));
  assert.throws(
    () => registry.publishEligibilityAttestation(signPayload(attestation({ attestorId: RESIDENT_1 }), w.signers.get(RESIDENT_1)!)),
    /eligibility_attestation_rejected:attestor_not_trusted/,
  );
  assert.throws(
    () => registry.publishEligibilityAttestation(signPayload(attestation({ attestorId: RESIDENT_2, classId: 'other_class' }), w.signers.get(RESIDENT_2)!)),
    /eligibility_attestation_rejected:attestor_not_trusted/,
  );
});

test('attestations are stored per (subject, class); wrong lookups read absent, not invalid', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  const published = w.trace.events.filter((e) => e.event === 'eligibility_attestation_published');
  assert.equal(published.length, 1);
  assert.equal(published[0].origin, 'LOCAL');
  assert.equal(published[0].actor, 'registry');
  assert.equal(published[0].detail?.subjectId, RESIDENT_1);
  assert.equal(published[0].detail?.classId, IN_NEED);
  const s = scope(w);
  assert.equal(s.attestation(RESIDENT_1, IN_NEED).attestation!.subjectId, RESIDENT_1);
  // Another subject or another class finds nothing: genuinely absent
  // records, distinct from retained-but-invalid authority.
  assert.equal(s.attestation(RESIDENT_2, IN_NEED).problem, 'attestation_absent');
  assert.equal(s.attestation(RESIDENT_1, 'other_class').problem, 'attestation_absent');
});

test('attestation revisions require the next version; revocation is an accepted revision', () => {
  const w = world();
  assert.throws(() => publishAttestationAs(w, attestation({ version: 2 })), /eligibility_attestation_rejected:version_not_next/);
  publishAttestationAs(w, attestation());
  assert.throws(() => publishAttestationAs(w, attestation({ version: 3 })), /eligibility_attestation_rejected:version_not_next/);
  assert.throws(() => publishAttestationAs(w, attestation()), /eligibility_attestation_rejected:version_not_next/);
  publishAttestationAs(w, attestation({ version: 2, revoked: true }));
  const revoked = w.trace.events.filter((e) => e.event === 'eligibility_attestation_revoked');
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].detail?.version, 2);
  // A still-validly-signed revision predating the revocation can never
  // displace the accepted record — the version sequence is the rollback
  // guard, same as the allowance case.
  assert.throws(() => publishAttestationAs(w, attestation()), /eligibility_attestation_rejected:version_not_next/);
  const retained = w.authority.eligibilityAttestation(RESIDENT_1, IN_NEED)!.signed.payload;
  assert.equal(retained.version, 2);
  assert.equal(retained.revoked, true);
  // Revocation resolves as a valid record — temporal ineligibility is
  // policy input for the caller, not signature absence.
  const resolved = scope(w).attestation(RESIDENT_1, IN_NEED);
  assert.equal(resolved.problem, undefined);
  assert.equal(resolved.attestation!.revoked, true);
});

test('malformed attestations are rejected and preserve accepted authority', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  const bad: unknown[] = [
    null,
    'attestation',
    {},
    { payload: null, keyId: 'key', signature: 'sig' },
    attestation({ attestorId: '' }),
    attestation({ subjectId: '' }),
    attestation({ classId: '' }),
    attestation({ version: 0 }),
    attestation({ version: 1.5 }),
    attestation({ validFrom: -1 }),
    attestation({ validFrom: Number.NaN }),
    attestation({ validUntil: Number.POSITIVE_INFINITY }),
    attestation({ validFrom: 500, validUntil: 100 }),
    attestation({ revoked: 'yes' as unknown as boolean }),
  ];
  for (const b of bad) {
    const signed = signPayload(b, w.signers.get(ORACLE_1)!) as Signed<EligibilityAttestation>;
    assert.throws(() => w.authority.publishEligibilityAttestation(signed), /eligibility_attestation_rejected/, JSON.stringify(b));
    assert.equal(w.authority.eligibilityAttestation(RESIDENT_1, IN_NEED)!.signed.payload.version, 1, JSON.stringify(b));
  }
  assert.equal(attestationRejected(w).length, bad.length, 'every rejection is logged exactly once');
});

test('a retained attestation corrupted after acceptance fails closed at use', () => {
  const w = world();
  publishAttestationAs(w, attestation());
  const stored = w.authority.eligibilityAttestation(RESIDENT_1, IN_NEED)!.signed;
  // Corrupt the subject binding in place: the stored record no longer
  // binds the lookup pair — invalid authority, never absence.
  stored.payload.subjectId = RESIDENT_2;
  assert.equal(scope(w).attestation(RESIDENT_1, IN_NEED).problem, 'attestation_binding_invalid');
  // Corrupting a signed term instead breaks the signature itself.
  const w2 = world();
  publishAttestationAs(w2, attestation());
  w2.authority.eligibilityAttestation(RESIDENT_1, IN_NEED)!.signed.payload.validUntil = 5;
  assert.equal(scope(w2).attestation(RESIDENT_1, IN_NEED).problem, 'attestation_signature_invalid');
  // Removing the attestor's key after publication fails the same way.
  const w3 = world();
  const signed = publishAttestationAs(w3, attestation());
  w3.keys.delete(signed.keyId);
  assert.equal(scope(w3).attestation(RESIDENT_1, IN_NEED).problem, 'attestation_signature_invalid');
  // Corruption into a schema-invalid shape is malformed authority —
  // distinct from binding, trust or signature failure.
  const w4 = world();
  publishAttestationAs(w4, attestation());
  w4.authority.eligibilityAttestation(RESIDENT_1, IN_NEED)!.signed.payload.version = 0;
  assert.equal(scope(w4).attestation(RESIDENT_1, IN_NEED).problem, 'attestation_malformed');
  // An uncanonicalizable fault-injected field reads as malformed too:
  // the verification throw can never escape as a raw TypeError.
  const w5 = world();
  publishAttestationAs(w5, attestation());
  const injected = w5.authority.eligibilityAttestation(RESIDENT_1, IN_NEED)!.signed.payload as Record<string, unknown>;
  injected.extra = 10n;
  assert.equal(scope(w5).attestation(RESIDENT_1, IN_NEED).problem, 'attestation_malformed');
});

test('the employer fixture keeps working: unrelated publications leave the allowance namespace untouched', () => {
  const w = world();
  publishAllowanceAs(w, allowance());
  // Ordinary employer revisions publish beside the allowance without
  // touching it or tripping exclusivity.
  updateMandate(w, { maxPerPurchaseCents: 450 });
  assert.equal(w.authority.employerMandate('mandate-1')!.payload.version, 2);
  assert.equal(w.authority.allowanceMandate('allowance-1')!.signed.payload.version, 1);
  assert.equal(scope(w).allowance('allowance-1').problem, undefined);
  // And the default fixture published no donor authority on its own.
  const plain = world();
  assert.equal(plain.authority.allowanceRefs().length, 0);
  assert.equal(scope(plain).attestation(RESIDENT_1, IN_NEED).problem, 'attestation_absent');
});
