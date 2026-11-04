// Ledger-local settlement (spec §4.3, §4.4, §6, §7): digital-euro holds
// expire at reserve + 0.5 minutes, replay never extends a deadline, a
// same-ledger group validates every member before moving any holding, only
// the holder's provider may act on its customer's holding, a holding-limited
// destination receives its excess through tracked defunding transit, and a
// bank transfer's debit stays visible in transit until the destination
// credit is confirmed — a lost response never creates a second debit.
//
// Owning layer for these behaviors: the two ledger modules themselves —
// no higher-level test exercises hold deadlines, group atomicity or bank
// transit before Task 3 wires providers on top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Trace } from '../src/evidence/trace.ts';
import { operationKey } from '../src/settlement/operations.ts';
import { DigitalEuroLedger } from '../src/settlement/digital-euro-ledger.ts';
import { InterbankTransfer } from '../src/settlement/interbank-transfer.ts';
import type {
  DeGroupCommitEffects,
  DeHoldEffects,
  DeTransitAudit,
} from '../src/settlement/types.ts';

// A ledger world on the shared simulated-minute clock, starting at t=10
// like the scenario world. Pseudonyms are opaque holder identifiers; the
// providers named here are the only callers the ledger accepts for them.
function ledgerWorld() {
  const trace = new Trace();
  let t = 10;
  const ledger = new DigitalEuroLedger(() => t, trace);
  ledger.registerHolding({ pseudonym: 'ps-alice', provider: 'psp-alice', holdingLimitCents: 300_000, deCents: 2_000 });
  ledger.registerHolding({ pseudonym: 'ps-bob', provider: 'psp-bob', holdingLimitCents: 300_000, deCents: 2_000 });
  // A business destination: zero holding limit, so credits defund to bank.
  ledger.registerHolding({ pseudonym: 'ps-shop', provider: 'psp-shop', holdingLimitCents: 0, deCents: 0 });
  return {
    trace,
    ledger,
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
}

test('hold_replay_does_not_extend_deadline', () => {
  const { ledger, set } = ledgerWorld();
  const key = operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']);
  const req = { key, provider: 'psp-alice', pseudonym: 'ps-alice', amountCents: 800, destination: 'ps-shop' };
  const first = ledger.hold(req);
  assert.equal(first.status, 'succeeded');
  const holdRef = first.reference!;
  const firstEffects = first.effects as DeHoldEffects;
  assert.equal(firstEffects.holdRef, holdRef);
  assert.equal(firstEffects.reservedAt, 10);
  assert.equal(firstEffects.expiresAt, 10.5);
  // The reservation reduces spendable balance without moving money yet.
  assert.deepEqual(
    ledger.holding('ps-alice'),
    { pseudonym: 'ps-alice', provider: 'psp-alice', deCents: 2_000, holdingLimitCents: 300_000, heldCents: 800, spendableCents: 1_200 },
  );

  // A replay inside the window returns the original operation — same hold,
  // same deadline. Extending to 10.9 would be a renewal, which is forbidden.
  set(10.4);
  const replay = ledger.hold({ ...req });
  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.reference, holdRef);
  assert.equal((replay.effects as DeHoldEffects).expiresAt, 10.5);
  assert.equal(ledger.holdAudit(holdRef).expiresAt, 10.5);
  assert.equal(ledger.holdAudit(holdRef).reservedAt, 10);
  assert.equal(ledger.holds().length, 1);

  // The original deadline still governs: inside it the hold commits.
  const commit = ledger.commitHold({
    key: operationKey(['leg', 'purchase-1', 1, 'employee', 'commit']),
    provider: 'psp-alice',
    holdRef,
  });
  assert.equal(commit.status, 'succeeded');
  assert.equal(ledger.holdAudit(holdRef).status, 'committed');
});

