// The presenter journeys: two stories, two delivery modes each, with an
// evidence-backed conversation folded into the run's digest. These tests pin
// amounts, proposal versions, preserved limits, pending-before-completion,
// no duplicate executions, source-before-message ordering, permitted
// recipients and record determinism.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  PRESENTER_LABEL,
  runAutoPayJourney,
  runPresenterJourney,
  runPresenterJourneys,
} from '../src/presenter/journeys.ts';
import type { AutoPayRecord, ConversationClaim, ConversationMessage, PresenterRecord } from '../src/presenter/journeys.ts';
import type { OfferView, PresenterView, QuoteView } from '../src/presenter/session.ts';
import { PRESENTER_FIXTURE_VERSION } from '../src/presenter/fixtures.ts';
import { traceDigest } from '../src/evidence/run-record.ts';
import type { TraceEvent } from '../src/core/types.ts';

const MODES = ['scripted', 'manual'] as const;
const AUTHORITIES = new Set(['user_instruction', 'user_approval', 'information_only', 'status_report']);
// A role pins its authority classes: only a user message may carry the
// employee's instructions or approvals; the assistant can only inform.
const USER_AUTHORITIES = new Set(['user_instruction', 'user_approval']);
const ASSISTANT_AUTHORITIES = new Set(['information_only', 'status_report']);

// Every numeric claim amount in a message, collected from any *Cents field.
const claimAmounts = (m: ConversationMessage): number[] => {
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k.endsWith('Cents') && typeof x === 'number') out.push(x);
        else walk(x);
      }
    }
  };
  walk(m.claims);
  return out;
};

const claimsOf = <K extends ConversationClaim['kind']>(r: PresenterRecord | AutoPayRecord, kind: K) =>
  r.conversation.flatMap((m) => m.claims).filter((c): c is Extract<ConversationClaim, { kind: K }> => c.kind === kind);

const decisionCount = (r: PresenterRecord | AutoPayRecord): number =>
  r.conversation.filter((m) => m.authority === 'user_instruction' || m.authority === 'user_approval').length;

