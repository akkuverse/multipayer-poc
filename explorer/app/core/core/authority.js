// GENERATED from src/core/authority.ts — type-stripped build artifact; never hand-edit.
// The one authority registry: every authority record — an employer's signed
// allowance or an employee's signed standing terms — is published and read
// through this module. Publication is the trust decision: a record is
// schema-checked, verified against the key bound to the owner it names and
// checked against its sequence before it may replace the accepted terms, so
// a rejected write can never displace them. The two kinds keep their
// different semantics: an employer mandate is one record per reference,
// versioned per reference and bound to its first employer; an employee's
// terms are one standing record per employee, versioned per employee, with
// each reference permanently bound to its first employee. Holding both
// reference namespaces is also what lets the registry enforce their
// exclusivity itself — one reference can never name both an employer
// mandate and employee standing terms. Accepted records emit their audit
// events here (actor 'registry'), and subscribers are told synchronously so
// a listener — the coordinator refreshing open purchases — reacts to the
// publication rather than polling for it. The coordinator still verifies
// the retained signature at every use and fails closed, so a record
// corrupted after acceptance can only deny funding, never create it.

import { verifyPayload } from './signing.js';
                                                        
                                                                   
import { EmployeeAuthority, EmployeeMandateRejection, namedEmployeeMandateFields } from './employee-authority.js';
                                                  

// A publication that failed validation or verification. Carries the
// machine-checkable reason plus the parties and proposed revision it names
// when the payload was well-formed enough to identify them.
export class EmployerMandateRejection extends Error {
           reason 
                 
                         
                                     
                             
                        ;
           employerId         ;
           mandateRef         ;
           version         ;

  constructor(reason                                    , employerId         , mandateRef         , version         ) {
    super(`employer_mandate_rejected:${reason}`);
    this.name = 'EmployerMandateRejection';
    this.reason = reason;
    this.employerId = employerId;
    this.mandateRef = mandateRef;
    this.version = version;
  }
}

const nonempty = (v         )              => typeof v === 'string' && v.length > 0;
const cents = (v         )              => Number.isSafeInteger(v) && (v          ) >= 0;

// Unique, nonempty merchant IDs.
const merchantIds = (v         )                =>
  Array.isArray(v) && v.every((m) => typeof m === 'string' && m.length > 0) && new Set(v).size === v.length;

// Every field of a well-formed allowance, checked before any field is
// dereferenced for verification or indexing.
const wellFormed = (p         )                       => {
  if (typeof p !== 'object' || p === null) return false;
  const m = p                   ;
  return (
    nonempty(m.mandateRef) &&
    nonempty(m.employerId) &&
    nonempty(m.beneficiaryRef) &&
    Number.isSafeInteger(m.version) &&
    m.version >= 1 &&
    cents(m.maxPerPurchaseCents) &&
    cents(m.maxPerDayCents) &&
    Number.isSafeInteger(m.maxPurchasesPerDay) &&
    m.maxPurchasesPerDay >= 0 &&
    merchantIds(m.eligibleMerchants) &&
    Number.isFinite(m.validFrom) &&
    m.validFrom >= 0 &&
    Number.isFinite(m.validUntil) &&
    // A mandate whose window never opens is malformed, not merely expired.
    m.validFrom <= m.validUntil &&
    typeof m.revoked === 'boolean' &&
    // The employer signs its disclosure profile into the mandate: only the
    // employer-benefit profile is recognized here. A missing, unknown or
    // cross-arrangement profile is malformed — a signed record without a
    // recognized profile can never authorize new work.
    m.privacyProfile === 'employer_benefit_v1'
  );
};

// The parties and proposed revision a malformed payload still safely names.
// Used for rejection detail and for the reference-exclusivity check, which
// runs before the record kind's own validation.
export const namedEmployerMandateFields = (p         )                                                                 => {
  if (typeof p !== 'object' || p === null) return {};
  const o = p                           ;
  return {
    employerId: nonempty(o.employerId) ? o.employerId : undefined,
    mandateRef: nonempty(o.mandateRef) ? o.mandateRef : undefined,
    version: Number.isSafeInteger(o.version) ? (o.version          ) : undefined,
  };
};

