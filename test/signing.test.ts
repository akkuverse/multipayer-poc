// Signed authority (D6): approvals and mandates are Ed25519-signed payloads
// over canonical JSON. Keys come from fixed synthetic seeds, so signatures —
// and therefore trace digests — are reproducible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, sign } from 'node:crypto';
import { canonicalJson, keyPairFromSeed, sharesDigestOf, signPayload, verifyPayload } from '../src/core/signing.ts';
import type { Signed } from '../src/core/signing.ts';
import { world, lunch, approveAs, submitAs, updateMandate, EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_C } from '../src/scenarios.ts';
import { approvalCents, approvalFeeCents, shareCents } from '../src/core/coordinator.ts';
import type { EmployerMandate } from '../src/core/types.ts';

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
  w.authority.employerMandate('mandate-1')!.payload.maxPerPurchaseCents = 1_300;
  await submitAs(w, p, EMPLOYEE);
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
      sharesDigest: sharesDigestOf(q.shares),
      expiresAt: q.expiresAt,
      basis: 'device',
    },
    w.signers.get(EMPLOYER)!,
  );
  assert.throws(() => w.coordinator.approve(p.purchaseId, forged), /does not match/);
});

// An approval binds the complete signed share terms — role, payer, payee,
// rail, principal and fee — not only the payer totals. The digest is
// independently recomputed here from canonicalJson so the assertion does not
// trust the production helper it checks.
test('an approval whose shares digest does not match the committed shares is rejected', () => {
  const w = world();
  const p = lunch(w);
  const q = p.proposal;
  const approval = {
    approvalRef: 'appr-tampered-shares',
    purchaseId: p.purchaseId,
    payerId: EMPLOYEE,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, EMPLOYEE),
    feeCents: approvalFeeCents(q, EMPLOYEE),
    // A valid signature over a digest of different share terms: the employee
    // rail flipped to bank. Every legacy field still matches, so only the
    // digest can refuse this.
    sharesDigest: createHash('sha256')
      .update(canonicalJson(q.shares.map((s) => (s.role === 'employee' ? { ...s, rail: 'bank' } : s))))
      .digest('hex'),
    expiresAt: q.expiresAt,
    basis: 'device',
  };
  assert.throws(() => w.coordinator.approve(p.purchaseId, signPayload(approval, w.signers.get(EMPLOYEE)!)), /does not match/);
  assert.equal(w.trace.events.at(-1)?.detail?.reason, 'terms_mismatch');
  // An approval that carries no digest at all carries no binding.
  const { sharesDigest: _omitted, ...noDigest } = approval;
  assert.throws(() => w.coordinator.approve(p.purchaseId, signPayload(noDigest, w.signers.get(EMPLOYEE)!)), /does not match/);
  assert.equal(p.authorizations.length, 0);
  assert.equal(p.state, 'awaiting_approvals');
  assert.equal(w.backend.executionCount(), 0, 'refused before any money operation');
});

test('a mandate signed with a key that is not the employer\'s is rejected at publish', () => {
  const w = world();
  const before = w.authority.employerMandate('mandate-1');
  // Signed by the employee, so it can never verify as the employer's grant.
  const forged = signPayload({ ...w.mandate, maxPerPurchaseCents: 1_300, version: 2 }, w.signers.get(EMPLOYEE)!);
  assert.throws(() => w.authority.publishEmployerMandate(forged), /employer_mandate_rejected:signature_invalid/);
  assert.equal(w.authority.employerMandate('mandate-1'), before, 'a rejected publish cannot displace the accepted mandate');
  const rejected = w.trace.events.find((e) => e.event === 'employer_mandate_rejected');
  assert.equal(rejected?.origin, 'LOCAL');
  assert.equal(rejected?.detail?.reason, 'signature_invalid');
  assert.equal(rejected?.detail?.employerId, EMPLOYER);
  assert.equal(rejected?.detail?.mandateRef, 'mandate-1');
  // The retained mandate still funds normally.
  const p = lunch(w);
  assert.equal(shareCents(p.proposal, 'employer'), 500);
});

test('publish rejects tampered payloads, unknown keys and malformed records', () => {
  const w = world();
  const tampered = signPayload({ ...w.mandate, version: 2 }, w.signers.get(EMPLOYER)!);
  tampered.payload.maxPerPurchaseCents = 9_999;
  assert.throws(() => w.authority.publishEmployerMandate(tampered), /employer_mandate_rejected:signature_invalid/);
  const unknownKey = signPayload({ ...w.mandate, version: 2 }, keyPairFromSeed('key-rogue', 'rogue-seed'));
  assert.throws(() => w.authority.publishEmployerMandate(unknownKey), /employer_mandate_rejected:signature_invalid/);
  const malformed = { payload: { ...w.mandate, version: 2, validUntil: 'soon' }, keyId: 'key-employer-1', signature: 'x' };
  assert.throws(
    () => w.authority.publishEmployerMandate(malformed as unknown as Signed<EmployerMandate>),
    /employer_mandate_rejected:malformed/,
  );
  assert.equal(w.authority.employerMandate('mandate-1')!.payload.version, 1, 'no rejected write reached the registry');
  assert.equal(w.trace.events.filter((e) => e.event === 'employer_mandate_rejected').length, 3);
});

