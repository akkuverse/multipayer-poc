// One scenario run as retained evidence: run identifier, fixture version,
// settlement identity and specification version, outcome, and the full
// trace. docs/experiment-protocol.md requires all of these for every
// result.

import { createHash } from 'node:crypto';
import { FIXTURE_VERSION } from '../scenarios.ts';
import type { World } from '../scenarios.ts';
import type { Cents, Origin, Purchase, PurchaseView, TraceEvent } from '../core/types.ts';

export interface RunRecord {
  runId: string;
  scenarioId: string;
  fixtureVersion: string;
  // The reproducible calendar/window fixture settings the run's coordinator
  // used: booking months and dispute deadlines derive from them. Optional so
  // older records without it remain readable.
  fixtureSettings?: { calendarEpoch: string; disputeWindowMinutes: number };
  settlement: { name: string; origin: Origin; specVersion: string };
  result: { state: Purchase['state']; reason?: string; returnStatus: Purchase['returnStatus']; outstandingCents: Cents };
  traceDigest: string;
  events: TraceEvent[];
}

// SHA-256 over the event list, first 16 hex characters. The same fixtures and
// code give the same digest, so a reader can check a run was reproduced.
export function traceDigest(events: TraceEvent[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex').slice(0, 16);
}

// p may be a live view or a detached snapshot: fields are read at call
// time into the plain result object, so the two are equivalent here.
export function recordRun(runId: string, scenarioId: string, w: World, p: PurchaseView): RunRecord {
  return {
    runId,
    scenarioId,
    fixtureVersion: FIXTURE_VERSION,
    fixtureSettings: {
      calendarEpoch: w.coordinator.calendarEpoch,
      disputeWindowMinutes: w.coordinator.disputeWindowMinutes,
    },
    settlement: { name: w.settlement.name, origin: w.settlement.origin, specVersion: w.settlement.specVersion },
    result: {
      state: p.state,
      reason: p.reason,
      returnStatus: p.returnStatus,
      outstandingCents: w.coordinator.outstandingCents(p.purchaseId),
    },
    traceDigest: traceDigest(w.trace.events),
    // Snapshot: the record's events must always match its digest, even if the
    // trace were appended to afterwards.
    events: [...w.trace.events],
  };
}
