// Pure funding decisions (spec §2): decideFunding is the owner of pledge
// acceptance and replay ordering, expiry lapse, condition truth, progress,
// irreversible roster closure and admission eligibility. These tests drive
// the decision interface directly with synthetic signed payloads and
// injected signature verdicts — the module itself never verifies crypto.
// Expected states, totals, phases and version deltas are written out
// explicitly, never recomputed through the decision under test. Inputs are
// deep-frozen so any mutation of a snapshot fails loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFunding } from '../src/core/funding.ts';
import type { FundingCommand, FundingDecision, FundingSnapshot, FundingVerification } from '../src/core/funding.ts';
import { campaignDigestOf, canonicalJson, keyPairFromSeed, signPayload } from '../src/core/signing.ts';
import type { Signed } from '../src/core/signing.ts';
import type {
  Authorization,
  CampaignTerms,
  DeepReadonly,
  FundingState,
  OpenFundRequest,
  PledgeAcceptance,
  PledgeRequest,
  PurchaseState,
  Share,
} from '../src/core/types.ts';

const signer = (id: string) => keyPairFromSeed(`key-${id}`, `synthetic-seed-${id}`);

// The terms a payee's open_fund request commits; every table field explicit.
function fundTerms(over: Partial<CampaignTerms> = {}): CampaignTerms {
  return {
    purchaseId: 'fund-1',
    payeeId: 'project-1',
    condition: { minPayers: 2 },
    fundingEndsAt: 20,
    settleBy: 30,
    acceptPledgesUntil: 'condition_met',
    submitPolicy: 'on_request',
    settlementMode: 'atomic',
    privacyProfile: 'public_good_pledge_v1',
    ...over,
  };
}

// The funding state an accepted open_fund commits: verified campaign,
// empty history, collecting phase, zeroed progress.
function openFundState(terms: CampaignTerms): FundingState {
  const request: OpenFundRequest = { kind: 'open_fund', proposalVersion: 1, by: terms.payeeId, ...terms };
  return {
    campaign: signPayload(request, signer(terms.payeeId)),
    campaignDigest: campaignDigestOf(terms),
    terms,
    phase: 'collecting',
    history: [],
    progress: { livePayers: 0, liveTotalCents: 0, met: false },
  };
}

// A complete, correctly bound pledge payload — the kind a contributor's
// device signs. Tests needing malformed input override individual fields.
function pledgeRequest(
  terms: CampaignTerms,
  payerId: string,
  pledgeRef: string,
  amountCents: number,
  expiresAt: number,
  over: Record<string, unknown> = {},
): PledgeRequest {
  return {
    kind: 'pledge',
    purchaseId: terms.purchaseId,
    by: payerId,
    pledgeRef,
    campaignDigest: campaignDigestOf(terms),
    share: {
      role: `pledge:${pledgeRef}`,
      payerId,
      payeeId: terms.payeeId,
      amountCents,
      feeCents: 0,
      rail: 'digital_euro',
    },
    expiresAt,
    privacyProfile: 'public_good_pledge_v1',
    ...over,
  } as PledgeRequest;
}

function signPledge(
  terms: CampaignTerms,
  payerId: string,
  pledgeRef: string,
  amountCents: number,
  expiresAt: number,
  over: Record<string, unknown> = {},
): Signed<PledgeRequest> {
  return signPayload(pledgeRequest(terms, payerId, pledgeRef, amountCents, expiresAt, over), signer(payerId));
}

// Records an accepted pledge in fixture-built history exactly the way an
// acceptance did: canonical payload retained, detached acknowledgment,
// active outcome.
function record(state: FundingState, signed: Signed<PledgeRequest>, acceptedAt: number, proposalVersion: number): PledgeAcceptance {
  const acknowledgment: PledgeAcceptance = {
    purchaseId: state.terms.purchaseId,
    pledgeRef: signed.payload.pledgeRef,
    acceptedAt,
    proposalVersion,
  };
  state.history.push({ signed, canonicalPayload: canonicalJson(signed.payload), acknowledgment, outcome: 'active' });
  return acknowledgment;
}

// The coordinator-applied materializations of the active history — input
// construction only; expected outputs below are asserted literally. The
// funding state is cloned so freezing a snapshot never freezes the fixture.
function snapshot(funding: FundingState, purchaseState: PurchaseState, proposalVersion: number): FundingSnapshot {
  funding = structuredClone(funding);
  const active = funding.history.filter((e) => e.outcome === 'active');
  return {
    purchaseId: funding.terms.purchaseId,
    purchaseState,
    proposalVersion,
    funding,
    shares: active.map(
      (e): Share => ({
        role: `pledge:${e.signed.payload.pledgeRef}`,
        payerId: e.signed.payload.share.payerId,
        payeeId: e.signed.payload.share.payeeId,
        amountCents: e.signed.payload.share.amountCents,
        feeCents: e.signed.payload.share.feeCents,
        rail: e.signed.payload.share.rail,
        authority: 'payer',
      }),
    ),
    authorizations: active.map((e): Authorization => ({ basis: 'pledge', pledge: e.signed })),
  };
}

// The verdicts a caller's verified read would produce for this funding
// state: campaign plus every active retained pledge.
function verdicts(funding: DeepReadonly<FundingState>, opts: { incoming?: boolean; campaign?: boolean; retained?: Record<string, boolean> } = {}): FundingVerification {
  const retained = new Map<string, boolean>();
  for (const e of funding.history) if (e.outcome === 'active') retained.set(e.signed.payload.pledgeRef, true);
  for (const [k, v] of Object.entries(opts.retained ?? {})) retained.set(k, v);
  return {
    campaignValid: opts.campaign ?? true,
    retained,
    ...(opts.incoming === undefined ? {} : { incomingValid: opts.incoming }),
  };
}