test('expiry_at_half_minute_forbids_commit', () => {
  // now >= expiresAt refuses the commit; the deadline is the injected
  // clock's minutes, so 30 simulated seconds is 0.5 (decision 1).
  for (const at of [10.5, 10.9]) {
    const { ledger, set } = ledgerWorld();
    const hold = ledger.hold({
      key: operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']),
      provider: 'psp-alice',
      pseudonym: 'ps-alice',
      amountCents: 800,
      destination: 'ps-shop',
    });
    const holdRef = hold.reference!;
    set(at);
    const commit = ledger.commitHold({
      key: operationKey(['leg', 'purchase-1', 1, 'employee', 'commit']),
      provider: 'psp-alice',
      holdRef,
    });
    assert.equal(commit.status, 'rejected');
    assert.equal(commit.reason, 'hold_expired');
    // The expiry tombstone is preserved, the reservation is gone and no
    // money moved — spendable returns to the full balance.
    assert.equal(ledger.holdAudit(holdRef).status, 'expired');
    assert.equal(ledger.holding('ps-alice').deCents, 2_000);
    assert.equal(ledger.holding('ps-alice').spendableCents, 2_000);
    assert.equal(ledger.holding('ps-shop').deCents, 0);
    assert.equal(ledger.transit().length, 0);
    // A replay of the refused commit does not resurrect the hold.
    const again = ledger.commitHold({
      key: operationKey(['leg', 'purchase-1', 1, 'employee', 'commit']),
      provider: 'psp-alice',
      holdRef,
    });
    assert.equal(again.status, 'rejected');
    assert.equal(again.reason, 'hold_expired');
  }
  // Just inside the window the same hold would still have committed.
  const { ledger, set } = ledgerWorld();
  const hold = ledger.hold({
    key: operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']),
    provider: 'psp-alice',
    pseudonym: 'ps-alice',
    amountCents: 800,
    destination: 'ps-shop',
  });
  set(10.49);
  assert.equal(
    ledger.commitHold({ key: operationKey(['leg', 'purchase-1', 1, 'employee', 'commit']), provider: 'psp-alice', holdRef: hold.reference! }).status,
    'succeeded',
  );
});

test('group_failure_changes_no_member', () => {
  // One failing member fails the whole group before any holding changes:
  // the ledger validates all holds first (decision 2, spec §4.3).
  const groupKey = operationKey(['de-group', 'purchase-1', 1, 'commit', 'employee', 'diner']);
  const groupOf = (self: string) => ({ key: groupKey, self, members: ['employee', 'diner'] });
  const cases: {
    name: string;
    arrange: (w: ReturnType<typeof ledgerWorld>, holds: string[]) => { leg: string; holdRef: string; provider: string }[];
    reason: string;
  }[] = [
    {
      name: 'an expired member',
      arrange: (w, holds) => {
        w.set(10.6);
        return [
          { leg: 'employee', holdRef: holds[0], provider: 'psp-alice' },
          { leg: 'diner', holdRef: holds[1], provider: 'psp-bob' },
        ];
      },
      reason: 'hold_expired',
    },
    {
      name: 'a member offered by a foreign provider',
      arrange: (_w, holds) => [
        { leg: 'employee', holdRef: holds[0], provider: 'psp-alice' },
        { leg: 'diner', holdRef: holds[1], provider: 'psp-intruder' },
      ],
      reason: 'foreign_provider',
    },
    {
      name: 'members presented out of their frozen order',
      arrange: (_w, holds) => [
        { leg: 'diner', holdRef: holds[0], provider: 'psp-alice' },
        { leg: 'employee', holdRef: holds[1], provider: 'psp-bob' },
      ],
      reason: 'group_membership_invalid',
    },
  ];
  for (const c of cases) {
    const w = ledgerWorld();
    const h1 = w.ledger.hold({
      key: operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']),
      provider: 'psp-alice',
      pseudonym: 'ps-alice',
      amountCents: 800,
      destination: 'ps-shop',
      group: groupOf('employee'),
    });
    const h2 = w.ledger.hold({
      key: operationKey(['leg', 'purchase-1', 1, 'diner', 'hold']),
      provider: 'psp-bob',
      pseudonym: 'ps-bob',
      amountCents: 700,
      destination: 'ps-shop',
      group: groupOf('diner'),
    });
    const members = c.arrange(w, [h1.reference!, h2.reference!]);
    const commit = w.ledger.commitGroup({ key: groupKey, members });
    assert.equal(commit.status, 'rejected', c.name);
    assert.equal(commit.reason, c.reason, c.name);
    // No member's holding changed, no destination credit, no transit.
    assert.equal(w.ledger.holding('ps-alice').deCents, 2_000, c.name);
    assert.equal(w.ledger.holding('ps-bob').deCents, 2_000, c.name);
    assert.equal(w.ledger.holding('ps-shop').deCents, 0, c.name);
    assert.equal(w.ledger.transit().length, 0, c.name);
  }
});

