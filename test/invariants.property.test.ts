// Randomised check of the safety rules in AGENTS.md. Each seed builds a
// fixture with random funding, faults, return support, standing terms and
// initiation model, then applies a random sequence of operations over several
// purchases that share one automatic monthly budget. After every step the
// invariants must hold. A failure names the seed and the operations so the
// case can be replayed.
//
// Composed invariants (plan task 9): sequences of individually valid actions
// — employee publication/revocation, signed exceptions, automatic refresh and
// admission, cancellation, disputes and time advancement — must not break
// authorization, accounting or settlement rules. The automatic budget is
// shadowed independently: admitted charges and confirmed releases are folded
// from trace events per employee/month, every admission must fit the cap its
// mandate revision carried at that moment (never the cap in force now), and
// an admission or a mandate authorization record may only exist behind a
// live Auto assessment of its proposal version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  world,
  lunch,
  approveAs,
  updateMandate,
  updateEmployeeMandate,
  advance,
  AUTO_EMPLOYEE_TERMS,
  EMPLOYEE,
  EMPLOYER,
  MERCHANT_A,
  MERCHANT_B,
  MERCHANT_C,
} from '../src/scenarios.ts';
import type { World } from '../src/scenarios.ts';
import type { Fault } from '../src/settlement/mock-backend.ts';
import type { EmployeeMandate, EmployerMandate, Purchase, SettlementMode } from '../src/core/types.ts';
import type { LegRequest } from '../src/settlement/backend.ts';
import type { Signed } from '../src/core/signing.ts';
import { PspUnavailableError } from '../src/settlement/psp.ts';
import { signPayload, verifyPayload } from '../src/core/signing.ts';
import { monthOf } from '../src/core/autopay-ledger.ts';

const SEEDS = 250;
const STEPS = 30;
const MAX_PURCHASES = 3;
const MERCHANTS = [MERCHANT_A, MERCHANT_B, MERCHANT_C] as const;
// Purchases favour the trusted merchant so Auto admission is reached often;
// terms edits still pick every merchant.
const OFFER_MERCHANTS = [MERCHANT_A, MERCHANT_A, MERCHANT_A, MERCHANT_B, MERCHANT_C] as const;

// mulberry32: small, fast, deterministic.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

const FAULTS: Fault[] = ['none', 'decline', 'timeout_then_settle', 'timeout_then_reject'];
const MODES: SettlementMode[] = ['atomic', 'independent'];
// Lifecycle operations are weighted so sequences often propose, authorize and
// submit a purchase, with mandate edits, repricing, cancellation, time and
// PSP changes interleaved between them.
const ACTIONS = [
  'propose', 'propose',
  'approve', 'approve', 'approve', 'approve', 'approveException', 'approveException',
  'submit', 'submit', 'submit', 'submit', 'submit', 'resubmit',
  'reconcile', 'reconcile', 'reconcile',
  'recover', 'refund', 'refund', 'dispute', 'dispute', 'cancel', 'refresh',
  'advance',
  'reprice', 'employeeEdit', 'revokeEmployee', 'revokeEmployer', 'lowerEmployerCap',
  'pspFlip',
] as const;
type Action = (typeof ACTIONS)[number];

// Operations that act on the world rather than one purchase: with no purchase
// yet, any other action falls back to proposing one.
const WORLD_ACTIONS: ReadonlySet<Action> = new Set([
  'propose',
  'advance',
  'employeeEdit',
  'revokeEmployee',
  'revokeEmployer',
  'lowerEmployerCap',
  'pspFlip',
]);

// After the random steps every purchase is driven once toward a terminal
// state in this order — refusals are allowed, as in the random steps.
const DRAIN: readonly Action[] = ['reconcile', 'resubmit', 'recover', 'refund', 'dispute'];

// Errors the coordinator raises on purpose when an operation is not allowed
// in the current state. Anything else is a bug.
const REFUSALS =
  /^(cannot |approval does not match|nothing to |split purchases cannot|dispute rejected:|proposal rejected:)/;

const totalMoney = (w: World): number =>
  [...w.backend.accounts.values()].reduce((s, a) => s + a.deCents + a.linkedBankCents, 0);

interface Booking {
  employeeId: string;
  month: string;
  cents: number;
  feeCents: number;
  // The mandate revision and proposal version the admission was filed
  // under: every later accounting event must cite the same revision.
  mandateRef: string;
  mandateVersion: number;
  proposalVersion: number;
  consumed: boolean;
  resolved: boolean;
}

// Observed at the real backend entry, after any PSP pre-forward refusal.
// These are snapshots of the world at each leg's first handoff, independent
// of the coordinator's admission time and its retained evidence.
interface FirstHandoff {
  request: LegRequest;
  purchase: Purchase;
  now: number;
  employeeMandate?: Signed<EmployeeMandate>;
  employerMandate?: Signed<EmployerMandate>;
  capable: boolean;
  monthlyUsageCents: number;
}

