// One synchronous decision verifies each signed record once. The decision
// scope (src/core/verified-authority.ts) memoizes reads and verdicts by
// signed content inside one uninterrupted stretch, so helpers that compose
// share verified authority instead of re-verifying it. These tests count
// verifyPayload calls through the key registry — one keys.get per call —
// and check the scope boundary: corruption between two operations is still
// caught at the next decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  world,
  lunch,
  approveAs,
  changeOfferAs,
  proposeSplitAs,
  submitAs,
  publishAllowanceAs,
  publishAttestationAs,
  AUTO_EMPLOYEE_TERMS,
  EMPLOYEE,
  EMPLOYER,
  COLLEAGUE_1,
  COLLEAGUE_2,
  DONOR_1,
  ORACLE_1,
  RESIDENT_1,
  IN_NEED,
  CHARITY_1,
  MERCHANT_A,
} from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';
import { signPayload } from '../src/core/signing.ts';
import type { AllowanceMandate, EligibilityAttestation } from '../src/core/types.ts';
import { VerifiedAuthority } from '../src/core/verified-authority.ts';

// Count verifyPayload invocations: each one reads the key registry exactly
// once, so a get() spy is an exact counter. Setup publishes happen before
// the spy installs, so the count is the measured operation's alone.
const verifyCount = (w: World): (() => number) => {
  let calls = 0;
  const get = w.keys.get.bind(w.keys);
  w.keys.get = ((keyId: string) => {
    calls++;
    return get(keyId);
  }) as typeof w.keys.get;
  return () => calls;
};

const AUTO_WORLD = { employeeMandate: AUTO_EMPLOYEE_TERMS, supportsMandatePayments: true };

test('propose with auto-pay verifies the employer allowance and the standing terms once each', () => {
  const w = world({}, {}, AUTO_WORLD);
  const count = verifyCount(w);
  const p = lunch(w, 900);
  assert.equal(p.state, 'ready');
  // resolveBenefit and the share naming share the scope's employer
  // resolution; assessment, expiry noting and mandate evidence share the
  // one verified standing record. The signed proposal's own request
  // signature is the third verification.
  assert.equal(count(), 3);
});

test('an offer change verifies each authority record once across the whole decision', () => {
  const w = world({}, {}, AUTO_WORLD);
  const p = lunch(w, 900);
  const count = verifyCount(w);
  const change = changeOfferAs(w, p, { merchantId: MERCHANT_A, totalCents: 1_000, expiresAt: 100 }, MERCHANT_A);
  assert.equal(change.outcome, 'replaced');
  // The old-offer employer pre-check and reprice's own resolution share the
  // scope's employer read; the standing terms are read once for reprice.
  // The signed request's own signature is the third verification.
  assert.equal(count(), 3);
});

test('a quote verifies the allowance and the standing terms once each', () => {
  const w = world({}, {}, AUTO_WORLD);
  const count = verifyCount(w);
  w.coordinator.quote({ merchantId: MERCHANT_A, totalCents: 900, employeeId: EMPLOYEE, mandateRef: w.mandate.mandateRef });
  assert.equal(count(), 2);
});

test('each approve call verifies only the incoming signature in a split', () => {
  const w = world();
  const p = proposeSplitAs(
    w,
    {
      purchaseId: 'split-1',
      merchantId: MERCHANT_A,
      amountsFrom: 'equal_split',
      totalCents: 1_200,
      shares: [
        { role: 'a', payerId: EMPLOYEE },
        { role: 'b', payerId: COLLEAGUE_1 },
        { role: 'c', payerId: COLLEAGUE_2 },
      ],
      expiresAt: 100,
    },
    EMPLOYEE,
  );
  // A split has no standing terms to refresh, so each call's one
  // verification is the new evidence itself — a fresh decision each time.
  for (const id of [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2]) {
    const count = verifyCount(w);
    approveAs(w, p, id);
    assert.equal(count(), 1, `approve by ${id}`);
  }
});

