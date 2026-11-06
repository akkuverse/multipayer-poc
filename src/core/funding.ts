// Pure funding decisions for conditional-fund purchases (spec §2). One
// interface — decideFunding — owns pledge acceptance and replay ordering,
// expiry lapse, condition truth, progress, irreversible roster closure and
// admission eligibility. It returns detached data only: the coordinator
// applies each decision once under its per-purchase operation guard.
//
// Nothing here verifies signatures itself, reads keys/registry/ledger,
// logs, advances a clock or calls settlement. Signature verdicts arrive in
// FundingVerification and a missing verdict is invalid — the module fails
// closed rather than trusting retained or incoming evidence.

import { campaignDigestOf, canonicalJson } from './signing.ts';
import type { Signed } from './signing.ts';
import {
  RAILS,
  type AcceptedPledge,
  type Authorization,
  type CampaignTerms,
  type Cents,
  type DeepReadonly,
  type FundingState,
  type PledgeAcceptance,
  type PledgeRequest,
  type PurchaseState,
  type Share,
} from './types.ts';

// Everything a funding decision needs, detached from the purchase record:
// the funding phase/history the module owns plus the coordinator-applied
// materializations (shares, authorizations) it cross-checks against that
// history. proposalVersion is the committed roster version the next
// lapse/append bumps from.
export interface FundingSnapshot {
  purchaseId: string;
  purchaseState: PurchaseState;
  proposalVersion: number;
  funding: DeepReadonly<FundingState>;
  shares: readonly DeepReadonly<Share>[];
  authorizations: readonly DeepReadonly<Authorization>[];
}

// 'pledge' records a signed contribution; 'evaluate' applies the already
// signed terms to the current clock (it grants no new spending authority);
// 'admit' is the ready→admitted gate settlement runs before freezing the
// intent; 'check_pledge' is read-only revalidation of one retained pledge
// and its exact materialized share — the same binding rule reused by the
// authorizationCurrentlyValid and firstHandoffRefusal callers.
export type FundingCommand =
  | { kind: 'pledge'; signed: Signed<PledgeRequest> }
  | { kind: 'evaluate' }
  | { kind: 'admit' }
  | { kind: 'check_pledge'; pledgeRef: string; share: DeepReadonly<Share> };

// Verdicts the caller computed with its own verified read: the retained
// campaign signature, every still-active retained pledge's signature keyed
// by pledgeRef, and — for a pledge command — the incoming signature. A
// missing verdict is invalid: the decision fails closed, never assumes.
export interface FundingVerification {
  campaignValid: boolean;
  retained: ReadonlyMap<string, boolean>;
  incomingValid?: boolean;
}

export type FundingDecision =
  // The request itself is rejected; nothing mutates and the reference
  // stays free.
  | { kind: 'refused'; reason: string }
  // An exact canonical replay of an accepted pledge: the original
  // detached acknowledgment, no events, no roster or version change —
  // even after closure, lapse or admission. The coordinator's operation
  // guard still applies; replay only bypasses funding evaluation.
  | { kind: 'replay'; acknowledgment: PledgeAcceptance }
  // Nothing to change: an admitted or terminal evaluation, or a currently
  // valid check_pledge.
  | { kind: 'unchanged' }
  // The complete replacement the coordinator applies once: funding state,
  // the roster materializations derived from active history, the proposal
  // version delta, the purchase state to transition to and the events
  // (LOCAL) to record. failureReason accompanies state 'failed';
  // accepted carries a newly recorded pledge's acknowledgment.
  | {
      kind: 'apply';
      funding: FundingState;
      shares: Share[];
      authorizations: Authorization[];
      versionDelta: number;
      state: PurchaseState;
      failureReason?: string;
      accepted?: PledgeAcceptance;
      events: { event: string; detail: Record<string, unknown> }[];
    };

// Terminal states retain evidence and outcomes; funding decisions are
// inert on them.
const TERMINAL: readonly PurchaseState[] = ['completed', 'failed', 'cancelled', 'compensated'];
// A registered settlement intent already owns these purchases; funding
// evaluation never rewrites them.
const SETTLEMENT_OWNED: readonly PurchaseState[] = ['pending', 'recovery_required'];

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const nonnegativeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const finiteTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// Campaign times are simulated minutes: finite AND nonnegative (§2.1).
const nonnegativeTime = (v: unknown): v is number => finiteTime(v) && v >= 0;

