import type { Origin, TraceEvent } from './types.ts';

// Append-only audit log. The coordinator and the backend share one instance,
// so seq is a single global ordering across both actors' events.
export class Trace {
  readonly events: TraceEvent[] = [];

  add(origin: Origin, actor: string, event: string, detail?: Record<string, unknown>): void {
    this.events.push({ seq: this.events.length + 1, origin, actor, event, detail });
  }

  // Fixed-width rendering for the CLI; the detail payload is appended as JSON.
  format(): string {
    return this.events
      .map((e) => {
        const detail = e.detail ? ' ' + JSON.stringify(e.detail) : '';
        return `${String(e.seq).padStart(3)} [${e.origin}] ${e.actor.padEnd(11)} ${e.event}${detail}`;
      })
      .join('\n');
  }
}

// Display helper; all computation stays in integer cents.
export const euro = (cents: number): string => `EUR ${(cents / 100).toFixed(2)}`;
