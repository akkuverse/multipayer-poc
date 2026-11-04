// The scripted synthetic presenter: two workshop journeys — changed offer /
// pending settlement, and lost employer contribution — each replayed in a
// fresh world through the shared session logic. Scripted mode hands the
// fixed script to the agent handle; manual mode drives the same steps
// through the trusted handle, like a conventional filter-and-checkout. Both
// require the same explicit user approvals and produce the same conversation.
//
// Every conversation message carries a deterministic id, role, permitted
// recipient, authority class, text rendered from structured claims and the
// trace sequences that evidence it — and is itself appended to the trace as
// a presenter_message event, so the run digest covers what was shown, not
// only what settled. This artifact is a scripted synthetic presenter: it is
// no evidence of live model reasoning or consumer preference.

import { advance, approveAs, updateEmployeeMandate, updateMandate, world, legChildKey, AUTO_EMPLOYEE_TERMS, EMPLOYEE, EMPLOYER, MERCHANT_C } from '../scenarios.ts';
import type { World } from '../scenarios.ts';
import { signPayload } from '../core/signing.ts';
import { createPresenterSession } from './session.ts';
import type {
  AgentGrant,
  AgentPresenter,
  OfferView,
  PresenterRunner,
  PresenterUserFlow,
  PresenterView,
  QuoteView,
  SafeReason,
} from './session.ts';
import {
  AUTO_CATALOG,
  AUTO_SCRIPT,
  OFFER_A,
  OFFER_AUTO_A,
  OFFER_AUTO_B,
  OFFER_B,
  OFFER_C,
  PRESENTER_CATALOG,
  PRESENTER_FIXTURE_VERSION,
  PRESENTER_SCRIPT,
} from './fixtures.ts';
import { recordRun } from '../evidence/run-record.ts';
import type { RunRecord } from '../evidence/run-record.ts';
import { euro } from '../evidence/trace.ts';
import type { Authorization, AuthZone, AutoPayBlockedReason, Cents, LegStatus, PurchaseState } from '../core/types.ts';

export type JourneyId = 'changed-offer' | 'funding-loss';
export type DeliveryMode = 'scripted' | 'manual';
export type MessageRole = 'user' | 'assistant';
// The only parties a message may be addressed to: the employee whose
// instruction this session carries, or the presenter surface they talk to.
export type MessageRecipient = 'employee' | 'assistant';
export type AuthorityClass = 'user_instruction' | 'user_approval' | 'information_only' | 'status_report';

export const PRESENTER_JOURNEYS: readonly JourneyId[] = ['changed-offer', 'funding-loss'];
export const PRESENTER_MODES: readonly DeliveryMode[] = ['scripted', 'manual'];
export const PRESENTER_LABEL = 'scripted synthetic presenter';

// What a message asserts, in structured form. Amounts are integer cents;
// text is rendered from these values, never the other way around.
export type ConversationClaim =
  // The fixed scripted instruction: preferred tags, walking radius and the
  // personal limit. Fixed preferences are not natural-language understanding.
  | { kind: 'instruction'; tags: string[]; maxWalkingMinutes: number; maxPersonalCents: Cents }
  | { kind: 'clarification'; phrase: string; interpretation: string }
  | { kind: 'offer'; offerRef: string; title: string; priceCents: Cents; walkingMinutes: number; source: string; retrievedAt: number }
  | { kind: 'contribution'; offerRef: string; totalCents: Cents; personalCents: Cents; othersCents: Cents; feeCents: Cents }
  | { kind: 'limit'; employeeMaxCents?: Cents }
  | { kind: 'proposal'; offerRef: string; proposalVersion: number; expiresAt: number; state: PurchaseState }
  | { kind: 'approval'; approvalRef: string; proposalVersion: number; amountCents: Cents }
  | { kind: 'decision'; action: 'choose_offer' | 'confirm_payment'; offerRef?: string }
  | { kind: 'status'; state: PurchaseState; ownLegs: { payeeId: string; amountCents: Cents; status: LegStatus }[] }
  | { kind: 'reasons'; reasons: SafeReason[] }
  // Explanations that name a deferred branch without performing it.
  | { kind: 'explanation'; code: 'new_instruction_required' }
  // Which authority a proposal needs (or used): the observed zone, the basis
  // that funded it when one exists, the observed terms revision and the
  // deterministic reason it is not automatic.
  | { kind: 'authorization'; authZone: AuthZone; basis?: Authorization['basis']; autoPayBlockedReason?: AutoPayBlockedReason; mandateVersion?: number }
  // The retained Auto receipt: the employee's original debit, the fixed
  // dispute deadline and the standing-terms revision that paid.
  | { kind: 'receipt'; debitCents: Cents; disputeUntil: number; mandateVersion: number }
  // An assistant suggestion the user may act on later — described, never
  // performed: trusting a merchant is always the employee's signed choice.
  | { kind: 'suggestion'; action: 'trust_merchant'; merchantId: string };

export interface ConversationMessage {
  // Deterministic within a journey: same fixtures, same ids, same digest.
  messageId: string;
  role: MessageRole;
  recipient: MessageRecipient;
  authority: AuthorityClass;
  text: string;
  claims: ConversationClaim[];
  // Trace sequences of the source events evidencing this message; every one
  // precedes the message's own presenter_message event.
  eventSeqs: number[];
}

// A link from a comparison observation to the run that produced it.
export interface ComparisonRef {
  scenarioId: string;
  runId: string;
  eventSeqs: number[];
}

export type ComparisonAspect =
  | 'preferences'
  | 'changed_terms'
  | 'funding_loss'
  | 'user_decisions'
  | 'unsupported_assertions'
  | 'authority_preservation'
  | 'automatic_payment'
  | 'trust_suggestion';