// Feeds an apply decision back into the next snapshot, as the coordinator
// would after applying it once.
function nextSnapshot(before: FundingSnapshot, d: FundingDecision): FundingSnapshot {
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') throw new Error('unreachable');
  return snapshot(d.funding, d.state, before.proposalVersion + d.versionDelta);
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    for (const value of Object.values(v as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(v);
  }
  return v;
}

const FROZEN = <T>(v: T): T => deepFreeze(v);
const eventNames = (d: FundingDecision): string[] => (d.kind === 'apply' ? d.events.map((e) => e.event) : []);

test('a missing or non-record command is refused as malformed, never a throw', () => {
  const terms = fundTerms();
  const funding = openFundState(terms);
  const snap = FROZEN(snapshot(funding, 'awaiting_approvals', 1));
  for (const command of [null, undefined, 'pledge', 42] as unknown as FundingCommand[]) {
    assert.deepEqual(decideFunding(snap, command, 5, verdicts(funding)), { kind: 'refused', reason: 'malformed_command' });
  }
});

test('a valid pledge appends one share under one version bump and reports progress', () => {
  const terms = fundTerms({ condition: { minPayers: 2 } });
  const funding = openFundState(terms);
  const snap = FROZEN(snapshot(funding, 'awaiting_approvals', 1));
  const signed = signPledge(terms, 'resident-1', 'r1', 300, 30);
  const d = decideFunding(snap, { kind: 'pledge', signed }, 5, verdicts(funding, { incoming: true }));
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  assert.equal(d.versionDelta, 1);
  assert.equal(d.state, 'awaiting_approvals');
  assert.equal(d.funding.phase, 'collecting');
  assert.deepEqual(d.funding.progress, { livePayers: 1, liveTotalCents: 300, met: false });
  assert.deepEqual(d.accepted, { purchaseId: 'fund-1', pledgeRef: 'r1', acceptedAt: 5, proposalVersion: 2 });
  assert.equal(d.shares.length, 1);
  assert.deepEqual(
    d.shares.map((s) => [s.role, s.payerId, s.amountCents]),
    [['pledge:r1', 'resident-1', 300]],
  );
  assert.equal(d.authorizations.length, 1);
  assert.equal(d.authorizations[0].basis, 'pledge');
  assert.deepEqual(eventNames(d), ['pledge_recorded', 'funding_evaluated']);
  assert.equal(d.funding.history.length, 1);
  assert.equal(d.funding.history[0].outcome, 'active');
  assert.equal(d.funding.history[0].canonicalPayload, canonicalJson(signed.payload));
});

test('two live payers at 300+700 meet minPayers 2; principal is 1000 and fees never count', () => {
  const terms = fundTerms({ condition: { minPayers: 2, minTotalCents: 1_050 } });
  const funding = openFundState(terms);
  const snap1 = FROZEN(snapshot(funding, 'awaiting_approvals', 1));
  // A fee-bearing pledge: the 50 fee must not reach the principal counter.
  const p1 = signPledge(terms, 'resident-1', 'r1', 300, 30, { share: { role: 'pledge:r1', payerId: 'resident-1', payeeId: 'project-1', amountCents: 300, feeCents: 50, rail: 'bank' } });
  const d1 = decideFunding(snap1, { kind: 'pledge', signed: p1 }, 5, verdicts(funding, { incoming: true }));
  const snap2 = FROZEN(nextSnapshot(snap1, d1));
  const p2 = signPledge(terms, 'resident-2', 'r2', 700, 30);
  const d2 = decideFunding(snap2, { kind: 'pledge', signed: p2 }, 6, verdicts(snap2.funding as FundingState, { incoming: true }));
  // minPayers 2 tips the OR condition even though principal 1000 < 1050.
  assert.equal(d2.kind, 'apply');
  if (d2.kind !== 'apply') return;
  assert.equal(d2.state, 'ready');
  assert.equal(d2.funding.phase, 'closed');
  assert.equal(d2.versionDelta, 1);
  assert.deepEqual(d2.funding.progress, { livePayers: 2, liveTotalCents: 1_000, met: true });
  assert.deepEqual(d2.accepted, { purchaseId: 'fund-1', pledgeRef: 'r2', acceptedAt: 6, proposalVersion: 3 });
  assert.deepEqual(eventNames(d2), ['pledge_recorded', 'funding_evaluated', 'funding_succeeded']);
});

test('the condition is OR: minTotalCents meets even when minPayers does not', () => {
  const terms = fundTerms({ condition: { minPayers: 3, minTotalCents: 1_000 } });
  const funding = openFundState(terms);
  let snap = snapshot(funding, 'awaiting_approvals', 1);
  snap = nextSnapshot(snap, decideFunding(FROZEN(snap), { kind: 'pledge', signed: signPledge(terms, 'resident-1', 'r1', 600, 30) }, 5, verdicts(snap.funding, { incoming: true })));
  const d = decideFunding(FROZEN(snap), { kind: 'pledge', signed: signPledge(terms, 'resident-2', 'r2', 500, 30) }, 6, verdicts(snap.funding, { incoming: true }));
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  // Two payers is short of minPayers 3; 1100 >= 1000 carries it alone.
  assert.deepEqual(d.funding.progress, { livePayers: 2, liveTotalCents: 1_100, met: true });
  assert.equal(d.state, 'ready');
});

test('a pledge is live at expiry equality and lapses only later, in one batch bump', () => {
  const terms = fundTerms({ condition: { minPayers: 2 }, fundingEndsAt: 40, settleBy: 50 });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 25), 5, 2);
  record(funding, signPledge(terms, 'resident-2', 'r2', 700, 25), 6, 3);
  // now == expiresAt: both still live — no lapse, no bump.
  const atEqual = decideFunding(FROZEN(snapshot(funding, 'awaiting_approvals', 3)), { kind: 'evaluate' }, 25, verdicts(funding));
  assert.equal(atEqual.kind, 'apply');
  if (atEqual.kind !== 'apply') return;
  assert.equal(atEqual.versionDelta, 0);
  assert.equal(atEqual.shares.length, 2);
  assert.deepEqual(atEqual.funding.progress, { livePayers: 2, liveTotalCents: 1_000, met: true });
  // One minute later both lapse in a single batch — one version bump.
  const atOver = decideFunding(FROZEN(snapshot(funding, 'awaiting_approvals', 3)), { kind: 'evaluate' }, 26, verdicts(funding));
  assert.equal(atOver.kind, 'apply');
  if (atOver.kind !== 'apply') return;
  assert.equal(atOver.versionDelta, 1, 'one bump for the whole lapse batch');
  assert.equal(atOver.state, 'awaiting_approvals');
  assert.deepEqual(atOver.funding.progress, { livePayers: 0, liveTotalCents: 0, met: false });
  assert.deepEqual(atOver.funding.history.map((e) => e.outcome), ['lapsed', 'lapsed'], 'history retained');
  assert.equal(atOver.shares.length, 0);
  assert.equal(atOver.authorizations.length, 0);
  assert.deepEqual(eventNames(atOver), ['pledge_lapsed', 'pledge_lapsed', 'funding_evaluated']);
});

