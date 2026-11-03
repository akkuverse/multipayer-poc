// The coordinator-owned purchase store: ids in, live read-only views out,
// and a reused purchaseId refused before any state or trace change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approveAs, lunch, updateEmployeeMandate, updateMandate, world, AUTO_EMPLOYEE_TERMS, COLLEAGUE_1, COLLEAGUE_2, EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_B, MERCHANT_C } from '../src/scenarios.ts';
import { readonlyView, unwrapView } from '../src/core/live-view.ts';
import { ADOPTABLE, TRANSITIONS, canTransition } from '../src/core/states.ts';
import type { Purchase, PurchaseState } from '../src/core/types.ts';

const SPLIT = {
  purchaseId: 'split-1',
  merchantId: MERCHANT_B,
  expiresAt: 100,
  shares: [
    { role: 'a', payerId: EMPLOYEE, amountCents: 500 },
    { role: 'b', payerId: COLLEAGUE_1, amountCents: 500 },
  ],
};

const SPLIT3 = {
  purchaseId: 'split-3',
  merchantId: MERCHANT_B,
  expiresAt: 100,
  shares: [
    { role: 'a', payerId: EMPLOYEE, amountCents: 334 },
    { role: 'b', payerId: COLLEAGUE_1, amountCents: 333 },
    { role: 'c', payerId: COLLEAGUE_2, amountCents: 333 },
  ],
};

const READ_ONLY = { name: 'TypeError', message: 'purchase view is read-only' };

test('propose refuses a reused purchaseId and appends no trace events', () => {
  const w = world();
  lunch(w);
  const events = w.trace.events.length;
  assert.throws(() => lunch(w), /duplicate_purchase/);
  assert.equal(w.trace.events.length, events);
});

test('proposeSplit refuses a reused purchaseId and appends no trace events', () => {
  const w = world();
  w.coordinator.view(w.coordinator.proposeSplit(SPLIT));
  const events = w.trace.events.length;
  assert.throws(() => w.coordinator.view(w.coordinator.proposeSplit(SPLIT)), /duplicate_purchase/);
  // A reused id is refused at whichever entry point takes it.
  assert.throws(() => lunch(w, 1_300, MERCHANT_A, { purchaseId: SPLIT.purchaseId }), /duplicate_purchase/);
  assert.equal(w.trace.events.length, events);
});

test('view reads current fields and reflects later mutations', () => {
  const w = world();
  const p = lunch(w);
  const v = w.coordinator.view(p.purchaseId);
  assert.equal(v.purchaseId, 'purchase-1');
  assert.equal(v.state, 'awaiting_approvals');
  assert.equal(v.proposal.version, 1);
  assert.equal(v.proposal.totalCents, 1_300);
  assert.equal(v.benefit?.employeeId, EMPLOYEE);
  assert.deepEqual(
    v.proposal.shares.map((s) => `${s.role}:${s.amountCents}`),
    ['employee:800', 'employer:500'],
  );
  approveAs(w, p, EMPLOYEE);
  assert.equal(v.state, 'ready');
  assert.equal(v.authorizations.length, 1);
});

test('every write shape through a view throws', async () => {
  const w = world();
  const p = w.coordinator.view(w.coordinator.proposeSplit(SPLIT));
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, COLLEAGUE_1);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  const v = w.coordinator.view(p.purchaseId);
  assert.equal(v.state, 'completed');
  assert.equal(v.legs.length, 2);
  assert.throws(() => {
    (v as Purchase).state = 'failed';
  }, READ_ONLY);
  assert.throws(() => {
    (v.legs as unknown[]).push({});
  }, READ_ONLY);
  assert.throws(() => {
    (v.legs[0] as { status: string }).status = 'settled';
  }, READ_ONLY);
  assert.throws(() => {
    delete (v as Partial<Purchase>).state;
  }, READ_ONLY);
  assert.throws(() => Object.defineProperty(v, 'extra', { value: 1 }), READ_ONLY);
  assert.throws(() => Object.setPrototypeOf(v, null), READ_ONLY);
  assert.throws(() => Object.preventExtensions(v), READ_ONLY);
  assert.throws(() => Object.freeze(v), READ_ONLY);
  // A failed freeze must not leave the record non-extensible: fields the
  // coordinator adds later (receipt, dispute, …) would silently die.
  assert.equal(Object.isExtensible(unwrapView(v)), true);
});

