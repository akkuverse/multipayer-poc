// The presenter session: one purchase, one fixed employee instruction, two
// restricted handles. These tests pin the authority boundary (the signed
// session-scoped grant), capability separation, result isolation, catalog
// behaviour and the recipient-safe projections — through the handles only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  world,
  approveAs,
  advance,
  updateMandate,
  EMPLOYEE,
  EMPLOYER,
  MERCHANT_A,
  MERCHANT_C,
} from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';
import { keyPairFromSeed, signPayload } from '../src/signing.ts';
import type { Signed } from '../src/signing.ts';
import { shareCents } from '../src/coordinator.ts';
import { createPresenterSession } from '../src/presenter-session.ts';
import type { AgentCapability, AgentGrant, CatalogOffer, PresenterSession } from '../src/presenter-session.ts';
import {
  OFFER_A,
  OFFER_B,
  OFFER_C,
  OFFER_FAR,
  OFFER_MEAT,
  PRESENTER_CATALOG,
} from '../src/presenter-fixtures.ts';
import type { Purchase } from '../src/types.ts';

const SESSION_ID = 'session-1';
const PURCHASE_ID = 'purchase-1';
const AGENT_ID = 'agent-1';

const grantPayload = (over: Partial<AgentGrant> = {}): AgentGrant => ({
  grantRef: 'grant-1',
  agentId: AGENT_ID,
  principalId: EMPLOYEE,
  sessionId: SESSION_ID,
  purchaseId: PURCHASE_ID,
  capabilities: ['discover', 'propose', 'explain'],
  expiresAt: 1_000,
  ...over,
});

interface Setup {
  w: World;
  session: PresenterSession;
  signed: Signed<AgentGrant>;
}

const setup = (
  opts: {
    grant?: AgentGrant;
    // Sign with a different registered holder's key, or an unregistered one.
    signAs?: string;
    sessionId?: string;
    purchaseId?: string;
    agentId?: string;
    catalog?: CatalogOffer[];
    configure?: (w: World) => { keyId: string; sign: (g: AgentGrant) => Signed<AgentGrant> };
    // The trusted device confirmation; defaults to the employee signing on
    // their own key. Tests replace it to observe invocation, never outcome.
    onDevice?: (w: World, p: Purchase) => void;
  } = {},
): Setup => {
  const w = world();
  const g = opts.grant ?? grantPayload();
  let signed: Signed<AgentGrant>;
  if (opts.configure) {
    signed = opts.configure(w).sign(g);
  } else if (opts.signAs) {
    const key = w.signers.get(opts.signAs) ?? keyPairFromSeed(`unregistered-${opts.signAs}`, opts.signAs);
    signed = signPayload(g, key);
  } else {
    signed = signPayload(g, w.signers.get(EMPLOYEE)!);
  }
  const session = createPresenterSession({
    sessionId: opts.sessionId ?? SESSION_ID,
    purchaseId: opts.purchaseId ?? PURCHASE_ID,
    agentId: opts.agentId ?? AGENT_ID,
    employeeId: EMPLOYEE,
    employeeMaxCents: 800,
    employeeFeeCents: 0,
    mandateRef: w.mandate.mandateRef,
    grant: signed,
    catalog: structuredClone(opts.catalog ?? PRESENTER_CATALOG),
    coordinator: w.coordinator,
    trace: w.trace,
    keys: w.keys,
    approveOnDevice: (p: Purchase) => {
      if (opts.onDevice) {
        opts.onDevice(w, p);
        return;
      }
      approveAs(w, p, EMPLOYEE);
    },
  });
  return { w, session, signed };
};

const lastDenial = (w: World) => w.trace.events.filter((e) => e.event === 'presenter_denied').at(-1);

// A denied operation may append audit evidence but must never move money,
// record an approval or create/change the purchase.
const assertDenialIsClean = (w: World, reason: string): void => {
  const d = lastDenial(w);
  assert.ok(d, `expected a presenter_denied event (${reason})`);
  assert.equal(d.origin, 'LOCAL');
  assert.equal(d.detail?.reason, reason);
  assert.equal(d.detail?.sessionId, SESSION_ID);
  assert.equal(d.detail?.purchaseId, PURCHASE_ID);
  assert.equal(d.detail?.onBehalfOf, AGENT_ID);
  // A grant denial is audited as presenter_denied only — never also as a
  // refusal (deny() throws before run() is entered).
  assert.equal(
    w.trace.events.filter((e) => e.event === 'presenter_refused').length,
    0,
    'denial must not double-log as refusal',
  );
  assert.equal(w.backend.executionCount(), 0, 'denial executed nothing');
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000, 'denial moved no money');
};

test('each grant defect denies independently and leaves state untouched', () => {
  // A second registered principal, so 'wrong_principal' can carry a valid
  // signature instead of collapsing into signature_invalid.
  const outsider = (w: World) => {
    const k = keyPairFromSeed('key-employee-2', 'synthetic-seed-employee-2');
    w.keys.set(k.keyId, { publicKey: k.publicKey, holder: 'employee-2' });
    return { keyId: k.keyId, sign: (g: AgentGrant) => signPayload(g, k) };
  };

  const cases: { name: string; opts: Parameters<typeof setup>[0]; reason: string }[] = [
    {
      name: 'signature does not verify against the named principal',
      opts: { signAs: EMPLOYER },
      reason: 'signature_invalid',
    },
    {
      name: 'grant expired at the trusted clock',
      opts: { grant: grantPayload({ expiresAt: 5 }) }, // world now = 10
      reason: 'grant_expired',
    },
    {
      name: 'required capability missing',
      opts: { grant: grantPayload({ capabilities: ['explain'] }) },
      reason: 'missing_capability',
    },
    {
      name: 'grant names a different agent',
      opts: { grant: grantPayload({ agentId: 'agent-2' }) },
      reason: 'wrong_agent',
    },
    {
      name: 'grant names a different principal, validly signed',
      opts: { grant: grantPayload({ principalId: 'employee-2' }), configure: outsider },
      reason: 'wrong_principal',
    },
    {
      name: 'grant names a different session',
      opts: { grant: grantPayload({ sessionId: 'session-2' }) },
      reason: 'wrong_session',
    },
    {
      name: 'grant names a different purchase',
      opts: { grant: grantPayload({ purchaseId: 'purchase-2' }) },
      reason: 'wrong_purchase',
    },
  ];

  for (const c of cases) {
    const { w, session } = setup(c.opts);
    assert.throws(() => session.agent.discover({}), /^Error: presenter access denied$/, c.name);
    assertDenialIsClean(w, c.reason);
    // The denial created no purchase: the trusted view still has nothing to
    // explain, and nothing was proposed or approved.
    assert.throws(() => session.userFlow.explain(), /no_proposal/, c.name);
  }
});