test("deadline mode refuses a pledge expiring at the cutoff, and the reference stays free", () => {
  const terms = fundTerms({ acceptPledgesUntil: 'deadline' });
  const funding = openFundState(terms);
  const snap = FROZEN(snapshot(funding, 'awaiting_approvals', 1));
  const before = structuredClone(snapshot(funding, 'awaiting_approvals', 1));
  // expiresAt == fundingEndsAt cannot survive collection closure.
  const refused = decideFunding(snap, { kind: 'pledge', signed: signPledge(terms, 'resident-1', 'r1', 300, 20) }, 5, verdicts(funding, { incoming: true }));
  assert.deepEqual(refused, { kind: 'refused', reason: 'pledge_expiry_invalid' });
  assert.deepEqual(snapshot(funding, 'awaiting_approvals', 1), before, 'a refusal never mutates');
  // The same reference is free: a deadline-valid expiry is accepted.
  const accepted = decideFunding(snap, { kind: 'pledge', signed: signPledge(terms, 'resident-1', 'r1', 300, 25) }, 5, verdicts(funding, { incoming: true }));
  assert.equal(accepted.kind, 'apply');
  if (accepted.kind !== 'apply') return;
  assert.equal(accepted.accepted?.pledgeRef, 'r1');
});

test('an exact accepted replay is inert — before and after lapse and closure', () => {
  const terms = fundTerms({ condition: { minPayers: 1 }, fundingEndsAt: 40, settleBy: 50 });
  const funding = openFundState(terms);
  const signed = signPledge(terms, 'resident-1', 'r1', 300, 25);
  const ack = record(funding, signed, 5, 2);
  const replay = (f: FundingState, state: PurchaseState, v: number, incoming = true) =>
    decideFunding(FROZEN(snapshot(f, state, v)), { kind: 'pledge', signed }, 30, verdicts(f, { incoming }));
  // While open: the original acknowledgment, no apply, no events.
  assert.deepEqual(replay(funding, 'awaiting_approvals', 2), { kind: 'replay', acknowledgment: ack });
  // After the roster closed.
  funding.phase = 'closed';
  assert.deepEqual(replay(funding, 'ready', 2), { kind: 'replay', acknowledgment: ack });
  // After lapse the acknowledgment still stands — evidence never moves.
  funding.phase = 'collecting';
  funding.history[0].outcome = 'lapsed';
  assert.deepEqual(replay(funding, 'awaiting_approvals', 3), { kind: 'replay', acknowledgment: ack });
  // A replay is never a way through signature verification.
  assert.deepEqual(replay(funding, 'awaiting_approvals', 3, false), { kind: 'refused', reason: 'pledge_authority_invalid' });
});

test('the same reference over different bytes is a conflict even when the change mismatches terms', () => {
  const terms = fundTerms();
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 30), 5, 2);
  const snap = FROZEN(snapshot(funding, 'awaiting_approvals', 2));
  // Changed amount — would also alter the share.
  assert.deepEqual(
    decideFunding(snap, { kind: 'pledge', signed: signPledge(terms, 'resident-1', 'r1', 400, 30) }, 6, verdicts(funding, { incoming: true })),
    { kind: 'refused', reason: 'pledge_ref_conflict' },
  );
  // Changed payee — independently a campaign_terms_mismatch, still conflict.
  assert.deepEqual(
    decideFunding(
      snap,
      { kind: 'pledge', signed: signPledge(terms, 'resident-1', 'r1', 300, 30, { share: { role: 'pledge:r1', payerId: 'resident-1', payeeId: 'project-2', amountCents: 300, feeCents: 0, rail: 'digital_euro' } }) },
      6,
      verdicts(funding, { incoming: true }),
    ),
    { kind: 'refused', reason: 'pledge_ref_conflict' },
  );
});