test('view identity is stable per record, nested objects included', () => {
  const w = world();
  const p = w.coordinator.view(w.coordinator.proposeSplit(SPLIT));
  assert.equal(w.coordinator.view(p.purchaseId), w.coordinator.view(p.purchaseId));
  const v = w.coordinator.view(p.purchaseId);
  assert.equal(v.legs, v.legs);
  assert.equal(v.proposal, v.proposal);
});

test('a view deep-equals the plain literal of its record', () => {
  const w = world();
  w.coordinator.view(w.coordinator.proposeSplit(SPLIT));
  assert.deepEqual(w.coordinator.view('split-1'), {
    purchaseId: 'split-1',
    state: 'awaiting_approvals',
    proposal: {
      version: 1,
      merchantId: MERCHANT_B,
      totalCents: 1_000,
      shares: [
        { role: 'a', payerId: EMPLOYEE, payeeId: MERCHANT_B, amountCents: 500, feeCents: 0, authority: 'payer' },
        { role: 'b', payerId: COLLEAGUE_1, payeeId: MERCHANT_B, amountCents: 500, feeCents: 0, authority: 'payer' },
      ],
      expiresAt: 100,
    },
    authorizations: [],
    legs: [],
    returnStatus: 'none',
  });
});

test('view of an unknown purchaseId throws', () => {
  const w = world();
  assert.throws(() => w.coordinator.view('nope'), /unknown_purchase/);
});

test('a raw view cannot be cloned; unwrapView yields the record to detach', () => {
  const w = world();
  const p = w.coordinator.view(w.coordinator.proposeSplit(SPLIT));
  const v = w.coordinator.view(p.purchaseId);
  assert.throws(() => structuredClone(v), (err: unknown) => (err as { name?: string }).name === 'DataCloneError');
  const copy = structuredClone(unwrapView(v)) as Purchase;
  copy.state = 'cancelled';
  copy.reason = 'detached';
  approveAs(w, p, EMPLOYEE);
  approveAs(w, p, COLLEAGUE_1);
  assert.equal(v.state, 'ready');
  // The detached copy no longer tracks the record.
  assert.equal(copy.state, 'cancelled');
  assert.equal(copy.proposal.version, 1);
});

test('the view refuses non-plain values rather than proxying them', () => {
  class Foreign {
    x = 1;
  }
  assert.throws(() => readonlyView({ m: new Map() }), /plain data/);
  assert.throws(() => readonlyView({ nested: { d: new Date() } }), /plain data/);
  assert.throws(() => readonlyView({ c: new Foreign() }), /plain data/);
});

test('canTransition accepts every table pair and refuses unreachable moves', () => {
  for (const [from, targets] of Object.entries(TRANSITIONS) as [PurchaseState, PurchaseState[]][]) {
    for (const to of targets) assert.equal(canTransition(from, to), true, `${from} → ${to}`);
  }
  assert.deepEqual(ADOPTABLE, ['awaiting_approvals', 'ready']);
  assert.equal(canTransition('completed', 'cancelled'), false);
  assert.equal(canTransition('pending', 'draft'), false);
  assert.equal(canTransition('draft', 'pending'), false);
  // completed, failed and cancelled are terminal: nothing leaves them.
  for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
    for (const to of Object.keys(TRANSITIONS) as PurchaseState[]) {
      assert.equal(canTransition(terminal, to), false, `${terminal} → ${to}`);
    }
  }
});