// The retained campaign table must be exactly the well-formed terms an
// open_fund request committed — malformed terms are corrupted evidence,
// never a new reading: at least one positive safe-integer condition
// clause, finite ordered times and the fund-only mode/profile constants.
function termsWellFormed(t: unknown): t is CampaignTerms {
  if (!isRecord(t)) return false;
  if (!nonempty(t.purchaseId) || !nonempty(t.payeeId)) return false;
  if (!isRecord(t.condition)) return false;
  const clauses = [t.condition.minPayers, t.condition.minTotalCents].filter((v) => v !== undefined);
  if (clauses.length === 0 || !clauses.every(positiveInt)) return false;
  if (!nonnegativeTime(t.fundingEndsAt) || !nonnegativeTime(t.settleBy) || !(t.fundingEndsAt < t.settleBy)) return false;
  if (t.acceptPledgesUntil !== 'condition_met' && t.acceptPledgesUntil !== 'deadline') return false;
  if (t.submitPolicy !== 'on_request' && t.submitPolicy !== 'on_ready') return false;
  if (t.settlementMode !== 'atomic') return false;
  return t.privacyProfile === 'public_good_pledge_v1';
}

// The one verifier of a pledge's signed content and bindings, shared by
// pledge acceptance, retained-history validation and the read-only
// check_pledge — there is no second binding rule. It covers schema, the
// campaign binding (purchase, digest, payee, profile echo), the derived
// role, recognized rail and safe-integer amounts. Expiry finiteness is
// structural and checked here; the liveness windows differ per caller and
// live outside. Returns the refusal reason, undefined when the content is
// exactly what may have been signed.
function pledgeContentProblem(p: Record<string, unknown>, terms: CampaignTerms, campaignDigest: string): string | undefined {
  if (p.kind !== 'pledge') return 'pledge_malformed';
  // A pledge is not a SignedRequest: a supplied proposalVersion or
  // cancelUntil is refused, never reinterpreted as a roster binding or a
  // withdrawal grant.
  if ('proposalVersion' in p || 'cancelUntil' in p) return 'pledge_malformed';
  if (!nonempty(p.by) || !nonempty(p.pledgeRef)) return 'pledge_malformed';
  if (p.purchaseId !== terms.purchaseId) return 'campaign_terms_mismatch';
  if (p.campaignDigest !== campaignDigest) return 'campaign_terms_mismatch';
  if (p.privacyProfile !== 'public_good_pledge_v1') return 'campaign_terms_mismatch';
  const s = p.share;
  if (!isRecord(s)) return 'pledge_malformed';
  if (s.payerId !== p.by) return 'pledge_malformed';
  // The role is derived from the reference, never freely chosen — distinct
  // contributors can never collide on a settlement leg.
  if (s.role !== `pledge:${p.pledgeRef}`) return 'pledge_malformed';
  if (s.payeeId !== terms.payeeId) return 'campaign_terms_mismatch';
  if (!nonempty(s.rail) || !RAILS.includes(s.rail as Share['rail'])) return 'pledge_malformed';
  if (!positiveInt(s.amountCents)) return 'pledge_malformed';
  if (!nonnegativeInt(s.feeCents)) return 'pledge_malformed';
  if (!Number.isSafeInteger(s.amountCents + s.feeCents)) return 'pledge_malformed';
  if (!finiteTime(p.expiresAt)) return 'pledge_expiry_invalid';
  return undefined;
}

// The coordinator-applied materialization of one accepted pledge: its own
// complete signed share under 'payer' authority — never inferred fields.
function materializedShare(p: PledgeRequest): Share {
  return {
    role: `pledge:${p.pledgeRef}`,
    payerId: p.share.payerId,
    payeeId: p.share.payeeId,
    amountCents: p.share.amountCents,
    feeCents: p.share.feeCents,
    rail: p.share.rail,
    authority: 'payer',
  };
}

