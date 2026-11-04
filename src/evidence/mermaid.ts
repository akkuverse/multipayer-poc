// A trace as a Mermaid sequence diagram, for slides and GitHub. Ledger events
// (de-ledger, bank-transfer) are drawn as replies to the acting provider — a
// simplification: some are children of the orchestrator's own group commit,
// and internal events (hold expiry, transit defunding) are not replies at
// all. Provider events are forwards to their ledgers, orchestrator events
// are replies to the coordinator, and every other event is a note on the
// acting participant. Each label keeps its evidence origin.

import type { TraceEvent } from '../core/types.ts';

const id = (actor: string): string => actor.replace(/[^A-Za-z0-9_]/g, '_');

// Mermaid treats ';', '#', '<' and '>' specially in message text.
const scrub = (s: string): string => s.replace(/[;#<>]/g, ' ');

function label(e: TraceEvent): string {
  const detail = Object.entries(e.detail ?? {})
    .filter(([, v]) => v !== undefined)
    // Scalars and flat scalar lists stay. A nested object would render as an
    // opaque "[object Object]" — drop it from the label; the full detail
    // JSON remains in the text trace and the run record.
    .filter(([, v]) => typeof v !== 'object' || v === null || (Array.isArray(v) && v.every((x) => typeof x !== 'object' || x === null)))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
  return scrub(`[${e.origin}] ${e.event}${detail ? ` ${detail}` : ''}`);
}

// The settlement actors this module draws as ledgers rather than providers.
const LEDGERS = new Set(['de-ledger', 'bank-transfer']);

export function toMermaid(events: TraceEvent[]): string {
  const actors = [...new Set(['coordinator', 'orchestrator', ...events.map((e) => e.actor)])];
  const ledgers = new Set(events.map((e) => e.actor).filter((a) => LEDGERS.has(a)));
  // Provider actors are the ones whose operations drive ledger work.
  const providerActors = new Set(
    events
      .map((e) => e.actor)
      .filter((a) => a !== 'coordinator' && a !== 'orchestrator' && !ledgers.has(a) && a.startsWith('psp-')),
  );
  // Sanitised ids must stay injective; suffix on collision so no two actors
  // silently share a lifeline.
  const ids = new Map<string, string>();
  for (const a of actors) {
    let i = id(a);
    for (let n = 2; [...ids.values()].includes(i); n++) i = `${id(a)}_${n}`;
    ids.set(a, i);
  }
  const pid = (a: string): string => ids.get(a)!;
  const lines = ['sequenceDiagram', ...actors.map((a) => `  participant ${pid(a)} as ${scrub(a)}`)];
  for (const e of events) {
    if (e.actor === 'orchestrator') lines.push(`  orchestrator-->>coordinator: ${label(e)}`);
    else if (ledgers.has(e.actor)) {
      // A ledger event replies to the provider named in its detail when one
      // is recorded there; otherwise it lands on the orchestrator that
      // invoked the group commit.
      const to = typeof e.detail?.provider === 'string' && ids.has(e.detail.provider) ? e.detail.provider : 'orchestrator';
      lines.push(`  ${pid(e.actor)}-->>${pid(to)}: ${label(e)}`);
    } else if (providerActors.has(e.actor)) {
      // Provider work reaches whichever ledger its stage names: bank
      // rails to bank-transfer, everything else to the digital-euro
      // ledger. With no ledger actor in the trace it is a plain note.
      const stage = String(e.detail?.stage ?? '');
      const ledger = stage.startsWith('bank') || stage === 'pay' ? 'bank-transfer' : 'de-ledger';
      if (ledgers.has(ledger)) lines.push(`  ${pid(e.actor)}->>${pid(ledger)}: ${label(e)}`);
      else lines.push(`  Note over ${pid(e.actor)}: ${label(e)}`);
    } else if (e.event === 'submit' || e.event === 'resubmit_same_keys') {
      lines.push(`  coordinator->>orchestrator: ${label(e)}`);
    } else lines.push(`  Note over ${pid(e.actor)}: ${label(e)}`);
  }
  return lines.join('\n');
}
