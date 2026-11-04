// A trace as a Mermaid sequence diagram, for slides and GitHub. Ledger events
// (de-ledger, bank-transfer) are drawn as replies to the acting provider —
// named in the event's provider/from/to detail when the module records one,
// otherwise they land on the orchestrator that drove the work. Provider
// events are bookkeeping confirmations, drawn as arrows to the ledger their
// rail names when the evidence carries one (rail, stage or key
// destination), and as notes otherwise — a provider event without rail
// evidence is never drawn as a fabricated ledger call. Orchestrator events
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

// Which ledger a provider event's bookkeeping ran against, or undefined
// when the event carries no rail evidence: explicit rail first, then the
// operation key's destination ('bank' or a 'psp-*' book is interbank, a
// 'ps-*' pseudonym or 'digital_euro' the Eurosystem ledger), then the
// fault stage name. Provider-internal book operations whose names happen
// to mention 'bank' carry none of that evidence and fall through to a
// note — the event's own naming is not rail evidence.
const providerLedger = (e: TraceEvent): 'de-ledger' | 'bank-transfer' | undefined => {
  const rail = String(e.detail?.rail ?? '');
  if (rail === 'bank') return 'bank-transfer';
  if (rail === 'digital_euro') return 'de-ledger';
  const key = String(e.detail?.key ?? '');
  if (/"(?:bank|psp-[^"]*)"\s*\]$/.test(key)) return 'bank-transfer';
  if (/"(?:ps-[^"]*|digital_euro)"\s*\]$/.test(key)) return 'de-ledger';
  const stage = String(e.detail?.stage ?? '');
  if (stage === 'debit' || stage === 'credit' || stage.startsWith('bank')) return 'bank-transfer';
  if (stage.length > 0) return 'de-ledger';
  return undefined;
};

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
  const participant = (a: unknown): string | undefined =>
    typeof a === 'string' && ids.has(a) ? a : undefined;
  const lines = ['sequenceDiagram', ...actors.map((a) => `  participant ${pid(a)} as ${scrub(a)}`)];
  for (const e of events) {
    if (e.actor === 'orchestrator') lines.push(`  orchestrator-->>coordinator: ${label(e)}`);
    else if (ledgers.has(e.actor)) {
      // A ledger event replies to the provider its detail names — the
      // invoking provider, the credited 'to' book or the debited 'from'
      // book — and otherwise lands on the orchestrator that invoked the
      // group commit.
      const to =
        participant(e.detail?.provider) ?? participant(e.detail?.to) ?? participant(e.detail?.from) ?? 'orchestrator';
      lines.push(`  ${pid(e.actor)}-->>${pid(to)}: ${label(e)}`);
    } else if (providerActors.has(e.actor)) {
      // Provider work is drawn toward whichever ledger its rail names:
      // 'bank' to the interbank module, 'digital_euro' to the Eurosystem
      // ledger. With no rail evidence — or no ledger participant in the
      // trace — it is a plain note, not a fabricated call.
      const ledger = providerLedger(e);
      if (ledger !== undefined && ledgers.has(ledger)) lines.push(`  ${pid(e.actor)}->>${pid(ledger)}: ${label(e)}`);
      else lines.push(`  Note over ${pid(e.actor)}: ${label(e)}`);
    } else if (e.event === 'submit' || e.event === 'resubmit_same_keys') {
      lines.push(`  coordinator->>orchestrator: ${label(e)}`);
    } else lines.push(`  Note over ${pid(e.actor)}: ${label(e)}`);
  }
  return lines.join('\n');
}
