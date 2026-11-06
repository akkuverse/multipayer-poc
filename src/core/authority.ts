// The one authority registry: every authority record — an employer's signed
// mandate, an employee's signed standing terms, a donor's signed allowance
// or an oracle's signed eligibility attestation — is published and read
// through this module. Publication is the trust decision: a record is
// schema-checked, verified against the key bound to the owner it names and
// checked against its sequence before it may replace the accepted terms, so
// a rejected write can never displace them. The kinds keep their different
// semantics: an employer mandate is one record per reference, versioned per
// reference and bound to its first employer; an employee's terms are one
// standing record per employee, versioned per employee, with each reference
// permanently bound to its first employee; a donor allowance is one record
// per reference, versioned per reference and bound to its first donor and
// beneficiary class; an attestation is one record per (subject, class)
// pair, versioned per pair and issuable only by the class's configured
// attestor — a registered signing key alone confers no attestation
// privilege. Holding the three reference namespaces is also what lets the
// registry enforce their exclusivity itself — one reference can never name
// an employer mandate, employee standing terms and a donor allowance at
// once. Acceptance-time owner/class/version and subject/class/issuer/
// version facts live outside the mutable retained records, so corrupting
// retained data can only deny funding at use — it can never reopen the
// rollback window, rebind a reference or change the accepted issuer.
// Accepted records emit their audit events here (actor 'registry'), and
// subscribers are told synchronously so a listener — the coordinator
// refreshing open purchases — reacts to the publication rather than
// polling for it. The coordinator still verifies the retained signature at
// every use and fails closed, so a record corrupted after acceptance can
// only deny funding, never create it.

import { verifyPayload } from './signing.ts';
import type { KeyRegistry, Signed } from './signing.ts';
import type { AllowanceMandate, EligibilityAttestation, EmployeeMandate, EmployerMandate } from './types.ts';
import { EmployeeAuthority, EmployeeMandateRejection, namedEmployeeMandateFields } from './employee-authority.ts';
import type { Trace } from '../evidence/trace.ts';

// A publication that failed validation or verification. Carries the
// machine-checkable reason plus the parties and proposed revision it names
// when the payload was well-formed enough to identify them.
export class EmployerMandateRejection extends Error {
  readonly reason:
    | 'malformed'
    | 'signature_invalid'
    | 'ref_owned_by_another_employer'
    | 'ref_owned_by_employee'
    | 'ref_owned_by_allowance'
    | 'version_not_next';
  readonly employerId?: string;
  readonly mandateRef?: string;
  readonly version?: number;

  constructor(reason: EmployerMandateRejection['reason'], employerId?: string, mandateRef?: string, version?: number) {
    super(`employer_mandate_rejected:${reason}`);
    this.name = 'EmployerMandateRejection';
    this.reason = reason;
    this.employerId = employerId;
    this.mandateRef = mandateRef;
    this.version = version;
  }
}

const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const cents = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

// Unique, nonempty merchant IDs.
const merchantIds = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((m) => typeof m === 'string' && m.length > 0) && new Set(v).size === v.length;