test('foreign_provider_cannot_spend_holding', () => {
  const w = ledgerWorld();
  // A hold attempt under the intruder's own key is a recorded refusal.
  const hold = w.ledger.hold({
    key: operationKey(['leg', 'purchase-9', 1, 'x', 'hold']),
    provider: 'psp-intruder',
    pseudonym: 'ps-alice',
    amountCents: 100,
    destination: 'ps-shop',
  });
  assert.equal(hold.status, 'rejected');
  assert.equal(hold.reason, 'foreign_provider');
  // The owner's own hold under the same operation key cannot be poisoned:
  // the intruder's terms differ, so key reuse is a conclusive conflict.
  const ownerKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']);
  const owner = w.ledger.hold({
    key: ownerKey,
    provider: 'psp-alice',
    pseudonym: 'ps-alice',
    amountCents: 800,
    destination: 'ps-shop',
  });
  assert.equal(owner.status, 'succeeded');
  const holdRef = owner.reference!;
  assert.throws(
    () =>
      w.ledger.hold({
        key: ownerKey,
        provider: 'psp-intruder',
        pseudonym: 'ps-alice',
        amountCents: 800,
        destination: 'ps-shop',
      }),
    /operation_terms_conflict/,
  );
  // Nor may a foreign provider commit, release, defund or transfer it.
  assert.equal(
    w.ledger.commitHold({ key: operationKey(['leg', 'purchase-1', 1, 'employee', 'commit']), provider: 'psp-intruder', holdRef }).reason,
    'foreign_provider',
  );
  assert.equal(
    w.ledger.releaseHold({ key: operationKey(['leg', 'purchase-1', 1, 'employee', 'release']), provider: 'psp-intruder', holdRef }).reason,
    'foreign_provider',
  );
  assert.equal(
    w.ledger.defund({ key: operationKey(['leg', 'purchase-1', 1, 'employee', 'defund']), provider: 'psp-intruder', pseudonym: 'ps-alice', amountCents: 100 })
      .reason,
    'foreign_provider',
  );
  assert.equal(
    w.ledger.transfer({ key: operationKey(['leg', 'purchase-1', 1, 'employee', 'transfer']), provider: 'psp-intruder', from: 'ps-alice', to: 'ps-shop', amountCents: 100 })
      .reason,
    'foreign_provider',
  );
  // Nothing moved anywhere.
  assert.equal(w.ledger.holding('ps-alice').deCents, 2_000);
  assert.equal(w.ledger.holding('ps-shop').deCents, 0);
  // Ledger evidence carries pseudonyms and operation/group handles — no
  // payer identifiers appear in any event detail.
  for (const e of w.trace.events) {
    if (e.actor !== 'de-ledger') continue;
    const detail = JSON.stringify(e.detail ?? {});
    assert.equal(detail.includes('payerId'), false, `event ${e.event} leaks a payer id field`);
    assert.equal(detail.includes('alice-the-payer'), false);
  }
});