// Invariants every conversation in every record must hold: messages are
// stored in the trace, sources precede the message, recipients stay within
// the allowlist and every EUR amount in the text is backed by a claim.
const checkConversation = (rec: PresenterRecord | AutoPayRecord): void => {
  const msgEvents = new Map<string, TraceEvent>();
  for (const e of rec.run.events) {
    if (e.event === 'presenter_message') msgEvents.set(e.detail?.messageId as string, e);
    else assert.equal(e.origin, 'LOCAL', `non-message event ${e.event} is not LOCAL`);
  }
  // Every message is digest-covered exactly once.
  assert.equal(msgEvents.size, rec.conversation.length);
  for (const m of rec.conversation) {
    const ev = msgEvents.get(m.messageId);
    assert.ok(ev, `message ${m.messageId} missing from the trace`);
    assert.equal(ev!.origin, 'LOCAL');
    assert.equal(ev!.actor, 'presenter');
    // The stored copy is the same message the record reports.
    assert.equal(ev!.detail?.text, m.text);
    assert.deepEqual(ev!.detail?.claims, m.claims);
    assert.deepEqual(ev!.detail?.eventSeqs, m.eventSeqs);
    // Permitted recipients: the employee, or the assistant surface.
    assert.ok(m.recipient === 'employee' || m.recipient === 'assistant', `${m.messageId} recipient`);
    assert.equal(m.recipient, m.role === 'user' ? 'assistant' : 'employee');
    assert.ok(AUTHORITIES.has(m.authority), `${m.messageId} authority`);
    // A mislabelled role/authority pair must not inflate user decisions.
    const roleAuthority = m.role === 'user' ? USER_AUTHORITIES : ASSISTANT_AUTHORITIES;
    assert.ok(roleAuthority.has(m.authority), `${m.messageId}: role ${m.role} cannot carry authority ${m.authority}`);
    // Source events precede the message's own trace event.
    assert.ok(m.eventSeqs.length > 0, `${m.messageId} has no evidence`);
    assert.ok(m.claims.length > 0, `${m.messageId} has no claims`);
    for (const s of m.eventSeqs) {
      assert.ok(s >= 1 && s < ev!.seq, `${m.messageId} cites seq ${s}, not before its own event ${ev!.seq}`);
    }
    // Digest coverage alone is not support: the cited earlier observation
    // must actually contain the offer, contribution, status or reason shown.
    const observations = m.eventSeqs.map((s) => rec.run.events[s - 1].detail?.observation)
      .filter((o) => o !== undefined) as (OfferView[] | QuoteView | PresenterView)[];
    for (const claim of m.claims) {
      if (!['offer', 'contribution', 'proposal', 'status', 'reasons', 'authorization', 'receipt', 'suggestion'].includes(claim.kind)) continue;
      assert.ok(observations.some((o) => {
        if (claim.kind === 'offer') {
          const offers = Array.isArray(o) ? o : [o.offer];
          return offers.some((offer) => offer.offerRef === claim.offerRef && offer.title === claim.title &&
            offer.priceCents === claim.priceCents && offer.source === claim.source &&
            offer.walkingMinutes === claim.walkingMinutes && offer.retrievedAt === claim.retrievedAt);
        }
        if (Array.isArray(o)) return false;
        if (claim.kind === 'contribution') {
          const personal = 'payer' in o ? o.payer.ownCents : o.personalCents;
          const others = 'payer' in o ? o.payer.othersCents : o.othersCents;
          const total = 'payer' in o ? o.payer.totalCents : o.totalCents;
          const fee = 'payer' in o ? o.payer.ownFeeCents : o.employeeFeeCents;
          return o.offer.offerRef === claim.offerRef && personal === claim.personalCents &&
            others === claim.othersCents && total === claim.totalCents && fee === claim.feeCents;
        }
        if (claim.kind === 'reasons') return claim.reasons.every((reason) => o.reasons.includes(reason));
        if (claim.kind === 'authorization') {
          // Both QuoteView and PresenterView carry the observed zone, reason
          // and terms revision; only the purchase view can attest a recorded
          // basis bound to the current proposal.
          return o.authZone === claim.authZone &&
            (claim.autoPayBlockedReason === undefined || o.autoPayBlockedReason === claim.autoPayBlockedReason) &&
            (claim.mandateVersion === undefined || o.mandateVersion === claim.mandateVersion) &&
            (claim.basis === undefined ||
              ('payer' in o && o.authorizations.some((a) => a.basis === claim.basis && a.bindsCurrentProposal)));
        }
        if (!('payer' in o)) return false;
        if (claim.kind === 'receipt') {
          const r = o.payer.receipt;
          return r !== undefined && r.disputeUntil === claim.disputeUntil &&
            r.mandateVersion === claim.mandateVersion &&
            o.payer.ownCents + o.payer.ownFeeCents === claim.debitCents;
        }
        if (claim.kind === 'suggestion') {
          // A trust suggestion is grounded in the completed purchase at that
          // merchant — the observation it cites, never a publication it caused.
          return claim.action === 'trust_merchant' &&
            o.offer.merchantId === claim.merchantId && o.payer.state === 'completed';
        }
        if (claim.kind === 'proposal') return o.offerRef === claim.offerRef && o.proposalVersion === claim.proposalVersion &&
          o.proposalExpiresAt === claim.expiresAt && o.payer.state === claim.state;
        if (claim.kind === 'status') return o.payer.state === claim.state &&
          JSON.stringify(o.payer.ownLegs.map(({ payeeId, amountCents, status }) => ({ payeeId, amountCents, status }))) === JSON.stringify(claim.ownLegs);
        return false;
      }), `${m.messageId}: ${claim.kind} has no supporting observation`);
    }
    // Amounts in the text are rendered from structured claims: no unbound
    // numeric prose. Every "EUR x.xx" must appear among the claim amounts.
    const amounts = claimAmounts(m);
    for (const match of m.text.matchAll(/EUR (\d+)\.(\d{2})/g)) {
      const cents = Number(match[1]) * 100 + Number(match[2]);
      assert.ok(amounts.includes(cents), `${m.messageId}: "${match[0]}" is not backed by any claim`);
    }
  }
};

