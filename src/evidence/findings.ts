// The findings table of docs/experiment-protocol.md, generated from actual
// runs. Local results only ever fill the local column; the ECB column stays
// 'not tested' until an adapter run records ECB_API evidence.

import { scenarios, QUESTIONS, FIXTURE_VERSION } from '../scenarios.ts';
import { recordRun } from './run-record.ts';

const HEADER = [
  '| Scenario | Question | Local mock | ECB test environment | Run reference | Application responsibility | Infrastructure gap | Limitation |',
  '|---|---|---|---|---|---|---|---|',
];

export async function findingsTable(runId: string): Promise<string> {
  const rows = [...HEADER];
  for (const s of scenarios) {
    const result = await s.run();
    const problem = s.check(result);
    const r = recordRun(runId, s.id, result.w, result.p);
    const local = `${problem ? `observed/fail (${problem})` : 'observed/pass'}, ${r.settlement.name} ${r.settlement.specVersion}`;
    rows.push(
      `| ${s.id} | ${s.question} ${QUESTIONS[s.question]} | ${local} | not tested | ${r.runId} ${r.traceDigest} | ${s.responsibility} | unknown until tested | Local mock semantics are assumptions |`,
    );
  }
  return `Findings ${runId}, fixtures ${FIXTURE_VERSION}\n\n${rows.join('\n')}`;
}
