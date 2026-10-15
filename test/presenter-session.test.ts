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
  EMPLOYEE,
  EMPLOYER,
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
  // submit() holds the in-flight guard from before its first await until
  // finally: a call made before awaiting still sees it held.
  const submitted = session.userFlow.submit(1);
  assert.throws(() => session.userFlow.discover({}), /operation_in_progress/);
  assert.throws(() => session.userFlow.snapshot(), /operation_in_progress/);
  assert.throws(() => session.agent.discover({}), /operation_in_progress/);
  const refusals = w.trace.events.filter(
    (e) => e.event === 'presenter_refused' && e.detail?.reason === 'operation_in_progress',
  );
  assert.equal(refusals.length, 3);
  assert.deepEqual(
    refusals.map((e) => [e.detail?.channel, e.detail?.op]),
    [
      ['user', 'discover'],
      ['user', 'snapshot'],
      ['agent', 'discover'],
    ],
  );
  await submitted;
  // The guard is released in finally: the session is operable again.
  assert.equal(session.userFlow.explain().value.proposalVersion, 1);
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