export interface ComparisonRow {
  aspect: ComparisonAspect;
  observation: string;
  // Set on the user_decisions row: counted explicit decision events.
  userDecisionEvents?: number;
  refs: ComparisonRef[];
  // Always a manual assessment of a synthetic run — never a measured AI benefit.
  assessment: 'manual_assessment';
}

export interface PresenterRecord {
  label: typeof PRESENTER_LABEL;
  journey: JourneyId;
  mode: DeliveryMode;
  presenterFixtureVersion: string;
  run: RunRecord;
  conversation: ConversationMessage[];
  comparison: ComparisonRow[];
}

// The automatic-payment journey's record: the same shape as a manual
// journey record, under its own journey id. It is a distinct record — the
// four manual comparison records are unchanged.
export type AutoPayRecord = Omit<PresenterRecord, 'journey'> & { journey: 'auto-pay' };

// Everything a journey needs from its world: the read handle (agent in
// scripted mode, trusted in manual), the trusted user flow for approvals and
// execution, the trace and the conversation being built.
interface JourneyContext {
  w: World;
  mode: DeliveryMode;
  // The ids the session was built with; presenter_message events carry them
  // so the audit trail names the actual session, not the fixture default.
  sessionId: string;
  purchaseId: string;
  reads: AgentPresenter;
  userFlow: PresenterUserFlow;
  // The trusted no-tap executor; only the automatic journey steps it.
  runner?: PresenterRunner;
  conversation: ConversationMessage[];
  // presenter_message event sequence per message id.
  messageSeqs: Map<string, number>;
  messagePrefix: string;
  // Named evidence anchors the comparison rows point at.
  keyEvents: Record<string, number[]>;
  // Observed payer amounts the comparison rows cite — taken from the
  // evidence-backed view the user saw, never from script arithmetic.
  // funding-loss records the employee's approved share here.
  approvedShareCents?: Cents;
}

const offerClaim = (o: OfferView): ConversationClaim => ({
  kind: 'offer',
  offerRef: o.offerRef,
  title: o.title,
  priceCents: o.priceCents,
  walkingMinutes: o.walkingMinutes,
  source: o.source,
  retrievedAt: o.retrievedAt,
});

const contributionFromQuote = (q: QuoteView): ConversationClaim => ({
  kind: 'contribution',
  offerRef: q.offer.offerRef,
  totalCents: q.totalCents,
  personalCents: q.personalCents,
  othersCents: q.othersCents,
  feeCents: q.employeeFeeCents,
});

const contributionFromView = (v: PresenterView): ConversationClaim => ({
  kind: 'contribution',
  offerRef: v.offerRef,
  totalCents: v.payer.totalCents,
  personalCents: v.payer.ownCents,
  othersCents: v.payer.othersCents,
  feeCents: v.payer.ownFeeCents,
});

const proposalClaim = (v: PresenterView): ConversationClaim => ({
  kind: 'proposal',
  offerRef: v.offerRef,
  proposalVersion: v.proposalVersion,
  expiresAt: v.proposalExpiresAt,
  state: v.payer.state,
});

const statusClaim = (v: PresenterView): ConversationClaim => ({
  kind: 'status',
  state: v.payer.state,
  ownLegs: v.payer.ownLegs.map((l) => ({ payeeId: l.payeeId, amountCents: l.amountCents, status: l.status })),
});

// The standing maximum restated from the observed assessment — never from
// the script. Absent terms mean no standing maximum at all.
const limitClaim = (v: { employeeMaxCents?: Cents }): ConversationClaim => ({ kind: 'limit', employeeMaxCents: v.employeeMaxCents });
const limitText = (v: { employeeMaxCents?: Cents }): string =>
  v.employeeMaxCents === undefined ? 'no standing maximum' : `${euro(v.employeeMaxCents)} limit`;

// Append one message: assigned its deterministic id and permitted recipient,
// cloned into the trace so the digest covers it, then into the conversation.
const say = (
  ctx: JourneyContext,
  spec: { role: MessageRole; authority: AuthorityClass; claims: ConversationClaim[]; eventSeqs: number[]; text: string },
): ConversationMessage => {
  const msg: ConversationMessage = {
    messageId: `${ctx.messagePrefix}-msg-${String(ctx.conversation.length + 1).padStart(2, '0')}`,
    role: spec.role,
    recipient: spec.role === 'user' ? 'assistant' : 'employee',
    authority: spec.authority,
    text: spec.text,
    claims: structuredClone(spec.claims),
    // Evidence anchors, canonicalised: callers pass merged windows, and the
    // sorted order lands in the trace so identical runs stay byte-identical.
    eventSeqs: [...new Set(spec.eventSeqs)].sort((a, b) => a - b),
  };
  ctx.w.trace.add('LOCAL', 'presenter', 'presenter_message', {
    sessionId: ctx.sessionId,
    purchaseId: ctx.purchaseId,
    observedAt: ctx.w.coordinator.now,
    ...structuredClone(msg),
  });
  ctx.messageSeqs.set(msg.messageId, ctx.w.trace.events.length);
  ctx.conversation.push(msg);
  return msg;
};

// Shared opening of both journeys: the fixed instruction, discovery under
// the scripted preferences and the sourced offer list — with the synthetic
// clarification that "within ten minutes" means walking time.
const presentOffers = (ctx: JourneyContext): void => {
  const prefs = PRESENTER_SCRIPT.preferences;
  const d = ctx.reads.discover({ tags: [...prefs.tags], maxWalkingMinutes: prefs.maxWalkingMinutes });
  ctx.keyEvents.discover = d.eventSeqs;
  say(ctx, {
    role: 'user',
    authority: 'user_instruction',
    claims: [
      {
        kind: 'instruction',
        tags: [...prefs.tags],
        maxWalkingMinutes: prefs.maxWalkingMinutes,
        maxPersonalCents: PRESENTER_SCRIPT.employeeMaxCents,
      },
    ],
    eventSeqs: d.eventSeqs,
    text:
      `I want a ${prefs.tags.join(' and ')} lunch within ${prefs.maxWalkingMinutes} minutes, ` +
      `paying at most ${euro(PRESENTER_SCRIPT.employeeMaxCents)} myself; use the employer benefit if it applies.`,
  });
  const offers = d.value;
  say(ctx, {
    role: 'assistant',
    authority: 'information_only',
    claims: [
      { kind: 'clarification', phrase: `within ${prefs.maxWalkingMinutes} minutes`, interpretation: 'walking_minutes' },
      ...offers.map(offerClaim),
    ],
    eventSeqs: d.eventSeqs,
    text:
      `I read "within ${prefs.maxWalkingMinutes} minutes" as walking time. Matching offers: ` +
      offers.map((o) => `${o.title} at ${euro(o.priceCents)}, ${o.walkingMinutes} minutes on foot`).join('; ') +
      '.',
  });
};