interface Ctx {
  money: number;
  keys: Set<string>;
  // Within one proposal version a retry may only ever reuse the key set
  // admission produced — keyed by purchase, version and leg role.
  legKeys: Map<string, string>;
  // Each execution the backend returned belongs to exactly one purchase.
  execOwner: Map<string, string>;
  // The frozen submission descriptor, while it exists; a rolled-back attempt
  // frees the slot for a corrected retry.
  submissions: Map<string, { mode: SettlementMode; keys: string[]; assembly?: { size: number; assembleBy: number } }>;
  // Independent shadow of the automatic budget, folded from trace events:
  // admitted charges and confirmed releases per employee/month. Unresolved
  // outcomes keep their booking; a mandate update never resets this shadow.
  traceCursor: number;
  usage: Map<string, number>; // `${employeeId}|${month}` → cents
  bookings: Map<string, Booking>; // purchaseId → booking (resolved = tombstone)
  // Every employee-mandate revision ever accepted, kept whole: admissions
  // check the monthly cap it carried and exceptions the maximum it signed —
  // never the values a later revision installed.
  revisions: Map<string, EmployeeMandate>;
  // The last assessment zone each proposal version was observed under —
  // folded from EVERY auth_zone event, so evidence recorded or retained
  // while the zone was Confirm/Exception/Blocked is visible, not just the
  // assessments the cap check inspects.
  lastZone: Map<string, string>; // `${purchaseId}|v${proposalVersion}` → authZone
  // The simulated instant of each purchase's last admission: time freezes
  // within a step, so the clock at fold time is the send instant.
  sentAt: Map<string, number>; // purchaseId → coordinator.now
  handoffs: Map<string, FirstHandoff>; // actual request key → first route entry
  checkedHandoffs: Set<string>;
  handoffCaptureErrors: unknown[];
}

// Wrap the real backend without asserting inside the route: the coordinator
// correctly catches route errors as uncertain outcomes, which would hide a
// thrown test assertion. Capture now, assert outside the operation afterward.
function observeFirstHandoffs(w: World, ps: readonly Purchase[], ctx: Ctx): void {
  const submit = w.backend.submit.bind(w.backend);
  w.backend.submit = async (req) => {
    try {
      for (const request of req.legs) {
        if (ctx.handoffs.has(request.idempotencyKey)) continue;
        const p = ps.find((p) => p.purchaseId === req.groupRef)!;
        const month = p.submission?.bookingMonth;
        // Replay the independent accounting events up to this handoff. The
        // total includes this purchase's admission, even when it is new in
        // the current action and the main event fold has not run yet.
        let monthlyUsageCents = 0;
        for (const e of w.trace.events) {
          if (e.detail?.employeeId !== EMPLOYEE || e.detail?.month !== month) continue;
          if (e.event === 'autopay_reserved') monthlyUsageCents += e.detail.cents as number;
          if (e.event === 'autopay_released') monthlyUsageCents -= e.detail.cents as number;
        }
        ctx.handoffs.set(request.idempotencyKey, {
          request: structuredClone(request), purchase: structuredClone(p), now: w.coordinator.now,
          employeeMandate: w.coordinator.employeeMandate(EMPLOYEE),
          employerMandate: structuredClone(w.authority.employerMandate(p.benefit!.mandateRef)),
          capable: w.psps.get(EMPLOYEE)?.supportsMandatePayments ?? w.coordinator.supportsMandatePaymentsFor(EMPLOYEE),
          monthlyUsageCents,
        });
      }
    } catch (err) {
      ctx.handoffCaptureErrors.push(err);
    }
    return submit(req);
  };
}

function checkFirstHandoffs(w: World, ctx: Ctx): void {
  assert.deepEqual(ctx.handoffCaptureErrors, [], 'the route observer captured every first handoff');
  for (const [key, h] of ctx.handoffs) {
    if (ctx.checkedHandoffs.has(key)) continue;
    const p = h.purchase;
    const request = h.request;
    const leg = p.submission!.legs.find((l) => l.idempotencyKey === key)!;
    assert.ok(h.now <= p.proposal.expiresAt, 'the offer is live at each first handoff');
    if (request.payerId === EMPLOYER) {
      const record = h.employerMandate!;
      assert.ok(record && verifyPayload(record, w.keys, EMPLOYER), 'employer terms verify at handoff');
      assert.deepEqual(leg.employerMandate, record, 'retained employer evidence is exactly the handoff grant');
      const m = record.payload;
      assert.equal(m.revoked, false);
      assert.ok(m.validFrom <= h.now && h.now <= m.validUntil);
      assert.equal(m.beneficiaryRef, EMPLOYEE);
      assert.ok(m.eligibleMerchants.includes(request.payeeId));
      assert.ok(request.amountCents <= m.maxPerPurchaseCents);
    } else {
      const auth = authorizationFor(p, EMPLOYEE)!;
      const current = h.employeeMandate?.payload;
      const debit = request.amountCents + request.feeCents;
      assert.ok(!current?.blockedMerchants.includes(request.payeeId), 'a block forbids every employee basis');
      if (auth.basis === 'mandate') {
        assert.ok(current, 'automatic handoff has current standing terms');
        assert.ok(verifyPayload(auth.mandate, w.keys, EMPLOYEE));
        assert.deepEqual(auth.mandate, h.employeeMandate, 'automatic first handoff uses the current signed revision');
        assert.equal(current.revoked, false);
        assert.ok(h.now <= current.validUntil);
        assert.ok(current.autoPayMaxCents > 0 && current.autoPayMonthlyCents > 0);
        assert.ok(current.trustedMerchants.includes(request.payeeId));
        assert.ok(debit <= current.autoPayMaxCents && debit <= current.maxCents);
        assert.ok(h.monthlyUsageCents <= current.autoPayMonthlyCents, 'held booking fits the cap at first handoff');
        assert.equal(h.capable, true);
      } else {
        const a = auth.approval.payload;
        assert.ok(verifyPayload(auth.approval, w.keys, EMPLOYEE));
        assert.ok(h.now <= a.expiresAt, 'device authority is live at first handoff, not just admission');
        assert.equal(a.purchaseId, p.purchaseId);
        assert.equal(a.proposalVersion, p.proposal.version);
        assert.equal(a.merchantId, request.payeeId);
        assert.equal(a.totalCents, p.proposal.totalCents);
        assert.equal(a.amountCents, request.amountCents);
        assert.equal(a.feeCents, request.feeCents);
        if (auth.basis === 'exception') {
          assert.ok(current);
          assert.equal(a.exception, true);
          assert.equal(a.mandateRef, current.mandateRef);
          assert.equal(a.mandateVersion, current.version);
          assert.equal(a.maxCents, current.maxCents);
          assert.equal(a.overByCents, debit - current.maxCents);
          assert.ok(debit > current.maxCents);
        } else if (current) {
          assert.ok(debit <= current.maxCents, 'ordinary approval still fits the current maximum');
        }
      }
    }
    ctx.checkedHandoffs.add(key);
  }
}

