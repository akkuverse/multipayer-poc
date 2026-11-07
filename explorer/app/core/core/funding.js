// GENERATED from src/core/funding.ts — type-stripped build artifact; never hand-edit.
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

import { campaignDigestOf, canonicalJson } from './signing.js';
                                           
import {
  RAILS,
                      
                     
                     
             
                    
                    
                        
                     
                     
             
} from './types.js';

// Everything a funding decision needs, detached from the purchase record:
// the funding phase/history the module owns plus the coordinator-applied
// materializations (shares, authorizations) it cross-checks against that
// history. proposalVersion is the committed roster version the next
// lapse/append bumps from.
                                  
                     
                               
                          
                                      
                                         
                                                         
 

// 'pledge' records a signed contribution; 'evaluate' applies the already
// signed terms to the current clock (it grants no new spending authority);
// 'admit' is the ready→admitted gate settlement runs before freezing the
// intent; 'check_pledge' is read-only revalidation of one retained pledge
// and its exact materialized share — the same binding rule reused by the
// authorizationCurrentlyValid and firstHandoffRefusal callers.
                            
                                                     
                        
                     
                                                                            

// Verdicts the caller computed with its own verified read: the retained
// campaign signature, every still-active retained pledge's signature keyed
// by pledgeRef, and — for a pledge command — the incoming signature. A
// missing verdict is invalid: the decision fails closed, never assumes.
                                      
                         
                                         
                          
 

                             
                                                                      
                
                                       
                                                                  
                                                                      
                                                                        
                                                                  
                                                        
                                                                          
                        
                         
                                                                          
                                                                          
                                                                      
                                                                 
                                                               
     
                    
                            
                      
                                      
                           
                           
                             
                                  
                                                                   
      

// Terminal states retain evidence and outcomes; funding decisions are
// inert on them.
const TERMINAL                           = ['completed', 'failed', 'cancelled', 'compensated'];
// A registered settlement intent already owns these purchases; funding
// evaluation never rewrites them.
const SETTLEMENT_OWNED                           = ['pending', 'recovery_required'];

const isRecord = (v         )                               => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v         )              => typeof v === 'string' && v.length > 0;
const positiveInt = (v         )              => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const nonnegativeInt = (v         )              => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const finiteTime = (v         )              => typeof v === 'number' && Number.isFinite(v);
// Campaign times are simulated minutes: finite AND nonnegative (§2.1).
const nonnegativeTime = (v         )              => finiteTime(v) && v >= 0;

