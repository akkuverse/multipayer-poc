// GENERATED from src/evidence/findings.ts — type-stripped build artifact; never hand-edit.
// The findings table of docs/experiment-protocol.md, generated from actual
// runs. Local results only ever fill the local column; the ECB column stays
// 'not tested' until an adapter run records ECB_API evidence.

import { scenarios, QUESTIONS, FIXTURE_VERSION } from '../scenarios.js';
import { recordRun, settlementOf } from './run-record.js';

const HEADER = [
  '| Scenario | Question | Local mock | ECB test environment | Run reference | Application responsibility | Infrastructure gap | Limitation |',
  '|---|---|---|---|---|---|---|---|',
];

export async function findingsTable(runId        )                  {
  const rows = [...HEADER];
  for (const s of scenarios) {
    const result = await s.run();
    const problem = s.check(result);
    const r = recordRun(runId, s.id, result.w, result.p);
    const impl = settlementOf(r);
    const local = `${problem ? `observed/fail (${problem})` : 'observed/pass'}, ${impl.name} ${impl.specVersion}`;
    rows.push(
      `| ${s.id} | ${s.question} ${QUESTIONS[s.question]} | ${local} | not tested | ${r.runId} ${r.traceDigest} | ${s.responsibility} | unknown until tested | Local mock semantics are assumptions |`,
    );
  }
  return `Findings ${runId}, fixtures ${FIXTURE_VERSION}\n\n${rows.join('\n')}`;
}