test('folded state events reproduce view(id).state after a full run', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  await w.coordinator.reconcile(p.purchaseId);
  let folded: PurchaseState | undefined;
  for (const e of w.trace.events.filter((e) => e.event === 'state' && e.detail?.purchaseId === p.purchaseId)) {
    // A move continues the last reported state; a re-report repeats it.
    if (e.detail?.from !== undefined && folded !== undefined) assert.equal(e.detail.from, folded);
    folded = e.detail?.to as PurchaseState;
  }
  assert.equal(folded, w.coordinator.view(p.purchaseId).state);
  assert.equal(folded, 'completed');
});

test('approve emits a state event for the awaiting_approvals → ready move', () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE);
  const ready = w.trace.events.find(
    (e) => e.event === 'state' && e.detail?.purchaseId === p.purchaseId && e.detail?.to === 'ready',
  );
  assert.equal(ready?.detail?.from, 'awaiting_approvals');
});

test('propose adopts the purchase at proposal version 1 — no draft, no version-0 moment', () => {
  const w = world();
  const p = lunch(w);
  const v = w.coordinator.view(p.purchaseId);
  assert.equal(v.proposal.version, 1);
  assert.equal(v.state, 'awaiting_approvals');
  const events = w.trace.events.filter((e) => e.detail?.purchaseId === p.purchaseId);
  // The insertion state event has no 'from': adoption lands the record
  // directly in its derived open state; the draft skeleton is gone.
  const inserted = events.find((e) => e.event === 'state')!;
  assert.equal(inserted.detail?.to, 'awaiting_approvals');
  assert.equal(inserted.detail?.from, undefined);
  const proposal = events.find((e) => e.event === 'proposal')!;
  assert.equal(proposal.detail?.version, 1);
  // The event always reports the post-commit state and why it was written.
  assert.equal(proposal.detail?.state, 'awaiting_approvals');
  assert.equal(proposal.detail?.cause, 'proposed');
  // No trace event ever observed a version-0 proposal.
  assert.ok(!events.some((e) => e.detail?.version === 0 || e.detail?.proposalVersion === 0));
});

test('a blocked-merchant propose throws, leaves no record, and logs only proposal_rejected', () => {
  const w = world({}, {}, { employeeMandate: { ...AUTO_EMPLOYEE_TERMS, blockedMerchants: [MERCHANT_C] } });
  const events = w.trace.events.length;
  assert.throws(() => lunch(w, 900, MERCHANT_C), /proposal rejected/);
  assert.throws(() => w.coordinator.view('purchase-1'), /unknown_purchase/);
  // The rejection itself stays evidence; nothing else was produced.
  assert.deepEqual(
    w.trace.events.slice(events).map((e) => [e.event, e.detail?.reason]),
    [['proposal_rejected', 'blocked_merchant']],
  );
});

test('proposeSplit emits the insertion state event then the proposal event', () => {
  const w = world();
  w.coordinator.view(w.coordinator.proposeSplit(SPLIT));
  const events = w.trace.events.filter((e) => e.detail?.purchaseId === 'split-1');
  assert.deepEqual(
    events.map((e) => e.event),
    ['state', 'proposal'],
  );
  assert.equal(events[0].detail?.to, 'awaiting_approvals');
  assert.equal(events[0].detail?.from, undefined);
  assert.equal(events[1].detail?.state, 'awaiting_approvals');
  assert.equal(events[1].detail?.cause, 'split');
});

test('an Auto proposal records its authority evidence before the insertion state event', () => {
  const w = world({}, {}, { employeeMandate: AUTO_EMPLOYEE_TERMS, supportsMandatePayments: true });
  const p = lunch(w, 900);
  // Auto under the signed standing terms: adopted straight into 'ready'.
  assert.equal(w.coordinator.view(p.purchaseId).state, 'ready');
  const events = w.trace.events.filter((e) => e.detail?.purchaseId === p.purchaseId);
  assert.deepEqual(
    events.map((e) => e.event),
    ['auth_zone', 'approval_recorded', 'state', 'proposal'],
  );
  assert.equal(events[2].detail?.to, 'ready');
  assert.equal(events[2].detail?.from, undefined);
  assert.equal(events[3].detail?.state, 'ready');
});