test('changed-offer journey: expiry, renewal, pending, reconciled completion — in both modes', async () => {
  for (const mode of MODES) {
    const rec = await runPresenterJourney('changed-offer', mode, 'test-run');
    assert.equal(rec.label, PRESENTER_LABEL);
    assert.equal(rec.journey, 'changed-offer');
    assert.equal(rec.mode, mode);
    assert.equal(rec.presenterFixtureVersion, PRESENTER_FIXTURE_VERSION);
    assert.equal(rec.run.scenarioId, `presenter-changed-offer-${mode}`);
    checkConversation(rec);

    // Completion exists only because reconciliation observed it.
    assert.equal(rec.run.result.state, 'completed');
    assert.equal(rec.run.result.outstandingCents, 0);

    // Amounts: A €8+€5, replacement B €9+€5 over the €8 limit, C €8+€5.
    const contribs = claimsOf(rec, 'contribution');
    assert.ok(contribs.some((c) => c.offerRef === 'offer-a' && c.totalCents === 1_300 && c.personalCents === 800 && c.othersCents === 500));
    assert.ok(contribs.some((c) => c.offerRef === 'offer-b' && c.totalCents === 1_400 && c.personalCents === 900 && c.othersCents === 500));
    assert.ok(contribs.some((c) => c.offerRef === 'offer-c' && c.totalCents === 1_300 && c.personalCents === 800 && c.othersCents === 500));
    // The preserved instruction appears wherever money is shown.
    assert.ok(claimsOf(rec, 'limit').every((l) => l.employeeMaxCents === 800));
    assert.ok(claimsOf(rec, 'limit').length > 0);

    // Proposal versions climb 1 → 2 → 3; approvals bind only v1 and v3.
    assert.deepEqual(claimsOf(rec, 'proposal').map((p) => p.proposalVersion), [1, 2, 3]);
    assert.deepEqual(
      claimsOf(rec, 'approval').map((a) => [a.proposalVersion, a.amountCents]),
      [[1, 800], [3, 800]],
    );
    assert.deepEqual(
      rec.run.events.filter((e) => e.event === 'approval_recorded').map((e) => e.detail?.version),
      [1, 3],
    );
    // The replacement invalidated the recorded v1 approval.
    assert.ok(rec.run.events.some((e) => e.event === 'approval_invalidated'));
    assert.ok(
      rec.conversation.some((m) => m.claims.some((c) => c.kind === 'reasons' && c.reasons.includes('personal_limit_exceeded'))),
      'B is reported as exceeding the limit',
    );
    assert.ok(
      rec.conversation.some((m) => m.claims.some((c) => c.kind === 'reasons' && c.reasons.includes('offer_expired'))),
      'A is reported as expired',
    );

    // Status reports: pending first, completed only after reconciliation.
    const statusMsgs = rec.conversation.filter((m) => m.claims.some((c) => c.kind === 'status'));
    assert.deepEqual(
      statusMsgs.map((m) => (m.claims.find((c) => c.kind === 'status') as { state: string }).state),
      ['pending', 'completed'],
    );
    const pendingMsg = statusMsgs[0];
    assert.ok(!pendingMsg.claims.some((c) => c.kind === 'status' && c.state !== 'pending'));
    assert.ok(!pendingMsg.text.includes('settled') && !pendingMsg.text.includes(' charged'));
    const doneMsg = statusMsgs[1];
    const doneRefs = doneMsg.eventSeqs.map((s) => rec.run.events[s - 1]);
    assert.ok(doneRefs.some((e) => e.actor === 'coordinator' && e.event === 'reconciled'));
    assert.ok(doneRefs.some((e) => e.event === 'state' && e.detail?.to === 'completed'));
    // The pending message was emitted before the reconciliation observed anything.
    const pendSeq = rec.run.events.find((e) => e.event === 'presenter_message' && e.detail?.messageId === pendingMsg.messageId)!.seq;
    const reconciledSeq = rec.run.events.find((e) => e.event === 'reconciled')!.seq;
    assert.ok(pendSeq < reconciledSeq, 'pending was reported before reconciliation resolved it');

    // One submission, no retry, no dedupe: exactly one execution per leg.
    assert.equal(rec.run.events.filter((e) => e.actor === 'coordinator' && e.event === 'submit').length, 1);
    assert.equal(rec.run.events.filter((e) => e.actor === 'backend' && e.event === 'submit').length, 1);
    assert.ok(!rec.run.events.some((e) => e.event === 'resubmit_same_keys' || e.event === 'duplicate_request_ignored'));
    const subEvent = rec.run.events.find((e) => e.actor === 'coordinator' && e.event === 'submit')!;
    const legs = subEvent.detail?.legs as string[];
    assert.equal(legs.length, 2);
    // The pending state was derived from unknown legs, then resolved.
    assert.ok(rec.run.events.some((e) => e.event === 'state' && e.detail?.to === 'pending'));
    assert.ok(rec.run.events.filter((e) => e.event === 'status_resolved').length >= 1);

    // The same explicit user decisions in both modes.
    assert.equal(decisionCount(rec), 5);
  }
});