// Record the currently accepted standing terms under their revision key, so
// an admission, assessment or signed exception citing that revision can be
// checked against the terms it carried — never those of a later revision.
function recordCaps(w: World, ctx: Ctx): void {
  const m = w.coordinator.employeeMandate(EMPLOYEE);
  if (m) ctx.revisions.set(`${m.payload.mandateRef}:${m.payload.version}`, m.payload);
}

// Fold new trace events into the independent month shadow. Admissions must
// fit the cap their recorded revision carried and may only exist under a
// live Auto assessment of their proposal version; releases and consumptions
// must account exactly for the booking they settle and cite its revision;
// every Auto assessment and every monthly_cap refusal must agree with the
// shadow's usage.
function foldEvents(w: World, ps: readonly Purchase[], ctx: Ctx): void {
  const events = w.trace.events;
  for (let i = ctx.traceCursor; i < events.length; i++) {
    const d = events[i].detail ?? {};
    if (events[i].event === 'autopay_reserved') {
      const purchaseId = d.purchaseId as string;
      const p = ps.find((x) => x.purchaseId === purchaseId);
      assert.ok(p?.benefit, `an automatic admission names an unknown purchase ${purchaseId}`);
      const employeeId = p.benefit.employeeId;
      const month = d.month as string;
      const cents = d.cents as number;
      // The booking month is the admission instant's own UTC month —
      // recomputed independently rather than trusted from the detail.
      assert.equal(month, monthOf(d.now as number, w.coordinator.calendarEpoch), 'an admission books its own month');
      // The reservation exists only under a live Auto assessment of this
      // proposal version — evidence held while the zone was Confirm or
      // Exception would pass every amount check yet break the contract.
      assert.equal(
        ctx.lastZone.get(`${purchaseId}|v${p.proposal.version}`),
        'Auto',
        'an automatic admission happened without a live Auto assessment',
      );
      const revision = ctx.revisions.get(`${d.mandateRef as string}:${d.mandateVersion as number}`);
      assert.ok(revision, `admission for ${purchaseId} cites a mandate revision never published`);
      const before = ctx.usage.get(`${employeeId}|${month}`) ?? 0;
      assert.ok(before + cents <= revision.autoPayMonthlyCents, 'an admission exceeded its then-current monthly cap');
      ctx.usage.set(`${employeeId}|${month}`, before + cents);
      const feeCents = p.proposal.shares
        .filter((s) => s.payerId === employeeId && s.authority === 'payer')
        .reduce((t, s) => t + s.feeCents, 0);
      ctx.bookings.set(purchaseId, {
        employeeId,
        month,
        cents,
        feeCents,
        mandateRef: d.mandateRef as string,
        mandateVersion: d.mandateVersion as number,
        proposalVersion: p.proposal.version,
        consumed: false,
        resolved: false,
      });
    } else if (events[i].event === 'autopay_consumed') {
      const purchaseId = d.purchaseId as string;
      const b = ctx.bookings.get(purchaseId);
      assert.ok(b, `a consumption for ${purchaseId} names no admitted booking`);
      assert.ok(!b.consumed && !b.resolved, 'an accounted booking cannot be consumed again');
      assert.equal(d.employeeId, b.employeeId);
      assert.equal(d.month, b.month, 'a consumption keeps the booking month, not the current one');
      assert.equal(d.cents, b.cents, 'a consumption confirms the whole booked debit');
      assert.equal(d.mandateRef, b.mandateRef, 'a consumption cites the revision that admitted it');
      assert.equal(d.mandateVersion, b.mandateVersion, 'a consumption cites the revision that admitted it');
      // A consumed debit keeps counting against the month in full — the
      // shadow's usage is unchanged until a confirmed outcome resolves it.
      b.consumed = true;
    } else if (events[i].event === 'autopay_released') {
      const purchaseId = d.purchaseId as string;
      const b = ctx.bookings.get(purchaseId);
      assert.ok(b, `a release for ${purchaseId} names no admitted booking`);
      assert.equal(d.month, b.month, 'a release settles into the booking month, not the current one');
      assert.equal(d.employeeId, b.employeeId);
      assert.equal(d.mandateRef, b.mandateRef, 'a release cites the revision that admitted the booking');
      assert.equal(d.mandateVersion, b.mandateVersion, 'a release cites the revision that admitted the booking');
      const key = `${b.employeeId}|${b.month}`;
      if (d.reason === 'admission_rollback') {
        assert.equal(d.retainedCents, 0);
        assert.equal(d.cents, b.cents, 'a proven pre-dispatch undo frees the whole hold');
        ctx.usage.set(key, ctx.usage.get(key)! - b.cents);
        ctx.bookings.delete(purchaseId);
      } else {
        assert.ok(!b.resolved, 'a resolved booking cannot release a second time');
        // Only a fee the employee leg actually charged and never got back is
        // retained — the same rule an independent read of the legs gives.
        const p = ps.find((x) => x.purchaseId === purchaseId);
        const expectedRetained = p?.legs.find((l) => l.leg === 'employee')?.status === 'returned' ? b.feeCents : 0;
        assert.equal(d.retainedCents, expectedRetained, 'only a confirmed charged fee stays counted');
        assert.equal(
          (d.cents as number) + (d.retainedCents as number),
          b.cents,
          'released plus retained accounts for the whole booking',
        );
        ctx.usage.set(key, ctx.usage.get(key)! - (d.cents as number));
        b.resolved = true;
      }
    } else if (events[i].event === 'auth_zone') {
      // Every zone observation updates the last-seen zone for that proposal
      // version, whatever the zone — an admission or a mandate record behind
      // a non-Auto zone is the central contract this fold exists to see.
      const p = ps.find((x) => x.purchaseId === d.purchaseId);
      assert.ok(p?.benefit, `an authorization-zone assessment names an unknown purchase ${String(d.purchaseId)}`);
      ctx.lastZone.set(`${p.purchaseId}|v${d.proposalVersion as number}`, d.authZone as string);
      if (d.authZone === 'Auto' || d.reason === 'monthly_cap') {
        // Open purchases never hold a booking, so the assessment's usage is
        // the shadow's usage in the assessment's own month — not today's.
        const employeeId = p.benefit.employeeId;
        const month = monthOf(d.now as number, w.coordinator.calendarEpoch);
        const revision = ctx.revisions.get(`${d.mandateRef as string}:${d.mandateVersion as number}`);
        assert.ok(revision, 'an assessment cites a mandate revision never published');
        const used = ctx.usage.get(`${employeeId}|${month}`) ?? 0;
        const debit = d.employeeDebitCents as number;
        if (d.authZone === 'Auto') {
          assert.ok(
            used + debit <= revision.autoPayMonthlyCents,
            'an Auto assessment admits more than the tracked month allows',
          );
        } else {
          assert.ok(
            used + debit > revision.autoPayMonthlyCents,
            'a monthly_cap refusal does not match the tracked month',
          );
        }
      }
    } else if (events[i].event === 'approval_recorded' && d.basis === 'mandate') {
      // Standing evidence may only exist under a live Auto assessment of the
      // proposal version it binds: a record behind a Confirm, Exception or
      // absent assessment is authority no live zone granted.
      assert.equal(
        ctx.lastZone.get(`${d.purchaseId as string}|v${d.version as number}`),
        'Auto',
        'mandate evidence was recorded while its proposal version was not Auto',
      );
    } else if (events[i].event === 'submit') {
      ctx.sentAt.set(d.purchaseId as string, w.coordinator.now);
    }
  }
  ctx.traceCursor = events.length;
}