test('an expired grant denies even mid-run, without changing the proposal', () => {
  const { w, session } = setup({ grant: grantPayload({ expiresAt: 50 }) });
  const sel = session.agent.selectOffer(OFFER_A.offerRef);
  assert.equal(sel.value.proposalVersion, 1);
  advance(w, 51);
  assert.throws(() => session.agent.explain(), /presenter access denied/);
  assertDenialIsClean(w, 'grant_expired');
  // The retained purchase is exactly where the accepted operation left it.
  const view = session.userFlow.explain().value;
  assert.equal(view.proposalVersion, 1);
  assert.equal(view.approvals.length, 0);
});

test('a malformed or unsigned grant denies; grant-less denials record the absence', () => {
  const w = world();
  // Missing grantRef inside the signed payload: malformed, and the audit
  // event explicitly records that no usable grant reference exists.
  const g = grantPayload();
  delete (g as Partial<AgentGrant>).grantRef;
  const session = createPresenterSession({
    sessionId: SESSION_ID,
    purchaseId: PURCHASE_ID,
    agentId: AGENT_ID,
    employeeId: EMPLOYEE,
    employeeMaxCents: 800,
    mandateRef: w.mandate.mandateRef,
    grant: signPayload(g, w.signers.get(EMPLOYEE)!),
    catalog: structuredClone(PRESENTER_CATALOG),
    coordinator: w.coordinator,
    trace: w.trace,
    keys: w.keys,
    approveOnDevice: (p: Purchase) => approveAs(w, p, EMPLOYEE),
  });
  assert.throws(() => session.agent.discover({}), /presenter access denied/);
  const d = lastDenial(w)!;
  assert.equal(d.detail?.reason, 'malformed_grant');
  assert.equal(d.detail?.grantAbsent, true);
  assert.equal(d.detail?.grantRef, undefined);
  // The trusted handle does not depend on the grant: a malformed grant never
  // blocks the scripted human path.
  assert.ok(session.userFlow.discover({}).value.length > 0);
});

test('a grant carrying extra signed fields is denied as malformed', () => {
  // Every signed key outside GRANT_FIELDS is rejected, not ignored: an
  // injected field could otherwise smuggle in a second meaning under one
  // valid signature.
  const g = { ...grantPayload(), sponsor: 'mallory' } as AgentGrant;
  const { w, session } = setup({ grant: g });
  assert.throws(() => session.agent.discover({}), /presenter access denied/);
  assertDenialIsClean(w, 'malformed_grant');
});

test('capabilities separate: explain-only evaluates but cannot select or discover', () => {
  const { session } = setup({ grant: grantPayload({ capabilities: ['explain'] }) });
  const q = session.agent.evaluate(OFFER_A.offerRef);
  assert.equal(q.value.personalCents, 800);
  assert.equal(q.value.othersCents, 500);
  assert.throws(() => session.agent.selectOffer(OFFER_A.offerRef), /presenter access denied/);
  assert.throws(() => session.agent.discover({}), /presenter access denied/);
  // explain is permitted by the grant and refuses on state, not authority.
  assert.throws(() => session.agent.explain(), /no_proposal/);
});

test('capabilities separate: propose-only selects but cannot discover or explain', () => {
  const { w, session } = setup({ grant: grantPayload({ capabilities: ['propose'] }) });
  const sel = session.agent.selectOffer(OFFER_A.offerRef);
  assert.equal(sel.value.proposalVersion, 1);
  assert.throws(() => session.agent.discover({}), /presenter access denied/);
  assert.throws(() => session.agent.explain(), /presenter access denied/);
  assert.throws(() => session.agent.evaluate(OFFER_A.offerRef), /presenter access denied/);
  // The denials did not reprice: still version 1, still unapproved.
  const view = session.userFlow.explain().value;
  assert.equal(view.proposalVersion, 1);
  assert.equal(view.approvals.length, 0);
  assert.equal(w.backend.executionCount(), 0);
});

test('a grant issued for one session cannot be used in another', () => {
  // The session is session-1; the grant — validly signed — names session-2.
  const { session } = setup({ grant: grantPayload({ sessionId: 'session-2' }) });
  assert.throws(() => session.agent.discover({}), /presenter access denied/);
});

test('mutating returned views cannot affect later observations', () => {
  const { session } = setup();
  const d = session.agent.discover({ tags: ['vegetarian'], maxWalkingMinutes: 10 });
  const shown = d.value[0];
  assert.equal(shown.offerRef, OFFER_A.offerRef);
  shown.priceCents = 1;
  shown.merchantId = 'merchant-x';
  shown.tags.push('hacked');
  shown.availability.until = 99_999;

  const q = session.agent.evaluate(OFFER_A.offerRef).value;
  assert.equal(q.totalCents, 1_300);
  assert.equal(q.offer.priceCents, 1_300);
  assert.equal(q.offer.availability.until, OFFER_A.availability.until);

  const sel = session.agent.selectOffer(OFFER_A.offerRef).value;
  sel.payer.totalCents = 1;
  sel.payer.ownCents = 0;
  sel.proposalVersion = 99;
  sel.employeeMaxCents = 999_999;
  sel.approvals.push({
    approvalRef: 'forged',
    payerId: EMPLOYEE,
    proposalVersion: 1,
    expiresAt: 1_000,
    bindsCurrentProposal: true,
    currentlyValid: true,
  });
  sel.offer.priceCents = 5;

  const again = session.agent.explain().value;
  assert.equal(again.payer.totalCents, 1_300);
  assert.equal(again.payer.ownCents, 800);
  assert.equal(again.proposalVersion, 1);
  assert.equal(again.employeeMaxCents, 800);
  assert.equal(again.approvals.length, 0);
  assert.equal(again.offer.priceCents, 1_300);
});