test('funding-loss journey: revoked mandate fails submission, approved share unchanged — in both modes', async () => {
  for (const mode of MODES) {
    const rec = await runPresenterJourney('funding-loss', mode, 'test-run');
    assert.equal(rec.run.scenarioId, `presenter-funding-loss-${mode}`);
    checkConversation(rec);

    assert.equal(rec.run.result.state, 'failed');
    assert.match(rec.run.result.reason ?? '', /employer_authority_invalid:mandate_revoked/);
    assert.equal(rec.run.result.outstandingCents, 0);

    // The refusal happened before initiation: nothing reached the backend,
    // no benefit was reserved and no leg exists.
    assert.equal(rec.run.events.filter((e) => e.actor === 'backend' && e.event === 'submit').length, 0);
    assert.ok(!rec.run.events.some((e) => e.event === 'benefit_reserved'));
    assert.ok(!rec.run.events.some((e) => e.event === 'reconciled'));

    // Exactly one approval was ever recorded, at v1 for EUR 8; wherever the
    // conversation restates it, the amount is unchanged — never raised.
    assert.deepEqual(
      rec.run.events.filter((e) => e.event === 'approval_recorded').map((e) => e.detail?.version),
      [1],
    );
    assert.ok(claimsOf(rec, 'approval').length > 0);
    assert.ok(claimsOf(rec, 'approval').every((a) => a.proposalVersion === 1 && a.amountCents === 800));
    assert.ok(claimsOf(rec, 'limit').every((l) => l.employeeMaxCents === 800));

    // Failed is reported as a status, and the deferred branch is explained:
    // full personal payment would need a new instruction and approval.
    assert.ok(claimsOf(rec, 'status').some((s) => s.state === 'failed'));
    assert.ok(claimsOf(rec, 'explanation').some((x) => x.code === 'new_instruction_required'));
    // The honest post-revocation quote shows the full amount on the employee —
    // as a projection, not as an approved or executed share.
    assert.ok(claimsOf(rec, 'contribution').some((c) => c.personalCents === 1_300 && c.othersCents === 0));

    assert.equal(decisionCount(rec), 3);
  }
});

test('scripted and manual modes reach equivalent outcomes with identical conversations', async () => {
  for (const journey of ['changed-offer', 'funding-loss'] as const) {
    const s = await runPresenterJourney(journey, 'scripted', 'eq-run');
    const m = await runPresenterJourney(journey, 'manual', 'eq-run');
    assert.equal(m.run.result.state, s.run.result.state);
    assert.equal(m.run.result.reason, s.run.result.reason);
    assert.equal(m.run.result.outstandingCents, s.run.result.outstandingCents);
    // Identical text and claims; the trusted channel may also cite raw audit
    // events, while the agent receives only safe observation references.
    const content = (r: PresenterRecord) => r.conversation.map(({ eventSeqs, ...message }) => message);
    assert.deepEqual(content(m), content(s));
    assert.notEqual(m.run.traceDigest, s.run.traceDigest);
    // In manual mode no agent channel is ever used; in scripted mode only
    // read/proposal ops are.
    const channels = (r: PresenterRecord, channel: string) =>
      r.run.events.filter((e) => e.actor === 'presenter' && e.detail?.channel === channel).map((e) => e.event);
    assert.equal(channels(m, 'agent').length, 0);
    assert.ok(
      channels(s, 'agent').every((e) => ['presenter_discover', 'presenter_evaluate', 'presenter_select', 'presenter_explain'].includes(e)),
    );
    // Approvals and submission come from the trusted user channel in both.
    for (const r of [s, m]) {
      const exec = r.run.events.filter((e) => e.event === 'presenter_approve' || e.event === 'presenter_submit');
      assert.ok(exec.length > 0 && exec.every((e) => e.detail?.channel === 'user' && e.detail?.onBehalfOf === undefined));
    }
  }
});