test('submit with auto-pay verifies the standing terms and the allowance once each', async () => {
  const w = world({}, {}, AUTO_WORLD);
  const p = lunch(w, 900);
  const count = verifyCount(w);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  // The admission refresh verifies the standing record; the mandate
  // evidence carries identical signed bytes, so its re-checks consult the
  // scope's verdict. The employer recheck and the frozen evidence share one
  // resolution. The signed submit request's own signature is the third.
  // Under per-payer initiation each leg's first handoff is its own decision
  // scope, adding one verified read per leg: the standing record for the
  // employee leg and the allowance for the employer leg.
  assert.equal(count(), 5);
});

test('submit with a device approval verifies the terms, the approval and the allowance once each', async () => {
  const w = world();
  const p = lunch(w, 900);
  approveAs(w, p);
  const count = verifyCount(w);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'completed');
  // The admission-time approval re-check reuses the verdict the refresh
  // computed in the same decision; the signed submit request's own
  // signature is the fourth. Under per-payer initiation each leg's first
  // handoff is its own decision scope: the employee leg re-verifies its
  // approval and the standing record, the employer leg the allowance.
  assert.equal(count(), 7);
});

test('a validity projection shares the verified standing read its caller passes', () => {
  const w = world({}, {}, AUTO_WORLD);
  const p = lunch(w, 900);
  const count = verifyCount(w);
  // The caller reads the record once for the whole list; each entry's own
  // signature still verifies — the mandate snapshot's bytes equal the
  // record's only when they are the same revision, which is one record.
  const record = w.coordinator.employeeMandate(EMPLOYEE);
  const reads = count();
  for (const a of p.authorizations) {
    assert.equal(w.coordinator.authorizationCurrentlyValid(p.purchaseId, a, record), true);
  }
  assert.equal(reads, 1, 'one verified read served the whole list');
  assert.equal(count() - reads, p.authorizations.length, 'each entry still verifies its own signature');
});

test('a stored record corrupted between two operations fails closed at the next decision', async () => {
  const w = world({}, {}, AUTO_WORLD);
  const p = lunch(w, 900);
  // Corrupt the retained standing record in place (the registry's
  // fault-injection seam). The next decision must not reuse the earlier
  // scope's verdicts: it verifies the mutated content and refuses.
  w.authority.storedEmployeeMandate(EMPLOYEE)!.payload.maxCents = 1;
  assert.throws(() => w.coordinator.refreshAuthorization(p.purchaseId), /employee_mandate_invalid/);
  await assert.rejects(() => submitAs(w, p, EMPLOYEE), /employee_mandate_invalid/);
});

test('an employer record corrupted between two operations fails closed at the next decision', async () => {
  const w = world();
  const p = lunch(w, 900);
  approveAs(w, p);
  // Corrupt the retained allowance in place: the admission recheck verifies
  // the mutated bytes, never a verdict from the proposal's scope.
  w.authority.employerMandate(w.mandate.mandateRef)!.payload.beneficiaryRef = COLLEAGUE_1;
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'failed');
  assert.match(p.reason ?? '', /^employer_authority_invalid:/);
});

test('a verified employer record with an incompatible profile reports its problem once per scope', () => {
  const w = world();
  // Inject past publication: swap the retained record for one correctly
  // signed over incompatible privacy terms — verified, yet unusable.
  const stored = w.authority.employerMandate('mandate-1')!;
  const bad = signPayload({ ...w.mandate, privacyProfile: 'split_bill_v1' } as never, w.signers.get(EMPLOYER)!);
  stored.payload = bad.payload;
  stored.keyId = bad.keyId;
  stored.signature = bad.signature;
  const count = verifyCount(w);
  const scope = new VerifiedAuthority(w.authority, w.keys);
  // The verified-but-invalid profile is its own problem — never masked as
  // an absent mandate — and the added check does not multiply signature
  // verification: the resolution and the content verdict are memoized, so
  // repeated reads of the same signed record cost the one verification.
  assert.equal(scope.employer('mandate-1').problem, 'mandate_privacy_profile_invalid');
  assert.equal(scope.employer('mandate-1').problem, 'mandate_privacy_profile_invalid');
  assert.equal(scope.verify(stored, EMPLOYER), true, 'the record itself still verifies');
  assert.equal(count(), 1, 'one verification served the whole scope');
});