test('a second pledge from an accepted payer is refused, including after lapse', () => {
  const terms = fundTerms({ fundingEndsAt: 40, settleBy: 50 });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 25), 5, 2);
  // The first pledge lapsed — the payer still cannot pledge again.
  funding.history[0].outcome = 'lapsed';
  const d = decideFunding(
    FROZEN(snapshot(funding, 'awaiting_approvals', 3)),
    { kind: 'pledge', signed: signPledge(terms, 'resident-1', 'r2', 500, 45) },
    10,
    verdicts(funding, { incoming: true }),
  );
  assert.deepEqual(d, { kind: 'refused', reason: 'payer_already_pledged' });
});

test('a new pledge at the cutoff is refused with no append', () => {
  const terms = fundTerms();
  const funding = openFundState(terms);
  const snap = FROZEN(snapshot(funding, 'awaiting_approvals', 1));
  const d = decideFunding(snap, { kind: 'pledge', signed: signPledge(terms, 'resident-1', 'r1', 300, 30) }, 20, verdicts(funding, { incoming: true }));
  assert.deepEqual(d, { kind: 'refused', reason: 'roster_closed' });
  assert.equal(funding.history.length, 0);
});

test('a pledge on a closed roster is refused; replay of its own ref is not', () => {
  const terms = fundTerms({ condition: { minPayers: 1 } });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 30), 5, 2);
  funding.phase = 'closed';
  const snap = FROZEN(snapshot(funding, 'ready', 2));
  const d = decideFunding(snap, { kind: 'pledge', signed: signPledge(terms, 'resident-2', 'r2', 700, 30) }, 10, verdicts(funding, { incoming: true }));
  assert.deepEqual(d, { kind: 'refused', reason: 'roster_closed' });
});

test('a collecting evaluation delayed past settleBy fails with no intent and keeps the lapse', () => {
  const terms = fundTerms({ condition: { minPayers: 2 }, fundingEndsAt: 20, settleBy: 30 });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 28), 5, 2);
  record(funding, signPledge(terms, 'resident-2', 'r2', 700, 30), 6, 3);
  const d = decideFunding(FROZEN(snapshot(funding, 'awaiting_approvals', 3)), { kind: 'evaluate' }, 31, verdicts(funding));
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  assert.equal(d.state, 'failed');
  assert.equal(d.failureReason, 'funding_settlement_expired');
  // Both pledges expired before the failure — no valid expiry outlives
  // settleBy — and lapse still applies in one batch before the failure.
  assert.deepEqual(d.funding.history.map((e) => e.outcome), ['lapsed', 'lapsed']);
  assert.equal(d.versionDelta, 1);
  assert.equal(d.shares.length, 0);
  assert.deepEqual(eventNames(d), ['pledge_lapsed', 'pledge_lapsed', 'funding_evaluated', 'funding_failed']);
});

test('an empty roster at the cutoff fails with no money effects', () => {
  const terms = fundTerms();
  const funding = openFundState(terms);
  const d = decideFunding(FROZEN(snapshot(funding, 'awaiting_approvals', 1)), { kind: 'evaluate' }, 20, verdicts(funding));
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  assert.equal(d.state, 'failed');
  assert.equal(d.failureReason, 'funding_condition_unmet');
  assert.equal(d.versionDelta, 0);
  assert.equal(d.shares.length, 0);
});

test('a closed roster losing a pledge fails the whole purchase even when the rest still meet', () => {
  const terms = fundTerms({ condition: { minTotalCents: 300 }, fundingEndsAt: 20, settleBy: 35 });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 25), 5, 2);
  record(funding, signPledge(terms, 'resident-2', 'r2', 700, 34), 6, 3);
  funding.phase = 'closed';
  // At 26, r1 expired; r2's 700 alone still satisfies minTotalCents 300 —
  // the whole purchase still fails, frozen roster and version preserved.
  const d = decideFunding(FROZEN(snapshot(funding, 'ready', 3)), { kind: 'evaluate' }, 26, verdicts(funding));
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  assert.equal(d.state, 'failed');
  assert.equal(d.failureReason, 'pledge_expired');
  assert.equal(d.versionDelta, 0, 'closed rosters never bump');
  assert.equal(d.funding.phase, 'closed');
  assert.deepEqual(d.funding.history.map((e) => e.outcome), ['active', 'active'], 'never pruned');
  assert.equal(d.shares.length, 2, 'frozen materialization preserved');
});

test('closed-phase lapses never happen: an expired pledge is a failure, not a removal', () => {
  const terms = fundTerms({ condition: { minPayers: 2 }, fundingEndsAt: 20, settleBy: 35 });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 25), 5, 2);
  record(funding, signPledge(terms, 'resident-2', 'r2', 700, 25), 6, 3);
  funding.phase = 'closed';
  const d = decideFunding(FROZEN(snapshot(funding, 'ready', 3)), { kind: 'evaluate' }, 26, verdicts(funding));
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  assert.equal(d.failureReason, 'pledge_expired');
  assert.equal(d.funding.history.filter((e) => e.outcome === 'lapsed').length, 0);
});