test('mutating construction inputs after the fact has no effect', () => {
  const w = world();
  const catalog = structuredClone(PRESENTER_CATALOG) as CatalogOffer[];
  const signed = signPayload(grantPayload(), w.signers.get(EMPLOYEE)!);
  const session = createPresenterSession({
    sessionId: SESSION_ID,
    purchaseId: PURCHASE_ID,
    agentId: AGENT_ID,
    employeeId: EMPLOYEE,
    employeeMaxCents: 800,
    mandateRef: w.mandate.mandateRef,
    grant: signed,
    catalog,
    coordinator: w.coordinator,
    trace: w.trace,
    keys: w.keys,
    approveOnDevice: (p: Purchase) => approveAs(w, p, EMPLOYEE),
  });
  // Rewrite everything the caller still holds: price, tags, an injected
  // offer, and the grant the session was built with.
  catalog.find((o) => o.offerRef === OFFER_A.offerRef)!.priceCents = 1;
  catalog.find((o) => o.offerRef === OFFER_MEAT.offerRef)!.tags.push('vegetarian');
  catalog.push({
    offerRef: 'offer-injected',
    merchantId: EMPLOYEE,
    title: 'injected',
    tags: ['vegetarian'],
    priceCents: 1,
    availability: { from: 0, until: 9_999 },
    source: 'forged',
    walkingMinutes: 1,
  });
  signed.payload.capabilities = [];
  signed.payload.expiresAt = 0;

  const d = session.agent.discover({ tags: ['vegetarian'], maxWalkingMinutes: 10 });
  assert.deepEqual(
    d.value.map((o) => o.offerRef),
    [OFFER_A.offerRef, OFFER_C.offerRef, OFFER_B.offerRef],
  );
  assert.equal(session.agent.evaluate(OFFER_A.offerRef).value.totalCents, 1_300);
  assert.throws(() => session.agent.evaluate('offer-injected'), /unknown_offer/);
  // The session kept its own copy of the grant: capabilities still hold.
  const sel = session.agent.selectOffer(OFFER_A.offerRef).value;
  assert.equal(sel.payer.totalCents, 1_300);
});

test('discovery filters tags and distance, orders by price then reference, and stamps source and time', () => {
  const { session } = setup();
  const d = session.agent.discover({ tags: ['vegetarian'], maxWalkingMinutes: 10 });
  // Meat decoy fails the tag filter; the far decoy fails the distance filter
  // although it is cheaper than A. Among the survivors, C ties A on price and
  // loses only on reference order.
  assert.deepEqual(
    d.value.map((o) => o.offerRef),
    [OFFER_A.offerRef, OFFER_C.offerRef, OFFER_B.offerRef],
  );
  for (const o of d.value) {
    assert.equal(o.retrievedAt, 10);
    assert.equal(typeof o.source, 'string');
    assert.ok(o.tags.includes('vegetarian'));
    assert.ok(o.walkingMinutes <= 10);
  }
  // Unfiltered discovery lists every live offer, cheapest first.
  const all = session.agent.discover({});
  assert.deepEqual(
    all.value.map((o) => o.offerRef),
    [OFFER_MEAT.offerRef, OFFER_FAR.offerRef, OFFER_A.offerRef, OFFER_C.offerRef, OFFER_B.offerRef],
  );
  assert.equal(all.value[0].source, OFFER_MEAT.source);
});

test('validity is inclusive at the endpoint; after it the offer is undiscoverable and unselectable', () => {
  const { w, session } = setup();
  advance(w, OFFER_A.availability.until); // t=60: still live
  assert.ok(session.agent.discover({}).value.some((o) => o.offerRef === OFFER_A.offerRef));
  assert.ok(!session.agent.evaluate(OFFER_A.offerRef).value.reasons.includes('offer_expired'));

  advance(w, OFFER_A.availability.until + 1); // t=61: expired
  assert.ok(!session.agent.discover({}).value.some((o) => o.offerRef === OFFER_A.offerRef));
  const q = session.agent.evaluate(OFFER_A.offerRef).value;
  assert.ok(q.reasons.includes('offer_expired'));
  assert.throws(() => session.agent.selectOffer(OFFER_A.offerRef), /offer_expired/);
  // No purchase was created by the refused selection.
  assert.throws(() => session.userFlow.explain(), /no_proposal/);
});

test('an offer whose window has not opened yet is refused precisely, never reported expired', () => {
  // The world clock starts at t=10; this offer goes live at t=20.
  const future: CatalogOffer = { ...OFFER_C, offerRef: 'offer-future', availability: { from: 20, until: 600 } };
  const { w, session } = setup({ catalog: [...PRESENTER_CATALOG, future] });
  // Discovery shows only live offers; evaluate still prices it but cannot
  // call it expired — the view itself carries the not-yet-open window.
  assert.ok(!session.agent.discover({}).value.some((o) => o.offerRef === future.offerRef));
  const q = session.agent.evaluate(future.offerRef).value;
  assert.equal(q.offer.availability.from, 20);
  assert.equal(q.offer.retrievedAt, 10);
  assert.ok(!q.reasons.includes('offer_expired'));
  // Selection refuses with the precise label, audited like a denial.
  assert.throws(() => session.agent.selectOffer(future.offerRef), /^Error: offer_not_yet_available$/);
  const r = w.trace.events.filter((e) => e.event === 'presenter_refused').at(-1)!;
  assert.equal(r.origin, 'LOCAL');
  assert.equal(r.detail?.op, 'select');
  assert.equal(r.detail?.reason, 'offer_not_yet_available');
  assert.equal(r.detail?.channel, 'agent');
  assert.equal(r.detail?.sessionId, SESSION_ID);
  // No purchase was created by the refused selection.
  assert.throws(() => session.userFlow.explain(), /no_proposal/);
  // Once the window opens, the same reference selects normally.
  advance(w, 20);
  const sel = session.agent.selectOffer(future.offerRef).value;
  assert.equal(sel.offerRef, future.offerRef);
});

test('inputs cannot override amount, instruction, identity or time', () => {
  const { session } = setup();
  assert.throws(
    () => session.agent.discover({ tags: ['vegetarian'], employeeMaxCents: 99_999 } as never),
    /unsupported preference field/,
  );
  assert.throws(() => session.agent.discover({ now: 0 } as never), /unsupported preference field/);
  assert.throws(() => session.agent.discover({ maxWalkingMinutes: -1 }), /non-negative/);
  assert.throws(() => session.agent.discover({ tags: 'vegetarian' } as never), /non-empty strings/);
  assert.throws(() => session.agent.evaluate({ offerRef: OFFER_A.offerRef, totalCents: 1 } as never), /non-empty string/);
  assert.throws(() => session.agent.selectOffer('not-an-offer'), /unknown_offer/);

  // The fixed instruction stands: B's EUR 9 personal share stays over the
  // EUR 8 limit no matter what the caller passes.
  const q = session.agent.evaluate(OFFER_B.offerRef).value;
  assert.equal(q.totalCents, 1_400);
  assert.equal(q.personalCents, 900);
  assert.equal(q.othersCents, 500);
  assert.equal(q.withinInstruction, false);
  assert.ok(q.reasons.includes('personal_limit_exceeded'));
});

