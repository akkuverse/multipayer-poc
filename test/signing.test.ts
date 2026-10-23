// Signed authority (D6): approvals and mandates are Ed25519-signed payloads
// over canonical JSON. Keys come from fixed synthetic seeds, so signatures —
// and therefore trace digests — are reproducible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, keyPairFromSeed, signPayload, verifyPayload } from '../src/core/signing.ts';
import { world, lunch, approveAs, EMPLOYEE, EMPLOYER, MERCHANT_C } from '../src/scenarios.ts';
import { approvalCents, approvalFeeCents, shareCents } from '../src/core/coordinator.ts';

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
      basis: 'device',
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

test('an approval signed for one purchase cannot authorise another', () => {
  const w = world();
  const a = lunch(w);
  approveAs(w, a);
  const b = lunch(w, 1_300, MERCHANT_C, { purchaseId: 'purchase-2' });
  // The signature is valid — the binding to purchaseId is what rejects it.
  assert.throws(() => w.coordinator.approve(b, a.authorizations[0].approval), /does not match/);
  assert.equal(b.state, 'awaiting_approvals');
  assert.equal(b.authorizations.length, 0);
});

test('a mandate cannot be re-published under another employer', () => {
  const w = world();
  assert.throws(
    () => w.mandates.publish(signPayload({ ...w.mandate, employerId: EMPLOYEE }, w.signers.get(EMPLOYEE)!)),
    /belongs to employer-1/,
  );
});
