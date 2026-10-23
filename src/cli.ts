// Run every scenario (or those whose id contains the filter argument).
//   pnpm scenarios [filter]            trace and final balances
//   pnpm scenarios [filter] --json     one run record per scenario, as JSON
//   pnpm scenarios [filter] --mermaid  sequence diagrams (Markdown)
//   pnpm findings                      findings table (Markdown)
//   pnpm presenter                     scripted synthetic presenter: labelled
//                                      conversations, audit evidence, comparison
//   pnpm --silent presenter --json     one JSON document: four records + comparison
//   pnpm --silent presenter --markdown shareable comparison document (Markdown)
//   --run-id=<id>                      pin the run id for deterministic artifacts;
//                                      default is the wall-clock convention below

import { scenarios } from './scenarios.ts';
import { findingsTable } from './evidence/findings.ts';
import { toMermaid } from './evidence/mermaid.ts';
import { PRESENTER_LABEL, runPresenterJourneys } from './presenter/journeys.ts';
import type { ComparisonRef, ComparisonRow, PresenterRecord } from './presenter/journeys.ts';
import { recordRun, traceDigest } from './evidence/run-record.ts';
import type { RunRecord } from './evidence/run-record.ts';
import { euro } from './evidence/trace.ts';
import type { TraceEvent } from './core/types.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
// Substring match on the scenario id: 'S03' runs one, 'S0' runs nine.
const filter = args.find((a) => !a.startsWith('--')) ?? '';
const selected = scenarios.filter((x) => x.id.includes(filter));
// One identifier for the whole invocation; each record also names its
// scenario. --run-id pins it (presenter artifacts); otherwise wall clock.
const runIdArg = args.find((a) => a.startsWith('--run-id='));
const runId = runIdArg?.slice('--run-id='.length) || `run-${new Date().toISOString().replace(/[-:.]/g, '')}`;

// The presenter report: the four journey/mode records plus the comparison
// rows they carry. Every output format renders from this one object — no
// output path recomputes anything.
interface PresenterReport {
  label: typeof PRESENTER_LABEL;
  runId: string;
  records: PresenterRecord[];
  comparison: ComparisonRow[];
}

// One trace event, same fixed-width shape as Trace.format().
const fmtEvent = (e: TraceEvent): string =>
  `${String(e.seq).padStart(3)} [${e.origin}] ${e.actor.padEnd(11)} ${e.event}${e.detail ? ' ' + JSON.stringify(e.detail) : ''}`;

// Compact evidence reference: the run's scenario id plus the trace sequences
// behind an observation. The Markdown renderer prints it verbatim so a
// reader (and the CLI smoke test) can match it against the JSON record.
const refText = (refs: ComparisonRef[]): string => refs.map((r) => `${r.scenarioId}#${r.eventSeqs.join(',')}`).join(' ');

const outcomeLine = (rec: PresenterRecord): string => {
  const res = rec.run.result;
  return `state=${res.state}${res.reason ? ` (${res.reason})` : ''} returns=${res.returnStatus} outstanding=${euro(res.outstandingCents)}`;
};

// pnpm presenter: the labelled conversation with the audit events behind
// each message printed right under it, then outcome and comparison rows.
const presenterText = (report: PresenterReport): string => {
  const out: string[] = [
    `${PRESENTER_LABEL} — run ${report.runId}`,
    'Synthetic actors and amounts; every event below is LOCAL. Not evidence of live model reasoning.',
    'Audit evidence under each message is an evaluator view — the assistant only ever received projections.',
  ];
  for (const rec of report.records) {
    out.push(`\n=== ${rec.run.scenarioId}: journey ${rec.journey} · mode ${rec.mode}`);
    out.push(
      `    presenter fixtures ${rec.presenterFixtureVersion} · scenario fixtures ${rec.run.fixtureVersion} · ` +
        `backend ${rec.run.backend.name} (${rec.run.backend.origin}, spec ${rec.run.backend.specVersion})`,
    );
    for (const m of rec.conversation) {
      out.push(`\n${m.role} → ${m.recipient} · ${m.authority} · ${m.messageId}`);
      out.push(`  ${m.text}`);
      out.push('  audit evidence:');
      for (const s of m.eventSeqs) out.push(`    ${fmtEvent(rec.run.events[s - 1])}`);
    }
    out.push(`\n--> ${outcomeLine(rec)}`);
    out.push(`    ${rec.run.runId} trace ${rec.run.traceDigest}`);
    out.push('  comparison (manual assessment of a synthetic run):');
    for (const row of rec.comparison) {
      out.push(`    [${row.aspect}] ${row.observation}`);
      out.push(`      evidence: ${refText(row.refs)}`);
    }
  }
  return out.join('\n');
};

const JOURNEY_TITLES: Record<PresenterRecord['journey'], string> = {
  'changed-offer': 'Changed offer and a pending outcome',
  'funding-loss': 'Lost employer contribution',
};

// What each journey is built to show — fixed narrative labels, not data
// recomputed from the records.
const JOURNEY_NOTES: Record<PresenterRecord['journey'], string> = {
  'changed-offer':
    'Offer A is approved while live and expires before submission. The replacement B would put ' +
    'EUR 9.00 on the employee — above the standing EUR 8.00 maximum, so only a signed exception ' +
    'or a lasting terms edit could pay it — and the user instead chooses ' +
    'eligible alternative C and approves the new proposal version. The mock backend loses the ' +
    "employer leg's first response (`timeout_then_settle`), so the outcome is pending until " +
    'trusted reconciliation observes it.',
  'funding-loss':
    'Offer A is approved while live, then the employer mandate is revoked between approval ' +
    'and initiation. Submission must fail without charging the employee more than the ' +
    'approved EUR 8.00 share.',
};