test('changeOffer bumps the version, invalidates the approval before the new state and proposal, and carries the cause', () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE);
  w.coordinator.changeOffer(p.purchaseId, { merchantId: MERCHANT_B, totalCents: 1_400, expiresAt: 100 });
  const v = w.coordinator.view(p.purchaseId);
  assert.equal(v.proposal.version, 2);
  assert.equal(v.proposal.merchantId, MERCHANT_B);
  assert.equal(v.state, 'awaiting_approvals');
  assert.equal(v.authorizations.length, 0);
  const events = w.trace.events;
  const invalidated = events.findIndex((e) => e.event === 'approval_invalidated');
  const moved = events.findIndex((e) => e.event === 'state' && e.detail?.from === 'ready' && e.detail?.to === 'awaiting_approvals');
  const proposal = events.findIndex((e) => e.event === 'proposal' && e.detail?.version === 2);
  assert.ok(
    invalidated !== -1 && invalidated < moved && moved < proposal,
    'the invalidation precedes the state move and the proposal event',
  );
  assert.equal(events[proposal].detail?.cause, 'offer_changed');
  assert.equal(events[proposal].detail?.state, 'awaiting_approvals');
});

// --- byPayer index and openFor (task 4) -------------------------------------

test('proposeSplit with three payers indexes all three', () => {
  const w = world();
  w.coordinator.view(w.coordinator.proposeSplit(SPLIT3));
  for (const payer of [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2]) {
    assert.deepEqual(w.coordinator.openFor(payer), ['split-3']);
  }
  // Nobody else holds a share — insertion-ordered ids, never a superset.
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), []);
  assert.deepEqual(w.coordinator.openFor('nobody'), []);
});

test('openFor(employer) lists open benefit purchases carrying an employer share', () => {
  const w = world();
  const p = lunch(w);
  const q = lunch(w, 1_300, MERCHANT_B, { purchaseId: 'purchase-2' });
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), [p.purchaseId, q.purchaseId]);
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), [p.purchaseId, q.purchaseId]);
  assert.deepEqual(w.coordinator.openFor(COLLEAGUE_1), []);
});

test('after submit, openFor returns [] for every payer', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(w.coordinator.view(p.purchaseId).state, 'completed');
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), []);
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), []);
});

test('a changeOffer that drops the employer share removes the employer index entry', () => {
  // A mandate that funds nothing still produces an employer share of 0:
  // the payer is indexed while the share exists at all.
  const w = world({}, { maxPerPurchaseCents: 0 });
  const p = lunch(w);
  assert.ok(w.coordinator.view(p.purchaseId).proposal.shares.some((s) => s.payerId === EMPLOYER));
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), [p.purchaseId]);
  // Corrupt the retained record — the registry's documented fault-injection
  // seam — so the mandate stops resolving entirely: the replacement
  // proposal carries no employer share, and the index entry goes with it.
  w.authority.employerMandate(w.mandate.mandateRef)!.payload.beneficiaryRef = COLLEAGUE_1;
  const outcome = w.coordinator.changeOffer(p.purchaseId, { merchantId: MERCHANT_B, totalCents: 1_300, expiresAt: 100 });
  assert.deepEqual(outcome, { outcome: 'replaced' });
  assert.ok(!w.coordinator.view(p.purchaseId).proposal.shares.some((s) => s.payerId === EMPLOYER));
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), []);
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), [p.purchaseId]);
});