test('malformed envelopes and payloads are rejected and never displace the accepted record', () => {
  const w = world();
  const before = w.authority.employerMandate('mandate-1');
  const terms = (over: Partial<EmployerMandate> = {}): EmployerMandate => ({ ...w.mandate, version: 2, ...over });
  const bad: unknown[] = [
    null,
    'mandate',
    {},
    { payload: null, keyId: 'key', signature: 'sig' },
    { payload: w.mandate, keyId: 7, signature: 'sig' },
    { payload: w.mandate, keyId: 'key', signature: 7 },
    terms({ mandateRef: '' }),
    terms({ employerId: '' }),
    terms({ beneficiaryRef: '' }),
    terms({ version: 0 }),
    terms({ version: -3 }),
    terms({ version: 1.5 }),
    terms({ maxPerPurchaseCents: -1 }),
    terms({ maxPerDayCents: 100.5 }),
    terms({ maxPurchasesPerDay: 1.5 }),
    terms({ eligibleMerchants: 'merchant-a' as unknown as string[] }),
    terms({ eligibleMerchants: [MERCHANT_A, MERCHANT_A] }),
    terms({ eligibleMerchants: [''] }),
    terms({ validFrom: -1 }),
    terms({ validUntil: Number.NaN }),
    // A window that never opens is malformed, not merely expired.
    terms({ validFrom: 600, validUntil: 100 }),
    terms({ revoked: 1 as unknown as boolean }),
  ];
  for (const b of bad) {
    const signed = signPayload(b, w.signers.get(EMPLOYER)!) as Signed<EmployerMandate>;
    assert.throws(() => w.authority.publishEmployerMandate(signed), /employer_mandate_rejected/, JSON.stringify(b));
    assert.equal(w.authority.employerMandate('mandate-1'), before, 'a rejected publish cannot displace the accepted mandate');
  }
  // A payload outside the signed domain makes canonicalisation throw during
  // verification — the registry reports malformed, not an untyped TypeError.
  const exotic = {
    payload: { ...w.mandate, version: 2, extra: 1n },
    keyId: w.signers.get(EMPLOYER)!.keyId,
    signature: 'x',
  };
  assert.throws(
    () => w.authority.publishEmployerMandate(exotic as unknown as Signed<EmployerMandate>),
    /employer_mandate_rejected:malformed/,
  );
  // An uncloneable extra field survives verification but fails the stored
  // copy — rejected malformed, never a thrown DataCloneError.
  const uncloneablePayload = { ...w.mandate, version: 2, extra: () => {} };
  const uncloneable = {
    payload: uncloneablePayload,
    keyId: w.signers.get(EMPLOYER)!.keyId,
    signature: sign(null, Buffer.from(canonicalJson(uncloneablePayload)), w.signers.get(EMPLOYER)!.privateKey).toString('base64url'),
  };
  assert.throws(
    () => w.authority.publishEmployerMandate(uncloneable as unknown as Signed<EmployerMandate>),
    /employer_mandate_rejected:malformed/,
  );
  assert.equal(
    w.trace.events.filter((e) => e.event === 'employer_mandate_rejected').length,
    bad.length + 2,
    'every rejection is logged exactly once',
  );
});

test('a mandate revision must carry the reference\'s next version', () => {
  const w = world();
  // A still-valid signature over superseded terms: captured before the
  // accepted record moves on.
  const stale = signPayload(w.mandate, w.signers.get(EMPLOYER)!);
  updateMandate(w, { maxPerPurchaseCents: 600 });
  assert.equal(w.authority.employerMandate('mandate-1')!.payload.version, 2);
  // Replaying the old revision — e.g. to roll back a later revocation — is
  // rejected even though its signature still verifies.
  assert.throws(() => w.authority.publishEmployerMandate(stale), /employer_mandate_rejected:version_not_next/);
  assert.equal(w.authority.employerMandate('mandate-1')!.payload.version, 2, 'the stale revision never displaced the accepted terms');
  // Skipping a version, and opening a new reference past version 1, reject too.
  assert.throws(
    () => w.authority.publishEmployerMandate(signPayload({ ...w.mandate, version: 4 }, w.signers.get(EMPLOYER)!)),
    /employer_mandate_rejected:version_not_next/,
  );
  assert.throws(
    () => w.authority.publishEmployerMandate(signPayload({ ...w.mandate, mandateRef: 'mandate-2', version: 2 }, w.signers.get(EMPLOYER)!)),
    /employer_mandate_rejected:version_not_next/,
  );
  w.authority.publishEmployerMandate(signPayload({ ...w.mandate, mandateRef: 'mandate-2', version: 1 }, w.signers.get(EMPLOYER)!));
  assert.equal(w.authority.employerMandate('mandate-2')!.payload.version, 1);
});