// Evaluate offer A and report the deterministic split.
const evaluateOfferA = (ctx: JourneyContext): QuoteView => {
  const e = ctx.reads.evaluate(OFFER_A.offerRef);
  ctx.keyEvents.evaluateA = e.eventSeqs;
  const q = e.value;
  say(ctx, {
    role: 'assistant',
    authority: 'information_only',
    claims: [offerClaim(q.offer), contributionFromQuote(q), limitClaim(q)],
    eventSeqs: e.eventSeqs,
    text:
      `${q.offer.title} totals ${euro(q.totalCents)}: ${euro(q.othersCents)} employer benefit and ` +
      `${euro(q.personalCents)} from you — within your ${limitText(q)}.`,
  });
  return q;
};

// Select an offer and report the resulting proposal.
const selectAndReport = (ctx: JourneyContext, offerRef: string, key: string): PresenterView => {
  const sel = ctx.reads.selectOffer(offerRef);
  ctx.keyEvents[key] = sel.eventSeqs;
  const v = sel.value;
  say(ctx, {
    role: 'assistant',
    authority: 'information_only',
    claims: [proposalClaim(v), contributionFromView(v), limitClaim(v)],
    eventSeqs: sel.eventSeqs,
    text:
      `Proposal v${v.proposalVersion}: ${v.offer.title} at ${euro(v.payer.totalCents)} — ` +
      `${euro(v.payer.othersCents)} employer benefit, ${euro(v.payer.ownCents)} from you. ` +
      `This version needs your explicit approval.`,
  });
  return v;
};

// The employee approves the shown proposal version on their device. Only the
// trusted user flow can do this; the message records it as a user approval.
const approveAndReport = (ctx: JourneyContext, expectedProposalVersion: number): PresenterView => {
  const ap = ctx.userFlow.approve(expectedProposalVersion);
  ctx.keyEvents[`approve:${expectedProposalVersion}`] = ap.eventSeqs;
  const v = ap.value;
  const recorded = v.authorizations.find((a) => a.bindsCurrentProposal);
  // A successful approve must leave an approval bound to the shown version;
  // recording 'none' would mask a broken approval path.
  if (!recorded) throw new Error(`no recorded approval binds proposal v${v.proposalVersion}`);
  say(ctx, {
    role: 'user',
    authority: 'user_approval',
    claims: [
      {
        kind: 'approval',
        approvalRef: recorded.approvalRef,
        proposalVersion: v.proposalVersion,
        amountCents: v.payer.ownCents,
      },
    ],
    eventSeqs: ap.eventSeqs,
    text: `I approve proposal v${v.proposalVersion}: ${euro(v.payer.ownCents)} from me.`,
  });
  return v;
};