test('publishing employee terms refreshes a benefit purchase and visits a split the employee pays', () => {
  const w = world({}, {}, { employeeMandate: AUTO_EMPLOYEE_TERMS, supportsMandatePayments: true });
  // Auto under the signed standing terms: adopted 'ready' with mandate evidence.
  const p = lunch(w, 900);
  const s = w.coordinator.view(w.coordinator.proposeSplit(SPLIT));
  // The index drives the publication sweep: the split appears because the
  // employee pays a share of it, even though it has no benefit terms.
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), [p.purchaseId, s.purchaseId]);
  // A next revision blocking merchant-a must re-assess the benefit
  // purchase (Blocked → draft); the split is visited and untouched —
  // refreshAuth no-ops on !benefit.
  updateEmployeeMandate(w, { blockedMerchants: [MERCHANT_A] });
  const v = w.coordinator.view(p.purchaseId);
  assert.equal(v.employeeAssessment?.authZone, 'Blocked');
  assert.equal(v.state, 'draft');
  assert.equal(v.reason, 'blocked_merchant');
  const sv = w.coordinator.view(s.purchaseId);
  assert.equal(sv.state, 'awaiting_approvals');
  assert.equal(sv.proposal.version, 1);
  assert.equal(sv.authorizations.length, 0);
  assert.ok(!w.trace.events.some((e) => e.event === 'auth_zone' && e.detail?.purchaseId === s.purchaseId));
  // Both purchases remain open — 'draft' is an open state.
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), [p.purchaseId, s.purchaseId]);
});

// --- Invariants over the trace, the version counter and the write paths ---

test('trace fold: the latest proposal event is the live proposal; state events fold to the live state', async () => {
  // A mixed world: one benefit purchase and one three-payer split, each run
  // through several transitions, the benefit purchase through two proposals.
  const w = world();
  const p = lunch(w);
  const s = w.coordinator.view(w.coordinator.proposeSplit(SPLIT3));
  approveAs(w, p, EMPLOYEE);
  approveAs(w, s, EMPLOYEE);
  approveAs(w, s, COLLEAGUE_1);
  approveAs(w, s, COLLEAGUE_2);
  w.coordinator.changeOffer(p.purchaseId, { merchantId: MERCHANT_B, totalCents: 1_300, expiresAt: 100 });
  approveAs(w, p, EMPLOYEE);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  await w.coordinator.submit(s.purchaseId, 'atomic');
  await w.coordinator.reconcile(p.purchaseId);
  await w.coordinator.reconcile(s.purchaseId);

  for (const id of [p.purchaseId, s.purchaseId]) {
    const v = w.coordinator.view(id);
    // The latest proposal event per purchase is the committed proposal,
    // verbatim — the event encodes shares as 'role:amount' strings.
    const proposals = w.trace.events.filter((e) => e.event === 'proposal' && e.detail?.purchaseId === id);
    const last = proposals.at(-1)!;
    assert.equal(last.detail?.version, v.proposal.version, `${id} version`);
    assert.equal(last.detail?.merchantId, v.proposal.merchantId, `${id} merchant`);
    assert.equal(last.detail?.totalCents, v.proposal.totalCents, `${id} total`);
    assert.deepEqual(
      last.detail?.shares,
      v.proposal.shares.map((x) => `${x.role}:${x.amountCents}`),
      `${id} shares`,
    );
    // Replay this purchase's state and proposal events in trace order. The
    // first state event is the insertion (no 'from'); every later one
    // continues the fold — including the recovery_required re-report, whose
    // 'from' repeats the folded value. A proposal event always reports the
    // post-commit state, i.e. the fold as of that moment.
    let folded: PurchaseState | undefined;
    for (const e of w.trace.events.filter((e) => e.detail?.purchaseId === id && (e.event === 'state' || e.event === 'proposal'))) {
      if (e.event === 'proposal') {
        assert.equal(e.detail?.state, folded, `${id}: proposal v${String(e.detail?.version)} reports the post-commit state`);
        continue;
      }
      if (folded === undefined) assert.equal(e.detail?.from, undefined, `${id}: the insertion state event has no 'from'`);
      else assert.equal(e.detail?.from, folded, `${id}: state events chain without gaps`);
      folded = e.detail?.to as PurchaseState;
    }
    assert.equal(folded, v.state, `${id}: the folded state is the live state`);
  }
});