// The retained authorization of a purchase for one payer.
const authorizationFor = (p: Purchase, payerId: string) =>
  p.authorizations.find((a) => (a.basis === 'mandate' ? a.payerId : a.approval.payload.payerId) === payerId);

function checkPurchase(w: World, p: Purchase, ctx: Ctx): void {
  // Every leg carries exactly its proposal share: no share ever grew to
  // cover another contribution's failure, and every leg has an outcome.
  for (const l of p.legs) {
    const s = p.proposal.shares.find((x) => x.role === l.leg);
    assert.ok(s, `leg ${l.leg} funds no proposal share`);
    assert.equal(l.payerId, s.payerId);
    assert.equal(l.payeeId, s.payeeId);
    assert.equal(l.amountCents, s.amountCents, 'a leg carries exactly its share, never more');
    assert.equal(l.feeCents, s.feeCents);
    assert.notEqual(l.status, 'planned', 'every leg carries an outcome');
    ctx.keys.add(l.idempotencyKey);
    const slot = `${p.purchaseId}|v${p.proposal.version}|${l.leg}`;
    const seen = ctx.legKeys.get(slot);
    if (seen === undefined) ctx.legKeys.set(slot, l.idempotencyKey);
    else assert.equal(l.idempotencyKey, seen, 'a retry never mints a new idempotency key');
    if (l.executionRef) {
      const owner = ctx.execOwner.get(l.executionRef);
      if (owner === undefined) ctx.execOwner.set(l.executionRef, p.purchaseId);
      else assert.equal(owner, p.purchaseId, 'an execution belongs to exactly one purchase');
    }
  }
  if (p.submission) {
    // The descriptor frozen at admission is what a replay sends: same legs,
    // same mode, same assembly window — while it exists it never changes.
    assert.equal(p.submission.groupRef, p.purchaseId);
    assert.deepEqual(
      p.submission.legs.map((l) => l.idempotencyKey),
      p.legs.map((l) => l.idempotencyKey),
      'the frozen request carries the legs built at admission',
    );
    const frozen = {
      mode: p.submission.mode,
      keys: p.submission.legs.map((l) => l.idempotencyKey),
      assembly: p.submission.assembly,
    };
    const last = ctx.submissions.get(p.purchaseId);
    if (last) assert.deepEqual(frozen, last, 'a live submission is replayed unchanged');
    else ctx.submissions.set(p.purchaseId, frozen);
  } else {
    ctx.submissions.delete(p.purchaseId);
  }
  if (p.state === 'completed') {
    assert.equal(p.legs.reduce((s, l) => s + l.amountCents, 0), p.proposal.totalCents, 'completed legs add up to the total');
    assert.ok(p.legs.every((l) => l.status === 'settled' || l.status === 'returned'), 'completed only when every leg settled');
  }
  if (p.state === 'failed') {
    assert.ok(p.legs.every((l) => l.status === 'rejected'), 'a failed purchase committed nothing');
  }
  if (p.legs.some((l) => l.status === 'unknown')) assert.equal(p.state, 'pending', 'an unknown outcome is pending, not failed');
  if (p.state === 'recovery_required') {
    // Committed money stays visible: at least one leg settled, and the
    // reported outstanding principal is exactly what those legs committed.
    // A fee charged on a zero-amount share is committed too, but returns
    // cover principal only — it is spent, not outstanding.
    const settled = p.legs.filter((l) => l.status === 'settled');
    assert.ok(settled.length > 0, 'recovery means a leg committed money');
    assert.equal(
      w.coordinator.outstandingCents(p),
      settled.reduce((s, l) => s + l.amountCents, 0),
      'the outstanding amount is exactly the committed principal',
    );
  }
  // The retained initiation evidence behind an employee leg: a device or
  // exception signature for the exact amount and fee, or the verified
  // standing-terms snapshot plus the admission record for the exact debit.
  // The evidence retained at initiation is what is checked — today's terms
  // are never applied retroactively, so a later revocation erases nothing.
  const employeeLeg = p.legs.find((l) => l.leg === 'employee');
  if (employeeLeg) {
    const auth = authorizationFor(p, EMPLOYEE);
    assert.ok(auth, 'an employee leg exists only with retained authorization evidence');
    if (auth.basis === 'mandate') {
      assert.ok(verifyPayload(auth.mandate, w.keys, EMPLOYEE), 'the retained mandate snapshot verifies');
      assert.equal(auth.proposalVersion, p.proposal.version);
      assert.equal(auth.employeeDebitCents, employeeLeg.amountCents + employeeLeg.feeCents, 'the admission authorized this exact debit');
      assert.equal(employeeLeg.authorityRef, auth.mandate.payload.mandateRef);
      const b = ctx.bookings.get(p.purchaseId);
      assert.ok(b, 'a mandate-funded leg carries an automatic-budget booking');
      assert.equal(b.cents, auth.employeeDebitCents);
      assert.equal(p.submission?.bookingMonth, b.month, 'the booking month is the admission month');
    } else {
      assert.ok(verifyPayload(auth.approval, w.keys, EMPLOYEE), 'the retained approval verifies');
      // The signature binds this purchase, this proposal version and this
      // payer's exact amount and fee — evidence for other terms is none.
      assert.equal(auth.approval.payload.purchaseId, p.purchaseId);
      assert.equal(auth.approval.payload.proposalVersion, p.proposal.version);
      // It was live at the send instant; lapsing later revokes nothing —
      // replays reuse the frozen request without re-approving.
      const sentAt = ctx.sentAt.get(p.purchaseId);
      assert.ok(sentAt !== undefined, 'a purchase with legs has a recorded admission instant');
      assert.ok(sentAt <= auth.approval.payload.expiresAt, 'the retained approval was unexpired at send');
      assert.equal(employeeLeg.amountCents, auth.approval.payload.amountCents, 'the employee pays exactly what they approved');
      assert.equal(employeeLeg.feeCents, auth.approval.payload.feeCents, 'and exactly the fee they approved');
      assert.equal(employeeLeg.authorityRef, auth.approval.payload.approvalRef);
      if (auth.basis === 'exception') {
        // The signed acknowledgment must carry the fields the coordinator
        // recomputes: the flag, the mandate revision acknowledged, its
        // maximum at that revision and the exact overage of this debit.
        const a = auth.approval.payload;
        assert.equal(a.exception, true, 'an exception approval signs its acknowledgment flag');
        assert.ok(
          a.mandateRef !== undefined && a.mandateVersion !== undefined && a.maxCents !== undefined && a.overByCents !== undefined,
          'an exception signs the revision, maximum and overage it acknowledges',
        );
        const revision = ctx.revisions.get(`${a.mandateRef}:${a.mandateVersion}`);
        assert.ok(revision, 'an exception acknowledges a mandate revision never published');
        assert.equal(a.maxCents, revision.maxCents, 'the acknowledged maximum is the revision’s own');
        assert.equal(
          a.overByCents,
          a.amountCents + a.feeCents - a.maxCents,
          'the acknowledged overage is exactly this debit above the maximum',
        );
        assert.ok(a.overByCents > 0, 'an exception acknowledges a real overage');
      }
    }
  }
  // The one Auto receipt a completed mandate-authorized purchase earns,
  // bound to the revision that paid; device and exception payments earn none.
  if (p.state === 'completed' && employeeLeg) {
    const auth = authorizationFor(p, EMPLOYEE);
    if (auth?.basis === 'mandate') {
      assert.ok(p.receipt, 'a completed automatic purchase retains its receipt');
      assert.equal(p.receipt.mandateVersion, auth.mandate.payload.version);
      assert.equal(p.receipt.debitCents, employeeLeg.amountCents + employeeLeg.feeCents);
      assert.equal(p.receipt.disputeUntil, p.receipt.receiptAt + w.coordinator.disputeWindowMinutes, 'the dispute window is fixed at first observation');
    } else {
      assert.equal(p.receipt, undefined, 'device and exception payments earn no Auto receipt');
    }
  }
  // A dispute case exists only on a receipted purchase of its own employee,
  // opened inside the window fixed on the receipt.
  if (p.dispute) {
    assert.ok(p.receipt, 'a dispute case exists only on a receipted purchase');
    assert.equal(p.dispute.employeeId, p.benefit?.employeeId);
    assert.ok(p.dispute.openedAt <= p.receipt.disputeUntil, 'the case opened inside its window');
  }
}