test('admitted and terminal evaluations are no-ops', () => {
  const terms = fundTerms({ condition: { minPayers: 1 } });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 30), 5, 2);
  funding.phase = 'admitted';
  assert.deepEqual(
    decideFunding(FROZEN(snapshot(funding, 'pending', 2)), { kind: 'evaluate' }, 45, verdicts(funding)),
    { kind: 'unchanged' },
  );
  funding.phase = 'collecting';
  for (const terminal of ['completed', 'failed', 'cancelled', 'compensated'] as const) {
    assert.deepEqual(
      decideFunding(FROZEN(snapshot(funding, terminal, 2)), { kind: 'evaluate' }, 45, verdicts(funding)),
      { kind: 'unchanged' },
      terminal,
    );
  }
});

test('admission requires closed, live and met — and never moves the version', () => {
  const terms = fundTerms({ condition: { minTotalCents: 300 }, fundingEndsAt: 20, settleBy: 35 });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 34), 5, 2);
  record(funding, signPledge(terms, 'resident-2', 'r2', 700, 34), 6, 3);
  // Still collecting: admit refuses.
  assert.deepEqual(
    decideFunding(FROZEN(snapshot(funding, 'awaiting_approvals', 3)), { kind: 'admit' }, 21, verdicts(funding)),
    { kind: 'refused', reason: 'funding_not_closed' },
  );
  funding.phase = 'closed';
  // Closed and live at 34: admission freezes the phase, version untouched.
  const ok = decideFunding(FROZEN(snapshot(funding, 'ready', 3)), { kind: 'admit' }, 34, verdicts(funding));
  assert.equal(ok.kind, 'apply');
  if (ok.kind !== 'apply') return;
  assert.equal(ok.funding.phase, 'admitted');
  assert.equal(ok.versionDelta, 0);
  assert.equal(ok.state, 'ready');
  assert.equal(ok.shares.length, 2);
  // Past settleBy the same roster can no longer be admitted.
  assert.equal(
    (decideFunding(FROZEN(snapshot(funding, 'ready', 3)), { kind: 'admit' }, 36, verdicts(funding)) as { failureReason?: string }).failureReason,
    'funding_settlement_expired',
  );
  // An unmet roster fails admission even under a corrupting caller.
  const short = openFundState(terms);
  record(short, signPledge(terms, 'resident-3', 'r3', 100, 34), 5, 2);
  short.phase = 'closed';
  const unmet = decideFunding(FROZEN(snapshot(short, 'ready', 2)), { kind: 'admit' }, 21, verdicts(short));
  assert.equal(unmet.kind, 'apply');
  if (unmet.kind !== 'apply') return;
  assert.equal(unmet.state, 'failed');
  assert.equal(unmet.failureReason, 'funding_condition_unmet');
});

test('check_pledge reports current validity read-only and never applies', () => {
  const terms = fundTerms({ fundingEndsAt: 20, settleBy: 35 });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 34), 5, 2);
  const snapFor = (state: PurchaseState) => FROZEN(snapshot(funding, state, 2));
  const goodShare: Share = { role: 'pledge:r1', payerId: 'resident-1', payeeId: 'project-1', amountCents: 300, feeCents: 0, rail: 'digital_euro', authority: 'payer' };
  const check = (snap: FundingSnapshot, ref: string, share: Share, now: number) => decideFunding(snap, { kind: 'check_pledge', pledgeRef: ref, share }, now, verdicts(funding));
  assert.deepEqual(check(snapFor('awaiting_approvals'), 'r1', goodShare, 10), { kind: 'unchanged' });
  // The exact frozen share is part of the binding.
  assert.deepEqual(check(snapFor('awaiting_approvals'), 'r1', { ...goodShare, amountCents: 301 }, 10), { kind: 'refused', reason: 'pledge_authority_invalid' });
  assert.deepEqual(check(snapFor('awaiting_approvals'), 'r1', { ...goodShare, rail: 'bank' }, 10), { kind: 'refused', reason: 'pledge_authority_invalid' });
  assert.deepEqual(check(snapFor('awaiting_approvals'), 'r9', goodShare, 10), { kind: 'refused', reason: 'pledge_authority_invalid' });
  assert.deepEqual(check(snapFor('awaiting_approvals'), 'r1', goodShare, 35), { kind: 'refused', reason: 'pledge_expired' });
  // A lapsed pledge has no live authority even inside its expiry.
  funding.history[0].outcome = 'lapsed';
  assert.deepEqual(check(FROZEN(snapshot(funding, 'awaiting_approvals', 3)), 'r1', goodShare, 10), { kind: 'refused', reason: 'pledge_expired' });
  funding.history[0].outcome = 'active';
  // The admitted frozen leg is checked against the same rule plus settleBy.
  funding.phase = 'admitted';
  assert.deepEqual(check(snapFor('pending'), 'r1', goodShare, 30), { kind: 'unchanged' });
  assert.deepEqual(check(snapFor('pending'), 'r1', goodShare, 36), { kind: 'refused', reason: 'funding_settlement_expired' });
  // A malformed funding record is not_a_fund, like every sibling command.
  const broken = snapshot(funding, 'awaiting_approvals', 2);
  (broken.funding as unknown as Record<string, unknown>).terms = 5;
  assert.deepEqual(check(FROZEN(broken), 'r1', goodShare, 10), { kind: 'refused', reason: 'not_a_fund' });
});

