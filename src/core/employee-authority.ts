// Where the coordinator keeps each employee's signed standing payment terms.
// Unlike the employer MandateRegistry, publication here is the trust decision:
// a record is schema-checked, verified against its owner's key and checked
// against the version sequence before it replaces the accepted terms, so a
// rejected write can never displace them. There is one standing record per
// employee; a mandate reference stays bound to the employee that first used
// it, even after they move their terms to a new reference. Reads verify the
// retained signature again and return detached copies, so stored terms can
// neither be mutated through a returned object nor silently treated as absent
// when they no longer verify.

import { verifyPayload } from './signing.ts';
import type { KeyRegistry, Signed } from './signing.ts';
import type { EmployeeMandate } from './types.ts';

// A publication that failed validation or verification. Carries the
// machine-checkable reason plus the parties and proposed revision it names
// when the payload was well-formed enough to identify them.
export class EmployeeMandateRejection extends Error {
  readonly reason:
    | 'malformed'
    | 'signature_invalid'
    | 'ref_owned_by_another_employee'
    | 'ref_owned_by_employer'
    | 'version_not_next';
  readonly employeeId?: string;
  readonly mandateRef?: string;
  readonly version?: number;

  constructor(reason: EmployeeMandateRejection['reason'], employeeId?: string, mandateRef?: string, version?: number) {
    super(`employee_mandate_rejected:${reason}`);
    this.name = 'EmployeeMandateRejection';
    this.reason = reason;
    this.employeeId = employeeId;
    this.mandateRef = mandateRef;
    this.version = version;
  }
}

const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const cents = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

// Unique, nonempty merchant IDs. Overlap between the trust and block lists is
// allowed here; the block takes precedence when the terms are used.
const merchantIds = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((m) => typeof m === 'string' && m.length > 0) && new Set(v).size === v.length;

// Every field the spec §3 schema requires, with its value rules, checked
// before any field is dereferenced for verification or indexing.
const wellFormed = (p: unknown): p is EmployeeMandate => {
  if (typeof p !== 'object' || p === null) return false;
  const m = p as EmployeeMandate;
  return (
    nonempty(m.mandateRef) &&
    nonempty(m.employeeId) &&
    Number.isSafeInteger(m.version) &&
    m.version >= 1 &&
    cents(m.autoPayMaxCents) &&
    cents(m.maxCents) &&
    m.autoPayMaxCents <= m.maxCents &&
    cents(m.autoPayMonthlyCents) &&
    merchantIds(m.trustedMerchants) &&
    merchantIds(m.blockedMerchants) &&
    Number.isFinite(m.validUntil) &&
    m.validUntil >= 0 &&
    typeof m.revoked === 'boolean'
  );
};

// The parties and proposed revision a malformed payload still safely names.
// Used for rejection detail and for the coordinator's employer-reference
// check, which runs before the authority module's own validation.
export const namedEmployeeMandateFields = (p: unknown): { employeeId?: string; mandateRef?: string; version?: number } => {
  if (typeof p !== 'object' || p === null) return {};
  const o = p as Record<string, unknown>;
  return {
    employeeId: nonempty(o.employeeId) ? o.employeeId : undefined,
    mandateRef: nonempty(o.mandateRef) ? o.mandateRef : undefined,
    version: Number.isSafeInteger(o.version) ? (o.version as number) : undefined,
  };
};

export class EmployeeAuthority {
  // The accepted record per employee — at most one standing set of terms.
  private readonly byEmployee = new Map<string, Signed<EmployeeMandate>>();
  // Permanent binding of every published reference to its first owner, so a
  // reference change cannot hand standing terms to another employee.
  private readonly refOwner = new Map<string, string>();

  private readonly keys: KeyRegistry;

  constructor(keys: KeyRegistry) {
    this.keys = keys;
  }

  // Validate, verify and replace the employee's standing terms. Any failure
  // throws EmployeeMandateRejection and leaves the accepted record untouched.
  // Returns the stored terms so the caller can log the accepted revision.
  publish(signed: Signed<EmployeeMandate>): EmployeeMandate {
    if (typeof signed !== 'object' || signed === null || typeof signed.keyId !== 'string' || typeof signed.signature !== 'string') {
      throw new EmployeeMandateRejection('malformed');
    }
    const p: unknown = signed.payload;
    if (!wellFormed(p)) {
      const n = namedEmployeeMandateFields(p);
      throw new EmployeeMandateRejection('malformed', n.employeeId, n.mandateRef, n.version);
    }
    // The signer must be the employee the terms name: a mandate signed by
    // anyone else — or tampered with after signing — is not authority.
    if (!verifyPayload(signed, this.keys, p.employeeId)) {
      throw new EmployeeMandateRejection('signature_invalid', p.employeeId, p.mandateRef, p.version);
    }
    const owner = this.refOwner.get(p.mandateRef);
    if (owner !== undefined && owner !== p.employeeId) {
      throw new EmployeeMandateRejection('ref_owned_by_another_employee', p.employeeId, p.mandateRef, p.version);
    }
    // The version sequence belongs to the employee's record, not the
    // reference: a replacement under a new reference must still carry the
    // next version, so a new reference cannot reset standing terms.
    const next = (this.byEmployee.get(p.employeeId)?.payload.version ?? 0) + 1;
    if (p.version !== next) {
      throw new EmployeeMandateRejection('version_not_next', p.employeeId, p.mandateRef, p.version);
    }
    // Store a copy: later edits to the caller's signed object must not alter
    // the accepted terms.
    this.byEmployee.set(p.employeeId, structuredClone(signed));
    this.refOwner.set(p.mandateRef, p.employeeId);
    return structuredClone(p);
  }

  // The employee's current verified standing terms as a detached copy, or
  // undefined when they never published. A retained record whose signature
  // no longer verifies is invalid data, not absence: fail closed.
  current(employeeId: string): Signed<EmployeeMandate> | undefined {
    const s = this.byEmployee.get(employeeId);
    if (!s) return undefined;
    if (!verifyPayload(s, this.keys, s.payload.employeeId)) throw new Error('employee_mandate_invalid');
    return structuredClone(s);
  }
}
