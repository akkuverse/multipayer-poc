import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../src/scenarios.ts';
import { toMermaid } from '../src/mermaid.ts';

const run = (id: string) => scenarios.find((s) => s.id.startsWith(id))!.run();

test('a trace becomes a sequence diagram with one line per event', async () => {
  const { w } = await run('S01');
  const lines = toMermaid(w.trace.events).split('\n');
  assert.equal(lines[0], 'sequenceDiagram');
  assert.ok(lines.includes('  participant coordinator as coordinator'));
  assert.ok(lines.includes('  participant backend as backend'));
  assert.ok(lines.some((l) => l.startsWith('  coordinator->>backend: [LOCAL] submit')));
  assert.ok(lines.some((l) => l.startsWith('  backend-->>coordinator: [LOCAL] submit')));
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

test('PSP forwards are arrows; a refused forward is a note, not a fake request', async () => {
  const { w } = await run('S17');
  const text = toMermaid(w.trace.events);
  assert.ok(text.includes('participant psp_employee_1 as psp-employee-1'));
  assert.ok(text.includes('psp_employee_1->>backend: [LOCAL] forward'));
  assert.ok(
    text.split('\n').some(
      (l) => l.startsWith('  Note over psp_employer_1: [LOCAL] psp_unavailable'),
    ),
  );
});