test('changeOffer chains produce proposal versions 1,2,3… and the events agree', () => {
  const w = world();
  const p = lunch(w);
  const seen: number[] = [w.coordinator.view(p.purchaseId).proposal.version];
  for (const merchantId of [MERCHANT_B, MERCHANT_C, MERCHANT_A]) {
    w.coordinator.changeOffer(p.purchaseId, { merchantId, totalCents: 1_300, expiresAt: 100 });
    seen.push(w.coordinator.view(p.purchaseId).proposal.version);
  }
  assert.deepEqual(seen, [1, 2, 3, 4]);
  // The proposal events record exactly that sequence — no skipped, repeated
  // or rewritten version. Only commitProposal may write them; the source
  // lint below guards the writer.
  const emitted = w.trace.events
    .filter((e) => e.event === 'proposal' && e.detail?.purchaseId === p.purchaseId)
    .map((e) => e.detail?.version);
  assert.deepEqual(emitted, seen);
  // No trace event ever observed a version-0 proposal (the draft skeleton).
  assert.ok(!w.trace.events.some((e) => e.detail?.version === 0 || e.detail?.proposalVersion === 0));
});

// The write-path lint reads the coordinator's own source. Members of the
// Coordinator class start on a two-space-indented header line — methods as
// `name(`, fields as `name:` or `name =`, optional modifiers and generic
// parameters — while bodies indent deeper, so header lines mark the member
// boundaries no matter how the bodies are edited. Fields count: an
// arrow-function field could hold a write or a leak that a methods-only
// pattern would misattribute to the previous member.
const coordinatorClassBody = (): string => {
  const src = readFileSync(new URL('../src/core/coordinator.ts', import.meta.url), 'utf8');
  const start = src.indexOf('export class Coordinator');
  assert.ok(start !== -1, 'coordinator.ts no longer declares the Coordinator class');
  return src.slice(start);
};

