import type { Origin, TraceEvent } from './types.ts';

export class Trace {
  readonly events: TraceEvent[] = [];

  add(origin: Origin, actor: string, event: string, detail?: Record<string, unknown>): void {
    this.events.push({ seq: this.events.length + 1, origin, actor, event, detail });
  }

  format(): string {
    return this.events
      .map((e) => {
        const detail = e.detail ? ' ' + JSON.stringify(e.detail) : '';
        return `${String(e.seq).padStart(3)} [${e.origin}] ${e.actor.padEnd(11)} ${e.event}${detail}`;
      })
      .join('\n');
  }
}

export const euro = (cents: number): string => `EUR ${(cents / 100).toFixed(2)}`;