// Every field of a well-formed allowance, checked before any field is
// dereferenced for verification or indexing.
const wellFormed = (p: unknown): p is EmployerMandate => {
  if (typeof p !== 'object' || p === null) return false;
  const m = p as EmployerMandate;
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
export const namedEmployerMandateFields = (p: unknown): { employerId?: string; mandateRef?: string; version?: number } => {
  if (typeof p !== 'object' || p === null) return {};
  const o = p as Record<string, unknown>;
  return {
    employerId: nonempty(o.employerId) ? o.employerId : undefined,
    mandateRef: nonempty(o.mandateRef) ? o.mandateRef : undefined,
    version: Number.isSafeInteger(o.version) ? (o.version as number) : undefined,
  };
};

// An allowance publication that failed validation or verification. Carries
// the machine-checkable reason plus the parties and proposed revision it
// names when the payload was well-formed enough to identify them.
export class AllowanceMandateRejection extends Error {
  readonly reason:
    | 'malformed'
    | 'signature_invalid'
    | 'ref_owned_by_another_donor'
    | 'ref_owned_by_employer'
    | 'ref_owned_by_employee'
    | 'beneficiary_class_changed'
    | 'version_not_next';
  readonly donorId?: string;
  readonly allowanceRef?: string;
  readonly version?: number;

  constructor(reason: AllowanceMandateRejection['reason'], donorId?: string, allowanceRef?: string, version?: number) {
    super(`allowance_mandate_rejected:${reason}`);
    this.name = 'AllowanceMandateRejection';
    this.reason = reason;
    this.donorId = donorId;
    this.allowanceRef = allowanceRef;
    this.version = version;
  }
}

// An attestation publication that failed validation or verification.
// Carries the machine-checkable reason plus the issuer, subject, class and
// proposed revision it names when the payload was well-formed enough to
// identify them.
export class EligibilityAttestationRejection extends Error {
  readonly reason:
    | 'malformed'
    | 'signature_invalid'
    | 'attestor_not_trusted'
    | 'version_not_next';
  readonly attestorId?: string;
  readonly subjectId?: string;
  readonly classId?: string;
  readonly version?: number;

  constructor(
    reason: EligibilityAttestationRejection['reason'],
    attestorId?: string,
    subjectId?: string,
    classId?: string,
    version?: number,
  ) {
    super(`eligibility_attestation_rejected:${reason}`);
    this.name = 'EligibilityAttestationRejection';
    this.reason = reason;
    this.attestorId = attestorId;
    this.subjectId = subjectId;
    this.classId = classId;
    this.version = version;
  }
}

// Every field of a well-formed donor allowance, checked before any field is
// dereferenced for verification or indexing. Exported for the decision
// scope's use-time revalidation: a retained record swapped for differently
// shaped signed content must fail closed, not fall into policy.
export const wellFormedAllowance = (p: unknown): p is AllowanceMandate => {
  if (typeof p !== 'object' || p === null) return false;
  const m = p as AllowanceMandate;
  return (
    nonempty(m.allowanceRef) &&
    nonempty(m.donorId) &&
    nonempty(m.beneficiaryClass) &&
    Number.isSafeInteger(m.version) &&
    m.version >= 1 &&
    cents(m.maxPerPurchaseCents) &&
    cents(m.maxPerDayCents) &&
    Number.isSafeInteger(m.maxPurchasesPerDay) &&
    m.maxPurchasesPerDay >= 0 &&
    // The lifetime cap is optional; present, it obeys the cents rule.
    (m.totalEndowmentCents === undefined || cents(m.totalEndowmentCents)) &&
    merchantIds(m.eligibleMerchants) &&
    Number.isFinite(m.validFrom) &&
    m.validFrom >= 0 &&
    Number.isFinite(m.validUntil) &&
    m.validFrom <= m.validUntil &&
    typeof m.revoked === 'boolean' &&
    // The donor signs its disclosure profile into the allowance: only the
    // anonymous-donation profile is recognized here. A missing, unknown or
    // cross-arrangement profile is malformed.
    m.privacyProfile === 'anonymous_donation_v1'
  );
};

// Every field of a well-formed eligibility attestation, checked before any
// field is dereferenced for verification or indexing.
export const wellFormedAttestation = (p: unknown): p is EligibilityAttestation => {
  if (typeof p !== 'object' || p === null) return false;
  const a = p as EligibilityAttestation;
  return (
    nonempty(a.attestorId) &&
    nonempty(a.subjectId) &&
    nonempty(a.classId) &&
    Number.isSafeInteger(a.version) &&
    a.version >= 1 &&
    Number.isFinite(a.validFrom) &&
    a.validFrom >= 0 &&
    Number.isFinite(a.validUntil) &&
    a.validFrom <= a.validUntil &&
    typeof a.revoked === 'boolean'
  );
};

// The parties and proposed revision a malformed allowance payload still
// safely names — for rejection detail and for the reference-exclusivity
// check, which runs before the record kind's own validation.
export const namedAllowanceFields = (p: unknown): { donorId?: string; allowanceRef?: string; version?: number } => {
  if (typeof p !== 'object' || p === null) return {};
  const o = p as Record<string, unknown>;
  return {
    donorId: nonempty(o.donorId) ? o.donorId : undefined,
    allowanceRef: nonempty(o.allowanceRef) ? o.allowanceRef : undefined,
    version: Number.isSafeInteger(o.version) ? (o.version as number) : undefined,
  };
};

// The parties and proposed revision a malformed attestation payload still
// safely names.
export const namedAttestationFields = (
  p: unknown,
): { attestorId?: string; subjectId?: string; classId?: string; version?: number } => {
  if (typeof p !== 'object' || p === null) return {};
  const o = p as Record<string, unknown>;
  return {
    attestorId: nonempty(o.attestorId) ? o.attestorId : undefined,
    subjectId: nonempty(o.subjectId) ? o.subjectId : undefined,
    classId: nonempty(o.classId) ? o.classId : undefined,
    version: Number.isSafeInteger(o.version) ? (o.version as number) : undefined,
  };
};

// The store key for one (subject, class) attestation slot. Tuple
// serialization, never a string prefix that could collide with real ids.
export const attestationKey = (subjectId: string, classId: string): string => JSON.stringify([subjectId, classId]);

// The acceptance-time facts a verified read checks the retained record
// against: an allowance keeps the owner, class and revision it entered
// under; an attestation keeps the issuer and revision. Both live outside
// the mutable retained record.
export interface AcceptedAllowance {
  donorId: string;
  beneficiaryClass: string;
  version: number;
}
export interface AcceptedAttestation {
  attestorId: string;
  version: number;
}

// What a subscriber is told after a record is accepted: which kind of
// authority it is and the accepted revision. Fired synchronously inside the
// publish call, after the accepted kind's own audit event — a listener's
// failure propagates to the publisher rather than masking the write.
export type AcceptedAuthorityRecord =
  | { kind: 'employer'; mandate: EmployerMandate }
  | { kind: 'employee'; mandate: EmployeeMandate }
  | { kind: 'allowance'; allowance: AllowanceMandate }
  | { kind: 'attestation'; attestation: EligibilityAttestation };

export class AuthorityRegistry {
  // The accepted employer record per reference — what employerMandate()
  // exposes.
  private readonly latest = new Map<string, Signed<EmployerMandate>>();
  // Acceptance-time owner and version per reference. Never exposed through
  // employerMandate(): ownership and version decisions consult this, not the
  // mutable record, so corrupting retained data can only deny funding at
  // use — it can never reopen the rollback window or rebind a reference.
  // Its key set is also the employer side of the reference namespace.
  private readonly accepted = new Map<string, { employerId: string; version: number }>();
  // The employee side of the store: one standing record per employee with
  // its own version and reference-binding semantics, encapsulated behind
  // the same publication-is-the-trust-decision interface.
  private readonly employees: EmployeeAuthority;
  // The retained donor allowance per reference — what allowanceMandate()
  // exposes.
  private readonly allowances = new Map<string, Signed<AllowanceMandate>>();
  // Acceptance-time owner, class and version per allowance reference.
  // Never exposed through the retained record: owner/class/version
  // decisions consult this, so corrupting retained data can only deny
  // funding at use — never reopen the rollback window, rebind the
  // reference or move it to another class. Its key set is also the
  // allowance side of the reference namespace.
  private readonly allowancesAccepted = new Map<string, AcceptedAllowance>();
  // The retained attestation per (subject, class) pair, keyed by
  // attestationKey — what eligibilityAttestation() exposes.
  private readonly attestations = new Map<string, Signed<EligibilityAttestation>>();
  // Acceptance-time issuer and version per (subject, class) pair.
  private readonly attestationsAccepted = new Map<string, AcceptedAttestation>();
  // The trusted class → attestor fixture configuration, detached at
  // construction: which oracle may sign each beneficiary class. An
  // unconfigured class accepts nothing; a registered signing key alone
  // confers no attestation privilege.
  private readonly attestors: ReadonlyMap<string, string>;

  private readonly keys: KeyRegistry;
  private readonly trace: Trace;
  // The world's simulated clock, read lazily: every audit event carries the
  // fixture time of the publication it records.
  private readonly now: () => number;
  private readonly subscribers: ((accepted: AcceptedAuthorityRecord) => void)[] = [];

  constructor(keys: KeyRegistry, trace: Trace, now: () => number, trustedAttestors?: ReadonlyMap<string, string>) {
    this.keys = keys;
    this.trace = trace;
    this.now = now;
    this.employees = new EmployeeAuthority(keys);
    // The trust map is copied once: later edits to the caller's
    // configuration can never change who may attest a class mid-run.
    this.attestors = new Map(trustedAttestors ?? []);
    for (const [classId, attestorId] of this.attestors) {
      if (!nonempty(classId) || !nonempty(attestorId)) {
        throw new Error('trusted attestors need nonempty class and attestor ids');
      }
    }
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.trace.add('LOCAL', 'registry', event, detail);
  }

  // React to accepted records: called synchronously inside publish once the
  // record is stored and its event appended, in publication order. The
  // coordinator subscribes to refresh the publisher employee's open
  // purchases; other kinds need no reaction today.
  subscribe(listener: (accepted: AcceptedAuthorityRecord) => void): void {
    this.subscribers.push(listener);
  }

  private notify(accepted: AcceptedAuthorityRecord): void {
    for (const l of this.subscribers) l(accepted);
  }

  private rejectEmployer(err: EmployerMandateRejection): void {
    const detail: Record<string, unknown> = { reason: err.reason };
    if (err.employerId !== undefined) detail.employerId = err.employerId;
    if (err.mandateRef !== undefined) detail.mandateRef = err.mandateRef;
    if (err.version !== undefined) detail.version = err.version;
    detail.now = this.now();
    this.log('employer_mandate_rejected', detail);
  }

  private rejectEmployee(err: EmployeeMandateRejection): void {
    const detail: Record<string, unknown> = { reason: err.reason };
    if (err.employeeId !== undefined) detail.employeeId = err.employeeId;
    if (err.mandateRef !== undefined) detail.mandateRef = err.mandateRef;
    if (err.version !== undefined) detail.version = err.version;
    detail.now = this.now();
    this.log('employee_mandate_rejected', detail);
  }

  private rejectAllowance(err: AllowanceMandateRejection): void {
    const detail: Record<string, unknown> = { reason: err.reason };
    if (err.donorId !== undefined) detail.donorId = err.donorId;
    if (err.allowanceRef !== undefined) detail.allowanceRef = err.allowanceRef;
    if (err.version !== undefined) detail.version = err.version;
    detail.now = this.now();
    this.log('allowance_mandate_rejected', detail);
  }

  private rejectAttestation(err: EligibilityAttestationRejection): void {
    const detail: Record<string, unknown> = { reason: err.reason };
    if (err.attestorId !== undefined) detail.attestorId = err.attestorId;
    if (err.subjectId !== undefined) detail.subjectId = err.subjectId;
    if (err.classId !== undefined) detail.classId = err.classId;
    if (err.version !== undefined) detail.version = err.version;
    detail.now = this.now();
    this.log('eligibility_attestation_rejected', detail);
  }

  // The employer publishes or replaces the signed mandate a reference
  // resolves to — new terms, changed caps or a revocation. Only a
  // well-formed revision signed by the employer it names and carrying the
  // reference's next version is accepted; every rejection is logged once
  // and leaves the retained mandate in force. Accepted revisions
  // deliberately emit no event: the existing traces predate audited
  // publication and keep their digests.
  publishEmployerMandate(signed: Signed<EmployerMandate>): void {
    let p: EmployerMandate;
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
      if (n.mandateRef !== undefined && this.allowancesAccepted.has(n.mandateRef)) {
        throw new EmployerMandateRejection('ref_owned_by_allowance', n.employerId, n.mandateRef, n.version);
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
  private acceptEmployer(signed: Signed<EmployerMandate>): EmployerMandate {
    if (typeof signed !== 'object' || signed === null || typeof signed.keyId !== 'string' || typeof signed.signature !== 'string') {
      throw new EmployerMandateRejection('malformed');
    }
    const p: unknown = signed.payload;
    if (!wellFormed(p)) {
      const n = namedEmployerMandateFields(p);
      throw new EmployerMandateRejection('malformed', n.employerId, n.mandateRef, n.version);
    }
    // The signer must be the employer the terms name: a mandate signed by
    // anyone else — or tampered with after signing — is not authority. A
    // payload outside the signed domain (a BigInt or function in an extra
    // field) makes canonicalisation throw — malformed, not unverifiable.
    let verified: boolean;
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
  publishEmployeeMandate(signed: Signed<EmployeeMandate>): EmployeeMandate {
    let m: EmployeeMandate;
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
      // Moving the employee's terms to a fresh reference cannot alias a
      // donor allowance either — the namespace check covers the reference
      // the record names, wherever it came from.
      if (n.mandateRef !== undefined && this.allowancesAccepted.has(n.mandateRef)) {
        throw new EmployeeMandateRejection('ref_owned_by_allowance', n.employeeId, n.mandateRef, n.version);
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
  employerMandate(mandateRef: string): Signed<EmployerMandate> | undefined {
    return this.latest.get(mandateRef);
  }

  // The employee's current verified standing terms as a detached copy, or
  // undefined when they never published. Retained data whose signature no
  // longer verifies is invalid, not absent: fail closed.
  employeeMandate(employeeId: string): Signed<EmployeeMandate> | undefined {
    return this.employees.current(employeeId);
  }

  // The retained employee record itself — the object, not a copy, and
  // without re-verification. The fault-injection seam for the check at use:
  // a test corrupting the stored record must see every later verified read
  // fail closed. Callers that are not injecting a fault want
  // employeeMandate().
  storedEmployeeMandate(employeeId: string): Signed<EmployeeMandate> | undefined {
    return this.employees.stored(employeeId);
  }

  // The donor publishes or revises the signed allowance a reference
  // resolves to — new terms, changed caps or a revocation. Only a
  // well-formed revision signed by the donor it names, keeping the
  // reference's first donor and beneficiary class and carrying the next
  // version is accepted; every rejection is logged once and leaves the
  // accepted allowance untouched. Emits the registry's own acceptance
  // event — a revoked revision is its own event, not a second
  // publication.
  publishAllowanceMandate(signed: Signed<AllowanceMandate>): AllowanceMandate {
    let m: AllowanceMandate;
    try {
      // The donor reference space stays distinct from the employer's and
      // the employee's: a sponsor-backed share cites its authority by
      // reference, so one reference must never name an employer mandate,
      // employee terms and an allowance at once. Checked before the
      // record's own validation against acceptance-time state.
      const n = namedAllowanceFields(
        typeof signed === 'object' && signed !== null ? signed.payload : undefined,
      );
      if (n.allowanceRef !== undefined && this.accepted.has(n.allowanceRef)) {
        throw new AllowanceMandateRejection('ref_owned_by_employer', n.donorId, n.allowanceRef, n.version);
      }
      if (n.allowanceRef !== undefined && this.employees.ownsRef(n.allowanceRef)) {
        throw new AllowanceMandateRejection('ref_owned_by_employee', n.donorId, n.allowanceRef, n.version);
      }
      m = this.acceptAllowance(signed);
    } catch (err) {
      if (err instanceof AllowanceMandateRejection) this.rejectAllowance(err);
      throw err;
    }
    this.log(m.revoked ? 'allowance_mandate_revoked' : 'allowance_mandate_published', {
      donorId: m.donorId,
      allowanceRef: m.allowanceRef,
      version: m.version,
      now: this.now(),
    });
    // Subscribers get their own copy: a listener mutating the notified
    // record must not corrupt the copy returned to the publisher.
    this.notify({ kind: 'allowance', allowance: structuredClone(m) });
    return m;
  }

  // Validate, verify and replace the reference's allowance. Any failure
  // throws AllowanceMandateRejection and leaves the accepted record
  // untouched. Returns the accepted revision as a detached copy.
  private acceptAllowance(signed: Signed<AllowanceMandate>): AllowanceMandate {
    if (typeof signed !== 'object' || signed === null || typeof signed.keyId !== 'string' || typeof signed.signature !== 'string') {
      throw new AllowanceMandateRejection('malformed');
    }
    const p: unknown = signed.payload;
    if (!wellFormedAllowance(p)) {
      const n = namedAllowanceFields(p);
      throw new AllowanceMandateRejection('malformed', n.donorId, n.allowanceRef, n.version);
    }
    // The signer must be the donor the terms name: an allowance signed by
    // anyone else — or tampered with after signing — is not authority.
    let verified: boolean;
    try {
      verified = verifyPayload(signed, this.keys, p.donorId);
    } catch {
      throw new AllowanceMandateRejection('malformed', p.donorId, p.allowanceRef, p.version);
    }
    if (!verified) {
      throw new AllowanceMandateRejection('signature_invalid', p.donorId, p.allowanceRef, p.version);
    }
    const prev = this.allowancesAccepted.get(p.allowanceRef);
    if (prev && prev.donorId !== p.donorId) {
      throw new AllowanceMandateRejection('ref_owned_by_another_donor', p.donorId, p.allowanceRef, p.version);
    }
    // The beneficiary class is part of the reference's first-accepted
    // identity: a revision cannot move the allowance to another class.
    if (prev && prev.beneficiaryClass !== p.beneficiaryClass) {
      throw new AllowanceMandateRejection('beneficiary_class_changed', p.donorId, p.allowanceRef, p.version);
    }
    // The version sequence is the rollback guard: a still-valid signature
    // over a superseded revision — in particular one predating a
    // revocation — can never displace the accepted record.
    if (p.version !== (prev?.version ?? 0) + 1) {
      throw new AllowanceMandateRejection('version_not_next', p.donorId, p.allowanceRef, p.version);
    }
    try {
      this.allowances.set(p.allowanceRef, structuredClone(signed));
    } catch {
      throw new AllowanceMandateRejection('malformed', p.donorId, p.allowanceRef, p.version);
    }
    this.allowancesAccepted.set(p.allowanceRef, {
      donorId: p.donorId,
      beneficiaryClass: p.beneficiaryClass,
      version: p.version,
    });
    return structuredClone(p);
  }

  // The oracle publishes or revises the signed attestation a (subject,
  // class) pair resolves to. Only a well-formed record issued by the
  // class's configured attestor, signed by that attestor and carrying the
  // next version is accepted; every rejection is logged once and leaves
  // the accepted attestation untouched.
  publishEligibilityAttestation(signed: Signed<EligibilityAttestation>): EligibilityAttestation {
    let a: EligibilityAttestation;
    try {
      a = this.acceptAttestation(signed);
    } catch (err) {
      if (err instanceof EligibilityAttestationRejection) this.rejectAttestation(err);
      throw err;
    }
    this.log(a.revoked ? 'eligibility_attestation_revoked' : 'eligibility_attestation_published', {
      attestorId: a.attestorId,
      subjectId: a.subjectId,
      classId: a.classId,
      version: a.version,
      now: this.now(),
    });
    // Same notify/return separation as the allowance publish above.
    this.notify({ kind: 'attestation', attestation: structuredClone(a) });
    return a;
  }

  // Validate, verify and replace the pair's attestation. Any failure
  // throws EligibilityAttestationRejection and leaves the accepted record
  // untouched. Returns the accepted revision as a detached copy.
  private acceptAttestation(signed: Signed<EligibilityAttestation>): EligibilityAttestation {
    if (typeof signed !== 'object' || signed === null || typeof signed.keyId !== 'string' || typeof signed.signature !== 'string') {
      throw new EligibilityAttestationRejection('malformed');
    }
    const p: unknown = signed.payload;
    if (!wellFormedAttestation(p)) {
      const n = namedAttestationFields(p);
      throw new EligibilityAttestationRejection('malformed', n.attestorId, n.subjectId, n.classId, n.version);
    }
    // Issuer trust is a property of the class, not of the signature: only
    // the attestor configured for the class may issue its attestations —
    // a registered signing key, including the subject's own, grants no
    // attestation privilege on its own.
    if (this.attestors.get(p.classId) !== p.attestorId) {
      throw new EligibilityAttestationRejection('attestor_not_trusted', p.attestorId, p.subjectId, p.classId, p.version);
    }
    let verified: boolean;
    try {
      verified = verifyPayload(signed, this.keys, p.attestorId);
    } catch {
      throw new EligibilityAttestationRejection('malformed', p.attestorId, p.subjectId, p.classId, p.version);
    }
    if (!verified) {
      throw new EligibilityAttestationRejection('signature_invalid', p.attestorId, p.subjectId, p.classId, p.version);
    }
    const key = attestationKey(p.subjectId, p.classId);
    const prev = this.attestationsAccepted.get(key);
    // Replacement or revocation requires the next version from the same
    // issuer the pair was accepted under — under a fixed class→attestor
    // map this is the trust check again, kept explicit so a changed
    // mapping still cannot quietly reissue accepted authority.
    if (prev && prev.attestorId !== p.attestorId) {
      throw new EligibilityAttestationRejection('attestor_not_trusted', p.attestorId, p.subjectId, p.classId, p.version);
    }
    if (p.version !== (prev?.version ?? 0) + 1) {
      throw new EligibilityAttestationRejection('version_not_next', p.attestorId, p.subjectId, p.classId, p.version);
    }
    try {
      this.attestations.set(key, structuredClone(signed));
    } catch {
      throw new EligibilityAttestationRejection('malformed', p.attestorId, p.subjectId, p.classId, p.version);
    }
    this.attestationsAccepted.set(key, { attestorId: p.attestorId, version: p.version });
    return structuredClone(p);
  }

  // The retained allowance record for a reference — the object itself,
  // not a copy, and without re-verification — bundled with the immutable
  // acceptance-time facts it entered under. The retained object is the
  // registry's fault-injection seam: publish proves only what entered the
  // store, and every verified read must still fail closed on whatever the
  // store now holds against the accepted metadata.
  allowanceMandate(allowanceRef: string): { signed: Signed<AllowanceMandate>; accepted: AcceptedAllowance } | undefined {
    const signed = this.allowances.get(allowanceRef);
    const accepted = this.allowancesAccepted.get(allowanceRef);
    if (signed === undefined || accepted === undefined) return undefined;
    return { signed, accepted: { ...accepted } };
  }

  // Every published allowance reference, as detached strings. References
  // enumerate only through this list — no retained records escape through
  // it.
  allowanceRefs(): string[] {
    return [...this.allowancesAccepted.keys()];
  }

  // The retained attestation for a (subject, class) pair — the object
  // itself, the same fault-injection seam as allowanceMandate — bundled
  // with the immutable issuer/version it was accepted under.
  eligibilityAttestation(
    subjectId: string,
    classId: string,
  ): { signed: Signed<EligibilityAttestation>; accepted: AcceptedAttestation } | undefined {
    const key = attestationKey(subjectId, classId);
    const signed = this.attestations.get(key);
    const accepted = this.attestationsAccepted.get(key);
    if (signed === undefined || accepted === undefined) return undefined;
    return { signed, accepted: { ...accepted } };
  }

  // The attestor trusted for a class under the detached fixture
  // configuration, or undefined when the class accepts no attestations.
  trustedAttestor(classId: string): string | undefined {
    return this.attestors.get(classId);
  }
}