test('unsafe amounts and sums are refused before any mutation', () => {
  const terms = fundTerms();
  const funding = openFundState(terms);
  const snap = FROZEN(snapshot(funding, 'awaiting_approvals', 1));
  const before = structuredClone(snapshot(funding, 'awaiting_approvals', 1));
  const attempt = (signed: Signed<PledgeRequest>) => decideFunding(snap, { kind: 'pledge', signed }, 5, verdicts(funding, { incoming: true }));
  // Zero and negative principal.
  assert.deepEqual(attempt(signPledge(terms, 'resident-1', 'r1', 0, 30)), { kind: 'refused', reason: 'pledge_malformed' });
  assert.deepEqual(attempt(signPledge(terms, 'resident-1', 'r1', -5, 30)), { kind: 'refused', reason: 'pledge_malformed' });
  // Non-integer cents.
  assert.deepEqual(attempt(signPledge(terms, 'resident-1', 'r1', 10.5, 30)), { kind: 'refused', reason: 'pledge_malformed' });
  // principal + fee overflows a safe integer.
  assert.deepEqual(
    attempt(signPledge(terms, 'resident-1', 'r1', Number.MAX_SAFE_INTEGER, 30, { share: { role: 'pledge:r1', payerId: 'resident-1', payeeId: 'project-1', amountCents: Number.MAX_SAFE_INTEGER, feeCents: 1, rail: 'digital_euro' } })),
    { kind: 'refused', reason: 'pledge_malformed' },
  );
  // Negative fee.
  assert.deepEqual(
    attempt(signPledge(terms, 'resident-1', 'r1', 300, 30, { share: { role: 'pledge:r1', payerId: 'resident-1', payeeId: 'project-1', amountCents: 300, feeCents: -1, rail: 'digital_euro' } })),
    { kind: 'refused', reason: 'pledge_malformed' },
  );
  assert.deepEqual(snapshot(funding, 'awaiting_approvals', 1), before, 'every refusal left the snapshot untouched');
  // Roster-sum overflow: an existing giant plus any positive amount.
  const big = openFundState(terms);
  record(big, signPledge(terms, 'resident-1', 'r1', Number.MAX_SAFE_INTEGER - 10, 30), 5, 2);
  const d = decideFunding(
    FROZEN(snapshot(big, 'awaiting_approvals', 2)),
    { kind: 'pledge', signed: signPledge(terms, 'resident-2', 'r2', 100, 30) },
    6,
    verdicts(big, { incoming: true }),
  );
  assert.deepEqual(d, { kind: 'refused', reason: 'pledge_malformed' });
  assert.equal(big.history.length, 1);
});

test('forbidden envelope fields and binding mismatches refuse before mutation', () => {
  const terms = fundTerms();
  const funding = openFundState(terms);
  const snap = FROZEN(snapshot(funding, 'awaiting_approvals', 1));
  const attempt = (signed: Signed<PledgeRequest>) => decideFunding(snap, { kind: 'pledge', signed }, 5, verdicts(funding, { incoming: true }));
  const cases: [string, Record<string, unknown>, string][] = [
    ['supplied proposalVersion', { proposalVersion: 1 }, 'pledge_malformed'],
    ['supplied cancelUntil', { cancelUntil: 10 }, 'pledge_malformed'],
    ['wrong campaign digest', { campaignDigest: '0'.repeat(64) }, 'campaign_terms_mismatch'],
    ['wrong purchase', { purchaseId: 'fund-2' }, 'campaign_terms_mismatch'],
    ['wrong profile', { privacyProfile: 'split_bill_v1' }, 'campaign_terms_mismatch'],
    ['wrong payee', { share: { role: 'pledge:r1', payerId: 'resident-1', payeeId: 'project-2', amountCents: 300, feeCents: 0, rail: 'digital_euro' } }, 'campaign_terms_mismatch'],
    ['arbitrary role', { share: { role: 'friend', payerId: 'resident-1', payeeId: 'project-1', amountCents: 300, feeCents: 0, rail: 'digital_euro' } }, 'pledge_malformed'],
    ['signer is not the payer', { share: { role: 'pledge:r1', payerId: 'resident-2', payeeId: 'project-1', amountCents: 300, feeCents: 0, rail: 'digital_euro' } }, 'pledge_malformed'],
    ['unrecognized rail', { share: { role: 'pledge:r1', payerId: 'resident-1', payeeId: 'project-1', amountCents: 300, feeCents: 0, rail: 'sepa' } }, 'pledge_malformed'],
    ['empty reference', { pledgeRef: '', share: { role: 'pledge:', payerId: 'resident-1', payeeId: 'project-1', amountCents: 300, feeCents: 0, rail: 'digital_euro' } }, 'pledge_malformed'],
    ['expired on arrival', { expiresAt: 4 }, 'pledge_expired'],
    ['expiry past settleBy', { expiresAt: 31 }, 'pledge_expiry_invalid'],
    ['nonfinite expiry', { expiresAt: Number.NaN }, 'pledge_expiry_invalid'],
  ];
  for (const [name, over, reason] of cases) {
    const signed = signPledge(terms, 'resident-1', 'r1', 300, 30, over);
    assert.deepEqual(attempt(signed), { kind: 'refused', reason }, name);
    assert.equal(funding.history.length, 0, `${name}: no mutation`);
  }
  // A missing incoming verdict fails closed like a bad signature.
  assert.deepEqual(
    decideFunding(snap, { kind: 'pledge', signed: signPledge(terms, 'resident-1', 'r1', 300, 30) }, 5, verdicts(funding)),
    { kind: 'refused', reason: 'pledge_authority_invalid' },
  );
});