// Journey 1: offer A is approved while live, expires before submission, the
// replacement B would exceed the fixed instruction, the user chooses C, and
// the settled outcome is pending until trusted reconciliation confirms it.
const changedOfferJourney = async (ctx: JourneyContext): Promise<void> => {
  // The employer leg's transfer response will be lost after its effect: the
  // commit is 'unknown' until an authoritative status query observes it.
  ctx.w.providers.get(EMPLOYER)!.setFault(
    // The journey bumps the proposal to version 3 before submission.
    legChildKey(ctx.purchaseId, 3, 'employer', 'pay', `psp-shop-${MERCHANT_C}`),
    'credit',
    'lose_response_after_effect',
  );

  presentOffers(ctx);
  evaluateOfferA(ctx);
  selectAndReport(ctx, OFFER_A.offerRef, 'selectA');
  approveAndReport(ctx, 1);

  // A's window ends at the fixture boundary; the script resumes after it.
  advance(ctx.w, PRESENTER_SCRIPT.resumeAt);
  const expired = ctx.reads.evaluate(OFFER_A.offerRef);
  ctx.keyEvents.offerAExpired = expired.eventSeqs;
  say(ctx, {
    role: 'assistant',
    authority: 'information_only',
    claims: [offerClaim(expired.value.offer), { kind: 'reasons', reasons: expired.value.reasons }],
    eventSeqs: expired.eventSeqs,
    text:
      `${expired.value.offer.title} is no longer available: the offer expired, ` +
      `so the earlier approval cannot be used.`,
  });

  // Selecting the replacement invalidates the recorded v1 approval; B's
  // EUR 9 personal share exceeds the standing EUR 8 maximum, so it waits in
  // Exception — a signed one-off exception or a lasting terms edit could pay
  // it, never an ordinary approval.
  const selB = ctx.reads.selectOffer(OFFER_B.offerRef);
  ctx.keyEvents.selectB = selB.eventSeqs;
  const b = selB.value;
  say(ctx, {
    role: 'assistant',
    authority: 'information_only',
    claims: [offerClaim(b.offer), contributionFromView(b), limitClaim(b), { kind: 'reasons', reasons: b.reasons }, proposalClaim(b)],
    eventSeqs: selB.eventSeqs,
    text:
      `The replacement ${b.offer.title} totals ${euro(b.payer.totalCents)}: with ${euro(b.payer.othersCents)} ` +
      `employer benefit, ${euro(b.payer.ownCents)} would fall to you — above your ` +
      `${limitText(b)}. An ordinary approval cannot pay it: you could allow it once ` +
      `as a signed exception, or change your standing terms for good.`,
  });

  // The user picks eligible alternative C instead — a new proposal version.
  const selC = ctx.reads.selectOffer(OFFER_C.offerRef);
  ctx.keyEvents.selectC = selC.eventSeqs;
  const c = selC.value;
  say(ctx, {
    role: 'user',
    authority: 'user_instruction',
    claims: [{ kind: 'decision', action: 'choose_offer', offerRef: c.offerRef }],
    eventSeqs: selC.eventSeqs,
    text: `I choose ${c.offer.title} instead.`,
  });
  say(ctx, {
    role: 'assistant',
    authority: 'information_only',
    claims: [proposalClaim(c), contributionFromView(c), limitClaim(c)],
    eventSeqs: selC.eventSeqs,
    text:
      `Proposal v${c.proposalVersion}: ${c.offer.title} at ${euro(c.payer.totalCents)} — ` +
      `${euro(c.payer.othersCents)} employer benefit, ${euro(c.payer.ownCents)} from you. ` +
      `This new version needs your renewed approval.`,
  });
  approveAndReport(ctx, c.proposalVersion);

  // The user confirms payment; the lost response leaves the outcome pending.
  const sub = await ctx.userFlow.submit(c.proposalVersion);
  ctx.keyEvents.submit = sub.eventSeqs;
  say(ctx, {
    role: 'user',
    authority: 'user_instruction',
    claims: [{ kind: 'decision', action: 'confirm_payment' }],
    eventSeqs: sub.eventSeqs,
    text: 'Confirm the payment.',
  });
  // Explanation while pending is a projection only: it makes no status call
  // and issues no retry.
  const pending = ctx.reads.explain();
  const pmsg = say(ctx, {
    role: 'assistant',
    authority: 'status_report',
    claims: [statusClaim(pending.value)],
    eventSeqs: [...sub.eventSeqs, ...pending.eventSeqs],
    text:
      `The payment was sent but the outcome is not confirmed yet: it is pending — ` +
      `neither completed nor failed. I will not retry it or start a replacement payment; ` +
      `a trusted status check has to confirm it first.`,
  });
  // The pending claim's evidence is its own presenter_message event: the
  // comparison cites what the user was told, not only the ops behind it.
  ctx.keyEvents.pendingMessage = [ctx.messageSeqs.get(pmsg.messageId)!];

  const rec = await ctx.userFlow.reconcile();
  ctx.keyEvents.reconcile = rec.eventSeqs;
  say(ctx, {
    role: 'assistant',
    authority: 'status_report',
    claims: [statusClaim(rec.value), contributionFromView(rec.value)],
    eventSeqs: rec.eventSeqs,
    text:
      `The status check confirmed the payment completed: ${euro(rec.value.payer.ownCents)} from you ` +
      `and ${euro(rec.value.payer.othersCents)} from the employer benefit.`,
  });
};

// Journey 2: a live offer is approved, the employer mandate is revoked before
// initiation, and submission is refused without touching the approved share.
const fundingLossJourney = async (ctx: JourneyContext): Promise<void> => {
  presentOffers(ctx);
  evaluateOfferA(ctx);
  const v = selectAndReport(ctx, OFFER_A.offerRef, 'selectA');
  approveAndReport(ctx, v.proposalVersion);

  // The employer revokes the mandate between approval and initiation; the
  // evidence is the refused submission below, not a registry event.
  updateMandate(ctx.w, { revoked: true });

  const sub = await ctx.userFlow.submit(v.proposalVersion);
  ctx.keyEvents.submit = sub.eventSeqs;
  say(ctx, {
    role: 'user',
    authority: 'user_instruction',
    claims: [{ kind: 'decision', action: 'confirm_payment' }],
    eventSeqs: sub.eventSeqs,
    text: 'Confirm the payment.',
  });
  const f = sub.value;
  // The share the comparison row cites is the one the evidence showed, not a
  // number recomputed from the script.
  ctx.approvedShareCents = f.payer.ownCents;
  say(ctx, {
    role: 'assistant',
    authority: 'status_report',
    claims: [statusClaim(f), { kind: 'reasons', reasons: f.reasons }, ...f.authorizations.filter((a) => a.basis !== 'mandate').map((a) => ({
      kind: 'approval',
      approvalRef: a.approvalRef!,
      proposalVersion: a.proposalVersion,
      amountCents: f.payer.ownCents,
    } satisfies ConversationClaim))],
    eventSeqs: sub.eventSeqs,
    text:
      `The payment failed: the employer contribution lost its authority before initiation, so nothing ` +
      `was charged. Your recorded approval of ${euro(f.payer.ownCents)} stands unchanged and was not executed.`,
  });

  // A fresh quote after revocation honestly shows no benefit — a projection
  // for a would-be new purchase, never a rewrite of the approved terms.
  const q = ctx.reads.evaluate(OFFER_A.offerRef);
  ctx.keyEvents.evaluateAfterRevocation = q.eventSeqs;
  say(ctx, {
    role: 'assistant',
    authority: 'information_only',
    claims: [contributionFromQuote(q.value), limitClaim(q.value), { kind: 'explanation', code: 'new_instruction_required' }],
    eventSeqs: q.eventSeqs,
    text:
      `Paying the full ${euro(q.value.personalCents)} yourself would need a one-off signed exception ` +
      `or a higher standing maximum than your ${limitText(q.value)} — plus a fresh approval from you. ` +
      `I have not changed either.`,
  });
};

const isDecision = (m: ConversationMessage): boolean => m.authority === 'user_instruction' || m.authority === 'user_approval';