// The retained campaign table must be exactly the well-formed terms an
// open_fund request committed — malformed terms are corrupted evidence,
// never a new reading: at least one positive safe-integer condition
// clause, finite ordered times and the fund-only mode/profile constants.
// Exported: the coordinator's opening entry point and the privacy layer's
// retained-terms validation share this one rule — there is no second
// campaign-terms schema.
export function campaignTermsWellFormed(t         )                     {
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
function pledgeContentProblem(p                         , terms               , campaignDigest        )                     {
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
  if (!nonempty(s.rail) || !RAILS.includes(s.rail                 )) return 'pledge_malformed';
  if (!positiveInt(s.amountCents)) return 'pledge_malformed';
  if (!nonnegativeInt(s.feeCents)) return 'pledge_malformed';
  if (!Number.isSafeInteger(s.amountCents + s.feeCents)) return 'pledge_malformed';
  if (!finiteTime(p.expiresAt)) return 'pledge_expiry_invalid';
  return undefined;
}

// Signature-free retained content validation, shared with the privacy
// projection. Signature verdicts, current liveness and materializations
// remain checks of the funding decision; reads never evaluate or lapse.
export function retainedPledgeWellFormed(e         , terms               , campaignDigest        )                                    {
  if (!isRecord(e) || (e.outcome !== 'active' && e.outcome !== 'lapsed')) return false;
  const signed = e.signed;
  if (!isRecord(signed) || !nonempty(signed.keyId) || !nonempty(signed.signature) || !isRecord(signed.payload)) return false;
  const p = signed.payload;
  if (pledgeContentProblem(p, terms, campaignDigest) !== undefined) return false;
  const payload = p                            ;
  if (payload.expiresAt > terms.settleBy) return false;
  if (terms.acceptPledgesUntil === 'deadline' && payload.expiresAt <= terms.fundingEndsAt) return false;
  if (!nonempty(e.canonicalPayload)) return false;
  try {
    if (canonicalJson(p) !== e.canonicalPayload) return false;
  } catch {
    return false;
  }
  const ack = e.acknowledgment;
  return isRecord(ack) && ack.purchaseId === terms.purchaseId && ack.pledgeRef === p.pledgeRef &&
    finiteTime(ack.acceptedAt) && positiveInt(ack.proposalVersion);
}

// The coordinator-applied materialization of one accepted pledge: its own
// complete signed share under 'payer' authority — never inferred fields.
function materializedShare(p               )        {
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

function shareMatches(a                                 , b       )          {
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
function sameSignedPledge(a                       , b                       )          {
  try {
    return a.keyId === b.keyId && a.signature === b.signature && canonicalJson(a.payload) === canonicalJson(b.payload);
  } catch {
    return false;
  }
}

const pledgeRefOf = (a                             )                     => {
  if (a.basis !== 'pledge' || !isRecord(a.pledge) || !isRecord(a.pledge.payload)) return undefined;
  return nonempty(a.pledge.payload.pledgeRef) ? a.pledge.payload.pledgeRef : undefined;
};

// The outcome of cross-checking the retained funding record against the
// coordinator-applied materializations — either the corruption problem or
// the verified active roster and its totals.
                       
                   
                                         
                     
                        
 

// Validates the retained funding record fail-closed: well-formed terms,
// the stored campaign digest recomputed, a verified campaign signature,
// structurally sound history with no duplicate references or payers, the
// binding of every retained pledge still intact, a current signature
// verdict for every active pledge (missing is invalid), and exact one-to-
// one share/authorization materializations — extras and lapsed-entry
// leftovers count as corruption.
function checkRetained(snapshot                 , verified                     )              {
  const bad              = { problem: 'pledge_authority_invalid', active: [], livePayers: 0, liveTotalCents: 0 };
  const f = snapshot.funding;
  if (!isRecord(f) || !isRecord(f.campaign) || !isRecord(f.campaign.payload)) return bad;
  if (!campaignTermsWellFormed(f.terms)) return bad;
  const terms = f.terms;
  if (terms.purchaseId !== snapshot.purchaseId) return bad;
  if (!positiveInt(snapshot.proposalVersion)) return bad;
  if (!nonempty(f.campaignDigest)) return bad;
  const opening = f.campaign.payload;
  if (!campaignTermsWellFormed(opening) || opening.kind !== 'open_fund' || opening.proposalVersion !== 1 || opening.by !== terms.payeeId) return bad;
  try {
    // Opening retains only the two supported condition clauses. Signed
    // extra fields are ignored there, so use that same table here.
    const signedTerms = { ...opening, condition: { minPayers: opening.condition.minPayers, minTotalCents: opening.condition.minTotalCents } };
    if (campaignDigestOf(terms) !== f.campaignDigest || campaignDigestOf(signedTerms) !== f.campaignDigest) return bad;
  } catch {
    return bad;
  }
  if (f.phase !== 'collecting' && f.phase !== 'closed' && f.phase !== 'admitted') return bad;
  if (!Array.isArray(f.history)) return bad;
  if (verified?.campaignValid !== true) return bad;
  if (!Array.isArray(snapshot.shares) || !Array.isArray(snapshot.authorizations)) return bad;

  const refs = new Set        ();
  const payers = new Set        ();
  const active                                 = [];
  let liveTotalCents = 0;
  for (const e of f.history) {
    if (!retainedPledgeWellFormed(e, terms, f.campaignDigest)) return bad;
    const signed = e.signed;
    const p = signed.payload;
    // One accepted pledge per reference and per payer, ever — lapsed
    // history still bars a second pledge from the same payer.
    if (refs.has(p.pledgeRef) || payers.has(p.by)) return bad;
    refs.add(p.pledgeRef);
    payers.add(p.by);
    const payload = p                            ;
    const role = `pledge:${p.pledgeRef}`;
    if (e.outcome === 'active') {
      if (verified.retained?.get(p.pledgeRef) !== true) return bad;
      const shares = snapshot.shares.filter((s) => s.role === role);
      if (shares.length !== 1 || !shareMatches(shares[0], materializedShare(payload))) return bad;
      const auths = snapshot.authorizations.filter((a) => pledgeRefOf(a) === p.pledgeRef);
      if (auths.length !== 1 || auths[0].basis !== 'pledge' || !sameSignedPledge(auths[0].pledge, signed                         )) {
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
function rosterTotals(active                                         )                                                {
  let liveTotalCents = 0;
  for (const e of active) liveTotalCents += e.signed.payload.share.amountCents;
  return { livePayers: active.length, liveTotalCents };
}

// Both condition clauses mean OR: either suffices.
function progressOf(terms               , livePayers        , liveTotalCents       )                           {
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
function lapseExpired(funding              , now        )                   {
  const lapsed                   = [];
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
  funding              ,
  versionDelta        ,
  state               ,
  events                                                      ,
  extra                                                          ,
)                  {
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
function purchaseFailure(snapshot                 , funding              , reason        )                  {
  // Validation may have rejected structurally broken history. Preserve
  // the applied evidence without interpreting that history a second time.
  return {
    kind: 'apply',
    funding,
    shares: structuredClone(snapshot.shares)           ,
    authorizations: structuredClone(snapshot.authorizations)                   ,
    versionDelta: 0,
    state: 'failed',
    events: [{ event: 'funding_failed', detail: { purchaseId: snapshot.purchaseId, reason } }],
    failureReason: reason,
  };
}

// The collecting-phase resolution after lapse/append on a cloned funding
// state: recompute progress, emit the evaluation, then resolve in order —
// settlement-expiry failure, condition_met early close, cutoff close.
function finishCollectingEvaluation(
  snapshot                 ,
  funding              ,
  now        ,
  versionDelta        ,
  events                                                      ,
  accepted                   ,
)                  {
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
  let state                = 'awaiting_approvals';
  let failureReason                    ;
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
function evaluateClosed(snapshot                 , check             , now        )                  {
  const funding = structuredClone(snapshot.funding)                ;
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

function decideEvaluate(snapshot                 , now        , verified                     )                  {
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
    return purchaseFailure(snapshot, structuredClone(snapshot.funding)                , check.problem);
  }
  // Phase and purchase state must agree — a collecting fund is still
  // 'awaiting_approvals', a closed one 'ready' (the same bindings the
  // pledge and admit commands require). A snapshot that disagrees is
  // inconsistent coordinator-applied evidence: fail closed rather than
  // let evaluation upgrade the purchase to a state it never earned.
  const expectedState                = f.phase === 'collecting' ? 'awaiting_approvals' : 'ready';
  if (snapshot.purchaseState !== expectedState) {
    return purchaseFailure(snapshot, structuredClone(snapshot.funding)                , 'pledge_authority_invalid');
  }
  if (f.phase === 'collecting') {
    const funding = structuredClone(snapshot.funding)                ;
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

function decideAdmit(snapshot                 , now        , verified                     )                  {
  const f = snapshot.funding;
  if (!isRecord(f) || !Array.isArray(f.history)) return { kind: 'refused', reason: 'not_a_fund' };
  // Admission is exactly the closed+ready gate; a rollback may restore
  // 'closed' for another attempt but never reopens collection.
  if (f.phase !== 'closed' || snapshot.purchaseState !== 'ready') return { kind: 'refused', reason: 'funding_not_closed' };
  const funding = structuredClone(snapshot.funding)                ;
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
  snapshot                 ,
  pledgeRef        ,
  share                     ,
  now        ,
  verified                     ,
)                  {
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
  snapshot                 ,
  signed                       ,
  now        ,
  verified                     ,
)                  {
  // Signature first: an unverifiable or never-verified request is refused
  // before any replay lookup — a plausible payload cannot launder a bad
  // signature through replay.
  if (verified?.incomingValid !== true) return { kind: 'refused', reason: 'pledge_authority_invalid' };
  const p          = signed?.payload;
  if (!isRecord(p)) return { kind: 'refused', reason: 'pledge_malformed' };
  // Forbidden envelope fields precede the replay lookup: a pledge carries
  // neither a roster binding (proposalVersion) nor a withdrawal grant
  // (cancelUntil).
  if ('proposalVersion' in p || 'cancelUntil' in p) return { kind: 'refused', reason: 'pledge_malformed' };
  let canonical        ;
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
  const request = p                            ;
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
  // Retained evidence validates only for a new valid mutation: corrupted
  // evidence fails the whole purchase rather than accepting more pledges.
  const check = checkRetained(snapshot, verified);
  if (check.problem !== undefined) {
    return purchaseFailure(snapshot, structuredClone(snapshot.funding)                , check.problem);
  }
  // Validate the resulting live roster before cloning or applying any
  // lapse. Expired history contributes no principal to the new roster;
  // a real overflow still refuses without changing history or version.
  let projected = request.share.amountCents;
  for (const e of check.active) {
    if (now <= e.signed.payload.expiresAt) projected += e.signed.payload.share.amountCents;
    if (!Number.isSafeInteger(projected)) return { kind: 'refused', reason: 'pledge_malformed' };
  }
  const funding = structuredClone(snapshot.funding)                ;
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
  const acceptance                   = {
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
  snapshot                 ,
  command                ,
  now        ,
  verified                     ,
)                  {
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