test('de_group_commit_credits_destination_through_defunding_transit', () => {
  const w = ledgerWorld();
  const groupKey = operationKey(['de-group', 'purchase-1', 1, 'commit', 'employee', 'diner']);
  const groupOf = (self: string) => ({ key: groupKey, self, members: ['employee', 'diner'] });
  const h1 = w.ledger.hold({
    key: operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']),
    provider: 'psp-alice',
    pseudonym: 'ps-alice',
    amountCents: 800,
    destination: 'ps-shop',
    group: groupOf('employee'),
  });
  const h2 = w.ledger.hold({
    key: operationKey(['leg', 'purchase-1', 1, 'diner', 'hold']),
    provider: 'psp-bob',
    pseudonym: 'ps-bob',
    amountCents: 700,
    destination: 'ps-shop',
    group: groupOf('diner'),
  });
  const commit = w.ledger.commitGroup({
    key: groupKey,
    members: [
      { leg: 'employee', holdRef: h1.reference!, provider: 'psp-alice' },
      { leg: 'diner', holdRef: h2.reference!, provider: 'psp-bob' },
    ],
  });
  assert.equal(commit.status, 'succeeded');
  // Both members committed in one step; the zero-limit shop holding keeps
  // no spendable digital euro — the whole 1500 sits in defunding transit
  // awaiting its paired bank credit (decision 10, spec §6.1).
  assert.equal(w.ledger.holding('ps-alice').deCents, 1_200);
  assert.equal(w.ledger.holding('ps-bob').deCents, 1_300);
  assert.equal(w.ledger.holding('ps-shop').deCents, 0);
  assert.equal(w.ledger.holdAudit(h1.reference!).status, 'committed');
  assert.equal(w.ledger.holdAudit(h2.reference!).status, 'committed');
  const transit = w.ledger.transit();
  assert.equal(transit.length, 2);
  assert.deepEqual(
    transit.map((x: DeTransitAudit) => [x.pseudonym, x.amountCents, x.status]),
    [
      ['ps-shop', 800, 'in_transit'],
      ['ps-shop', 700, 'in_transit'],
    ],
  );
  // The destination's provider confirms each transit entry to bank through
  // its own keyed defund; a foreign provider cannot.
  const confirm = w.ledger.defund({
    key: operationKey(['leg', 'purchase-1', 1, 'employee', 'defund-transit']),
    provider: 'psp-shop',
    pseudonym: 'ps-shop',
    amountCents: 800,
    transitRef: transit[0].transitRef,
  });
  assert.equal(confirm.status, 'succeeded');
  assert.equal(w.ledger.transit()[0].status, 'defunded');
  // A replay of the group commit never settles the members twice.
  const replay = w.ledger.commitGroup({
    key: groupKey,
    members: [
      { leg: 'employee', holdRef: h1.reference!, provider: 'psp-alice' },
      { leg: 'diner', holdRef: h2.reference!, provider: 'psp-bob' },
    ],
  });
  assert.equal(replay.status, 'succeeded');
  assert.deepEqual((replay.effects as DeGroupCommitEffects).members.length, 2);
  assert.equal(w.ledger.holding('ps-alice').deCents, 1_200);
});

test('de_commit_response_loss_reconciles_by_original_key', () => {
  const w = ledgerWorld();
  const hold = w.ledger.hold({
    key: operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']),
    provider: 'psp-alice',
    pseudonym: 'ps-alice',
    amountCents: 800,
    destination: 'ps-shop',
  });
  const holdRef = hold.reference!;
  const commitKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit']);
  w.ledger.setFault(commitKey, 'commit', 'lose_response_after_effect');
  // The response is lost on the way back: the caller sees 'unknown' with
  // no reference, never a fabricated failure.
  const res = w.ledger.commitHold({ key: commitKey, provider: 'psp-alice', holdRef });
  assert.equal(res.status, 'unknown');
  assert.equal(res.reference, undefined);
  // The commit did happen — provable only through the original operation
  // key's authoritative status.
  const truth = w.ledger.status(commitKey)!;
  assert.equal(truth.status, 'succeeded');
  assert.equal(truth.reference, holdRef);
  assert.equal(w.ledger.holdAudit(holdRef).status, 'committed');
  assert.equal(w.ledger.holding('ps-alice').deCents, 1_200);
  assert.equal(w.ledger.transit().length, 1);
  // A replay under the same key and terms returns the resolved record —
  // never a second settle or destination credit.
  const replay = w.ledger.commitHold({ key: commitKey, provider: 'psp-alice', holdRef });
  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.reference, holdRef);
  assert.equal(w.ledger.holding('ps-alice').deCents, 1_200);
  assert.equal(w.ledger.transit().length, 1);
});