test('an employer mandate cannot be published under a reference employee terms own', () => {
  const w = world();
  const clash = signPayload({ ...w.mandate, mandateRef: 'employee-mandate-1', version: 1 }, w.signers.get(EMPLOYER)!);
  assert.throws(() => w.authority.publishEmployerMandate(clash), /employer_mandate_rejected:ref_owned_by_employee/);
  assert.equal(w.authority.employerMandate('employee-mandate-1'), undefined);
});

test('corrupting the retained record cannot reopen the rollback window or rebind a reference', () => {
  const w = world();
  updateMandate(w, { revoked: true }); // v2 accepted
  // A still-valid signature over the superseded v2 terms.
  const stale = signPayload(w.mandate, w.signers.get(EMPLOYER)!);
  updateMandate(w, { revoked: false, maxPerPurchaseCents: 600 }); // v3 accepted — v2 is stale
  // Corrupt the retained record's bookkeeping downward and rebind its owner.
  const stored = w.authority.employerMandate('mandate-1')!;
  stored.payload.version = 1;
  stored.payload.employerId = EMPLOYEE;
  // Ownership and version decisions consult acceptance-time state, not the
  // mutable record: the stale signed v2 still cannot roll the allowance back
  // (v4 is required — not the corrupted 2), and the reference is still bound
  // to employer-1, so an employee-named v2 is rejected too.
  assert.throws(() => w.authority.publishEmployerMandate(stale), /employer_mandate_rejected:version_not_next/);
  const hostile = signPayload({ ...w.mandate, employerId: EMPLOYEE, version: 2 }, w.signers.get(EMPLOYEE)!);
  assert.throws(() => w.authority.publishEmployerMandate(hostile), /employer_mandate_rejected:ref_owned_by_another_employer/);
});

test('a mandate record corrupted after acceptance fails closed at proposal', () => {
  const w = world();
  // Verified at publish, so a failing signature at use means the retained
  // record was corrupted after acceptance — exactly what the use-time check
  // exists to catch.
  w.authority.employerMandate('mandate-1')!.payload.beneficiaryRef = 'employee-2';
  const p = lunch(w);
  assert.equal(shareCents(p.proposal, 'employer'), 0);
  const proposal = w.trace.events.find((e) => e.event === 'proposal');
  assert.equal(proposal?.detail?.ineligibleReason, 'mandate_signature_invalid');
});

test('a corrupted mandate record fails a deferred first handoff at resubmit', async () => {
  const w = world({}, {}, { initiation: 'per_payer_psp' });
  w.psps.get(EMPLOYER)!.available = false;
  const p = lunch(w);
  approveAs(w, p);
  await submitAs(w, p, EMPLOYEE);
  assert.equal(p.state, 'pending');
  // The employer leg never reached the backend: resubmit is its first
  // initiation, so the same recheck submit() runs applies — and refuses the
  // leg again under a record corrupted after acceptance.
  w.authority.employerMandate('mandate-1')!.payload.beneficiaryRef = 'employee-2';
  w.psps.get(EMPLOYER)!.available = true;
  await w.coordinator.resubmit(p.purchaseId);
  assert.equal(p.legs[1].status, 'rejected');
  assert.equal(p.legs[1].rejectReason, 'employer_authority_invalid:mandate_signature_invalid');
  assert.equal(w.backend.executionCount(), 1, 'the refused leg was never handed off');
});

test('an approval signed for one purchase cannot authorise another', () => {
  const w = world();
  const a = lunch(w);
  approveAs(w, a);
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  // The signature is valid — the binding to purchaseId is what rejects it.
  assert.throws(() => w.coordinator.approve(b.purchaseId, a.authorizations[0].approval), /does not match/);
  assert.equal(b.state, 'awaiting_approvals');
  assert.equal(b.authorizations.length, 0);
});

test('a mandate cannot be re-published under another employer', () => {
  const w = world();
  // Signed by the employee naming the employee: the signature verifies, but
  // the reference stays bound to the employer that first published it.
  assert.throws(
    () => w.authority.publishEmployerMandate(signPayload({ ...w.mandate, employerId: EMPLOYEE, version: 2 }, w.signers.get(EMPLOYEE)!)),
    /employer_mandate_rejected:ref_owned_by_another_employer/,
  );
});