test('the catalog price maps into authoritative proposal amounts, and reselection revalidates', () => {
  const { session } = setup();
  const sel = session.agent.selectOffer(OFFER_A.offerRef).value;
  assert.equal(sel.payer.totalCents, 1_300);
  assert.equal(sel.payer.ownCents, 800);
  assert.equal(sel.payer.othersCents, 500);
  assert.equal(sel.proposalVersion, 1);
  assert.equal(sel.proposalExpiresAt, OFFER_A.availability.until);
  // The authoritative check is the retained proposal, not the view: the
  // trusted snapshot shows the shares the offer's price produced.
  const snap = session.userFlow.snapshot();
  assert.equal(shareCents(snap.proposal, 'employee'), 800);
  assert.equal(shareCents(snap.proposal, 'employer'), 500);
  assert.equal(snap.proposal.expiresAt, OFFER_A.availability.until);

  // B at EUR 14 stays in draft: EUR 9 exceeds the instruction.
  const b = session.agent.selectOffer(OFFER_B.offerRef).value;
  assert.equal(b.proposalVersion, 2);
  assert.equal(b.payer.ownCents, 900);
  assert.equal(b.payer.state, 'draft');
  assert.ok(b.reasons.includes('personal_limit_exceeded'));

  // C brings it back inside the instruction on a fresh version.
  const c = session.agent.selectOffer(OFFER_C.offerRef).value;
  assert.equal(c.proposalVersion, 3);
  assert.equal(c.payer.ownCents, 800);
  assert.equal(c.payer.state, 'awaiting_approvals');
});

test('session events carry ids, action, observation time and, for agents, the grant', () => {
  const { w, session } = setup();
  const ev = session.agent.discover({ tags: ['vegetarian'] });
  const e = w.trace.events.at(-1)!;
  assert.equal(e.origin, 'LOCAL');
  assert.equal(e.actor, 'presenter');
  assert.equal(e.event, 'presenter_discover');
  assert.equal(e.detail?.sessionId, SESSION_ID);
  assert.equal(e.detail?.purchaseId, PURCHASE_ID);
  assert.equal(e.detail?.observedAt, 10);
  assert.equal(e.detail?.channel, 'agent');
  assert.equal(e.detail?.onBehalfOf, AGENT_ID);
  assert.equal(e.detail?.grantRef, 'grant-1');
  assert.equal(typeof e.detail?.actionId, 'string');
  assert.deepEqual(ev.eventSeqs, [e.seq]);

  // A selection's evidence links the coordinator's proposal event too.
  const sel = session.agent.selectOffer(OFFER_A.offerRef);
  const seqs = sel.eventSeqs;
  const events = seqs.map((s) => w.trace.events[s - 1]);
  assert.ok(events.some((x) => x.actor === 'coordinator' && x.event === 'proposal'));
  assert.equal(events.at(-1)?.event, 'presenter_select');
  assert.equal(events.at(-1)?.detail?.proposalVersion, 1);

  // Trusted operations carry the same fields minus the agent identity.
  const t = session.userFlow.explain();
  const te = w.trace.events.at(-1)!;
  assert.equal(te.detail?.channel, 'user');
  assert.equal(te.detail?.onBehalfOf, undefined);
  assert.equal(te.detail?.grantRef, undefined);
  assert.ok(t.eventSeqs.includes(te.seq));
});

test('explain before any selection refuses with no_proposal', () => {
  const { w, session } = setup();
  assert.throws(() => session.agent.explain(), /no_proposal/);
  assert.throws(() => session.userFlow.explain(), /no_proposal/);
  assert.throws(() => session.userFlow.snapshot(), /no_proposal/);
  // Refusals are audited like denials: session fields, the op and the
  // internal reason — the operation itself is never logged as a success.
  const refusals = w.trace.events.filter((e) => e.event === 'presenter_refused');
  assert.equal(refusals.length, 3);
  assert.deepEqual(
    refusals.map((e) => [e.detail?.channel, e.detail?.op, e.detail?.reason]),
    [
      ['agent', 'explain', 'no_proposal'],
      ['user', 'explain', 'no_proposal'],
      ['user', 'snapshot', 'no_proposal'],
    ],
  );
  for (const e of refusals) {
    assert.equal(e.origin, 'LOCAL');
    assert.equal(e.detail?.sessionId, SESSION_ID);
    assert.equal(e.detail?.purchaseId, PURCHASE_ID);
    assert.equal(e.detail?.observedAt, 10);
    assert.equal(typeof e.detail?.actionId, 'string');
  }
  assert.ok(
    !w.trace.events.some((e) => e.event === 'presenter_explain' || e.event === 'presenter_snapshot'),
    'a refused operation logs no success event',
  );
});