// Per-record comparison rows: each observation links back to the run and the
// events behind it, and is always labelled a manual assessment.
const comparisonRows = (journey: JourneyId, ctx: JourneyContext, runId: string, scenarioId: string): ComparisonRow[] => {
  const ref = (eventSeqs: number[]): ComparisonRef[] => [{ scenarioId, runId, eventSeqs }];
  const decisions = ctx.conversation.filter(isDecision);
  const decisionSeqs = decisions.map((m) => ctx.messageSeqs.get(m.messageId)!);
  const rows: ComparisonRow[] = [
    {
      aspect: 'preferences',
      observation:
        `Both modes applied the same fixed scripted preferences ` +
        `(tags ${PRESENTER_SCRIPT.preferences.tags.join('/')}, at most ${PRESENTER_SCRIPT.preferences.maxWalkingMinutes} walking minutes, ` +
        `${euro(PRESENTER_SCRIPT.employeeMaxCents)} personal limit). Fixed scripted preferences are not evidence ` +
        `of natural-language understanding.`,
      refs: ref(ctx.keyEvents.discover),
      assessment: 'manual_assessment',
    },
    {
      aspect: 'user_decisions',
      observation:
        `${decisions.length} explicit user decision events (instructions and approvals). Scripted mode required ` +
        `the same explicit approvals as the manual checkout; the assistant never approved on the employee's behalf.`,
      userDecisionEvents: decisions.length,
      refs: ref(decisionSeqs),
      assessment: 'manual_assessment',
    },
    {
      aspect: 'authority_preservation',
      observation:
        `Every approval and the submission went through the trusted user-flow handle on the 'user' channel; ` +
        (ctx.mode === 'manual'
          ? `no agent handle was used in manual mode: all information and proposal operations also used the trusted handle.`
          : `the agent handle was used only for information and proposal operations and cannot approve or submit.`),
      refs: ref([
        ...Object.keys(ctx.keyEvents)
          .filter((k) => k.startsWith('approve:'))
          .flatMap((k) => ctx.keyEvents[k]),
        ...(ctx.keyEvents.submit ?? []),
        ...(ctx.keyEvents.reconcile ?? []),
      ]),
      assessment: 'manual_assessment',
    },
  ];
  if (journey === 'changed-offer') {
    rows.push(
      {
        aspect: 'changed_terms',
        observation:
          `The expired offer and the replacement produced new proposal versions; the recorded v1 approval was ` +
          `invalidated and only renewed approval of the chosen offer's version could execute.`,
        refs: ref([...(ctx.keyEvents.selectB ?? []), ...(ctx.keyEvents.selectC ?? [])]),
        assessment: 'manual_assessment',
      },
      {
        aspect: 'unsupported_assertions',
        observation:
          `The pending message claimed neither completion nor failure and recommended no speculative replacement ` +
          `payment; completion was reported only after the trusted reconciliation event.`,
        refs: ref([...(ctx.keyEvents.pendingMessage ?? []), ...(ctx.keyEvents.reconcile ?? [])]),
        assessment: 'manual_assessment',
      },
    );
  } else {
    // The cited share must be the one the evidence showed; a missing
    // observation fails loudly rather than printing a number from nothing.
    if (ctx.approvedShareCents === undefined) throw new Error('funding-loss comparison needs the observed approved share');
    rows.push(
      {
        aspect: 'funding_loss',
        observation:
          `With the mandate revoked, initiation failed the purchase: zero executions and the employee's approved ` +
          `${euro(ctx.approvedShareCents)} share unchanged — the lost employer share never moved onto them.`,
        refs: ref(ctx.keyEvents.submit ?? []),
        assessment: 'manual_assessment',
      },
      {
        aspect: 'unsupported_assertions',
        observation:
          `Full personal payment was explained as needing a new instruction and a fresh approval; the branch was ` +
          `described, not performed, and no message implied the approved share had grown.`,
        refs: ref(ctx.keyEvents.evaluateAfterRevocation ?? []),
        assessment: 'manual_assessment',
      },
    );
  }
  return rows;
};

// The signed grant for the session's agent handle: information and proposal
// capabilities only, bound to the script's agent, principal, session, purchase.
const sessionGrant = (w: World) =>
  signPayload(
    {
      grantRef: PRESENTER_SCRIPT.grantRef,
      agentId: PRESENTER_SCRIPT.agentId,
      principalId: PRESENTER_SCRIPT.employeeId,
      sessionId: PRESENTER_SCRIPT.sessionId,
      purchaseId: PRESENTER_SCRIPT.purchaseId,
      capabilities: ['discover', 'propose', 'explain'],
      expiresAt: PRESENTER_SCRIPT.grantExpiresAt,
    } satisfies AgentGrant,
    w.signers.get(PRESENTER_SCRIPT.employeeId)!,
  );