function checkInvariants(w: World, ps: readonly Purchase[], ctx: Ctx): void {
  checkFirstHandoffs(w, ctx);
  assert.equal(totalMoney(w), ctx.money, 'money is neither created nor destroyed');
  assert.ok(w.trace.events.every((e) => e.origin === 'LOCAL'), 'local runs only produce LOCAL evidence');
  assert.ok(!w.trace.events.some((e) => e.event === 'employee_mandate_rejected'), 'a well-formed publication is never rejected');
  for (const p of ps) checkPurchase(w, p, ctx);
  assert.ok(w.backend.executionCount() <= ctx.keys.size, 'at most one execution per idempotency key');
}

// The employee signs and publishes fresh standing terms when none exist —
// the only path a no-mandate world has to automatic authority.
function publishTerms(r: () => number, w: World, longLived: boolean, revoked = false): void {
  const maxCents = pick(r, [600, 800, 1_000, 1_500]);
  const terms: EmployeeMandate = {
    mandateRef: 'employee-mandate-1',
    employeeId: EMPLOYEE,
    version: 1,
    autoPayMaxCents: Math.min(maxCents, pick(r, [0, 300, 600])),
    maxCents,
    autoPayMonthlyCents: pick(r, [0, 500, 900, 3_000]),
    trustedMerchants: pick(r, [[MERCHANT_A], [MERCHANT_A, MERCHANT_B], []]),
    blockedMerchants: [],
    validUntil: longLived ? 200_000 : pick(r, [200, 1_000]),
    revoked,
  };
  w.authority.publishEmployeeMandate(signPayload(terms, w.signers.get(EMPLOYEE)!));
}