test('deferred_commit_locks_hold_past_deadline', () => {
  const w = ledgerWorld();
  const hold = w.ledger.hold({
    key: operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']),
    provider: 'psp-alice',
    pseudonym: 'ps-alice',
    amountCents: 800,
    destination: 'ps-shop',
  });
  const holdRef = hold.reference!;
  const commitKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'commit']);
  w.ledger.setFault(commitKey, 'commit', 'defer');
  const res = w.ledger.commitHold({ key: commitKey, provider: 'psp-alice', holdRef });
  assert.equal(res.status, 'pending');
  // The hold already exists, so naming it is honest — and the audit
  // reports the parked commit, not a plain 'active' hold.
  assert.equal(res.reference, holdRef);
  assert.equal(w.ledger.holdAudit(holdRef).commitPending, true);
  // Past the deadline the handed-off commit still cannot be preempted:
  // expiry must not tombstone a hold whose operation outcome is open.
  w.set(11);
  const parked = w.ledger.holdAudit(holdRef);
  assert.equal(parked.status, 'active');
  assert.equal(parked.commitPending, true);
  assert.equal(w.ledger.holding('ps-alice').heldCents, 800);
  // Dependent work stops while the commit is unresolved.
  assert.throws(
    () =>
      w.ledger.commitHold({
        key: operationKey(['leg', 'purchase-1', 1, 'employee', 'commit-again']),
        provider: 'psp-alice',
        holdRef,
      }),
    /hold_commit_pending/,
  );
  // The explicit simulation resolution decides the race: the commit
  // settles the hold past its original deadline and audits normally.
  const done = w.ledger.resolveDeferred(commitKey, 'succeed');
  assert.equal(done.status, 'succeeded');
  assert.equal(done.reference, holdRef);
  const audit = w.ledger.holdAudit(holdRef);
  assert.equal(audit.status, 'committed');
  assert.equal(audit.commitPending, false);
  assert.equal(w.ledger.holding('ps-alice').deCents, 1_200);
});

test('deferred_or_refused_hold_records_no_phantom_reference', () => {
  const w = ledgerWorld();
  const deferredKey = operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']);
  w.ledger.setFault(deferredKey, 'hold', 'defer');
  const parked = w.ledger.hold({
    key: deferredKey,
    provider: 'psp-alice',
    pseudonym: 'ps-alice',
    amountCents: 800,
    destination: 'ps-shop',
  });
  // Until the hold exists there is no handle to report: the pending
  // record reconciles by its original key alone.
  assert.equal(parked.status, 'pending');
  assert.equal(parked.reference, undefined);
  assert.equal(w.ledger.status(deferredKey)!.reference, undefined);
  assert.equal(w.ledger.holds().length, 0);
  // A rejected deferred hold leaves no phantom reference either.
  const rejected = w.ledger.resolveDeferred(deferredKey, 'reject');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reference, undefined);
  assert.equal(w.ledger.holds().length, 0);
  // A refused attempt records no reference either.
  const refusedKey = operationKey(['leg', 'purchase-2', 1, 'employee', 'hold']);
  w.ledger.setFault(refusedKey, 'hold', 'reject_before_effect');
  const refused = w.ledger.hold({
    key: refusedKey,
    provider: 'psp-alice',
    pseudonym: 'ps-alice',
    amountCents: 100,
    destination: 'ps-shop',
  });
  assert.equal(refused.status, 'rejected');
  assert.equal(refused.reference, undefined);
  assert.equal(w.ledger.holds().length, 0);
  // A deferred hold that succeeds mints its reference at apply time —
  // the first hold number, since the refused attempts consumed none.
  const okKey = operationKey(['leg', 'purchase-3', 1, 'employee', 'hold']);
  w.ledger.setFault(okKey, 'hold', 'defer');
  w.ledger.hold({ key: okKey, provider: 'psp-alice', pseudonym: 'ps-alice', amountCents: 100, destination: 'ps-shop' });
  const done = w.ledger.resolveDeferred(okKey, 'succeed');
  assert.equal(done.status, 'succeeded');
  assert.equal(done.reference, 'hold-1');
  assert.equal(w.ledger.holdAudit(done.reference!).status, 'active');
});