test('while a submission is in flight, every other operation is refused and audited', async () => {
  const { w, session } = setup();
  session.userFlow.selectOffer(OFFER_A.offerRef);
  session.userFlow.approve(1);
  // A scheduling-only adapter over the real coordinator.submit: the gate
  // decides when the call runs; the real mock backend still decides the
  // outcome, so the asserted settlement below is the mock's own.
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  const realSubmit = w.coordinator.submit.bind(w.coordinator);
  w.coordinator.submit = (p, mode) => gate.then(() => realSubmit(p, mode));

  // submit() acquires the in-flight guard synchronously, before its first
  // await: every call made before release() still sees it held.
  const submitted = session.userFlow.submit(1);
  const syncOps: [channel: 'agent' | 'user', op: string, fn: () => unknown][] = [
    ['user', 'discover', () => session.userFlow.discover({})],
    ['user', 'evaluate', () => session.userFlow.evaluate(OFFER_C.offerRef)],
    ['user', 'select', () => session.userFlow.selectOffer(OFFER_C.offerRef)],
    ['user', 'explain', () => session.userFlow.explain()],
    ['user', 'approve', () => session.userFlow.approve(1)],
    ['user', 'snapshot', () => session.userFlow.snapshot()],
    ['agent', 'discover', () => session.agent.discover({})],
    ['agent', 'evaluate', () => session.agent.evaluate(OFFER_C.offerRef)],
    ['agent', 'select', () => session.agent.selectOffer(OFFER_C.offerRef)],
    ['agent', 'explain', () => session.agent.explain()],
  ];
  for (const [, op, fn] of syncOps) {
    assert.throws(fn, /^Error: operation_in_progress$/, `${op} during flight`);
  }
  // The async operations refuse identically; their rejection is still a
  // audited presenter_refused event, appended during the call.
  await assert.rejects(() => session.userFlow.submit(1), /^Error: operation_in_progress$/);
  await assert.rejects(() => session.userFlow.reconcile(), /^Error: operation_in_progress$/);

  const refusals = w.trace.events.filter(
    (e) => e.event === 'presenter_refused' && e.detail?.reason === 'operation_in_progress',
  );
  assert.equal(refusals.length, syncOps.length + 2);
  assert.deepEqual(
    refusals.map((e) => [e.detail?.channel, e.detail?.op]),
    [
      ...syncOps.map(([channel, op]) => [channel, op]),
      ['user', 'submit'],
      ['user', 'reconcile'],
    ],
  );
  // The held operation prevented any concurrent change: still v1, still the
  // one recorded approval, nothing executed twice.
  assert.equal(w.backend.executionCount(), 0);

  release();
  const ev = await submitted;
  assert.equal(ev.value.payer.state, 'completed');
  assert.equal(w.backend.executionCount(), 2);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_200);
  // The guard was released in finally: the session is operable again.
  assert.equal(session.userFlow.explain().value.proposalVersion, 1);
});

test('agent operations produce no approvals, execution attempts or debits', () => {
  // The device callback is the only bridge to approval; count its invocations.
  // Authority is judged by observable device/backend effects — coordinator
  // actor labels are not a caller-identity oracle.
  let deviceCalls = 0;
  const { w, session } = setup({
    onDevice: (dw, p) => {
      deviceCalls++;
      approveAs(dw, p, EMPLOYEE);
    },
  });
  session.agent.discover({ tags: ['vegetarian'] });
  session.agent.evaluate(OFFER_A.offerRef);
  const sel = session.agent.selectOffer(OFFER_A.offerRef).value;
  session.agent.explain();
  // Proposing is the agent's one delegated effect: a purchase exists. But no
  // approval was recorded, nothing reached the backend and no money moved.
  assert.equal(sel.proposalVersion, 1);
  assert.ok(w.trace.events.some((e) => e.actor === 'coordinator' && e.event === 'proposal'));
  assert.equal(deviceCalls, 0, 'the device was never asked to sign');
  assert.equal(w.backend.executionCount(), 0);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 100_000);
  assert.ok(
    !w.trace.events.some(
      (e) => e.event === 'approval_recorded' || e.event === 'submit' || e.event === 'benefit_reserved',
    ),
    'no approval, submission or benefit reservation was attempted',
  );
  const snap = session.userFlow.snapshot();
  assert.equal(snap.state, 'awaiting_approvals');
  assert.equal(snap.approvals.length, 0);
  assert.equal(snap.legs.length, 0);
  // The delivered handle structurally lacks every execution surface.
  for (const m of ['approve', 'submit', 'reconcile', 'snapshot', 'resubmit', 'recover', 'refund', 'reviseInstruction']) {
    assert.equal((session.agent as unknown as Record<string, unknown>)[m], undefined, m);
  }
});

test('mutated projections and snapshots cannot alter the approved and executed terms', async () => {
  const { w, session } = setup();
  const sel = session.userFlow.selectOffer(OFFER_A.offerRef).value;
  // Rewrite every field of the returned view: version, instruction, price,
  // the payer projection, expiry, and a forged recorded approval.
  sel.proposalVersion = 99;
  sel.employeeMaxCents = 999_999;
  sel.offer.priceCents = 1;
  sel.offer.availability.until = 99_999;
  sel.payer.totalCents = 1;
  sel.payer.ownCents = 0;
  sel.approvals.push({
    approvalRef: 'forged',
    payerId: EMPLOYEE,
    proposalVersion: 1,
    expiresAt: 99_999,
    bindsCurrentProposal: true,
    currentlyValid: true,
  });
  // The detached snapshot detaches too: state, terms, shares, instruction and
  // approvals on the copy reach nothing the session retains.
  const snap = session.userFlow.snapshot();
  snap.state = 'ready';
  snap.proposal.version = 99;
  snap.proposal.totalCents = 1;
  snap.proposal.shares.find((s) => s.role === 'employee')!.amountCents = 0;
  snap.benefit!.employeeMaxCents = 999_999;
  snap.approvals.push({
    payload: {
      approvalRef: 'forged',
      purchaseId: PURCHASE_ID,
      payerId: EMPLOYEE,
      proposalVersion: 1,
      merchantId: MERCHANT_A,
      totalCents: 1,
      amountCents: 0,
      feeCents: 0,
      expiresAt: 99_999,
    },
    keyId: 'forged-key',
    signature: 'forged',
  });

  // Approval binds the retained v1 terms — the mutations bought nothing.
  const ap = session.userFlow.approve(1).value;
  assert.equal(ap.proposalVersion, 1);
  assert.equal(ap.payer.ownCents, 800);
  assert.equal(ap.approvals.length, 1);
  assert.equal(ap.approvals[0].approvalRef, `appr-${PURCHASE_ID}-v1-${EMPLOYEE}`);
  const done = await session.userFlow.submit(1);
  assert.equal(done.value.payer.state, 'completed');
  assert.equal(done.value.payer.ownCents, 800);
  // The debits are the retained amounts, not the forged ones.
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_200);
  assert.equal(w.backend.account(MERCHANT_A).linkedBankCents, 1_300);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 99_500);
  const after = session.userFlow.snapshot();
  assert.equal(after.proposal.version, 1);
  assert.equal(shareCents(after.proposal, 'employee'), 800);
  assert.equal(after.benefit!.employeeMaxCents, 800);
});