function shareMatches(a: DeepReadonly<Share> | undefined, b: Share): boolean {
  return (
    a !== undefined &&
    a.role === b.role &&
    a.payerId === b.payerId &&
    a.payeeId === b.payeeId &&
    a.amountCents === b.amountCents &&
    a.feeCents === b.feeCents &&
    a.rail === b.rail &&
    a.authority === b.authority
  );
}

// Byte-level equality of retained signed evidence: same key, same
// signature, same canonical payload.
function sameSignedPledge(a: Signed<PledgeRequest>, b: Signed<PledgeRequest>): boolean {
  try {
    return a.keyId === b.keyId && a.signature === b.signature && canonicalJson(a.payload) === canonicalJson(b.payload);
  } catch {
    return false;
  }
}

const pledgeRefOf = (a: DeepReadonly<Authorization>): string | undefined => {
  if (a.basis !== 'pledge' || !isRecord(a.pledge) || !isRecord(a.pledge.payload)) return undefined;
  return nonempty(a.pledge.payload.pledgeRef) ? a.pledge.payload.pledgeRef : undefined;
};

// The outcome of cross-checking the retained funding record against the
// coordinator-applied materializations — either the corruption problem or
// the verified active roster and its totals.
interface RosterCheck {
  problem?: string;
  active: DeepReadonly<AcceptedPledge>[];
  livePayers: number;
  liveTotalCents: Cents;
}

// Validates the retained funding record fail-closed: well-formed terms,
// the stored campaign digest recomputed, a verified campaign signature,
// structurally sound history with no duplicate references or payers, the
// binding of every retained pledge still intact, a current signature
// verdict for every active pledge (missing is invalid), and exact one-to-
// one share/authorization materializations — extras and lapsed-entry
// leftovers count as corruption.
function checkRetained(snapshot: FundingSnapshot, verified: FundingVerification): RosterCheck {
  const bad: RosterCheck = { problem: 'pledge_authority_invalid', active: [], livePayers: 0, liveTotalCents: 0 };
  const f = snapshot.funding;
  if (!isRecord(f) || !isRecord(f.campaign) || !isRecord(f.campaign.payload)) return bad;
  if (!termsWellFormed(f.terms)) return bad;
  const terms = f.terms;
  if (terms.purchaseId !== snapshot.purchaseId) return bad;
  if (!positiveInt(snapshot.proposalVersion)) return bad;
  if (!nonempty(f.campaignDigest)) return bad;
  try {
    if (campaignDigestOf(terms) !== f.campaignDigest) return bad;
  } catch {
    return bad;
  }
  if (f.phase !== 'collecting' && f.phase !== 'closed' && f.phase !== 'admitted') return bad;
  if (!Array.isArray(f.history)) return bad;
  if (verified?.campaignValid !== true) return bad;
  if (!Array.isArray(snapshot.shares) || !Array.isArray(snapshot.authorizations)) return bad;

  const refs = new Set<string>();
  const payers = new Set<string>();
  const active: DeepReadonly<AcceptedPledge>[] = [];
  let liveTotalCents = 0;
  for (const e of f.history) {
    if (!isRecord(e) || (e.outcome !== 'active' && e.outcome !== 'lapsed')) return bad;
    const signed = e.signed;
    if (!isRecord(signed) || !nonempty(signed.keyId) || !nonempty(signed.signature) || !isRecord(signed.payload)) return bad;
    const p = signed.payload;
    if (!nonempty(p.pledgeRef) || !nonempty(p.by)) return bad;
    // One accepted pledge per reference and per payer, ever — lapsed
    // history still bars a second pledge from the same payer.
    if (refs.has(p.pledgeRef) || payers.has(p.by)) return bad;
    refs.add(p.pledgeRef);
    payers.add(p.by);
    if (!nonempty(e.canonicalPayload)) return bad;
    try {
      if (canonicalJson(p) !== e.canonicalPayload) return bad;
    } catch {
      return bad;
    }
    const ack = e.acknowledgment;
    if (
      !isRecord(ack) ||
      ack.purchaseId !== snapshot.purchaseId ||
      ack.pledgeRef !== p.pledgeRef ||
      !finiteTime(ack.acceptedAt) ||
      !positiveInt(ack.proposalVersion)
    ) {
      return bad;
    }
    // The retained content must still bind the campaign it was accepted
    // under — the same verifier acceptance and check_pledge share. A
    // retained expiry past settleBy was never acceptable evidence either.
    if (pledgeContentProblem(p, terms, f.campaignDigest) !== undefined) return bad;
    const payload = p as unknown as PledgeRequest;
    if (payload.expiresAt > terms.settleBy) return bad;
    // A 'deadline' pledge was only ever acceptable with an expiry beyond
    // the cutoff; a retained entry that fails it is corrupted evidence.
    if (terms.acceptPledgesUntil === 'deadline' && payload.expiresAt <= terms.fundingEndsAt) return bad;
    const role = `pledge:${p.pledgeRef}`;
    if (e.outcome === 'active') {
      if (verified.retained?.get(p.pledgeRef) !== true) return bad;
      const shares = snapshot.shares.filter((s) => s.role === role);
      if (shares.length !== 1 || !shareMatches(shares[0], materializedShare(payload))) return bad;
      const auths = snapshot.authorizations.filter((a) => pledgeRefOf(a) === p.pledgeRef);
      if (auths.length !== 1 || auths[0].basis !== 'pledge' || !sameSignedPledge(auths[0].pledge, signed as Signed<PledgeRequest>)) {
        return bad;
      }
      active.push(e);
      liveTotalCents += payload.share.amountCents;
      if (!Number.isSafeInteger(liveTotalCents)) return bad;
    } else {
      // A lapsed pledge retains acceptance history only: no materialized
      // share or authorization may survive it.
      if (snapshot.shares.some((s) => s.role === role)) return bad;
      if (snapshot.authorizations.some((a) => pledgeRefOf(a) === p.pledgeRef)) return bad;
    }
  }
  if (snapshot.shares.length !== active.length || snapshot.authorizations.length !== active.length) return bad;
  return { active, livePayers: active.length, liveTotalCents };
}