// What a subscriber is told after a record is accepted: which kind of
// authority it is and the accepted revision. Fired synchronously inside the
// publish call, after the accepted kind's own audit event — a listener's
// failure propagates to the publisher rather than masking the write.
                                     
                                                  
                                                   

export class AuthorityRegistry {
  // The accepted employer record per reference — what employerMandate()
  // exposes.
                   latest = new Map                                 ();
  // Acceptance-time owner and version per reference. Never exposed through
  // employerMandate(): ownership and version decisions consult this, not the
  // mutable record, so corrupting retained data can only deny funding at
  // use — it can never reopen the rollback window or rebind a reference.
  // Its key set is also the employer side of the reference namespace.
                   accepted = new Map                                                 ();
  // The employee side of the store: one standing record per employee with
  // its own version and reference-binding semantics, encapsulated behind
  // the same publication-is-the-trust-decision interface.
                   employees                   ;

                   keys             ;
                   trace       ;
  // The world's simulated clock, read lazily: every audit event carries the
  // fixture time of the publication it records.
                   now              ;
                   subscribers                                                  = [];

  constructor(keys             , trace       , now              ) {
    this.keys = keys;
    this.trace = trace;
    this.now = now;
    this.employees = new EmployeeAuthority(keys);
  }

          log(event        , detail                          )       {
    this.trace.add('LOCAL', 'registry', event, detail);
  }

  // React to accepted records: called synchronously inside publish once the
  // record is stored and its event appended, in publication order. The
  // coordinator subscribes to refresh the publisher employee's open
  // purchases; other kinds need no reaction today.
  subscribe(listener                                             )       {
    this.subscribers.push(listener);
  }

          notify(accepted                         )       {
    for (const l of this.subscribers) l(accepted);
  }

          rejectEmployer(err                          )       {
    const detail                          = { reason: err.reason };
    if (err.employerId !== undefined) detail.employerId = err.employerId;
    if (err.mandateRef !== undefined) detail.mandateRef = err.mandateRef;
    if (err.version !== undefined) detail.version = err.version;
    detail.now = this.now();
    this.log('employer_mandate_rejected', detail);
  }

          rejectEmployee(err                          )       {
    const detail                          = { reason: err.reason };
    if (err.employeeId !== undefined) detail.employeeId = err.employeeId;
    if (err.mandateRef !== undefined) detail.mandateRef = err.mandateRef;
    if (err.version !== undefined) detail.version = err.version;
    detail.now = this.now();
    this.log('employee_mandate_rejected', detail);
  }

  // The employer publishes or replaces the signed mandate a reference
  // resolves to — new terms, changed caps or a revocation. Only a
  // well-formed revision signed by the employer it names and carrying the
  // reference's next version is accepted; every rejection is logged once
  // and leaves the retained mandate in force. Accepted revisions
  // deliberately emit no event: the existing traces predate audited
  // publication and keep their digests.
  publishEmployerMandate(signed                         )       {
    let p                 ;
    try {
      // The two reference spaces stay distinct: a mandate-backed share cites
      // its authority by reference, so one reference must never name both an
      // employer mandate and employee terms. Both namespaces live in this
      // registry, so the exclusivity check runs here on either publish path —
      // before the record's own validation, exactly as when the coordinator
      // owned it.
      const n = namedEmployerMandateFields(
        typeof signed === 'object' && signed !== null ? signed.payload : undefined,
      );
      if (n.mandateRef !== undefined && this.employees.ownsRef(n.mandateRef)) {
        throw new EmployerMandateRejection('ref_owned_by_employee', n.employerId, n.mandateRef, n.version);
      }
      p = this.acceptEmployer(signed);
    } catch (err) {
      if (err instanceof EmployerMandateRejection) this.rejectEmployer(err);
      throw err;
    }
    this.notify({ kind: 'employer', mandate: structuredClone(p) });
  }

