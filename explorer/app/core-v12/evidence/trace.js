// GENERATED from src/evidence/trace.ts — type-stripped build artifact; never hand-edit.


// Append-only audit log. The coordinator, the authority registry and the
// settlement modules share one instance, so seq is a single global
// ordering across every actor's events.
export class Trace {
   events = [];

  add(origin, actor, event, detail) {
    this.events.push({ seq: this.events.length + 1, origin, actor, event, detail });
  }

  // Fixed-width rendering for the CLI; the detail payload is appended as JSON.
  format() {
    return this.events
      .map((e) => {
        const detail = e.detail ? ' ' + JSON.stringify(e.detail) : '';
        return `${String(e.seq).padStart(3)} [${e.origin}] ${e.actor.padEnd(11)} ${e.event}${detail}`;
      })
      .join('\n');
  }
}

// Display helper; all computation stays in integer cents.
export const euro = (cents) => `EUR ${(cents / 100).toFixed(2)}`;

// One sender's half of the request/outcome model (spec §7.2). A cross-party
// call that can move or reserve money is announced by a '<op>_requested'
// event emitted immediately before dispatch: key is the operation identity
// the outcome pairs with, to is the receiving actor, parent is the key of
// the request that caused this one (null at the tree's root), and attempt
// counts this sender's dispatches under the same key — a retry is a new
// request, never a new key, and the receiver's dedup is unchanged.
//
// A mediated call keeps its real hops rather than collapsing onto the final
// receiver. The same-ledger digital-euro group commit is dispatched by
// provider-owned code, so the trace shows orchestrator → 'de-providers'
// (`de_group_commit_requested`), orchestrator → each owning provider
// (`de_group_vouch_requested`, answered by `de_group_vouched` /
// `de_group_vouch_refused`), then 'de-providers' → 'de-ledger'
// (`de_group_ledger_commit_requested`) — the request the ledger's
// `de_group_committed` / `de_op_rejected` outcome pairs with. 'de-providers'
// is the collective receiver id for the owning providers as a set: one
// record per distinct provider under the same group key would mint several
// requests whose rising attempts would read as retries, so the single
// receiver keeps the request model truthful while the member detail names
// each provider individually.
export class RequestLog {
    attempts = new Map();
    trace;
    actor;
    siblings;

  constructor(trace, actor) {
    this.trace = trace;
    this.actor = actor;
  }

  add(event, key, to, parent, detail = {}) {
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    this.trace.add('LOCAL', this.actor, event, { key, to, parent, attempt, ...detail });
  }

  // A sibling log on the same trace under another actor: provider-owned
  // code forwards or answers under the party it acts for — the providers
  // collectively or one owning provider — never under the caller's name.
  // Siblings are cached, so a retry under the same key counts up across
  // calls the way the parent's own attempts do.
  for(actor) {
    this.siblings ??= new Map();
    let sibling = this.siblings.get(actor);
    if (sibling === undefined) this.siblings.set(actor, (sibling = new RequestLog(this.trace, actor)));
    return sibling;
  }

  // A non-request event under this log's actor — the outcome half of a
  // provider hop where provider-owned code reports what a provider answered.
  emit(event, detail) {
    this.trace.add('LOCAL', this.actor, event, detail);
  }
}