// Distinct live payers with positive principal and their principal sum —
// fees never count toward the condition. Totals are already safe (checked
// on the way in), and lapse only shrinks the roster.
function rosterTotals(active: readonly DeepReadonly<AcceptedPledge>[]): { livePayers: number; liveTotalCents: Cents } {
  let liveTotalCents = 0;
  for (const e of active) liveTotalCents += e.signed.payload.share.amountCents;
  return { livePayers: active.length, liveTotalCents };
}

// Both condition clauses mean OR: either suffices.
function progressOf(terms: CampaignTerms, livePayers: number, liveTotalCents: Cents): FundingState['progress'] {
  const c = terms.condition;
  const met =
    (c.minPayers !== undefined && livePayers >= c.minPayers) ||
    (c.minTotalCents !== undefined && liveTotalCents >= c.minTotalCents);
  return { livePayers, liveTotalCents, met };
}

// Marks every active pledge whose personal expiry has passed 'lapsed' in
// the cloned history — the batch the caller bills as ONE version bump.
// Acceptance history, acknowledgment and evidence are retained; only the
// outcome flag changes.
function lapseExpired(funding: FundingState, now: number): AcceptedPledge[] {
  const lapsed: AcceptedPledge[] = [];
  for (const e of funding.history) {
    if (e.outcome === 'active' && now > e.signed.payload.expiresAt) {
      e.outcome = 'lapsed';
      lapsed.push(e);
    }
  }
  return lapsed;
}

// The roster materializations an apply decision hands the coordinator:
// exactly the active entries, in acceptance order.
function apply(
  funding: FundingState,
  versionDelta: number,
  state: PurchaseState,
  events: { event: string; detail: Record<string, unknown> }[],
  extra?: { failureReason?: string; accepted?: PledgeAcceptance },
): FundingDecision {
  const active = funding.history.filter((e) => e.outcome === 'active');
  return {
    kind: 'apply',
    funding,
    shares: active.map((e) => materializedShare(e.signed.payload)),
    authorizations: active.map((e) => ({ basis: 'pledge', pledge: structuredClone(e.signed) })),
    versionDelta,
    state,
    events,
    ...extra,
  };
}

// A whole-purchase failure over a detached clone of the retained funding
// state — the roster is never pruned or substituted on the failure path.
function purchaseFailure(snapshot: FundingSnapshot, funding: FundingState, reason: string): FundingDecision {
  return apply(funding, 0, 'failed', [{ event: 'funding_failed', detail: { purchaseId: snapshot.purchaseId, reason } }], {
    failureReason: reason,
  });
}