test('corrupted retained evidence fails the whole purchase, never the threshold count', () => {
  const terms = fundTerms({ condition: { minPayers: 1 } });
  const build = () => {
    const funding = openFundState(terms);
    record(funding, signPledge(terms, 'resident-1', 'r1', 300, 30), 5, 2);
    return funding;
  };
  const fail = (snap: FundingSnapshot, v: FundingVerification, reason = 'pledge_authority_invalid') => {
    const d = decideFunding(FROZEN(snap), { kind: 'evaluate' }, 10, v);
    assert.equal(d.kind, 'apply');
    if (d.kind !== 'apply') return d;
    assert.equal(d.state, 'failed');
    assert.equal(d.failureReason, reason);
    return d;
  };
  // A materialized share that no longer matches the signed pledge.
  {
    const funding = build();
    const snap = snapshot(funding, 'awaiting_approvals', 2);
    (snap.shares as Share[])[0].amountCents = 301;
    fail(snap, verdicts(funding));
  }
  // A materialized authorization whose payload no longer matches history.
  {
    const funding = build();
    const snap = snapshot(funding, 'awaiting_approvals', 2);
    const forged = signPledge(terms, 'resident-1', 'r1', 301, 30);
    (snap.authorizations as Authorization[])[0] = { basis: 'pledge', pledge: forged };
    fail(snap, verdicts(funding));
  }
  // Missing verdict for an active pledge.
  {
    const funding = build();
    fail(snapshot(funding, 'awaiting_approvals', 2), { campaignValid: true, retained: new Map() });
  }
  // False verdict for an active pledge.
  {
    const funding = build();
    fail(snapshot(funding, 'awaiting_approvals', 2), { campaignValid: true, retained: new Map([['r1', false]]) });
  }
  // Campaign signature unverifiable.
  {
    const funding = build();
    fail(snapshot(funding, 'awaiting_approvals', 2), { campaignValid: false, retained: new Map([['r1', true]]) });
  }
  // Duplicate pledge reference in retained history.
  {
    const funding = build();
    record(funding, signPledge(terms, 'resident-2', 'r1', 500, 30), 6, 3);
    fail(snapshot(funding, 'awaiting_approvals', 3), verdicts(funding));
  }
  // Duplicate payer under a different reference.
  {
    const funding = build();
    record(funding, signPledge(terms, 'resident-1', 'r2', 500, 30), 6, 3);
    fail(snapshot(funding, 'awaiting_approvals', 3), verdicts(funding));
  }
  // A lapsed entry that still materializes a share.
  {
    const funding = build();
    const snap = snapshot(funding, 'awaiting_approvals', 2);
    (snap.funding as FundingState).history[0].outcome = 'lapsed';
    fail(snap, verdicts(funding));
  }
  // A stored campaign digest that no longer matches the retained terms.
  {
    const funding = build();
    funding.campaignDigest = 'f'.repeat(64);
    fail(snapshot(funding, 'awaiting_approvals', 2), verdicts(funding));
  }
  // Campaign times must be finite AND nonnegative (spec §2.1): a
  // negative cutoff or settleBy is not well-formed terms even when the
  // ordering still holds.
  {
    const funding = openFundState(fundTerms({ fundingEndsAt: -1 }));
    fail(snapshot(funding, 'awaiting_approvals', 1), verdicts(funding));
  }
  {
    const funding = openFundState(fundTerms({ fundingEndsAt: -5, settleBy: -1 }));
    fail(snapshot(funding, 'awaiting_approvals', 1), verdicts(funding));
  }
  // A 'deadline' pledge whose expiry never outlived the cutoff could not
  // have been accepted — retained corruption like any other.
  {
    const dl = openFundState(fundTerms({ acceptPledgesUntil: 'deadline' }));
    record(dl, signPledge(dl.terms, 'resident-1', 'r1', 300, 15), 5, 2);
    fail(snapshot(dl, 'awaiting_approvals', 2), verdicts(dl));
  }
});

test('a new valid pledge cannot append over corrupted retained evidence — the purchase fails', () => {
  const terms = fundTerms();
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 30), 5, 2);
  const snap = snapshot(funding, 'awaiting_approvals', 2);
  (snap.shares as Share[])[0].amountCents = 301;
  const d = decideFunding(
    FROZEN(snap),
    { kind: 'pledge', signed: signPledge(terms, 'resident-2', 'r2', 700, 30) },
    6,
    verdicts(funding, { incoming: true }),
  );
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  assert.equal(d.state, 'failed');
  assert.equal(d.failureReason, 'pledge_authority_invalid');
  assert.equal(d.funding.history.length, 1, 'the new pledge was not appended');
});

test('a valid new pledge lapses expired entries, appends, then evaluates once', () => {
  const terms = fundTerms({ condition: { minPayers: 2 }, fundingEndsAt: 40, settleBy: 50 });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 10), 5, 2);
  // Now 11: r1 expired; the incoming r2 is valid — lapse batch + append =
  // two bumps, then one evaluation over the combined roster.
  const d = decideFunding(
    FROZEN(snapshot(funding, 'awaiting_approvals', 2)),
    { kind: 'pledge', signed: signPledge(terms, 'resident-2', 'r2', 700, 45) },
    11,
    verdicts(funding, { incoming: true }),
  );
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  assert.equal(d.versionDelta, 2, 'lapse batch bump plus append bump');
  assert.deepEqual(d.accepted, { purchaseId: 'fund-1', pledgeRef: 'r2', acceptedAt: 11, proposalVersion: 4 });
  assert.deepEqual(d.funding.history.map((e) => e.outcome), ['lapsed', 'active']);
  assert.deepEqual(d.funding.progress, { livePayers: 1, liveTotalCents: 700, met: false });
  assert.equal(d.state, 'awaiting_approvals');
  assert.deepEqual(eventNames(d), ['pledge_lapsed', 'pledge_recorded', 'funding_evaluated']);
});