// One journey in one mode, in a fresh world, with the deterministic fixture
// inputs. Returns a detached PresenterRecord.
export async function runPresenterJourney(journey: JourneyId, mode: DeliveryMode, runId: string): Promise<PresenterRecord> {
  const w = world();
  // One source for the session's ids: the context below labels every
  // presenter_message with exactly what the session was built with.
  const sessionId = PRESENTER_SCRIPT.sessionId;
  const purchaseId = PRESENTER_SCRIPT.purchaseId;
  const session = createPresenterSession({
    sessionId,
    purchaseId,
    agentId: PRESENTER_SCRIPT.agentId,
    employeeId: PRESENTER_SCRIPT.employeeId,
    employeeFeeCents: PRESENTER_SCRIPT.employeeFeeCents,
    mandateRef: PRESENTER_SCRIPT.mandateRef,
    grant: sessionGrant(w),
    catalog: PRESENTER_CATALOG,
    coordinator: w.coordinator,
    trace: w.trace,
    keys: w.keys,
    submitPolicy: 'on_request',
    settlementMode: 'atomic',
    signAsPrincipal: (payload) => signPayload(payload, w.signers.get(PRESENTER_SCRIPT.employeeId)!),
    signAsAgent: (payload) => signPayload(payload, w.signers.get(PRESENTER_SCRIPT.agentId)!),
    approveOnDevice: (p, choice) => approveAs(w, p, PRESENTER_SCRIPT.employeeId, choice),
    updateEmployeeMandateOnDevice: (changes, id) => updateEmployeeMandate(w, changes, id),
  });
  const ctx: JourneyContext = {
    w,
    mode,
    sessionId,
    purchaseId,
    // Scripted mode hands the fixed script to the agent handle; manual mode
    // is the conventional path through the trusted handle. Approvals and
    // execution always go through the trusted handle either way.
    reads: mode === 'scripted' ? session.agent : session.userFlow,
    userFlow: session.userFlow,
    conversation: [],
    messageSeqs: new Map(),
    messagePrefix: journey,
    keyEvents: {},
  };
  if (journey === 'changed-offer') await changedOfferJourney(ctx);
  else await fundingLossJourney(ctx);

  const scenarioId = `presenter-${journey}-${mode}`;
  const run = recordRun(runId, scenarioId, w, session.userFlow.snapshot());
  const record: PresenterRecord = {
    label: PRESENTER_LABEL,
    journey,
    mode,
    presenterFixtureVersion: PRESENTER_FIXTURE_VERSION,
    run,
    conversation: ctx.conversation,
    comparison: comparisonRows(journey, ctx, runId, scenarioId),
  };
  // Detached: later mutation of the returned record cannot reach the world,
  // the trace or the retained purchase the snapshot came from.
  return structuredClone(record);
}

// All four records: two journeys in both delivery modes.
export async function runPresenterJourneys(
  runId = `run-${new Date().toISOString().replace(/[-:.]/g, '')}`,
): Promise<PresenterRecord[]> {
  const records: PresenterRecord[] = [];
  for (const journey of PRESENTER_JOURNEYS) {
    for (const mode of PRESENTER_MODES) {
      records.push(await runPresenterJourney(journey, mode, runId));
    }
  }
  return records;
}

// --- Automatic payment journey -------------------------------------------
// A distinct record, deliberately outside PRESENTER_JOURNEYS: the four
// manual comparison records are unchanged. Two sessions of one purchase
// each run in one world — the lunch at the trusted merchant settles with
// no tap on a trusted runner step, the lunch at the new merchant still
// needs the employee's explicit approval, and only then may the assistant
// suggest trusting it — described, never published.

// Per-record comparison rows for the automatic journey: the runner step is
// the evidence the no-tap claims cite, and the suggestion row cites the
// completed purchase plus its own message.
const autoComparisonRows = (ctx: JourneyContext, second: JourneyContext, runId: string, scenarioId: string): ComparisonRow[] => {
  const ref = (eventSeqs: number[] | undefined): ComparisonRef[] => [{ scenarioId, runId, eventSeqs: eventSeqs ?? [] }];
  const decisions = ctx.conversation.filter(isDecision);
  const decisionSeqs = decisions.map((m) => ctx.messageSeqs.get(m.messageId)!);
  return [
    {
      aspect: 'preferences',
      observation:
        `Both modes applied the same fixed scripted preferences ` +
        `(tags ${AUTO_SCRIPT.preferences.tags.join('/')}, at most ${AUTO_SCRIPT.preferences.maxWalkingMinutes} walking minutes, ` +
        `${euro(AUTO_SCRIPT.employeeMaxCents)} standing personal maximum). Fixed scripted preferences are not evidence ` +
        `of natural-language understanding.`,
      refs: ref(ctx.keyEvents.discover),
      assessment: 'manual_assessment',
    },
    {
      aspect: 'user_decisions',
      observation:
        `${decisions.length} explicit user decision events (instructions, the new-merchant choice and its approval). ` +
        `The automatic purchase itself required none: it settled under the employee's signed standing terms, ` +
        `not under an assistant's say-so.`,
      userDecisionEvents: decisions.length,
      refs: ref(decisionSeqs),
      assessment: 'manual_assessment',
    },
    {
      aspect: 'authority_preservation',
      observation:
        `The no-tap submission ran through the trusted runner on the 'user' channel; ` +
        (ctx.mode === 'manual'
          ? `no agent handle was used in manual mode: all information and proposal operations also used the trusted handle.`
          : `the agent handle was used only for information and proposal operations — it holds no runner, approval, submission, publication or dispute method.`),
      refs: ref(ctx.keyEvents.stepAuto),
      assessment: 'manual_assessment',
    },
    {
      aspect: 'automatic_payment',
      observation:
        `The purchase at the trusted merchant completed with no device signature and issued exactly one receipt ` +
        `with a fixed dispute deadline; a repeated runner step observed the same completed purchase without a ` +
        `second payment or receipt.`,
      refs: ref([...(ctx.keyEvents.stepAuto ?? []), ...(ctx.keyEvents.stepAutoAgain ?? [])]),
      assessment: 'manual_assessment',
    },
    {
      aspect: 'trust_suggestion',
      observation:
        `The new merchant needed an explicit device approval because it was untrusted; only after its purchase ` +
        `completed did the assistant suggest trusting it — citing that completed purchase — and no standing-terms ` +
        `revision was published.`,
      refs: ref([...(second.keyEvents.submitNew ?? []), ...(second.keyEvents.trustSuggestion ?? [])]),
      assessment: 'manual_assessment',
    },
  ];
};