// The collecting-phase resolution after lapse/append on a cloned funding
// state: recompute progress, emit the evaluation, then resolve in order —
// settlement-expiry failure, condition_met early close, cutoff close.
function finishCollectingEvaluation(
  snapshot: FundingSnapshot,
  funding: FundingState,
  now: number,
  versionDelta: number,
  events: { event: string; detail: Record<string, unknown> }[],
  accepted?: PledgeAcceptance,
): FundingDecision {
  const terms = funding.terms;
  const totals = rosterTotals(funding.history.filter((e) => e.outcome === 'active'));
  funding.progress = progressOf(terms, totals.livePayers, totals.liveTotalCents);
  events.push({
    event: 'funding_evaluated',
    detail: {
      purchaseId: snapshot.purchaseId,
      met: funding.progress.met,
      livePayers: totals.livePayers,
      liveTotalCents: totals.liveTotalCents,
      proposalVersion: snapshot.proposalVersion + versionDelta,
    },
  });
  let state: PurchaseState = 'awaiting_approvals';
  let failureReason: string | undefined;
  const succeeded = () =>
    events.push({
      event: 'funding_succeeded',
      detail: { purchaseId: snapshot.purchaseId, livePayers: totals.livePayers, liveTotalCents: totals.liveTotalCents },
    });
  if (now > terms.settleBy) {
    // Evaluation ran past the settlement deadline: nothing may be
    // admitted, even if funding previously appeared sufficient.
    state = 'failed';
    failureReason = 'funding_settlement_expired';
    events.push({ event: 'funding_failed', detail: { purchaseId: snapshot.purchaseId, reason: failureReason } });
  } else if (terms.acceptPledgesUntil === 'condition_met' && funding.progress.met) {
    // The roster closes irreversibly at the pledge that tips the
    // condition; under 'deadline' an early met condition is progress only.
    funding.phase = 'closed';
    state = 'ready';
    succeeded();
  } else if (now >= terms.fundingEndsAt) {
    if (funding.progress.met) {
      funding.phase = 'closed';
      state = 'ready';
      succeeded();
    } else {
      // An unmet condition at cutoff — including an empty roster — fails
      // with no money effects.
      state = 'failed';
      failureReason = 'funding_condition_unmet';
      events.push({ event: 'funding_failed', detail: { purchaseId: snapshot.purchaseId, reason: failureReason } });
    }
  }
  return apply(funding, versionDelta, state, events, { failureReason, accepted });
}

// Closed-phase revalidation: the roster is frozen — membership, amounts
// and version never change. Settlement expiry, any retained expiry
// (signature, binding and materialization already ran in checkRetained)
// or an unmet condition fails the WHOLE purchase even when a smaller
// roster could still meet the condition. settleBy precedes per-pledge
// expiry because a valid expiry can never outlive it: past the window,
// the campaign-level failure is what happened.
function evaluateClosed(snapshot: FundingSnapshot, check: RosterCheck, now: number): FundingDecision {
  const funding = structuredClone(snapshot.funding) as FundingState;
  const terms = funding.terms;
  if (now > terms.settleBy) return purchaseFailure(snapshot, funding, 'funding_settlement_expired');
  for (const e of check.active) {
    if (now > e.signed.payload.expiresAt) return purchaseFailure(snapshot, funding, 'pledge_expired');
  }
  const progress = progressOf(terms, check.livePayers, check.liveTotalCents);
  funding.progress = progress;
  if (!progress.met) return purchaseFailure(snapshot, funding, 'funding_condition_unmet');
  return apply(funding, 0, 'ready', [
    {
      event: 'funding_evaluated',
      detail: {
        purchaseId: snapshot.purchaseId,
        met: true,
        livePayers: check.livePayers,
        liveTotalCents: check.liveTotalCents,
        proposalVersion: snapshot.proposalVersion,
      },
    },
  ]);
}