test('repeated runs give identical digests; the journeys differ; run ids stay outside the digest', async () => {
  const a = await runPresenterJourney('changed-offer', 'scripted', 'run-a');
  const b = await runPresenterJourney('changed-offer', 'scripted', 'run-b-different');
  assert.equal(a.run.traceDigest, b.run.traceDigest);
  assert.equal(traceDigest(a.run.events), a.run.traceDigest);
  assert.notEqual(a.run.runId, b.run.runId); // the wall-clock id is not digested

  const loss = await runPresenterJourney('funding-loss', 'scripted', 'run-a');
  assert.notEqual(a.run.traceDigest, loss.run.traceDigest);
});

test('auto-pay journey: no-tap completion with receipt, a tapped new merchant and a non-publishing suggestion', async () => {
  for (const mode of MODES) {
    const rec = await runAutoPayJourney(mode, 'test-run');
    assert.equal(rec.label, PRESENTER_LABEL);
    assert.equal(rec.journey, 'auto-pay');
    assert.equal(rec.mode, mode);
    assert.equal(rec.presenterFixtureVersion, PRESENTER_FIXTURE_VERSION);
    assert.equal(rec.run.scenarioId, `presenter-auto-pay-${mode}`);
    checkConversation(rec);

    // The recorded run's result is the automatic purchase: completed with
    // one receipt and nothing outstanding.
    assert.equal(rec.run.result.state, 'completed');
    assert.equal(rec.run.result.outstandingCents, 0);
    assert.equal(rec.run.events.filter((e) => e.event === 'autopay_receipt').length, 1);

    // Two purchases ran: the first under standing-mandate evidence with no
    // device signature, the second under an explicit device approval.
    assert.deepEqual(
      rec.run.events.filter((e) => e.event === 'approval_recorded').map((e) => e.detail?.basis),
      ['mandate', 'device'],
    );
    // The agent handle never approved: purchase-1 has no user-channel
    // approval or submission event; the runner stepped on the trusted one.
    assert.ok(
      !rec.run.events.some(
        (e) => (e.event === 'presenter_approve' || e.event === 'presenter_submit') && e.detail?.purchaseId === 'purchase-1',
      ),
    );
    const steps = rec.run.events.filter((e) => e.event === 'presenter_step');
    assert.ok(steps.length >= 2, 'the journey ran and repeated a trusted step');
    assert.ok(steps.every((e) => e.detail?.channel === 'user' && e.detail?.onBehalfOf === undefined));
    assert.equal(rec.run.events.filter((e) => e.event === 'presenter_submit').length, 1);

    // The receipt claim reports the observation the run retained.
    const receiptClaims = claimsOf(rec, 'receipt');
    assert.deepEqual(
      receiptClaims.map((r) => [r.debitCents, r.disputeUntil, r.mandateVersion]),
      [[400, 1_450, 1]],
    );
    // Authorization claims attest Auto under mandate evidence and Confirm
    // at the untrusted merchant.
    assert.ok(claimsOf(rec, 'authorization').some((a) => a.authZone === 'Auto' && a.basis === 'mandate' && a.mandateVersion === 1));
    assert.ok(claimsOf(rec, 'authorization').some((a) => a.authZone === 'Confirm' && a.autoPayBlockedReason === 'untrusted_merchant'));

    // The trust suggestion exists, cites the completed purchase — and the
    // standing terms were never revised: setup's version-1 publication is
    // the only one in the whole run.
    const suggestion = rec.conversation.find((m) => m.claims.some((c) => c.kind === 'suggestion' && c.action === 'trust_merchant'))!;
    assert.ok(suggestion, 'no trust suggestion message');
    const submitSeq = rec.run.events.find((e) => e.event === 'presenter_submit')!.seq;
    assert.ok(suggestion.eventSeqs.includes(submitSeq), 'the suggestion does not cite the completed purchase');
    assert.equal(rec.run.events.filter((e) => e.event === 'employee_mandate_published').length, 1);
    assert.ok(!rec.run.events.some((e) => e.event === 'employee_mandate_revoked'));

    // The comparison rows name the automatic aspects and cite real events.
    const aspects = rec.comparison.map((c) => c.aspect);
    for (const expected of ['preferences', 'user_decisions', 'authority_preservation', 'automatic_payment', 'trust_suggestion']) {
      assert.ok(aspects.includes(expected as never), `auto record lacks ${expected}`);
    }
    for (const row of rec.comparison) {
      assert.equal(row.assessment, 'manual_assessment');
      for (const ref of row.refs) {
        assert.ok(ref.eventSeqs.length > 0, `${rec.run.scenarioId} ${row.aspect} has empty refs`);
        for (const s of ref.eventSeqs) assert.ok(s >= 1 && s <= rec.run.events.length, `${row.aspect} ref ${s} out of range`);
      }
    }
    // The instruction, the new-merchant choice, its approval and the
    // confirmation: the automatic purchase needed no user decision at all.
    assert.equal(decisionCount(rec), 4);
  }
});

