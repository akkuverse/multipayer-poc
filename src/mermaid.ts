// A trace as a Mermaid sequence diagram, for slides and GitHub. Backend events
// are replies to the coordinator, PSP events are forwards to the backend, a
// direct submission is an arrow from the coordinator, and every other event is
// a note on the acting participant. Each label keeps its evidence origin.

import type { TraceEvent } from './types.ts';

const id = (actor: string): string => actor.replace(/[^A-Za-z0-9_]/g, '_');

// Mermaid treats ';', '#', '<' and '>' specially in message text.
const scrub = (s: string): string => s.replace(/[;#<>]/g, ' ');

function label(e: TraceEvent): string {
  const detail = Object.entries(e.detail ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
  return scrub(`[${e.origin}] ${e.event}${detail ? ` ${detail}` : ''}`);
}

export function toMermaid(events: TraceEvent[]): string {
  const actors = [...new Set(['coordinator', 'backend', ...events.map((e) => e.actor)])];
  const viaPsp = actors.some((a) => a.startsWith('psp-'));
  // Sanitised ids must stay injective; suffix on collision so no two actors
  // silently share a lifeline.
  const ids = new Map<string, string>();
  for (const a of actors) {
    let i = id(a);
    for (let n = 2; [...ids.values()].includes(i); n++) i = `${id(a)}_${n}`;
    ids.set(a, i);
  }
  const pid = (a: string): string => ids.get(a)!;
  const lines = [
    'sequenceDiagram',
    ...actors.map((a) => `  participant ${pid(a)} as ${scrub(a)}`),
  ];
  for (const e of events) {
    if (e.actor === 'backend') lines.push(`  backend-->>coordinator: ${label(e)}`);
    // A refused forward never reached the backend, so it is a note, not an arrow.
    else if (e.event === 'psp_unavailable') lines.push(`  Note over ${pid(e.actor)}: ${label(e)}`);
    else if (e.actor.startsWith('psp-')) lines.push(`  ${pid(e.actor)}->>backend: ${label(e)}`);
    else if (!viaPsp && (e.event === 'submit' || e.event === 'resubmit_same_keys')) lines.push(`  coordinator->>backend: ${label(e)}`);
    else lines.push(`  Note over ${pid(e.actor)}: ${label(e)}`);
  }
  return lines.join('\n');
}