// One signed revision of the standing terms, always well-formed: a rejection
// of what the device produces would be a defect, not a refusal.
function editTerms(r: () => number, w: World, longLived: boolean): void {
  const current = w.coordinator.employeeMandate(EMPLOYEE);
  if (!current) {
    publishTerms(r, w, longLived);
    return;
  }
  const m = current.payload;
  switch (pick(r, ['max', 'auto', 'monthly', 'trust', 'block', 'expiry', 'ref', 'lift'] as const)) {
    case 'max': {
      const maxCents = Math.floor(r() * 1_600);
      updateEmployeeMandate(w, { maxCents, autoPayMaxCents: Math.min(m.autoPayMaxCents, maxCents) });
      return;
    }
    case 'auto':
      updateEmployeeMandate(w, { autoPayMaxCents: Math.floor(r() * (m.maxCents + 1)) });
      return;
    case 'monthly':
      updateEmployeeMandate(w, { autoPayMonthlyCents: Math.floor(r() * 2_000) });
      return;
    case 'trust': {
      const trusted = new Set(m.trustedMerchants);
      const id = pick(r, MERCHANTS);
      if (trusted.has(id)) trusted.delete(id);
      else trusted.add(id);
      updateEmployeeMandate(w, { trustedMerchants: [...trusted] });
      return;
    }
    case 'block': {
      const blocked = new Set(m.blockedMerchants);
      const id = pick(r, MERCHANTS);
      if (blocked.has(id)) blocked.delete(id);
      else blocked.add(id);
      updateEmployeeMandate(w, { blockedMerchants: [...blocked] });
      return;
    }
    case 'expiry':
      updateEmployeeMandate(w, { validUntil: w.coordinator.now + Math.floor(r() * 2_000) });
      return;
    case 'ref':
      updateEmployeeMandate(w, { mandateRef: m.mandateRef === 'employee-mandate-1' ? 'employee-mandate-2' : 'employee-mandate-1' });
      return;
    case 'lift':
      updateEmployeeMandate(w, { revoked: false });
      return;
  }
}

