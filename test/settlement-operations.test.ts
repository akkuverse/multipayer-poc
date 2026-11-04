// Operation identity and the immutable keyed-operation store (spec §7): one
// payer holding several roles, replayed intents and lost responses all key on
// the same tuple-encoded operation identity; reusing a key under different
// terms is a conclusive refusal, never a silent alias.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationKey, OperationStore } from '../src/settlement/operations.ts';

test('operation_identity_separates_roles_versions_and_delimiters', () => {
  // Two roles of the same payer on one purchase are different operations.
  assert.notEqual(
    operationKey(['leg', 'purchase-1', 1, 'employee', 'reserve']),
    operationKey(['leg', 'purchase-1', 1, 'employer', 'reserve']),
  );
  // The proposal version is part of the identity.
  assert.notEqual(
    operationKey(['leg', 'purchase-1', 1, 'employee', 'reserve']),
    operationKey(['leg', 'purchase-1', 2, 'employee', 'reserve']),
  );
  // Delimiter-bearing identifiers cannot shift field boundaries: a ':' inside
  // a value encodes inside its tuple slot, never as a separator, so
  // 'purchase:1' + 1 can never alias 'purchase' + '1:1'.
  assert.notEqual(
    operationKey(['leg', 'purchase:1', 1, 'employee', 'reserve']),
    operationKey(['leg', 'purchase', '1:1', 'employee', 'reserve']),
  );
  assert.notEqual(
    operationKey(['leg', 'a:b', 'c', 'reserve']),
    operationKey(['leg', 'a', 'b:c', 'reserve']),
  );

  const store = new OperationStore();
  const key = operationKey(['leg', 'purchase-1', 1, 'employee', 'reserve']);
  const terms = { payerId: 'employee-1', payeeId: 'merchant-a', amountCents: 800, feeCents: 0 };
  const op = store.begin(key, terms);
  // The intent is recorded; nothing has been attempted yet.
  assert.equal(op.status, 'not_started');
  // An identical replay returns the original operation — including a replay
  // whose terms only differ in key order (canonical terms).
  assert.deepEqual(store.begin(key, structuredClone(terms)), op);
  assert.deepEqual(store.begin(key, { feeCents: 0, amountCents: 800, payeeId: 'merchant-a', payerId: 'employee-1' }), op);
  // An altered payee or amount under the same key is a conclusive refusal.
  assert.throws(() => store.begin(key, { ...terms, payeeId: 'merchant-b' }), /operation_terms_conflict/);
  assert.throws(() => store.begin(key, { ...terms, amountCents: 900 }), /operation_terms_conflict/);
});

test('an operation resolves once forward; terminal outcomes are immutable', () => {
  const store = new OperationStore();
  const key = operationKey(['bank', 'purchase-1', 1, 'employer', 'transfer']);
  // A key never begun has no record; resolving one is a protocol violation.
  assert.equal(store.status(key), undefined);
  assert.throws(() => store.resolve(key, { status: 'succeeded' }), /unknown_operation/);

  store.begin(key, { amountCents: 500 });
  // The handoff is recorded, then the confirmed outcome — the reference
  // learned at handoff survives the final resolution.
  assert.equal(store.resolve(key, { status: 'pending', reference: 'exec-1' }).status, 'pending');
  const done = store.resolve(key, { status: 'succeeded' });
  assert.equal(done.status, 'succeeded');
  assert.equal(done.reference, 'exec-1');
  // The same terminal outcome replays to the same record; a different
  // terminal outcome — or a contradicting reference — is refused.
  assert.equal(store.resolve(key, { status: 'succeeded' }).status, 'succeeded');
  assert.throws(() => store.resolve(key, { status: 'rejected', reason: 'declined' }), /operation_outcome_conflict/);
  assert.throws(() => store.resolve(key, { status: 'succeeded', reference: 'exec-2' }), /operation_outcome_conflict/);
  // Status returns the record as resolved, not a mutable handle.
  assert.equal(store.status(key)!.status, 'succeeded');
});

test('an unknown outcome stays resolvable — a lost response never proves failure', () => {
  const store = new OperationStore();
  const key = operationKey(['de-group', 'purchase-1', 1, 'commit']);
  store.begin(key, { members: ['employee', 'diner-1'] });
  const lost = store.resolve(key, { status: 'unknown' });
  assert.equal(lost.status, 'unknown');
  // Authoritative status later settles the question on the original key.
  const resolved = store.resolve(key, { status: 'succeeded', reference: 'hold-9' });
  assert.equal(resolved.status, 'succeeded');
  assert.equal(resolved.reference, 'hold-9');
  // And a non-terminal answer may still move between pending and unknown as
  // evidence arrives; it is never a terminal guess.
  const key2 = operationKey(['leg', 'purchase-2', 1, 'employee', 'fund']);
  store.begin(key2, { amountCents: 300 });
  store.resolve(key2, { status: 'pending', reference: 'f-1' });
  assert.equal(store.resolve(key2, { status: 'unknown' }).status, 'unknown');
  assert.equal(store.resolve(key2, { status: 'pending' }).status, 'pending');
});

