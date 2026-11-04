// Settlement domain types: the keyed-operation records every settlement
// module keeps for idempotent replay and status, plus the hold lifecycle
// reported separately from operation status. Records crossing a module
// boundary are detached plain data — no mutable Map, module instance or
// callback travels in them. All amounts are integer euro cents.
//
// Owned here so ledger, provider and orchestrator modules share one
// vocabulary; later tasks extend this file with frozen intents, provider
// outcomes and settlement snapshots (contract decisions 5–8).

// The authoritative status of a recorded operation under its original key.
// 'not_started' is an intent recorded before any attempt — it permits a
// replay under the same key and terms and is never a final rejection.
// 'pending' and 'unknown' are both open: a handed-off operation awaiting its
// outcome, or a lost response — neither proves failure. 'succeeded' and
// 'rejected' are terminal and immutable.
export type OperationStatus = 'not_started' | 'pending' | 'succeeded' | 'rejected' | 'unknown';

// The lifecycle of a ledger hold, reported separately from the operation
// that created it: an operation may be resolved while its hold lives on.
export type HoldStatus = 'active' | 'committed' | 'released' | 'expired';

// What resolving an operation reports. 'pending' and 'unknown' keep the
// operation open; a 'not_started' outcome is not a resolution at all and is
// refused by the store. The reference, when known, is the module's own
// handle for the attempt (a hold, an execution, a transfer) — the handle
// later status queries and returns key on. reason names a conclusive
// refusal; effects records structured knowledge about what may have moved.
export interface OperationOutcome {
  status: Exclude<OperationStatus, 'not_started'>;
  reference?: string;
  reason?: string;
  effects?: unknown;
}

// One keyed operation as the store retains it: the immutable copied terms
// the identity dedupes on, the key itself, the current status, and the
// reference/reason/effects evidence accumulated so far. Callers always
// receive detached copies — the retained record is never a mutable handle.
export interface OperationRecord {
  // The tuple-encoded identity produced by operationKey().
  key: string;
  // The canonical copy of the terms begin() recorded; a replay under
  // canonically different terms is refused.
  terms: unknown;
  status: OperationStatus;
  // The module's handle for the attempt, once known.
  reference?: string;
  reason?: string;
  // Structured knowledge about the attempt's effects, opaque to the store.
  effects?: unknown;
}
