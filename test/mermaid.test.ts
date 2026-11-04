import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../src/scenarios.ts';
import { toMermaid } from '../src/evidence/mermaid.ts';

const run = (id: string) => scenarios.find((s) => s.id.startsWith(id))!.run();

test('a trace becomes a sequence diagram with one line per event', async () => {
  const { w } = await run('S01');
  const lines = toMermaid(w.trace.events).split('\n');
  assert.equal(lines[0], 'sequenceDiagram');
  assert.ok(lines.includes('  participant coordinator as coordinator'));
  assert.ok(lines.includes('  participant orchestrator as orchestrator'));
  assert.ok(lines.includes('  participant de_ledger as de-ledger'));
  // Each payer's provider drives its own ledger work: the employee's
  // digital-euro reserve lands on the Eurosystem ledger, the employer's
  // bank transfer on the interbank rail, and orchestrator events render as
  // replies to the coordinator.
  assert.ok(lines.some((l) => l.startsWith('  psp_employee_1->>de_ledger: [LOCAL] provider_reserve_done')));
  assert.ok(lines.some((l) => l.startsWith('  orchestrator-->>coordinator: [LOCAL] leg_reserve')));
  assert.ok(lines.some((l) => l.startsWith('  coordinator->>orchestrator: [LOCAL] submit')));
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
  // The employer leg's conclusive reserve refusal is an orchestrator event
  // drawn as a reply, not a provider handoff that never happened.
  assert.ok(
    text.split('\n').some(
      (l) => l.startsWith('  orchestrator-->>coordinator: [LOCAL] leg_reserve') && l.includes('status=rejected'),
    ),
  );
});