test('an approved offer that expires can be neither re-approved nor submitted', async () => {
  const { w, session } = setup();
  session.userFlow.selectOffer(OFFER_A.offerRef); // v1; offer and proposal expire at t=60
  const ap = session.userFlow.approve(1).value;
  assert.equal(ap.approvals.length, 1);
  assert.equal(ap.approvals[0].expiresAt, OFFER_A.availability.until);
  assert.equal(ap.approvals[0].currentlyValid, true);

  advance(w, OFFER_A.availability.until + 1); // t=61: window and expiry passed
  assert.throws(() => session.userFlow.approve(1), /^Error: offer_expired$/);
  await assert.rejects(session.userFlow.submit(1), /^Error: offer_expired$/);
  // Refused before the coordinator was touched: no submission, no execution,
  // no money moved.
  assert.equal(w.backend.executionCount(), 0);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.ok(!w.trace.events.some((e) => e.event === 'submit' || e.event === 'benefit_reserved'));
  const refusals = w.trace.events.filter((e) => e.event === 'presenter_refused');
  assert.deepEqual(
    refusals.map((e) => [e.detail?.op, e.detail?.reason, e.detail?.proposalVersion]),
    [
      ['approve', 'offer_expired', 1],
      ['submit', 'offer_expired', 1],
    ],
  );
  // Recorded approval stays honestly visible: bound to v1, now expired. Clock
  // expiry alone did not mutate the coordinator's ready state.
  const v = session.userFlow.explain().value;
  assert.equal(v.payer.state, 'ready');
  assert.equal(v.approvals.length, 1);
  assert.equal(v.approvals[0].proposalVersion, 1);
  assert.equal(v.approvals[0].bindsCurrentProposal, true);
  assert.equal(v.approvals[0].currentlyValid, false);
  assert.ok(v.reasons.includes('offer_expired'));
  assert.ok(v.reasons.includes('approval_expired'));
});

test('a replaced offer invalidates the recorded approval; renewed approval on the new version completes', async () => {
  const { w, session } = setup();
  session.userFlow.selectOffer(OFFER_A.offerRef);
  session.userFlow.approve(1);

  advance(w, OFFER_A.availability.until + 1); // A expired; the script moves on.
  const b = session.userFlow.selectOffer(OFFER_B.offerRef).value;
  assert.equal(b.proposalVersion, 2);
  assert.equal(b.offerRef, OFFER_B.offerRef);
  // changeOffer invalidated the v1 approval: nothing binds version 2 yet.
  assert.equal(b.approvals.length, 0);
  assert.ok(w.trace.events.some((e) => e.event === 'approval_invalidated'));

  // The previous version can neither approve nor submit — refused before the
  // device callback or the coordinator is invoked.
  assert.throws(() => session.userFlow.approve(1), /^Error: stale_proposal$/);
  await assert.rejects(session.userFlow.submit(1), /^Error: stale_proposal$/);
  assert.equal(w.backend.executionCount(), 0);

  // B's EUR 9 personal share exceeds the fixed EUR 8 instruction: draft, and
  // the coordinator rejects approval of a draft on the retained state.
  assert.equal(b.payer.state, 'draft');
  assert.throws(() => session.userFlow.approve(2), /does not match/);
  assert.equal(session.userFlow.explain().value.approvals.length, 0);

  // Renewed selection C at EUR 13 prices inside the instruction on v3;
  // approving and submitting that version completes the purchase.
  const c = session.userFlow.selectOffer(OFFER_C.offerRef).value;
  assert.equal(c.proposalVersion, 3);
  assert.equal(c.payer.state, 'awaiting_approvals');
  session.userFlow.approve(3);
  const done = await session.userFlow.submit(3);
  assert.equal(done.value.payer.state, 'completed');
  assert.equal(done.value.payer.ownCents, 800);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_200);
  assert.equal(w.backend.account(MERCHANT_C).linkedBankCents, 1_300);
});

test('a same-price offer change still bumps the version and voids the approval', async () => {
  const { w, session } = setup();
  session.userFlow.selectOffer(OFFER_A.offerRef); // EUR 13, v1
  session.userFlow.approve(1);
  // C is also EUR 13 but a different offer: the terms changed even though the
  // price did not, so the version must move and the v1 approval must lapse.
  const c = session.userFlow.selectOffer(OFFER_C.offerRef).value;
  assert.equal(c.proposalVersion, 2);
  assert.equal(c.payer.totalCents, 1_300);
  assert.equal(c.offerRef, OFFER_C.offerRef);
  assert.equal(c.approvals.length, 0);
  assert.throws(() => session.userFlow.approve(1), /^Error: stale_proposal$/);
  await assert.rejects(session.userFlow.submit(1), /^Error: stale_proposal$/);
  assert.equal(w.backend.executionCount(), 0);
});

test('offer B stays outside the fixed EUR 8 instruction: no override and no approvable proposal', async () => {
  const { w, session } = setup();
  // Evaluation reports the breach through the safe reason allowlist.
  const q = session.agent.evaluate(OFFER_B.offerRef).value;
  assert.equal(q.totalCents, 1_400);
  assert.equal(q.personalCents, 900);
  assert.equal(q.withinInstruction, false);
  assert.ok(q.reasons.includes('personal_limit_exceeded'));
  // Selection produces a draft: EUR 9 personal exceeds the fixed EUR 8. The
  // view restates the unchanged instruction rather than the caller's wish.
  const b = session.agent.selectOffer(OFFER_B.offerRef).value;
  assert.equal(b.payer.state, 'draft');
  assert.equal(b.employeeMaxCents, 800);
  assert.equal(b.payer.ownCents, 900);
  assert.ok(b.reasons.includes('personal_limit_exceeded'));
  // The device cannot approve a draft: the coordinator rejects the signature
  // on the retained state, so nothing is recorded.
  assert.throws(() => session.userFlow.approve(b.proposalVersion), /does not match/);
  assert.equal(session.userFlow.explain().value.approvals.length, 0);
  // And with no complete approval set, submission cannot execute.
  await assert.rejects(session.userFlow.submit(b.proposalVersion), /cannot submit/);
  assert.equal(w.backend.executionCount(), 0);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
});