test('foreign_provider_cannot_confirm_transit_defund', () => {
  const w = ledgerWorld();
  // Park an excess credit in defunding transit: the zero-limit shop
  // receives the committed 800 as an in-transit entry.
  const hold = w.ledger.hold({
    key: operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']),
    provider: 'psp-alice',
    pseudonym: 'ps-alice',
    amountCents: 800,
    destination: 'ps-shop',
  });
  w.ledger.commitHold({
    key: operationKey(['leg', 'purchase-1', 1, 'employee', 'commit']),
    provider: 'psp-alice',
    holdRef: hold.reference!,
  });
  const transitRef = w.ledger.transit()[0].transitRef;
  // The paired transit confirm is still the destination provider's
  // operation — a foreign provider is refused before any transit check.
  const res = w.ledger.defund({
    key: operationKey(['leg', 'purchase-1', 1, 'employee', 'defund-transit']),
    provider: 'psp-intruder',
    pseudonym: 'ps-shop',
    amountCents: 800,
    transitRef,
  });
  assert.equal(res.status, 'rejected');
  assert.equal(res.reason, 'foreign_provider');
  assert.equal(w.ledger.transit()[0].status, 'in_transit');
});

test('hold_replay_after_expiry_keeps_operation_truth', () => {
  const { ledger, set } = ledgerWorld();
  const req = {
    key: operationKey(['leg', 'purchase-1', 1, 'employee', 'hold']),
    provider: 'psp-alice',
    pseudonym: 'ps-alice',
    amountCents: 800,
    destination: 'ps-shop',
  };
  const first = ledger.hold(req);
  assert.equal(first.status, 'succeeded');
  const holdRef = first.reference!;
  // Past the deadline the hold's lifecycle tombstones, but the operation
  // record is immutable truth: a replay still reports the reserve that
  // succeeded — status and lifecycle are separate evidence.
  set(11);
  const replay = ledger.hold({ ...req });
  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.reference, holdRef);
  assert.equal(ledger.holdAudit(holdRef).status, 'expired');
  assert.equal(ledger.holds().length, 1);
  assert.equal(ledger.holding('ps-alice').spendableCents, 2_000);
});

// A stub provider bank book: the transfer module holds nothing per
// customer — it asks each endpoint's book to move the money.
function bookStub(balance: number) {
  return {
    balance,
    debits: 0,
    credits: 0,
    debit(amount: number) {
      if (this.balance < amount) throw new Error('insufficient_funds');
      this.balance -= amount;
      this.debits += 1;
    },
    credit(amount: number) {
      this.balance += amount;
      this.credits += 1;
    },
  };
}

function bankWorld() {
  const trace = new Trace();
  let t = 10;
  const transfers = new InterbankTransfer(() => t, trace);
  const from = bookStub(100_000);
  const to = bookStub(0);
  transfers.registerBook('psp-employer', from);
  transfers.registerBook('psp-shop', to);
  return { trace, transfers, from, to, set: (v: number) => { t = v; } };
}

test('bank_response_loss_never_duplicates_credit', () => {
  const { transfers, from, to } = bankWorld();
  const key = operationKey(['leg', 'purchase-1', 1, 'employer', 'transfer']);
  const req = { key, initiator: 'psp-employer', from: 'psp-employer', to: 'psp-shop', amountCents: 500 };
  transfers.setFault(key, 'credit', 'lose_response_after_effect');
  // The response is lost on the way back: the caller sees 'unknown' with no
  // reference, never a fabricated failure.
  const res = transfers.transfer(req);
  assert.equal(res.status, 'unknown');
  assert.equal(res.reference, undefined);
  // The effect did happen on both books — provable only through the
  // original operation key's authoritative status.
  assert.equal(from.balance, 99_500);
  assert.equal(to.balance, 500);
  const truth = transfers.status(key)!;
  assert.equal(truth.status, 'succeeded');
  const transferRef = truth.reference!;
  const audit = transfers.transferAudit(key)!;
  assert.equal(audit.transferRef, transferRef);
  assert.equal(audit.debited, true);
  assert.equal(audit.credited, true);
  // A replay under the same key and terms returns the original transfer —
  // never a second debit or credit.
  const replay = transfers.transfer(req);
  assert.equal(replay.status, 'succeeded');
  assert.equal(replay.reference, transferRef);
  assert.equal(from.debits, 1);
  assert.equal(to.credits, 1);
  assert.equal(from.balance, 99_500);
  assert.equal(to.balance, 500);
});

