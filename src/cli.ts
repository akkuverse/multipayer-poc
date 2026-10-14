// Run every scenario (or those whose id contains the filter argument).
//   pnpm scenarios [filter]          trace and final balances
//   pnpm scenarios [filter] --json   one run record per scenario, as JSON
//   pnpm findings                    findings table (Markdown)

import { scenarios } from './scenarios.ts';
import { findingsTable } from './findings.ts';
import { recordRun, traceDigest } from './run-record.ts';
import type { RunRecord } from './run-record.ts';
import { euro } from './trace.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
// Substring match on the scenario id: 'S03' runs one, 'S0' runs nine.
const filter = args.find((a) => !a.startsWith('--')) ?? '';
const selected = scenarios.filter((x) => x.id.includes(filter));
// One identifier for the whole invocation; each record also names its scenario.
const runId = `run-${new Date().toISOString().replace(/[-:.]/g, '')}`;

if (flags.has('--findings')) {
  console.log(await findingsTable(runId));
} else if (flags.has('--json')) {
  const records: RunRecord[] = [];
  for (const s of selected) {
    const { w, p } = await s.run();
    records.push(recordRun(runId, s.id, w, p));
  }
  console.log(JSON.stringify(records, null, 2));
} else {
  for (const s of selected) {
    const { w, p } = await s.run();
    console.log(`\n=== ${s.id}: ${s.title}`);
    console.log(w.trace.format());
    // Summary line: derived state, return status and money still committed,
    // then the balance of every relevant account, holdings and linked bank.
    const outstanding = w.coordinator.outstandingCents(p);
    console.log(
      `--> state=${p.state}${p.reason ? ` (${p.reason})` : ''} returns=${p.returnStatus} outstanding=${euro(outstanding)}`,
    );
    console.log(`    ${runId} trace ${traceDigest(w.trace.events)}`);
    for (const [id, a] of w.backend.accounts) {
      console.log(`    ${id.padEnd(11)} digital euro ${euro(a.deCents).padStart(12)}   linked bank ${euro(a.linkedBankCents).padStart(12)}`);
    }
  }
}