test('a fully employer-funded offer still needs the employee approval before submission', async () => {
  // A EUR 4 offer is covered entirely by the EUR 5 mandate cap: the employee
  // share is zero, but the zero-personal-share approval requirement stands.
  const cheap: CatalogOffer = { ...OFFER_A, offerRef: 'offer-cheap', priceCents: 400 };
  const { w, session } = setup({ catalog: [...PRESENTER_CATALOG, cheap] });
  const sel = session.userFlow.selectOffer(cheap.offerRef).value;
  assert.equal(sel.payer.ownCents, 0);
  assert.equal(sel.payer.othersCents, 400);
  assert.equal(sel.payer.state, 'awaiting_approvals');
  // Nothing to pay is not the same as nothing to approve.
  await assert.rejects(session.userFlow.submit(1), /cannot submit/);
  assert.equal(w.backend.executionCount(), 0);
  session.userFlow.approve(1);
  const done = await session.userFlow.submit(1);
  assert.equal(done.value.payer.state, 'completed');
  const snap = session.userFlow.snapshot();
  // Only the employer leg exists and ran: EUR 4, one execution, no debit of
  // the employee at all.
  assert.deepEqual(
    snap.legs.map((l) => [l.leg, l.amountCents]),
    [['employer', 400]],
  );
  assert.equal(w.backend.executionCount(), 1);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  assert.equal(w.backend.account(EMPLOYER).linkedBankCents, 99_600);
});

test('employer authority lost after approval fails submission without raising the employee share', async () => {
  const { w, session } = setup();
  session.userFlow.selectOffer(OFFER_A.offerRef);
  session.userFlow.approve(1);
  // The employer revokes the mandate between approval and initiation.
  updateMandate(w, { revoked: true });
  const res = await session.userFlow.submit(1);
  const v = res.value;
  // The coordinator rechecked at initiation and stopped: nothing committed,
  // and the gap never moved onto the employee.
  assert.equal(v.payer.state, 'failed');
  assert.ok(v.reasons.includes('benefit_unavailable'));
  assert.equal(w.backend.executionCount(), 0);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 2_000);
  const snap = session.userFlow.snapshot();
  assert.equal(shareCents(snap.proposal, 'employee'), 800);
  assert.equal(shareCents(snap.proposal, 'employer'), 500);
  // The recorded approval still names the approved terms...
  assert.equal(v.approvals.length, 1);
  assert.equal(v.approvals[0].proposalVersion, 1);
  assert.equal(v.approvals[0].bindsCurrentProposal, true);
  // ...while a fresh evaluation honestly reports no benefit — a quote for a
  // new purchase, never a rewrite of the approved EUR 8.
  const q = session.agent.evaluate(OFFER_A.offerRef).value;
  assert.equal(q.othersCents, 0);
  assert.equal(q.personalCents, 1_300);
  assert.equal(session.userFlow.explain().value.payer.ownCents, 800);
});

test('a lost response stays pending through explanation until reconciliation observes the outcome', async () => {
  const { w, session } = setup();
  // The employer leg's response is lost; its deferred outcome settles later.
  w.backend.faults.set(EMPLOYER, 'timeout_then_settle');
  session.userFlow.selectOffer(OFFER_A.offerRef);
  session.userFlow.approve(1);
  const sub = await session.userFlow.submit(1);
  // A timeout is not failure: pending, with both legs 'unknown'.
  assert.equal(sub.value.payer.state, 'pending');
  const pendingSnap = session.userFlow.snapshot();
  assert.ok(pendingSnap.legs.every((l) => l.status === 'unknown'));
  // One execution per leg, keyed stably by purchase, version and role.
  const keys = pendingSnap.legs.map((l) => l.idempotencyKey);
  assert.deepEqual(keys, [`${PURCHASE_ID}:v1:employee`, `${PURCHASE_ID}:v1:employer`]);
  assert.equal(w.backend.executionCount(), 2);

  // A counting spy on the backend status path: from here until reconcile,
  // nothing may poll status.
  let statusCalls = 0;
  const realStatus = w.backend.status.bind(w.backend);
  w.backend.status = (ref: string) => {
    statusCalls++;
    return realStatus(ref);
  };

  // Explanation is a projection of retained state: it makes no status query
  // and issues no retry — the legs stay 'unknown' and nothing resolves.
  const ex = session.agent.explain().value;
  assert.equal(ex.payer.state, 'pending');
  assert.equal(ex.payer.ownLegs[0]?.status, 'unknown');
  assert.ok(!w.trace.events.some((e) => e.event === 'status_resolved'));
  assert.ok(!w.trace.events.some((e) => e.event === 'resubmit_same_keys'));
  assert.ok(session.userFlow.snapshot().legs.every((l) => l.status === 'unknown'));
  assert.equal(statusCalls, 0, 'explain and snapshot made no backend status call');
  assert.equal(w.backend.executionCount(), 2);

  // Trusted reconciliation asks the backend and observes the settled group.
  const rec = await session.userFlow.reconcile();
  assert.equal(rec.value.payer.state, 'completed');
  assert.equal(statusCalls, 2, 'reconcile polled status once per unresolved leg');
  const done = session.userFlow.snapshot();
  assert.ok(done.legs.every((l) => l.status === 'settled'));
  // Same idempotency keys throughout: resolution never minted new keys, and
  // still exactly one execution per leg.
  assert.deepEqual(
    done.legs.map((l) => l.idempotencyKey),
    keys,
  );
  assert.equal(w.backend.executionCount(), 2);
  assert.equal(w.backend.account(EMPLOYEE).deCents, 1_200);
  // The evidence chains to the actual events: the coordinator's submission
  // and pending transition, then the reconciliation that observed the result.
  const subEvents = sub.eventSeqs.map((s) => w.trace.events[s - 1]);
  assert.ok(subEvents.some((e) => e.actor === 'coordinator' && e.event === 'submit'));
  assert.ok(subEvents.some((e) => e.event === 'state' && e.detail?.to === 'pending'));
  const recEvents = rec.eventSeqs.map((s) => w.trace.events[s - 1]);
  assert.ok(recEvents.some((e) => e.actor === 'coordinator' && e.event === 'reconciled'));
  assert.ok(recEvents.some((e) => e.event === 'state' && e.detail?.to === 'completed'));
});

test('submission locks the terms; reconcile without submitted legs refuses', async () => {
  const { session } = setup();
  session.userFlow.selectOffer(OFFER_C.offerRef);
  // Nothing submitted, nothing to query.
  await assert.rejects(session.userFlow.reconcile(), /nothing to reconcile/);
  session.userFlow.approve(1);
  await session.userFlow.submit(1);
  // Once money has moved, the offer cannot change, be re-approved or resubmitted.
  assert.throws(() => session.userFlow.selectOffer(OFFER_A.offerRef), /not_selectable:completed/);
  assert.throws(() => session.userFlow.approve(1), /does not match/);
  await assert.rejects(session.userFlow.submit(1), /cannot submit/);
});

