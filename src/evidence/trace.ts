import type { Origin, TraceEvent } from '../core/types.ts';

// Append-only audit log. The coordinator, the authority registry and the
// settlement modules share one instance, so seq is a single global
// ordering across every actor's events.
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

// One sender's half of the request/outcome model (spec §7.2). A cross-party
// call that can move or reserve money is announced by a '<op>_requested'
// event emitted immediately before dispatch: key is the operation identity
// the outcome pairs with, to is the receiving actor, parent is the key of
// the request that caused this one (null at the tree's root), and attempt
// counts this sender's dispatches under the same key — a retry is a new
// request, never a new key, and the receiver's dedup is unchanged.
export class RequestLog {
  private readonly attempts = new Map<string, number>();
  private readonly trace: Trace;
  private readonly actor: string;

  constructor(trace: Trace, actor: string) {
    this.trace = trace;
    this.actor = actor;
  }

  add(event: string, key: string, to: string, parent: string | null, detail: Record<string, unknown> = {}): void {
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    this.trace.add('LOCAL', this.actor, event, { key, to, parent, attempt, ...detail });
  }
}