test('begin refuses terms that have no faithful canonical form', () => {
  const store = new OperationStore();
  const key = operationKey(['leg', 'purchase-1', 1, 'employee', 'reserve']);
  // An undefined root produces no canonical string at all.
  assert.throws(() => store.begin(key, undefined), /operation_terms_invalid/);
  // canonicalJson maps NaN and Infinity to null: recording '{a:NaN}' would
  // alias it with '{a:null}' under one key, so a non-finite number anywhere
  // in the terms is invalid rather than silently rewritten.
  assert.throws(() => store.begin(key, { amountCents: Number.NaN }), /operation_terms_invalid/);
  assert.throws(() => store.begin(key, { amountCents: Number.POSITIVE_INFINITY }), /operation_terms_invalid/);
  assert.throws(() => store.begin(key, { fees: [0, Number.NaN] }), /operation_terms_invalid/);
  // Nothing was recorded under the key — a genuine null still begins.
  assert.equal(store.begin(key, { amountCents: null }).status, 'not_started');
});

test('resolve refuses outcomes whose effects cannot be canonicalized or detached', () => {
  const store = new OperationStore();
  const key = operationKey(['leg', 'purchase-1', 1, 'employee', 'reserve']);
  store.begin(key, { amountCents: 500 });
  // A BigInt clones fine but canonicalJson cannot serialize it: stored, it
  // would make every later terminal replay throw — so it is invalid now.
  assert.throws(() => store.resolve(key, { status: 'pending', effects: { moved: 1n } }), /operation_outcome_invalid/);
  // A function value cannot be detached at all.
  assert.throws(() => store.resolve(key, { status: 'pending', effects: () => {} }), /operation_outcome_invalid/);
  // The refusals changed nothing: the operation is still open.
  assert.equal(store.status(key)!.status, 'not_started');
  // On a terminal record the same malformed replay is invalid, not a raw
  // serialization error out of the store.
  const done = operationKey(['leg', 'purchase-2', 1, 'employee', 'fund']);
  store.begin(done, { amountCents: 300 });
  store.resolve(done, { status: 'succeeded' });
  assert.throws(() => store.resolve(done, { status: 'succeeded', effects: { moved: 1n } }), /operation_outcome_invalid/);
});

test('an outcome that omits a field preserves the evidence already recorded', () => {
  const store = new OperationStore();
  const key = operationKey(['leg', 'purchase-1', 1, 'employee', 'reserve']);
  store.begin(key, { amountCents: 500 });
  store.resolve(key, { status: 'pending', reference: 'r-1', reason: 'awaiting', effects: { holdId: 'h-1' } });
  // A later open outcome carrying no reason or effects reports nothing new
  // about them — the recorded evidence survives.
  const updated = store.resolve(key, { status: 'unknown' });
  assert.equal(updated.status, 'unknown');
  assert.equal(updated.reason, 'awaiting');
  assert.deepEqual(updated.effects, { holdId: 'h-1' });
  // Latest-wins still applies where the outcome does carry a value.
  const overwritten = store.resolve(key, { status: 'pending', reason: 'retry' });
  assert.equal(overwritten.reason, 'retry');
  assert.deepEqual(overwritten.effects, { holdId: 'h-1' });
});

test('retained records cannot be mutated through caller terms or returned copies', () => {
  const store = new OperationStore();
  const key = operationKey(['leg', 'purchase-1', 1, 'employee', 'fund']);
  const terms = { payerId: 'employee-1', amountCents: 800, stages: ['bank-debit', 'de-credit'] };
  const begun = store.begin(key, terms);
  // The store keeps a copy: editing the caller's object changes nothing.
  terms.amountCents = 1;
  terms.stages.push('extra');
  assert.equal(store.status(key)!.terms.amountCents, 800);
  assert.deepEqual(store.status(key)!.terms.stages, ['bank-debit', 'de-credit']);
  // Returned records are detached: scribbling on one touches nothing stored.
  begun.terms.amountCents = 1;
  begun.status = 'rejected';
  const again = store.status(key)!;
  assert.equal(again.status, 'not_started');
  assert.equal(again.terms.amountCents, 800);
  // A returned terms object is detached too.
  again.terms.stages.push('x');
  assert.deepEqual(store.status(key)!.terms.stages, ['bank-debit', 'de-credit']);
});

test('operation keys refuse empty tuples and non-scalar parts', () => {
  assert.throws(() => operationKey([]), /operation key/);
  assert.throws(() => operationKey(['leg', '']), /operation key/);
  assert.throws(() => operationKey(['leg', Number.NaN]), /operation key/);
  assert.throws(() => operationKey(['leg', undefined as unknown as string]), /operation key/);
});