async function step(r: () => number, w: World, p: Purchase | undefined, longLived: boolean, action: Action): Promise<void> {
  const c = w.coordinator;
  switch (action) {
    case 'approve':
      approveAs(w, p!);
      return;
    case 'approveException':
      // A signed one-off exception acknowledges the current verified terms;
      // without a record there is nothing to acknowledge against.
      if (!c.employeeMandate(EMPLOYEE)) return;
      approveAs(w, p!, EMPLOYEE, { exception: true });
      return;
    case 'submit':
      await c.submit(p!, pick(r, MODES));
      return;
    case 'resubmit':
      await c.resubmit(p!);
      return;
    case 'reconcile':
      await c.reconcile(p!);
      return;
    case 'recover':
      await c.recover(p!);
      return;
    case 'refund':
      await c.refund(p!);
      return;
    case 'dispute':
      await c.dispute(p!, EMPLOYEE);
      return;
    case 'cancel':
      c.cancel(p!);
      return;
    case 'refresh':
      c.refreshAuthorization(p!);
      return;
    case 'advance':
      // Long-lived fixtures sometimes jump across a UTC month boundary.
      advance(w, c.now + (longLived && r() < 0.3 ? Math.floor(r() * 45_000) : Math.floor(r() * 40)));
      return;
    case 'reprice':
      c.changeOffer(p!, {
        merchantId: pick(r, MERCHANTS),
        totalCents: 300 + Math.floor(r() * 1_400),
        expiresAt: longLived ? 200_000 : pick(r, [20, 1_000, 1_000, 1_000]),
      });
      return;
    case 'employeeEdit':
      editTerms(r, w, longLived);
      return;
    case 'revokeEmployee':
      if (c.employeeMandate(EMPLOYEE)) updateEmployeeMandate(w, { revoked: true });
      else publishTerms(r, w, longLived, true);
      return;
    case 'revokeEmployer':
      updateMandate(w, { revoked: true });
      return;
    case 'lowerEmployerCap':
      updateMandate(w, { revoked: false, maxPerPurchaseCents: Math.floor(r() * 600) });
      return;
    case 'pspFlip':
      for (const psp of w.psps.values()) psp.available = r() < 0.5;
      return;
    default:
      throw new Error(`unhandled action ${action}`);
  }
}