// The automatic journey: agent discovery and selection at the trusted
// merchant, then a trusted runner step — no device-approval callback for
// the first purchase. The second session shows the boundary: untrusted
// means tap, and trust is suggested only after the confirmed purchase.
const autoPayJourney = async (ctx: JourneyContext, second: JourneyContext): Promise<void> => {
  const prefs = AUTO_SCRIPT.preferences;
  const d = ctx.reads.discover({ tags: [...prefs.tags], maxWalkingMinutes: prefs.maxWalkingMinutes });
  ctx.keyEvents.discover = d.eventSeqs;
  say(ctx, {
    role: 'user',
    authority: 'user_instruction',
    claims: [
      {
        kind: 'instruction',
        tags: [...prefs.tags],
        maxWalkingMinutes: prefs.maxWalkingMinutes,
        maxPersonalCents: AUTO_SCRIPT.employeeMaxCents,
      },
    ],
    eventSeqs: d.eventSeqs,
    text:
      `I want a ${prefs.tags.join(' and ')} lunch within ${prefs.maxWalkingMinutes} minutes, ` +
      `paying at most ${euro(AUTO_SCRIPT.employeeMaxCents)} myself under my standing terms; use the employer benefit if it applies.`,
  });
  const offers = d.value;
  say(ctx, {
    role: 'assistant',
    authority: 'information_only',
    claims: [
      { kind: 'clarification', phrase: `within ${prefs.maxWalkingMinutes} minutes`, interpretation: 'walking_minutes' },
      ...offers.map(offerClaim),
    ],
    eventSeqs: d.eventSeqs,
    text:
      `I read "within ${prefs.maxWalkingMinutes} minutes" as walking time. Matching offers: ` +
      offers.map((o) => `${o.title} at ${euro(o.priceCents)}, ${o.walkingMinutes} minutes on foot`).join('; ') +
      '.',
  });

  // The trusted merchant's offer: the current assessment says Auto, so the
  // split is reported together with the authority it needs — none today.
  const e = ctx.reads.evaluate(OFFER_AUTO_A.offerRef);
  ctx.keyEvents.evaluateAuto = e.eventSeqs;
  const q = e.value;
  say(ctx, {
    role: 'assistant',
    authority: 'information_only',
    claims: [
      offerClaim(q.offer),
      contributionFromQuote(q),
      limitClaim(q),
      { kind: 'authorization', authZone: q.authZone, autoPayBlockedReason: q.autoPayBlockedReason, mandateVersion: q.mandateVersion },
    ],
    eventSeqs: e.eventSeqs,
    text:
      `${q.offer.title} totals ${euro(q.totalCents)}: ${euro(q.othersCents)} employer benefit and ` +
      `${euro(q.personalCents)} from you — inside your standing terms, so it can pay automatically.`,
  });

  // The selection records standing-mandate authority: ready with no tap.
  const sel = ctx.reads.selectOffer(OFFER_AUTO_A.offerRef);
  ctx.keyEvents.selectAuto = sel.eventSeqs;
  const a = sel.value;
  say(ctx, {
    role: 'assistant',
    authority: 'information_only',
    claims: [
      proposalClaim(a),
      contributionFromView(a),
      { kind: 'authorization', authZone: 'Auto', basis: 'mandate', mandateVersion: a.mandateVersion },
    ],
    eventSeqs: sel.eventSeqs,
    text:
      `Proposal v${a.proposalVersion}: ${a.offer.title} at ${euro(a.payer.totalCents)} — ` +
      `${euro(a.payer.othersCents)} employer benefit, ${euro(a.payer.ownCents)} from you. ` +
      `Your standing terms authorize it: no approval is needed.`,
  });

  // The trusted runner step does the no-tap submission and reports the
  // outcome with the receipt it earned.
  const step = await ctx.runner!.step();
  ctx.keyEvents.stepAuto = step.eventSeqs;
  const v = step.value;
  say(ctx, {
    role: 'assistant',
    authority: 'status_report',
    claims: [
      statusClaim(v),
      contributionFromView(v),
      {
        kind: 'receipt',
        debitCents: v.payer.ownCents + v.payer.ownFeeCents,
        disputeUntil: v.payer.receipt!.disputeUntil,
        mandateVersion: v.payer.receipt!.mandateVersion,
      },
    ],
    eventSeqs: step.eventSeqs,
    text:
      `Paid automatically: ${euro(v.payer.ownCents)} from you and ${euro(v.payer.othersCents)} from the employer ` +
      `benefit — no approval was needed. The receipt keeps a dispute window open until simulated minute ` +
      `${v.payer.receipt!.disputeUntil}.`,
  });

  // A repeated step is a harmless observation of the same completed purchase.
  const again = await ctx.runner!.step();
  ctx.keyEvents.stepAutoAgain = again.eventSeqs;

  // The new merchant: same price, but outside the trusted list — automatic
  // payment stops exactly where the signed terms stop.
  say(second, {
    role: 'user',
    authority: 'user_instruction',
    claims: [{ kind: 'decision', action: 'choose_offer', offerRef: OFFER_AUTO_B.offerRef }],
    eventSeqs: d.eventSeqs,
    text: `I'll take the ${OFFER_AUTO_B.title} at the new place too.`,
  });
  const sel2 = second.reads.selectOffer(OFFER_AUTO_B.offerRef);
  second.keyEvents.selectNew = sel2.eventSeqs;
  const b = sel2.value;
  say(second, {
    role: 'assistant',
    authority: 'information_only',
    claims: [
      offerClaim(b.offer),
      proposalClaim(b),
      contributionFromView(b),
      { kind: 'authorization', authZone: 'Confirm', autoPayBlockedReason: b.autoPayBlockedReason },
    ],
    eventSeqs: sel2.eventSeqs,
    text:
      `${b.offer.title} totals ${euro(b.payer.totalCents)}: ${euro(b.payer.othersCents)} employer benefit, ` +
      `${euro(b.payer.ownCents)} from you. This merchant is not in your trusted merchants, ` +
      `so this purchase needs your explicit approval.`,
  });
  const ap = second.userFlow.approve(b.proposalVersion);
  second.keyEvents[`approve:${b.proposalVersion}`] = ap.eventSeqs;
  const apv = ap.value;
  const recorded = apv.authorizations.find((x) => x.bindsCurrentProposal);
  if (!recorded) throw new Error(`no recorded approval binds proposal v${apv.proposalVersion}`);
  say(second, {
    role: 'user',
    authority: 'user_approval',
    claims: [
      {
        kind: 'approval',
        approvalRef: recorded.approvalRef,
        proposalVersion: apv.proposalVersion,
        amountCents: apv.payer.ownCents,
      },
    ],
    eventSeqs: ap.eventSeqs,
    text: `I approve proposal v${apv.proposalVersion}: ${euro(apv.payer.ownCents)} from me.`,
  });
  const sub = await second.userFlow.submit(b.proposalVersion);
  second.keyEvents.submitNew = sub.eventSeqs;
  say(second, {
    role: 'user',
    authority: 'user_instruction',
    claims: [{ kind: 'decision', action: 'confirm_payment' }],
    eventSeqs: sub.eventSeqs,
    text: 'Confirm the payment.',
  });
  say(second, {
    role: 'assistant',
    authority: 'status_report',
    claims: [statusClaim(sub.value), contributionFromView(sub.value)],
    eventSeqs: sub.eventSeqs,
    text:
      `The payment completed: ${euro(sub.value.payer.ownCents)} from you ` +
      `and ${euro(sub.value.payer.othersCents)} from the employer benefit.`,
  });

  // Only now — with the completed purchase as evidence — may the assistant
  // suggest trust. A suggestion is a claim, never a publication: the signed
  // terms stay exactly as they were.
  const suggestion = say(second, {
    role: 'assistant',
    authority: 'information_only',
    claims: [{ kind: 'suggestion', action: 'trust_merchant', merchantId: OFFER_AUTO_B.merchantId }],
    eventSeqs: sub.eventSeqs,
    text:
      `You just paid at this new merchant once. If you want future lunches there to pay automatically, ` +
      `your device can sign a standing-terms change adding it to your trusted merchants — ` +
      `I have not changed anything.`,
  });
  second.keyEvents.trustSuggestion = [second.messageSeqs.get(suggestion.messageId)!];
};