function decideEvaluate(snapshot: FundingSnapshot, now: number, verified: FundingVerification): FundingDecision {
  const f = snapshot.funding;
  if (!isRecord(f) || !isRecord(f.terms) || !Array.isArray(f.history)) return { kind: 'refused', reason: 'not_a_fund' };
  // Admitted and terminal purchases are no-ops: settlement owns the
  // outcome and evidence is retained, never re-derived or pruned.
  if (f.phase === 'admitted' || TERMINAL.includes(snapshot.purchaseState) || SETTLEMENT_OWNED.includes(snapshot.purchaseState)) {
    return { kind: 'unchanged' };
  }
  const check = checkRetained(snapshot, verified);
  if (check.problem !== undefined) {
    // Corrupted retained evidence is a whole-purchase failure, never a
    // contribution toward a threshold.
    return purchaseFailure(snapshot, structuredClone(snapshot.funding) as FundingState, check.problem);
  }
  // Phase and purchase state must agree — a collecting fund is still
  // 'awaiting_approvals', a closed one 'ready' (the same bindings the
  // pledge and admit commands require). A snapshot that disagrees is
  // inconsistent coordinator-applied evidence: fail closed rather than
  // let evaluation upgrade the purchase to a state it never earned.
  const expectedState: PurchaseState = f.phase === 'collecting' ? 'awaiting_approvals' : 'ready';
  if (snapshot.purchaseState !== expectedState) {
    return purchaseFailure(snapshot, structuredClone(snapshot.funding) as FundingState, 'pledge_authority_invalid');
  }
  if (f.phase === 'collecting') {
    const funding = structuredClone(snapshot.funding) as FundingState;
    const lapsed = lapseExpired(funding, now);
    const events = lapsed.map((e) => ({
      event: 'pledge_lapsed',
      detail: { purchaseId: snapshot.purchaseId, pledgeRef: e.signed.payload.pledgeRef, payerId: e.signed.payload.by },
    }));
    // One version bump per lapse batch, however many pledges expired.
    return finishCollectingEvaluation(snapshot, funding, now, lapsed.length > 0 ? 1 : 0, events);
  }
  return evaluateClosed(snapshot, check, now);
}

function decideAdmit(snapshot: FundingSnapshot, now: number, verified: FundingVerification): FundingDecision {
  const f = snapshot.funding;
  if (!isRecord(f) || !Array.isArray(f.history)) return { kind: 'refused', reason: 'not_a_fund' };
  // Admission is exactly the closed+ready gate; a rollback may restore
  // 'closed' for another attempt but never reopens collection.
  if (f.phase !== 'closed' || snapshot.purchaseState !== 'ready') return { kind: 'refused', reason: 'funding_not_closed' };
  const funding = structuredClone(snapshot.funding) as FundingState;
  const check = checkRetained(snapshot, verified);
  if (check.problem !== undefined) return purchaseFailure(snapshot, funding, check.problem);
  if (now > funding.terms.settleBy) return purchaseFailure(snapshot, funding, 'funding_settlement_expired');
  for (const e of check.active) {
    if (now > e.signed.payload.expiresAt) return purchaseFailure(snapshot, funding, 'pledge_expired');
  }
  const progress = progressOf(funding.terms, check.livePayers, check.liveTotalCents);
  funding.progress = progress;
  if (!progress.met) return purchaseFailure(snapshot, funding, 'funding_condition_unmet');
  // The intent freezes: phase becomes admitted without a proposal-version
  // change and settlement owns the outcome from here. The purchase stays
  // 'ready' until the first settlement snapshot arrives.
  funding.phase = 'admitted';
  return apply(funding, 0, 'ready', [
    {
      event: 'funding_evaluated',
      detail: {
        purchaseId: snapshot.purchaseId,
        met: true,
        livePayers: check.livePayers,
        liveTotalCents: check.liveTotalCents,
        proposalVersion: snapshot.proposalVersion,
      },
    },
  ]);
}