const membersOf = (body: string): { name: string; isPrivate: boolean; isMethod: boolean; offset: number; paren: number }[] => {
  const re = /^  ((?:(?:private|public|protected|static|async|readonly|override)\s+)*)([A-Za-z_$#][\w$#]*)\??\s*(?:<[^>\n]*>)?\s*([(:=])/gm;
  return [...body.matchAll(re)].map((m) => ({
    name: m[2],
    isPrivate: m[1].includes('private'),
    isMethod: m[3] === '(',
    offset: m.index,
    paren: m.index + m[0].length - 1,
  }));
};

test('lint: rec.state and rec.proposal are assigned only inside their write paths', () => {
  const body = coordinatorClassBody();
  const members = membersOf(body);
  // The enclosing member of an offset is the last header that began before
  // it — method boundaries, not line numbers.
  const owner = (offset: number): string =>
    members.filter((m) => m.offset < offset).at(-1)?.name ?? '<class scope>';
  const writes = [...body.matchAll(/\.(state|proposal)\s*=(?!=)/g)];
  assert.ok(writes.length >= 3, 'the write-path assignments were not found — has the lint broken?');
  const GUARDS: Record<'state' | 'proposal', string[]> = {
    state: ['transition', 'adopt'],
    proposal: ['commitProposal'],
  };
  const guarded = new Set<string>();
  for (const w of writes) {
    const field = w[1] as 'state' | 'proposal';
    const holder = owner(w.index);
    assert.ok(
      GUARDS[field].includes(holder),
      `.${field} is assigned inside ${holder} — only ${GUARDS[field].join('/')} may write it`,
    );
    guarded.add(holder);
  }
  // A renamed or gutted write path must fail the lint, not pass vacuously.
  for (const guard of ['transition', 'adopt', 'commitProposal']) {
    assert.ok(guarded.has(guard), `${guard} writes neither field — was the write path renamed?`);
  }
});

test('lint: no public member exposes the Purchase record', () => {
  const body = coordinatorClassBody();
  for (const m of membersOf(body)) {
    if (m.isPrivate || m.name === 'constructor') continue;
    if (m.isMethod) {
      // The signature's return annotation sits between the closing ')' of the
      // parameters and the '{' of the body. It is required rather than
      // optional: an unannotated method could return a record this scan
      // could not see.
      let depth = 0;
      let i = m.paren;
      for (; i < body.length; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const annotation = body.slice(i + 1, body.indexOf('{', i));
      assert.match(
        annotation,
        /^\s*:/,
        `${m.name} has no return annotation — public methods must declare a return type so the seam stays scannable`,
      );
      assert.doesNotMatch(
        annotation,
        /\bPurchase\b/,
        `${m.name} returns ${annotation.trim()} — the record never crosses the public seam; return PurchaseView`,
      );
    } else {
      // A public field declares its type between the name and the
      // initializer or the terminating ';' — required too, and it must
      // never name the record.
      const rest = body.slice(m.paren);
      const decl = rest.slice(0, rest.search(/[=;\n]/));
      assert.match(
        decl,
        /^\s*:/,
        `${m.name} has no type annotation — public fields must declare a type so the seam stays scannable`,
      );
      assert.doesNotMatch(
        decl,
        /\bPurchase\b/,
        `${m.name} declares ${decl.trim()} — the record never crosses the public seam`,
      );
    }
  }
});

test('a backend reporting a settled leg unknown hits illegal_transition — never a silent downgrade', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE);
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(w.coordinator.view(p.purchaseId).state, 'completed');
  // A settled leg can never be reported 'unknown' by a correct backend; an
  // adapter that does must trip the transition table's loud refusal, not
  // downgrade a completed purchase to pending.
  w.backend.submit = (req) =>
    Promise.resolve(req.legs.map((l) => ({ idempotencyKey: l.idempotencyKey, executionRef: 'exec-lying', status: 'unknown' as const })));
  await assert.rejects(w.coordinator.resubmit(p.purchaseId), /illegal_transition:completed→pending/);
  assert.equal(w.coordinator.view(p.purchaseId).state, 'completed');
});

// --- openFor exactness: the index clears on every exit from the open states ---

test('openFor entries survive open→open moves', () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE); // awaiting_approvals → ready
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), [p.purchaseId]);
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), [p.purchaseId]);
  // ready → awaiting_approvals on the new offer: still open, still indexed.
  w.coordinator.changeOffer(p.purchaseId, { merchantId: MERCHANT_B, totalCents: 1_300, expiresAt: 100 });
  assert.equal(w.coordinator.view(p.purchaseId).state, 'awaiting_approvals');
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), [p.purchaseId]);
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), [p.purchaseId]);
});

test('openFor clears when an open purchase is cancelled', () => {
  const w = world();
  const p = lunch(w);
  w.coordinator.cancel(p.purchaseId);
  assert.equal(w.coordinator.view(p.purchaseId).state, 'cancelled');
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), []);
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), []);
});

test('openFor clears when initiation fails the purchase', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE);
  // The employer mandate is revoked between approval and initiation: the
  // recheck fails the purchase before money moves.
  updateMandate(w, { revoked: true });
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(w.coordinator.view(p.purchaseId).state, 'failed');
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), []);
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), []);
});

test('openFor clears while a purchase is pending', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE);
  // A lost response is not a failure: the purchase is pending, and pending
  // is not open.
  w.backend.faults.set(EMPLOYEE, 'timeout_then_settle');
  await w.coordinator.submit(p.purchaseId, 'atomic');
  assert.equal(w.coordinator.view(p.purchaseId).state, 'pending');
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), []);
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), []);
});

test('openFor clears in recovery_required', async () => {
  const w = world();
  const p = lunch(w);
  approveAs(w, p, EMPLOYEE);
  // Independent settlement: the employer leg is declined while the employee
  // leg settles — committed money stays visible, the purchase is not open.
  w.backend.faults.set(EMPLOYER, 'decline');
  await w.coordinator.submit(p.purchaseId, 'independent');
  assert.equal(w.coordinator.view(p.purchaseId).state, 'recovery_required');
  assert.deepEqual(w.coordinator.openFor(EMPLOYEE), []);
  assert.deepEqual(w.coordinator.openFor(EMPLOYER), []);
});