test('the auto-pay journey says the same thing in both delivery modes', async () => {
  const s = await runAutoPayJourney('scripted', 'eq-run');
  const m = await runAutoPayJourney('manual', 'eq-run');
  assert.equal(m.run.result.state, s.run.result.state);
  const content = (r: typeof s) => r.conversation.map(({ eventSeqs, ...message }) => message);
  assert.deepEqual(content(m), content(s));
  assert.notEqual(m.run.traceDigest, s.run.traceDigest);
  // Scripted mode used the agent only for reads and selection; manual mode
  // never touched it; the runner and approvals stayed on the user channel.
  const channels = (r: typeof s, channel: string) =>
    r.run.events.filter((e) => e.actor === 'presenter' && e.detail?.channel === channel).map((e) => e.event);
  assert.equal(channels(m, 'agent').length, 0);
  assert.ok(
    channels(s, 'agent').every((e) => ['presenter_discover', 'presenter_evaluate', 'presenter_select', 'presenter_explain'].includes(e)),
  );
});

test('comparison metadata names each aspect and links to run evidence', async () => {
  const records = await runPresenterJourneys('cmp-run');
  assert.equal(records.length, 4);
  for (const r of records) {
    const aspects = r.comparison.map((c) => c.aspect);
    for (const expected of ['preferences', 'user_decisions', 'unsupported_assertions', 'authority_preservation']) {
      assert.ok(aspects.includes(expected as never), `${r.run.scenarioId} lacks ${expected}`);
    }
    if (r.journey === 'changed-offer') {
      assert.ok(aspects.includes('changed_terms'));
      assert.ok(!aspects.includes('funding_loss'));
    } else {
      assert.ok(aspects.includes('funding_loss'));
      assert.ok(!aspects.includes('changed_terms'));
    }
    const dec = r.comparison.find((c) => c.aspect === 'user_decisions')!;
    assert.equal(dec.userDecisionEvents, decisionCount(r));
    const authority = r.comparison.find((c) => c.aspect === 'authority_preservation')!;
    assert.ok(authority.observation.includes(r.mode === 'manual' ? 'no agent handle was used' : 'agent handle was used'));
    for (const row of r.comparison) {
      assert.equal(row.assessment, 'manual_assessment');
      assert.ok(row.observation.length > 0);
      for (const ref of row.refs) {
        assert.equal(ref.runId, r.run.runId);
        assert.equal(ref.scenarioId, r.run.scenarioId);
        assert.ok(ref.eventSeqs.length > 0, `${r.run.scenarioId} ${row.aspect} has empty refs`);
        for (const s of ref.eventSeqs) {
          assert.ok(s >= 1 && s <= r.run.events.length, `${row.aspect} ref ${s} out of range`);
        }
      }
    }
  }
});