// The read-only revalidation check_pledge performs on a retained pledge
// and its exact materialized share — the same binding rule admission and
// first handoff reuse. It never evaluates, lapses or applies.
function decideCheckPledge(
  snapshot: FundingSnapshot,
  pledgeRef: string,
  share: DeepReadonly<Share>,
  now: number,
  verified: FundingVerification,
): FundingDecision {
  const f = snapshot.funding;
  if (!isRecord(f) || !isRecord(f.terms) || !Array.isArray(f.history)) return { kind: 'refused', reason: 'not_a_fund' };
  const check = checkRetained(snapshot, verified);
  if (check.problem !== undefined) return { kind: 'refused', reason: check.problem };
  const entry = f.history.find((e) => e.signed.payload.pledgeRef === pledgeRef);
  if (entry === undefined) return { kind: 'refused', reason: 'pledge_authority_invalid' };
  // A lapsed pledge has no live authority left, whatever its expiry says.
  if (entry.outcome !== 'active') return { kind: 'refused', reason: 'pledge_expired' };
  if (!shareMatches(share, materializedShare(entry.signed.payload))) return { kind: 'refused', reason: 'pledge_authority_invalid' };
  // First handoff requires the same live window as admission; a valid
  // expiry never outlives settleBy, so the window is reported first.
  if (now > f.terms.settleBy) return { kind: 'refused', reason: 'funding_settlement_expired' };
  if (now > entry.signed.payload.expiresAt) return { kind: 'refused', reason: 'pledge_expired' };
  return { kind: 'unchanged' };
}

