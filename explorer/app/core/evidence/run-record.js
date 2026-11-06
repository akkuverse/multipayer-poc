// GENERATED from src/evidence/run-record.ts — type-stripped build artifact; never hand-edit.
// One scenario run as retained evidence: run identifier, fixture version,
// settlement identity and specification version, outcome, and the full
// trace. docs/experiment-protocol.md requires all of these for every
// result.

import { createHash } from '../../shims/node-crypto.js';
import { FIXTURE_VERSION } from '../scenarios.js';
                                             
                                                                                          

                            
                
                     
                         
                                                                            
                                                                             
                                              
                                                                            
                                                                         
                                                                            
                                                
                                                                     
                                                                  
                                                                                                                         
                      
                       
 

// SHA-256 over the event list, first 16 hex characters. The same fixtures and
// code give the same digest, so a reader can check a run was reproduced.
export function traceDigest(events              )         {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex').slice(0, 16);
}

// The settlement identity a record reports: `settlement` on new records,
// the legacy `backend` on archived ones. A record naming neither is
// malformed — refuse rather than print an anonymous implementation.
export function settlementOf(r           )                                                        {
  const s = r.settlement ?? r.backend;
  if (s === undefined) throw new Error(`run record ${r.runId}/${r.scenarioId} names no settlement`);
  return s;
}

// p may be a live view or a detached snapshot: fields are read at call
// time into the plain result object, so the two are equivalent here.
export function recordRun(runId        , scenarioId        , w       , p              )            {
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