// One automatic journey in one mode, in a fresh world with the spec §12
// standing terms and mandate-capable routing. The employer's one-meal-per-day
// allowance is widened to two purchases with two full contributions so the
// second lunch keeps its benefit and only its trust status decides the
// authority it needs.
export async function runAutoPayJourney(mode: DeliveryMode, runId: string): Promise<AutoPayRecord> {
  const w = world(
    {},
    { maxPurchasesPerDay: 2, maxPerDayCents: 1_000 },
    { employeeMandate: AUTO_EMPLOYEE_TERMS, supportsMandatePayments: true },
  );
  const conversation: ConversationMessage[] = [];
  const messageSeqs = new Map<string, number>();
  const keyEvents: Record<string, number[]> = {};
  const mkSession = (sessionId: string, purchaseId: string, grantRef: string) =>
    createPresenterSession({
      sessionId,
      purchaseId,
      agentId: AUTO_SCRIPT.agentId,
      employeeId: AUTO_SCRIPT.employeeId,
      employeeFeeCents: AUTO_SCRIPT.employeeFeeCents,
      mandateRef: w.mandate.mandateRef,
      grant: signPayload(
        {
          grantRef,
          agentId: AUTO_SCRIPT.agentId,
          principalId: AUTO_SCRIPT.employeeId,
          sessionId,
          purchaseId,
          capabilities: ['discover', 'propose', 'explain'],
          expiresAt: AUTO_SCRIPT.grantExpiresAt,
        } satisfies AgentGrant,
        w.signers.get(EMPLOYEE)!,
      ),
      catalog: AUTO_CATALOG,
      coordinator: w.coordinator,
      trace: w.trace,
      keys: w.keys,
      submitPolicy: 'on_request',
      settlementMode: 'atomic',
      signAsPrincipal: (payload) => signPayload(payload, w.signers.get(EMPLOYEE)!),
      signAsAgent: (payload) => signPayload(payload, w.signers.get(AUTO_SCRIPT.agentId)!),
      approveOnDevice: (p, choice) => approveAs(w, p, EMPLOYEE, choice),
      updateEmployeeMandateOnDevice: (changes, id) => updateEmployeeMandate(w, changes, id),
    });
  const s1 = mkSession(AUTO_SCRIPT.sessionId, AUTO_SCRIPT.purchaseId, AUTO_SCRIPT.grantRef);
  const s2 = mkSession(AUTO_SCRIPT.secondSessionId, AUTO_SCRIPT.secondPurchaseId, AUTO_SCRIPT.secondGrantRef);
  const ctx: JourneyContext = {
    w,
    mode,
    sessionId: AUTO_SCRIPT.sessionId,
    purchaseId: AUTO_SCRIPT.purchaseId,
    reads: mode === 'scripted' ? s1.agent : s1.userFlow,
    userFlow: s1.userFlow,
    runner: s1.runner,
    conversation,
    messageSeqs,
    messagePrefix: 'auto-pay',
    keyEvents,
  };
  const second: JourneyContext = {
    ...ctx,
    sessionId: AUTO_SCRIPT.secondSessionId,
    purchaseId: AUTO_SCRIPT.secondPurchaseId,
    reads: mode === 'scripted' ? s2.agent : s2.userFlow,
    userFlow: s2.userFlow,
    runner: s2.runner,
  };
  await autoPayJourney(ctx, second);

  const scenarioId = `presenter-auto-pay-${mode}`;
  // The record's result is the automatic purchase — the journey's subject.
  const run = recordRun(runId, scenarioId, w, s1.userFlow.snapshot());
  const record: AutoPayRecord = {
    label: PRESENTER_LABEL,
    journey: 'auto-pay',
    mode,
    presenterFixtureVersion: PRESENTER_FIXTURE_VERSION,
    run,
    conversation,
    comparison: autoComparisonRows(ctx, second, runId, scenarioId),
  };
  // Detached: later mutation of the returned record cannot reach the world,
  // the trace or the retained purchases the snapshots came from.
  return structuredClone(record);
}