  // Validate, verify and replace the reference's mandate. Any failure throws
  // EmployerMandateRejection and leaves the accepted record untouched.
          acceptEmployer(signed                         )                  {
    if (typeof signed !== 'object' || signed === null || typeof signed.keyId !== 'string' || typeof signed.signature !== 'string') {
      throw new EmployerMandateRejection('malformed');
    }
    const p          = signed.payload;
    if (!wellFormed(p)) {
      const n = namedEmployerMandateFields(p);
      throw new EmployerMandateRejection('malformed', n.employerId, n.mandateRef, n.version);
    }
    // The signer must be the employer the terms name: a mandate signed by
    // anyone else — or tampered with after signing — is not authority. A
    // payload outside the signed domain (a BigInt or function in an extra
    // field) makes canonicalisation throw — malformed, not unverifiable.
    let verified         ;
    try {
      verified = verifyPayload(signed, this.keys, p.employerId);
    } catch {
      throw new EmployerMandateRejection('malformed', p.employerId, p.mandateRef, p.version);
    }
    if (!verified) {
      throw new EmployerMandateRejection('signature_invalid', p.employerId, p.mandateRef, p.version);
    }
    const prev = this.accepted.get(p.mandateRef);
    if (prev && prev.employerId !== p.employerId) {
      throw new EmployerMandateRejection('ref_owned_by_another_employer', p.employerId, p.mandateRef, p.version);
    }
    // The version sequence is the rollback guard: a still-valid signature
    // over a superseded revision — in particular one predating a revocation —
    // can never displace the accepted record.
    if (p.version !== (prev?.version ?? 0) + 1) {
      throw new EmployerMandateRejection('version_not_next', p.employerId, p.mandateRef, p.version);
    }
    // Store a copy: later edits to the caller's signed object must not alter
    // the accepted terms. An uncloneable extra field is malformed too.
    try {
      this.latest.set(p.mandateRef, structuredClone(signed));
    } catch {
      throw new EmployerMandateRejection('malformed', p.employerId, p.mandateRef, p.version);
    }
    this.accepted.set(p.mandateRef, { employerId: p.employerId, version: p.version });
    return p;
  }

  // The employee replaces their standing payment terms by publishing a new
  // signed record. Only a well-formed record signed by the employee it names
  // and carrying the next version is accepted; every rejection is logged
  // once and leaves the accepted terms untouched. A revoked revision is its
  // own event, not an additional publication. Returns the accepted revision
  // as a detached copy.
  publishEmployeeMandate(signed                         )                  {
    let m                 ;
    try {
      // The employee's reference space stays distinct from the employer's:
      // checked before the record's own validation, exactly as when the
      // coordinator owned it — acceptance-time employer state, never the
      // mutable record.
      const n = namedEmployeeMandateFields(
        typeof signed === 'object' && signed !== null ? signed.payload : undefined,
      );
      if (n.mandateRef !== undefined && this.accepted.has(n.mandateRef)) {
        throw new EmployeeMandateRejection('ref_owned_by_employer', n.employeeId, n.mandateRef, n.version);
      }
      m = this.employees.publish(signed);
    } catch (err) {
      if (err instanceof EmployeeMandateRejection) this.rejectEmployee(err);
      throw err;
    }
    this.log(m.revoked ? 'employee_mandate_revoked' : 'employee_mandate_published', {
      employeeId: m.employeeId,
      mandateRef: m.mandateRef,
      version: m.version,
      now: this.now(),
    });
    this.notify({ kind: 'employee', mandate: m });
    return m;
  }

  // The retained employer record for a reference — the object itself, not a
  // copy. Post-acceptance mutation is the fault-injection seam for the
  // coordinator's check at use: publish proves only what entered the store,
  // and every use must still fail closed on whatever the store now holds.
  employerMandate(mandateRef        )                                      {
    return this.latest.get(mandateRef);
  }

  // The employee's current verified standing terms as a detached copy, or
  // undefined when they never published. Retained data whose signature no
  // longer verifies is invalid, not absent: fail closed.
  employeeMandate(employeeId        )                                      {
    return this.employees.current(employeeId);
  }

  // The retained employee record itself — the object, not a copy, and
  // without re-verification. The fault-injection seam for the check at use:
  // a test corrupting the stored record must see every later verified read
  // fail closed. Callers that are not injecting a fault want
  // employeeMandate().
  storedEmployeeMandate(employeeId        )                                      {
    return this.employees.stored(employeeId);
  }
}