function decidePledge(
  snapshot: FundingSnapshot,
  signed: Signed<PledgeRequest>,
  now: number,
  verified: FundingVerification,
): FundingDecision {
  // Signature first: an unverifiable or never-verified request is refused
  // before any replay lookup — a plausible payload cannot launder a bad
  // signature through replay.
  if (verified?.incomingValid !== true) return { kind: 'refused', reason: 'pledge_authority_invalid' };
  const p: unknown = signed?.payload;
  if (!isRecord(p)) return { kind: 'refused', reason: 'pledge_malformed' };
  // Forbidden envelope fields precede the replay lookup: a pledge carries
  // neither a roster binding (proposalVersion) nor a withdrawal grant
  // (cancelUntil).
  if ('proposalVersion' in p || 'cancelUntil' in p) return { kind: 'refused', reason: 'pledge_malformed' };
  let canonical: string;
  try {
    canonical = canonicalJson(p);
  } catch {
    return { kind: 'refused', reason: 'pledge_malformed' };
  }
  const f = snapshot.funding;
  if (!isRecord(f) || !isRecord(f.terms) || !Array.isArray(f.history)) return { kind: 'refused', reason: 'not_a_fund' };
  // Replay and reference conflict are decided on the accepted canonical
  // payload before every live-roster, binding and expiry check — an exact
  // replay bypasses expiry, closure and evaluation, while the same
  // reference over different bytes is a conflict even when the changed
  // field would independently mismatch the campaign.
  if (nonempty(p.pledgeRef)) {
    const prior = f.history.find(
      (e) => isRecord(e) && isRecord(e.signed) && isRecord(e.signed.payload) && e.signed.payload.pledgeRef === p.pledgeRef,
    );
    if (prior !== undefined) {
      return prior.canonicalPayload === canonical
        ? { kind: 'replay', acknowledgment: structuredClone(prior.acknowledgment) }
        : { kind: 'refused', reason: 'pledge_ref_conflict' };
    }
  }
  const problem = pledgeContentProblem(p, f.terms, nonempty(f.campaignDigest) ? f.campaignDigest : '');
  if (problem !== undefined) return { kind: 'refused', reason: problem };
  const request = p as unknown as PledgeRequest;
  // One pledge per payer per campaign, lapsed history included — top-ups
  // and replacements do not exist.
  if (f.history.some((e) => isRecord(e) && isRecord(e.signed) && isRecord(e.signed.payload) && e.signed.payload.by === request.by)) {
    return { kind: 'refused', reason: 'payer_already_pledged' };
  }
  // A new pledge is accepted only while a live collecting roster is open.
  if (f.phase !== 'collecting' || snapshot.purchaseState !== 'awaiting_approvals' || !(now < f.terms.fundingEndsAt)) {
    return { kind: 'refused', reason: 'roster_closed' };
  }
  // The single personal expiry: strictly after acceptance and never past
  // settleBy; a 'deadline' pledge must also outlive the cutoff it can
  // survive into. A refusal leaves the reference free.
  if (!(request.expiresAt > now)) return { kind: 'refused', reason: 'pledge_expired' };
  if (request.expiresAt > f.terms.settleBy) return { kind: 'refused', reason: 'pledge_expiry_invalid' };
  if (f.terms.acceptPledgesUntil === 'deadline' && request.expiresAt <= f.terms.fundingEndsAt) {
    return { kind: 'refused', reason: 'pledge_expiry_invalid' };
  }
  // The appended roster sum must stay a safe integer — checked before any
  // lapse, append or retained validation, so a refusal can never mutate.
  // Only structurally sound entries feed the arithmetic; anything else is
  // corrupted retained evidence left for checkRetained to fail the whole
  // purchase, rather than a malformed-looking new pledge.
  let projected = request.share.amountCents;
  for (const e of f.history) {
    if (
      isRecord(e) &&
      e.outcome === 'active' &&
      isRecord(e.signed) &&
      isRecord(e.signed.payload) &&
      isRecord(e.signed.payload.share) &&
      Number.isSafeInteger(e.signed.payload.share.amountCents)
    ) {
      projected += e.signed.payload.share.amountCents;
    }
  }
  if (!Number.isSafeInteger(projected)) return { kind: 'refused', reason: 'pledge_malformed' };
  // Retained evidence validates only for a new valid mutation: corrupted
  // evidence fails the whole purchase rather than accepting more pledges.
  const check = checkRetained(snapshot, verified);
  if (check.problem !== undefined) {
    return purchaseFailure(snapshot, structuredClone(snapshot.funding) as FundingState, check.problem);
  }
  const funding = structuredClone(snapshot.funding) as FundingState;
  // Lapse expired entries first, then append — one bump for the lapse
  // batch, one more for the append, and no closure in between.
  const lapsed = lapseExpired(funding, now);
  const events = lapsed.map((e) => ({
    event: 'pledge_lapsed',
    detail: { purchaseId: snapshot.purchaseId, pledgeRef: e.signed.payload.pledgeRef, payerId: e.signed.payload.by },
  }));
  let versionDelta = lapsed.length > 0 ? 1 : 0;
  versionDelta += 1;
  if (!Number.isSafeInteger(snapshot.proposalVersion + versionDelta)) return { kind: 'refused', reason: 'pledge_malformed' };
  const acceptance: PledgeAcceptance = {
    purchaseId: snapshot.purchaseId,
    pledgeRef: request.pledgeRef,
    acceptedAt: now,
    proposalVersion: snapshot.proposalVersion + versionDelta,
  };
  funding.history.push({
    signed: structuredClone(signed),
    canonicalPayload: canonical,
    acknowledgment: structuredClone(acceptance),
    outcome: 'active',
  });
  events.push({
    event: 'pledge_recorded',
    detail: {
      purchaseId: snapshot.purchaseId,
      pledgeRef: request.pledgeRef,
      payerId: request.by,
      amountCents: request.share.amountCents,
      feeCents: request.share.feeCents,
      expiresAt: request.expiresAt,
      proposalVersion: acceptance.proposalVersion,
    },
  });
  // The combined roster is evaluated exactly once, after the append.
  return finishCollectingEvaluation(snapshot, funding, now, versionDelta, events, acceptance);
}

// The funding module's whole interface: one pure decision over a detached
// snapshot. 'refused' leaves everything untouched; 'replay' returns the
// original acknowledgment inertly; 'unchanged' reports a no-op or a valid
// read-only check; 'apply' carries the complete replacement the
// coordinator writes once.
export function decideFunding(
  snapshot: FundingSnapshot,
  command: FundingCommand,
  now: number,
  verified: FundingVerification,
): FundingDecision {
  if (!isRecord(snapshot) || !isRecord(command) || !Number.isFinite(now)) return { kind: 'refused', reason: 'malformed_command' };
  switch (command.kind) {
    case 'pledge':
      return decidePledge(snapshot, command.signed, now, verified);
    case 'evaluate':
      return decideEvaluate(snapshot, now, verified);
    case 'admit':
      return decideAdmit(snapshot, now, verified);
    case 'check_pledge':
      return decideCheckPledge(snapshot, command.pledgeRef, command.share, now, verified);
    default:
      return { kind: 'refused', reason: 'malformed_command' };
  }
}