test('deadline mode keeps collecting after the condition is met and closes at the cutoff', () => {
  const terms = fundTerms({ acceptPledgesUntil: 'deadline', condition: { minPayers: 2 } });
  const funding = openFundState(terms);
  let snap = snapshot(funding, 'awaiting_approvals', 1);
  for (const [payer, ref, amount] of [['resident-1', 'r1', 300], ['resident-2', 'r2', 700]] as const) {
    const d = decideFunding(FROZEN(snap), { kind: 'pledge', signed: signPledge(terms, payer, ref, amount, 30) }, 10, verdicts(snap.funding, { incoming: true }));
    assert.equal(d.kind, 'apply');
    if (d.kind !== 'apply') return;
    // Met already, but 'deadline' keeps accepting — progress only.
    assert.equal(d.state, 'awaiting_approvals');
    assert.equal(d.funding.phase, 'collecting');
    snap = nextSnapshot(snap, d);
  }
  // An overfunding pledge before the cutoff is still accepted.
  const extra = decideFunding(FROZEN(snap), { kind: 'pledge', signed: signPledge(terms, 'resident-3', 'r3', 50, 25) }, 19, verdicts(snap.funding, { incoming: true }));
  assert.equal(extra.kind, 'apply');
  if (extra.kind !== 'apply') return;
  assert.equal(extra.state, 'awaiting_approvals');
  snap = nextSnapshot(snap, extra);
  // At the cutoff the final roster — including the third pledge — closes ready.
  const close = decideFunding(FROZEN(snap), { kind: 'evaluate' }, 20, verdicts(snap.funding));
  assert.equal(close.kind, 'apply');
  if (close.kind !== 'apply') return;
  assert.equal(close.state, 'ready');
  assert.equal(close.funding.phase, 'closed');
  assert.deepEqual(close.funding.progress, { livePayers: 3, liveTotalCents: 1_050, met: true });
  assert.equal(close.shares.length, 3);
});

test('a malformed retained share amount fails the purchase instead of poisoning the sum pre-check', () => {
  const terms = fundTerms();
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 30), 5, 2);
  const snap = snapshot(funding, 'awaiting_approvals', 2);
  // The retained signed payload's principal is no longer a number: adding
  // it to the projected roster sum would poison a safe-integer check into
  // a pledge_malformed refusal. Corrupted evidence fails the purchase.
  (snap.funding as FundingState).history[0].signed.payload.share.amountCents = '300' as unknown as number;
  const d = decideFunding(
    FROZEN(snap),
    { kind: 'pledge', signed: signPledge(terms, 'resident-2', 'r2', 700, 30) },
    6,
    verdicts(funding, { incoming: true }),
  );
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  assert.equal(d.state, 'failed');
  assert.equal(d.failureReason, 'pledge_authority_invalid');
  assert.equal(d.funding.history.length, 1, 'the new pledge was not appended');
});

test('a phase/state-inconsistent snapshot fails closed rather than upgrading', () => {
  const terms = fundTerms({ condition: { minPayers: 1 }, settleBy: 35 });
  // A collecting roster reported under a state it never earned — 'ready'
  // or 'draft' — must fail, not be confirmed or advanced by evaluation.
  const collecting = openFundState(terms);
  record(collecting, signPledge(terms, 'resident-1', 'r1', 300, 34), 5, 2);
  for (const state of ['draft', 'ready'] as const) {
    const d = decideFunding(FROZEN(snapshot(collecting, state, 2)), { kind: 'evaluate' }, 21, verdicts(collecting));
    assert.equal(d.kind, 'apply', state);
    if (d.kind !== 'apply') continue;
    assert.equal(d.state, 'failed', state);
    assert.equal(d.failureReason, 'pledge_authority_invalid', state);
    assert.equal(d.versionDelta, 0, state);
    assert.equal(d.funding.phase, 'collecting', `${state}: no roster rewrite on the failure path`);
  }
  // A closed roster under 'awaiting_approvals' is equally inconsistent.
  const closed = openFundState(terms);
  record(closed, signPledge(terms, 'resident-1', 'r1', 300, 34), 5, 2);
  closed.phase = 'closed';
  const d = decideFunding(FROZEN(snapshot(closed, 'awaiting_approvals', 2)), { kind: 'evaluate' }, 21, verdicts(closed));
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  assert.equal(d.state, 'failed');
  assert.equal(d.failureReason, 'pledge_authority_invalid');
  assert.equal(d.funding.phase, 'closed');
});

test('a still-valid closed evaluation keeps the frozen roster and reports progress', () => {
  const terms = fundTerms({ condition: { minPayers: 1 }, settleBy: 35 });
  const funding = openFundState(terms);
  record(funding, signPledge(terms, 'resident-1', 'r1', 300, 34), 5, 2);
  funding.phase = 'closed';
  const d = decideFunding(FROZEN(snapshot(funding, 'ready', 2)), { kind: 'evaluate' }, 21, verdicts(funding));
  assert.equal(d.kind, 'apply');
  if (d.kind !== 'apply') return;
  assert.equal(d.state, 'ready');
  assert.equal(d.versionDelta, 0);
  assert.equal(d.funding.phase, 'closed');
  assert.equal(d.shares.length, 1);
  assert.deepEqual(eventNames(d), ['funding_evaluated']);
});