test(`safety invariants hold across ${SEEDS} random runs`, async (t) => {
  let firstHandoffs = 0;
  let deferredHandoffs = 0;
  let renewedGrantRechecks = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    // Long-lived runs keep offers and mandates valid across month jumps.
    const longLived = r() < 0.25;
    // Standing terms: about half of the runs enable automatic payment with
    // randomized limits, some start with no record at all, the rest keep the
    // manual-only default.
    const variant = r();
    let employeeMandate: EmployeeMandate | null | undefined;
    let capable = false;
    if (variant < 0.6) {
      const maxCents = pick(r, [800, 1_000, 1_500]);
      employeeMandate = {
        ...AUTO_EMPLOYEE_TERMS,
        autoPayMaxCents: Math.min(maxCents, pick(r, [0, 500, 600, 700, 900])),
        maxCents,
        autoPayMonthlyCents: pick(r, [0, 400, 600, 900, 1_200, 2_000]),
        trustedMerchants: pick(r, [[MERCHANT_A], [MERCHANT_A, MERCHANT_B]]),
        blockedMerchants: pick(r, [[], [MERCHANT_C]]),
        validUntil: longLived ? 200_000 : pick(r, [200, 1_000]),
      };
      capable = r() < 0.85;
    } else if (variant < 0.68) {
      employeeMandate = null;
    }
    const w = world(
      { deCents: Math.floor(r() * 2_000), reverseWaterfall: r() < 0.5 },
      // Auto worlds always raise the daily subsidy so several purchases keep
      // a small employee debit; manual worlds keep the tight default often.
      employeeMandate !== undefined || longLived || r() < 0.5
        ? {
            validUntil: longLived ? 200_000 : 1_000,
            maxPerDayCents: 10_000,
            maxPurchasesPerDay: 10,
            maxPerPurchaseCents: pick(r, [500, 500, 700, 900]),
          }
        : {},
      { initiation: r() < 0.3 ? 'per_payer_psp' : 'coordinator', employeeMandate, supportsMandatePayments: capable },
    );
    w.backend.faults.set(EMPLOYEE, pick(r, FAULTS));
    w.backend.faults.set(EMPLOYER, pick(r, FAULTS));
    w.backend.refundsSupported = r() < 0.7;
    // Some runs lose a return response once: the return really executes, its
    // answer never arrives — the oracle must see the attempt preserved and
    // resolved through the same execution reference, not a blind retry.
    if (r() < 0.15) {
      const refund = w.backend.refund.bind(w.backend);
      let lose = true;
      w.backend.refund = async (ref) => {
        const out = await refund(ref);
        if (lose) {
          lose = false;
          throw new Error('synthetic lost refund response');
        }
        return out;
      };
    }
    const ps: Purchase[] = [];
    let nextId = 0;
    const ctx: Ctx = {
      money: totalMoney(w),
      keys: new Set(),
      legKeys: new Map(),
      execOwner: new Map(),
      submissions: new Map(),
      traceCursor: w.trace.events.length,
      usage: new Map(),
      bookings: new Map(),
      revisions: new Map(),
      lastZone: new Map(),
      sentAt: new Map(),
      handoffs: new Map(),
      checkedHandoffs: new Set(),
      handoffCaptureErrors: [],
    };
    observeFirstHandoffs(w, ps, ctx);
    recordCaps(w, ctx);
    const done: string[] = [];
    // Give a subset of eligible PSP worlds a deferred automatic handoff
    // before the random suffix. Amounts, faults, balances and later actions
    // still vary by seed. Renewing otherwise identical terms isolates the
    // revision rule; the route observer, not a coordinator reason string,
    // must catch a stale grant actually reaching the backend.
    if (seed % 4 === 0 && w.psps.size > 0 && capable && employeeMandate && employeeMandate.autoPayMaxCents > 0 && employeeMandate.autoPayMonthlyCents > 0) {
      renewedGrantRechecks++;
      try {
        done.push('deferred-auto:propose');
        const debit = Math.min(employeeMandate.autoPayMaxCents, employeeMandate.autoPayMonthlyCents, 100 + Math.floor(r() * 300));
        const p = lunch(w, w.mandate.maxPerPurchaseCents + debit, MERCHANT_A, { purchaseId: `purchase-${++nextId}`, expiresAt: 1_000 });
        ps.push(p);
        foldEvents(w, ps, ctx);
        checkInvariants(w, ps, ctx);
        done.push('deferred-auto:submit-with-employee-psp-down');
        w.psps.get(EMPLOYEE)!.available = false;
        await w.coordinator.submit(p, 'atomic');
        foldEvents(w, ps, ctx);
        checkInvariants(w, ps, ctx);
        done.push('deferred-auto:renew-and-retry');
        updateEmployeeMandate(w, {});
        recordCaps(w, ctx);
        w.psps.get(EMPLOYEE)!.available = true;
        await w.coordinator.resubmit(p);
        foldEvents(w, ps, ctx);
        checkInvariants(w, ps, ctx);
      } catch (err) {
        throw new Error(`seed ${seed} after ${done.join(' > ')}: ${(err as Error).message}`);
      }
    }
    for (let i = 0; i < STEPS; i++) {
      let action = pick(r, ACTIONS);
      const p = ps.length > 0 ? pick(r, ps) : undefined;
      if (!p && !WORLD_ACTIONS.has(action)) action = 'propose';
      done.push(p ? `${action}@${p.purchaseId}` : action);
      try {
        if (action === 'propose') {
          if (ps.length < MAX_PURCHASES) {
            ps.push(
              lunch(w, 300 + Math.floor(r() * 1_400), pick(r, OFFER_MERCHANTS), {
                purchaseId: `purchase-${++nextId}`,
                expiresAt: longLived ? 200_000 : pick(r, [20, 1_000, 1_000, 1_000]),
                feesCents: r() < 0.3 ? Math.floor(r() * 25) : undefined,
              }),
            );
          }
        } else {
          await step(r, w, p, longLived, action);
        }
      } catch (err) {
        const refused = err instanceof PspUnavailableError || (err instanceof Error && REFUSALS.test(err.message));
        if (!refused) throw new Error(`seed ${seed} after ${done.join(' > ')}: ${String(err)}`);
      }
      try {
        recordCaps(w, ctx);
        foldEvents(w, ps, ctx);
        checkInvariants(w, ps, ctx);
      } catch (err) {
        throw new Error(`seed ${seed} after ${done.join(' > ')}: ${(err as Error).message}`);
      }
    }
    // Drain: drive each purchase once toward a terminal state so reservation
    // consumption, releases, receipts and dispute outcomes are reached in
    // every run, not only where random order happened to land. The full check
    // runs after every single drain step — a breach between two steps of a
    // drain must surface at the step that caused it.
    for (const p of ps) {
      for (const action of DRAIN) {
        done.push(`drain:${action}@${p.purchaseId}`);
        try {
          await step(r, w, p, longLived, action);
        } catch (err) {
          const refused = err instanceof PspUnavailableError || (err instanceof Error && REFUSALS.test(err.message));
          if (!refused) throw new Error(`seed ${seed} after ${done.join(' > ')}: ${String(err)}`);
        }
        try {
          recordCaps(w, ctx);
          foldEvents(w, ps, ctx);
          checkInvariants(w, ps, ctx);
        } catch (err) {
          throw new Error(`seed ${seed} after ${done.join(' > ')}: ${(err as Error).message}`);
        }
      }
    }
    try {
      recordCaps(w, ctx);
      foldEvents(w, ps, ctx);
      checkInvariants(w, ps, ctx);
    } catch (err) {
      throw new Error(`seed ${seed} after ${done.join(' > ')}: ${(err as Error).message}`);
    }
    firstHandoffs += ctx.checkedHandoffs.size;
    deferredHandoffs += [...ctx.handoffs.values()].filter((h) =>
      h.purchase.submission!.legs.find((l) => l.idempotencyKey === h.request.idempotencyKey)?.dispatch === 'refused',
    ).length;
  }
  assert.ok(deferredHandoffs > 0, 'generated sequences exercise first handoffs after a pre-forward refusal');
  assert.ok(renewedGrantRechecks > 0, 'generated sequences retry an unsent automatic leg after mandate renewal');
  t.diagnostic(`checked ${firstHandoffs} first handoffs (${deferredHandoffs} deferred), plus ${renewedGrantRechecks} renewed-grant rechecks`);
});