// CLI smoke check: spawn the real entry point once per output format. The
// JSON document must carry the four expected records with LOCAL provenance,
// the Markdown artifact must cite exactly the evidence references the JSON
// document carries, and the default text output must render the labelled
// evaluator view — structural checks only, no exact prose snapshot.
const execFileP = promisify(execFile);

test('CLI: --json emits one document; --markdown cites the same evidence; default text renders the evaluator view', async () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = async (mode?: '--json' | '--markdown'): Promise<string> =>
    (await execFileP(process.execPath, [cli, '--presenter', '--run-id=cli-smoke', ...(mode ? [mode] : [])], { maxBuffer: 64 * 1024 * 1024 })).stdout;

  const report = JSON.parse(await run('--json')) as {
    label: string;
    runId: string;
    records: PresenterRecord[];
    comparison: PresenterRecord['comparison'];
  };
  assert.equal(report.label, PRESENTER_LABEL);
  assert.equal(report.runId, 'cli-smoke');
  assert.equal(report.records.length, 4);
  assert.deepEqual(
    new Set(report.records.map((r) => `${r.journey}:${r.mode}`)),
    new Set(['changed-offer:scripted', 'changed-offer:manual', 'funding-loss:scripted', 'funding-loss:manual']),
  );
  assert.equal(report.comparison.length, report.records.flatMap((r) => r.comparison).length);
  for (const rec of report.records) {
    assert.equal(rec.label, PRESENTER_LABEL);
    assert.equal(rec.run.runId, 'cli-smoke');
    assert.equal(rec.run.scenarioId, `presenter-${rec.journey}-${rec.mode}`);
    assert.ok(rec.run.events.length > 0);
    assert.ok(rec.run.events.every((e) => e.origin === 'LOCAL'), `${rec.run.scenarioId} has a non-LOCAL event`);
  }

  const md = await run('--markdown');
  assert.ok(md.includes(PRESENTER_LABEL));
  assert.ok(md.includes('cli-smoke'));
  for (const rec of report.records) {
    assert.ok(md.includes(rec.run.scenarioId), `markdown lacks ${rec.run.scenarioId}`);
    assert.ok(md.includes(rec.run.traceDigest), `markdown lacks digest for ${rec.run.scenarioId}`);
    for (const m of rec.conversation) {
      // Anchored to the full bullet line as presenterMarkdown renders it, so
      // the seq list cannot false-pass inside another message's list
      // ('events 1' inside 'events 12, 13').
      assert.ok(
        md.includes(
          `- **${m.role}** → ${m.recipient} · \`${m.authority}\` · \`${m.messageId}\` · events ${m.eventSeqs.join(', ')}`,
        ),
        `markdown lacks the evidence line of ${m.messageId}`,
      );
    }
    for (const row of rec.comparison) {
      for (const ref of row.refs) {
        assert.ok(
          md.includes(`${ref.scenarioId}#${ref.eventSeqs.join(',')}`),
          `markdown lacks comparison ref ${ref.scenarioId}#${ref.eventSeqs.join(',')}`,
        );
      }
    }
  }

  // Default text output (no format flag): labelled, names all four runs and
  // carries the evaluator-view label. execFile rejects on a non-zero exit,
  // so reaching these asserts already pins exit code 0.
  const text = await run();
  assert.ok(text.includes(PRESENTER_LABEL));
  assert.ok(text.includes('cli-smoke'));
  assert.ok(
    text.includes('evaluator view — the assistant only ever received projections'),
    'text output lacks the evaluator-view label',
  );
  for (const rec of report.records) {
    assert.ok(text.includes(rec.run.scenarioId), `text output lacks ${rec.run.scenarioId}`);
  }
});