test('projections and audit details stay within the safe field allowlists', async () => {
  const { w, session } = setup();
  const SAFE_REASONS = new Set([
    'benefit_unavailable',
    'merchant_ineligible',
    'personal_limit_exceeded',
    'offer_expired',
    'approval_expired',
  ]);
  // Offer and quote views expose exactly the sourced/safe fields.
  const offer = session.agent.discover({}).value[0];
  assert.deepEqual(
    Object.keys(offer).sort(),
    ['availability', 'merchantId', 'offerRef', 'priceCents', 'retrievedAt', 'source', 'tags', 'title', 'walkingMinutes'],
  );
  const q = session.agent.evaluate(OFFER_A.offerRef).value;
  assert.deepEqual(
    Object.keys(q).sort(),
    ['employeeFeeCents', 'offer', 'othersCents', 'personalCents', 'reasons', 'totalCents', 'withinInstruction'],
  );
  assert.ok(q.reasons.every((r) => SAFE_REASONS.has(r)));
  // OFFER_A yields no reasons at t=10, so the check above is vacuous alone.
  // OFFER_B breaches the fixed EUR 8 instruction: a non-empty reason list is
  // what actually exercises the allowlist.
  const qb = session.agent.evaluate(OFFER_B.offerRef).value;
  assert.ok(qb.reasons.length > 0);
  assert.ok(qb.reasons.includes('personal_limit_exceeded'));
  assert.ok(qb.reasons.every((r) => SAFE_REASONS.has(r)));

  session.agent.selectOffer(OFFER_A.offerRef);
  const apEvidence = session.userFlow.approve(1);
  const ap = apEvidence.value;
  await session.userFlow.submit(1);
  const v = session.agent.explain().value;
  assert.deepEqual(
    Object.keys(v).sort(),
    ['approvals', 'employeeMaxCents', 'offer', 'offerRef', 'payer', 'proposalExpiresAt', 'proposalVersion', 'reasons'],
  );
  // The recorded approval names its reference, payer, version and expiry —
  // the binding evidence — and no signature or key material.
  assert.deepEqual(
    Object.keys(v.approvals[0]).sort(),
    ['approvalRef', 'bindsCurrentProposal', 'currentlyValid', 'expiresAt', 'payerId', 'proposalVersion'],
  );
  assert.equal(v.approvals[0].payerId, EMPLOYEE);
  assert.equal(ap.approvals[0].proposalVersion, 1);
  assert.ok(v.reasons.every((r) => SAFE_REASONS.has(r)));
  // Nothing below the allowlist leaks into the serialized view: no mandate
  // references, no other payer ids, no signatures, keys, idempotency keys or
  // ledger/balance internals.
  const serialized = JSON.stringify(v);
  for (const leak of ['mandate', 'signature', 'keyId', 'idempotency', EMPLOYER, 'ledger', 'linkedBank', 'deCents']) {
    assert.ok(!serialized.includes(leak), `presenter view leaks ${leak}`);
  }

  // Approval evidence links the coordinator's record for this version.
  const approveEvents = apEvidence.eventSeqs.map((s) => w.trace.events[s - 1]);
  assert.ok(
    approveEvents.some(
      (e) => e.event === 'approval_recorded' && e.detail?.version === 1 && e.detail?.payerId === EMPLOYEE,
    ),
  );

  // A denied operation is audited inside the same schema: generic text to the
  // caller, the specific safe reason in the event, agent attribution retained.
  advance(w, 1_001); // past the grant expiry
  assert.throws(() => session.agent.explain(), /^Error: presenter access denied$/);
  const denial = w.trace.events.at(-1)!;
  assert.equal(denial.event, 'presenter_denied');
  assert.equal(denial.detail?.reason, 'grant_expired');
  assert.equal(denial.detail?.op, 'explain');
  assert.equal(denial.detail?.channel, 'agent');
  assert.equal(denial.detail?.onBehalfOf, AGENT_ID);
  assert.equal(denial.detail?.grantRef, 'grant-1');
  assert.equal(denial.detail?.proposalVersion, 1);

  // Every presenter event is LOCAL, carries the session and purchase, and
  // stays within the audit field schema; the agent channel is the only one
  // that may carry an onBehalfOf.
  const AUDIT_FIELDS = new Set([
    'actionId',
    'channel',
    'sessionId',
    'purchaseId',
    'proposalVersion',
    'observedAt',
    'onBehalfOf',
    'grantRef',
    'grantAbsent',
    'op',
    'reason',
    'offers',
    'offerRef',
  ]);
  for (const e of w.trace.events.filter((x) => x.actor === 'presenter')) {
    assert.equal(e.origin, 'LOCAL');
    assert.equal(e.detail?.sessionId, SESSION_ID);
    assert.equal(e.detail?.purchaseId, PURCHASE_ID);
    for (const k of Object.keys(e.detail ?? {})) {
      assert.ok(AUDIT_FIELDS.has(k), `unexpected audit field ${k} on ${e.event}`);
    }
    if (e.detail?.channel === 'agent') assert.equal(e.detail?.onBehalfOf, AGENT_ID);
    else assert.equal(e.detail?.onBehalfOf, undefined);
  }
});

test('invalid catalogs are refused at construction', () => {
  const bad: [string, CatalogOffer[]][] = [
    ['duplicate refs', [OFFER_A, { ...OFFER_A, merchantId: OFFER_B.merchantId }]],
    ['empty ref', [{ ...OFFER_A, offerRef: '' }]],
    ['non-positive price', [{ ...OFFER_A, priceCents: 0 }]],
    ['fractional price', [{ ...OFFER_A, priceCents: 1.5 }]],
    ['inverted window', [{ ...OFFER_A, availability: { from: 10, until: 5 } }]],
    ['non-finite window', [{ ...OFFER_A, availability: { from: 0, until: Number.NaN } }]],
    ['negative walking time', [{ ...OFFER_A, walkingMinutes: -1 }]],
    ['non-finite walking time', [{ ...OFFER_A, walkingMinutes: Number.POSITIVE_INFINITY }]],
  ];
  for (const [name, catalog] of bad) {
    assert.throws(() => setup({ catalog }), /catalog|offer/i, name);
  }
});