// pnpm --silent presenter --markdown: the shareable artifact rendered from
// the same report. Conversation messages quote their evidence sequences;
// comparison rows cite them as `scenarioId#seqs`, matching the JSON document.
const presenterMarkdown = (report: PresenterReport): string => {
  const first = report.records[0];
  const out: string[] = [
    '# Multi-payer presenter comparison',
    '',
    `**${PRESENTER_LABEL[0].toUpperCase()}${PRESENTER_LABEL.slice(1)}** — a reproducible synthetic design`,
    'comparison, not user testing and not evidence of live model reasoning, consumer',
    'preference or ECB capability. Actors, offers and amounts are synthetic; every',
    'trace event is `LOCAL`; no personal data, no real money, no network calls.',
    '',
    `- Label: \`${PRESENTER_LABEL}\``,
    `- Run id: \`${report.runId}\``,
    `- Reproduce this document: \`pnpm --silent presenter --markdown --run-id=${report.runId}\``,
    `- Same records as JSON: \`pnpm --silent presenter --json --run-id=${report.runId}\``,
    `- Presenter fixtures \`${first.presenterFixtureVersion}\`; scenario fixtures \`${first.run.fixtureVersion}\`; ` +
      `backend \`${first.run.backend.name}\` (\`${first.run.backend.origin}\`, spec \`${first.run.backend.specVersion}\`).`,
    '',
    '## Setup',
    '',
    'One presenter session owns one purchase under the employee\'s signed standing terms: a',
    'vegetarian lunch within ten *walking* minutes, at most EUR 8.00 personally, employer',
    'benefit if it applies. The agent handle can only discover, evaluate, select offers',
    'and explain under a signed session-scoped grant; approvals and submission go through',
    'the separate trusted user-flow handle. Two journeys run in fresh worlds, each in two',
    'delivery modes:',
    '',
    '- **scripted** — the fixed script drives the agent handle for reads and selections.',
    '- **manual** — the same steps drive the trusted handle, like a conventional filter-and-checkout.',
    '',
    'Both modes require the same explicit user approvals; the assistant never approves,',
    'submits, retries or publishes new standing terms.',
    '',
    'Evidence references: `events n` beside a message, and `scenarioId#n` in the',
    "comparison tables, are `seq` numbers into that run's `events` array in the JSON",
    'document; `pnpm presenter` prints the cited audit events under each message.',
    '',
  ];
  for (const rec of report.records) {
    out.push(`## ${JOURNEY_TITLES[rec.journey]} — ${rec.mode} mode`);
    out.push('');
    out.push(JOURNEY_NOTES[rec.journey]);
    if (rec.mode === 'manual') {
      out.push(
        'Same fixed script and identical conversation as scripted mode; the trace digest ' +
          'differs because reads ran on the trusted channel and carry no agent grant attribution.',
      );
    }
    out.push('');
    out.push(
      `Scenario \`${rec.run.scenarioId}\` · outcome **${rec.run.result.state}**` +
        `${rec.run.result.reason ? ` (\`${rec.run.result.reason}\`)` : ''}` +
        ` · outstanding ${euro(rec.run.result.outstandingCents)} · trace digest \`${rec.run.traceDigest}\``,
    );
    out.push('');
    out.push('Conversation (evaluator view — the assistant only ever received projections; the');
    out.push("`events n` beside each message are `seq` references into this run's `events` array):");
    out.push('');
    for (const m of rec.conversation) {
      out.push(`- **${m.role}** → ${m.recipient} · \`${m.authority}\` · \`${m.messageId}\` · events ${m.eventSeqs.join(', ')}`);
      out.push(`  > ${m.text}`);
    }
    out.push('');
    out.push('| Aspect | Observation (manual assessment) | Evidence |');
    out.push('|---|---|---|');
    for (const row of rec.comparison) {
      out.push(`| ${row.aspect} | ${row.observation} | \`${refText(row.refs)}\` |`);
    }
    out.push('');
  }
  out.push('## Limits');
  out.push('');
  out.push('- The script is fixed: fixed preferences are not natural-language understanding,');
  out.push('  and identical conversations in both modes are a property of the fixtures, not a');
  out.push('  measured benefit of an agent design.');
  out.push('- Pending was explained as neither completed nor failed, and completion was');
  out.push('  reported only after trusted reconciliation observed it. A lost employer');
  out.push('  contribution failed the purchase without charging the employee more.');
  out.push('- All observations are `manual_assessment` rows over LOCAL mock-backend events.');
  return out.join('\n');
};

if (flags.has('--presenter')) {
  // Dispatched before the scenario filter/JSON paths: presenter flags never
  // reach the scenario loop below.
  const records = await runPresenterJourneys(runId);
  const report: PresenterReport = {
    label: PRESENTER_LABEL,
    runId,
    records,
    comparison: records.flatMap((r) => r.comparison),
  };
  if (flags.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else if (flags.has('--markdown')) {
    console.log(presenterMarkdown(report));
  } else {
    console.log(presenterText(report));
  }
} else if (flags.has('--findings')) {
  console.log(await findingsTable(runId));
} else if (flags.has('--json')) {
  const records: RunRecord[] = [];
  for (const s of selected) {
    const { w, p } = await s.run();
    records.push(recordRun(runId, s.id, w, p));
  }
  console.log(JSON.stringify(records, null, 2));
} else if (flags.has('--mermaid')) {
  // Built, not literal, so this file contains no triple-backtick sequence of
  // its own and can itself be quoted inside Markdown fences.
  const fence = '`'.repeat(3);
  for (const s of selected) {
    const { w } = await s.run();
    console.log(`\n### ${s.id}: ${s.title}\n\n${fence}mermaid\n${toMermaid(w.trace.events)}\n${fence}`);
  }
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
