import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../src/scenarios.ts';
import { toMermaid } from '../src/evidence/mermaid.ts';

const run = (id: string) => scenarios.find((s) => s.id.startsWith(id))!.run();

test('unanswered requests retain distinct receiver lifelines even when actor IDs collide', () => {
  const diagram = toMermaid(['psp-silent', 'psp_silent'].map((to, i) => ({
    seq: i + 1,
    origin: 'LOCAL' as const,
    actor: 'orchestrator',
    event: 'reserve_requested',
    detail: { key: `reserve-${i}`, to, parent: 'purchase-1', attempt: 1 },
  })));
  assert.ok(diagram.includes('  participant psp_silent as psp-silent'));
  assert.ok(diagram.includes('  participant psp_silent_2 as psp_silent'));
  assert.ok(diagram.includes('  orchestrator->>psp_silent: [LOCAL] reserve_requested key=reserve-0'));
  assert.ok(diagram.includes('  orchestrator->>psp_silent_2: [LOCAL] reserve_requested key=reserve-1'));
});

test('a trace becomes a sequence diagram with one line per event', async () => {
  const { w } = await run('S01');
  const lines = toMermaid(w.trace.events).split('\n');
  assert.equal(lines[0], 'sequenceDiagram');
  assert.ok(lines.includes('  participant coordinator as coordinator'));
  assert.ok(lines.includes('  participant orchestrator as orchestrator'));
  assert.ok(lines.includes('  participant de_ledger as de-ledger'));
  // Each payer's provider drives its own rail's ledger work: the employee's
  // digital-euro reserve lands on the Eurosystem ledger, the employer's
  // bank reserve on the interbank module — never the other ledger — and
  // orchestrator events render as replies to the coordinator.
  assert.ok(lines.some((l) => l.startsWith('  psp_employee_1->>de_ledger: [LOCAL] provider_reserve_done')));
  assert.ok(lines.some((l) => l.startsWith('  psp_employer_1->>bank_transfer: [LOCAL] provider_reserve_done')));
  assert.ok(lines.some((l) => l.startsWith('  orchestrator-->>coordinator: [LOCAL] leg_reserve')));
  assert.ok(lines.some((l) => l.startsWith('  coordinator->>orchestrator: [LOCAL] submit')));
  // Ledger events reply to the book they moved: the employee's provider on
  // the hold, the employer's on the debit, the shop's on the credit.
  assert.ok(lines.some((l) => l.startsWith('  de_ledger-->>psp_employee_1: [LOCAL] de_hold_reserved')));
  assert.ok(lines.some((l) => l.startsWith('  bank_transfer-->>psp_employer_1: [LOCAL] bank_transfer_debited')));
  assert.ok(lines.some((l) => l.startsWith('  bank_transfer-->>psp_shop_merchant_a: [LOCAL] bank_transfer_credited')));
  // The group commit answers the providers' collective that dispatched it —
  // the orchestrator never called the ledger itself.
  assert.ok(lines.some((l) => l.startsWith('  de_ledger-->>de_providers: [LOCAL] de_group_committed')));
  const participants = lines.filter((l) => l.startsWith('  participant')).length;
  assert.equal(lines.length, 1 + participants + w.trace.events.length);
});

test('labels avoid characters Mermaid treats specially', async () => {
  for (const s of scenarios) {
    const { w } = await s.run();
    for (const line of toMermaid(w.trace.events).split('\n').slice(1)) {
      const afterColon = line.split(': ').slice(1).join(': ');
      assert.doesNotMatch(afterColon, /[;#<>]/, `${s.id}: ${line}`);
      if (line.startsWith('  participant')) assert.doesNotMatch(line, /[;#<>]/, `${s.id}: ${line}`);
    }
  }
});

test('automatic-payment events keep their identifying fields; nested payloads stay out of labels', async () => {
  const { w } = await run('S19');
  const text = toMermaid(w.trace.events);
  // Budget deltas and receipt terms render as flat fields in the diagram.
  assert.ok(text.includes('autopay_reserved purchaseId=purchase-1'));
  assert.ok(text.includes('cents=400'));
  assert.ok(text.includes('autopay_receipt'));
  assert.ok(text.includes('disputeUntil=1450'));
  // Nested observation payloads would be unreadable as [object Object];
  // their identifying fields render, the blob does not.
  assert.ok(!text.includes('[object Object]'));
  assert.ok(text.includes('presenter_select'));
});

test('provider work is an arrow to its ledger; orchestrator refusals are notes, not fake requests', async () => {
  const { w } = await run('S13');
  const text = toMermaid(w.trace.events);
  assert.ok(text.includes('participant psp_employee_1 as psp-employee-1'));
  assert.ok(text.includes('psp_employee_1->>de_ledger: [LOCAL] provider_reserve_done'));
  // The employer provider's unavailability was never a ledger call: with no
  // rail evidence the event renders as a note on the provider.
  assert.ok(text.split('\n').some((l) => l.startsWith('  Note over psp_employer_1: [LOCAL] provider_unavailable')));
  // The employer leg's conclusive reserve refusal is an orchestrator event
  // drawn as a reply, not a provider handoff that never happened.
  assert.ok(
    text.split('\n').some(
      (l) => l.startsWith('  orchestrator-->>coordinator: [LOCAL] leg_reserve') && l.includes('status=rejected'),
    ),
  );
});