// A valid allowance/attestation fixture pair for the freshness tests below.
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
const ATTESTATION: EligibilityAttestation = {
  attestorId: ORACLE_1,
  subjectId: RESIDENT_1,
  classId: IN_NEED,
  validFrom: 0,
  validUntil: 1_000,
  version: 1,
  revoked: false,
};

test('an allowance and an attestation verify once each across the whole scope', () => {
  const w = world();
  publishAllowanceAs(w, ALLOWANCE);
  publishAttestationAs(w, ATTESTATION);
  const count = verifyCount(w);
  const scope = new VerifiedAuthority(w.authority, w.keys);
  // Repeated reads inside one decision share the memoized resolution: each
  // retained record's signature is verified on first access only.
  assert.equal(scope.allowance('allowance-1').problem, undefined);
  assert.equal(scope.allowance('allowance-1').problem, undefined);
  assert.equal(scope.attestation(RESIDENT_1, IN_NEED).problem, undefined);
  assert.equal(scope.attestation(RESIDENT_1, IN_NEED).problem, undefined);
  assert.equal(count(), 2, 'one verification per signed record served the whole scope');
});

test('an allowance published after a scope read it absent is seen by the next scope', () => {
  const w = world();
  const first = new VerifiedAuthority(w.authority, w.keys);
  assert.equal(first.allowance('allowance-1').problem, 'allowance_unknown');
  publishAllowanceAs(w, ALLOWANCE);
  // The stale scope keeps its memoized verdict: nothing inside it notices
  // the publication — only a new decision verifies against what the
  // registry now holds.
  assert.equal(first.allowance('allowance-1').problem, 'allowance_unknown');
  const next = new VerifiedAuthority(w.authority, w.keys);
  assert.equal(next.allowance('allowance-1').problem, undefined);
  assert.equal(next.allowance('allowance-1').allowance!.donorId, DONOR_1);
});

test('an attestation published after a scope read it absent is seen by the next scope', () => {
  const w = world();
  const first = new VerifiedAuthority(w.authority, w.keys);
  assert.equal(first.attestation(RESIDENT_1, IN_NEED).problem, 'attestation_absent');
  publishAttestationAs(w, ATTESTATION);
  assert.equal(first.attestation(RESIDENT_1, IN_NEED).problem, 'attestation_absent');
  const next = new VerifiedAuthority(w.authority, w.keys);
  assert.equal(next.attestation(RESIDENT_1, IN_NEED).problem, undefined);
  assert.equal(next.attestation(RESIDENT_1, IN_NEED).attestation!.subjectId, RESIDENT_1);
});

test('a retained allowance or attestation corrupted between scopes fails closed at the next decision', () => {
  const w = world();
  publishAllowanceAs(w, ALLOWANCE);
  publishAttestationAs(w, ATTESTATION);
  const first = new VerifiedAuthority(w.authority, w.keys);
  assert.equal(first.allowance('allowance-1').problem, undefined);
  assert.equal(first.attestation(RESIDENT_1, IN_NEED).problem, undefined);
  // Corrupt both retained records through the registry's fault-injection
  // seams. The settled scope still serves its memoized resolutions; the
  // next decision verifies the mutated content and refuses — corrupt
  // authority can never read as absent.
  w.authority.allowanceMandate('allowance-1')!.signed.payload.maxPerDayCents = 1;
  w.authority.eligibilityAttestation(RESIDENT_1, IN_NEED)!.signed.payload.validUntil = 5;
  assert.equal(first.allowance('allowance-1').problem, undefined);
  assert.equal(first.attestation(RESIDENT_1, IN_NEED).problem, undefined);
  const next = new VerifiedAuthority(w.authority, w.keys);
  assert.equal(next.allowance('allowance-1').problem, 'allowance_signature_invalid');
  assert.equal(next.attestation(RESIDENT_1, IN_NEED).problem, 'attestation_signature_invalid');
});