test('deferred_destination_credit_keeps_debit_in_transit', () => {
  const { transfers, from, to } = bankWorld();
  const key = operationKey(['leg', 'purchase-1', 1, 'employer', 'transfer']);
  transfers.setFault(key, 'credit', 'defer');
  const res = transfers.transfer({ key, initiator: 'psp-employer', from: 'psp-employer', to: 'psp-shop', amountCents: 500 });
  // A debit alone is not settlement: the amount sits in explicit transit —
  // debited, not yet credited, not cancelled.
  assert.equal(res.status, 'pending');
  assert.equal(from.balance, 99_500);
  assert.equal(to.balance, 0);
  assert.deepEqual(
    transfers.transit().map((x) => [x.amountCents, x.debited, x.credited]),
    [[500, true, false]],
  );
  // Dependent work stops while the operation is unresolved: the uncredited
  // transit cannot be cancelled until its outcome is known.
  assert.throws(() => transfers.cancelUncredited(key), /transfer_unresolved/);
  // A replay does not push the deferred credit forward — only the explicit
  // simulation resolution does, under the original key.
  assert.equal(transfers.transfer({ key, initiator: 'psp-employer', from: 'psp-employer', to: 'psp-shop', amountCents: 500 }).status, 'pending');
  const done = transfers.resolveDeferred(key, 'succeed');
  assert.equal(done.status, 'succeeded');
  assert.equal(to.balance, 500);
  assert.equal(transfers.transit().length, 0);
  assert.equal(from.debits, 1);
});

test('uncredited_bank_debit_cancels_back_to_source', () => {
  const { transfers, from, to } = bankWorld();
  const key = operationKey(['leg', 'purchase-1', 1, 'employer', 'transfer']);
  // The destination credit is conclusively refused after the debit applied:
  // the transfer is rejected but the debit remains in tracked transit.
  transfers.setFault(key, 'credit', 'reject_before_effect');
  const res = transfers.transfer({ key, initiator: 'psp-employer', from: 'psp-employer', to: 'psp-shop', amountCents: 500 });
  assert.equal(res.status, 'rejected');
  assert.equal(res.reason, 'credit_rejected');
  assert.equal(from.balance, 99_500);
  assert.equal(to.balance, 0);
  assert.equal(transfers.transit().length, 1);
  // Compensation cancels the uncredited transit back to the source book.
  const cancelled = transfers.cancelUncredited(key);
  assert.equal(cancelled.cancelled, true);
  assert.equal(from.balance, 100_000);
  assert.equal(to.balance, 0);
  assert.equal(transfers.transit().length, 0);
});

test('fractional_or_negative_amounts_are_refused', () => {
  const w = ledgerWorld();
  for (const bad of [10.5, -1, 0, Number.NaN]) {
    assert.throws(
      () => w.ledger.hold({ key: operationKey(['k', String(bad)]), provider: 'psp-alice', pseudonym: 'ps-alice', amountCents: bad, destination: 'ps-shop' }),
      /amount_invalid/,
    );
    assert.throws(
      () => w.ledger.fund({ key: operationKey(['k', 'f', String(bad)]), provider: 'psp-alice', pseudonym: 'ps-alice', amountCents: bad }),
      /amount_invalid/,
    );
  }
  const { transfers } = bankWorld();
  assert.throws(
    () => transfers.transfer({ key: operationKey(['k', 't']), initiator: 'psp-employer', from: 'psp-employer', to: 'psp-shop', amountCents: 1.5 }),
    /amount_invalid/,
  );
});
