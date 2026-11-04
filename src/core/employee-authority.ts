// The employee side of the AuthorityRegistry's store: each employee's signed
// standing payment terms. Like the employer side, publication here is the
// trust decision: a record is schema-checked, verified against its owner's
// key and checked against the version sequence before it replaces the
// accepted terms, so a rejected write can never displace them. There is one
// standing record per employee; a mandate reference stays bound to the
// employee that first used it, even after they move their terms to a new
// reference. Reads verify the retained signature again and return detached
// copies, so stored terms can neither be mutated through a returned object
// nor silently treated as absent when they no longer verify.

import { verifyPayload } from './signing.ts';
import type { KeyRegistry, Signed } from './signing.ts';
import { RAILS } from './types.ts';
import type { AutoPayBlockedReason, Cents, EmployeeAssessment, EmployeeMandate, Rail } from './types.ts';

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

// A nonempty, duplicate-free list of recognized rails.
const rails = (v: unknown): v is Rail[] =>
  Array.isArray(v) && v.length > 0 && new Set(v).size === v.length && v.every((r) => (RAILS as readonly unknown[]).includes(r));

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
    rails(m.allowedRails) &&
    Number.isFinite(m.validUntil) &&
    m.validUntil >= 0 &&
    typeof m.revoked === 'boolean'
  );
};

// The parties and proposed revision a malformed payload still safely names.
// Used for rejection detail and for the registry's reference-exclusivity
// check, which runs before the record kind's own validation.
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
  // Acceptance-time version per employee. Never exposed through stored():
  // the version decision consults this, not the mutable record, so
  // corrupting retained terms can only fail at use — it can never reopen
  // the rollback window.
  private readonly acceptedVersion = new Map<string, number>();

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
    // anyone else — or tampered with after signing — is not authority. A
    // payload outside the signed domain (a BigInt or function in an extra
    // field) makes canonicalisation throw — malformed, not unverifiable.
    let verified: boolean;
    try {
      verified = verifyPayload(signed, this.keys, p.employeeId);
    } catch {
      throw new EmployeeMandateRejection('malformed', p.employeeId, p.mandateRef, p.version);
    }
    if (!verified) {
      throw new EmployeeMandateRejection('signature_invalid', p.employeeId, p.mandateRef, p.version);
    }
    const owner = this.refOwner.get(p.mandateRef);
    if (owner !== undefined && owner !== p.employeeId) {
      throw new EmployeeMandateRejection('ref_owned_by_another_employee', p.employeeId, p.mandateRef, p.version);
    }
    // The version sequence belongs to the employee's record, not the
    // reference: a replacement under a new reference must still carry the
    // next version, so a new reference cannot reset standing terms.
    const next = (this.acceptedVersion.get(p.employeeId) ?? 0) + 1;
    if (p.version !== next) {
      throw new EmployeeMandateRejection('version_not_next', p.employeeId, p.mandateRef, p.version);
    }
    // Store a copy: later edits to the caller's signed object must not alter
    // the accepted terms. An uncloneable extra field is malformed too.
    try {
      this.byEmployee.set(p.employeeId, structuredClone(signed));
    } catch {
      throw new EmployeeMandateRejection('malformed', p.employeeId, p.mandateRef, p.version);
    }
    this.refOwner.set(p.mandateRef, p.employeeId);
    this.acceptedVersion.set(p.employeeId, p.version);
    return structuredClone(p);
  }

  // Whether a published reference is permanently bound to an employee's
  // terms — the registry's check against one reference naming both an
  // employer mandate and employee standing terms.
  ownsRef(mandateRef: string): boolean {
    return this.refOwner.has(mandateRef);
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

  // The retained record itself — the object, not a copy, and without
  // re-verification. The fault-injection seam for the check at use: a test
  // corrupting the stored record must see every later verified read fail
  // closed. Callers that are not injecting a fault want current().
  stored(employeeId: string): Signed<EmployeeMandate> | undefined {
    return this.byEmployee.get(employeeId);
  }
}

// Everything one deterministic assessment needs — verified standing terms or
// their absence, the employee debit (share plus fee), the merchant, current
// monthly usage, the clock and the routed PSP capability. A pure function:
// the same inputs always give the same zone and reason.
export interface AssessmentInput {
  // The employee's verified standing terms, or undefined when they never
  // published. Invalid stored authority never reaches here: it is a
  // precondition failure (employee_mandate_invalid), not absence.
  mandate?: EmployeeMandate;
  employeeDebitCents: Cents;
  // The rail(s) the employee debit would ride — every share of the employee's
  // payer-authority shares. Standing terms authorize only the rails they
  // name; a debit on any other rail can never draw automatic authority.
  employeeDebitRails: readonly Rail[];
  merchantId: string;
  // Reserved plus consumed automatic debits already booked this month,
  // excluding the purchase being assessed.
  monthlyUsageCents: Cents;
  now: number;
  // Whether the routed PSP can carry mandate-initiated payments (fixture
  // routing data; absent capability means false, never an assumption).
  mandateCapable: boolean;
}

// The spec §4 zone/reason decision, in its exact precedence order. Expiry
// and revocation disable automatic authority only: the retained maximum and
// the blocked list keep applying to manual purchases until the terms are
// explicitly replaced.
export const assessEmployeeAuthorization = (input: AssessmentInput): EmployeeAssessment => {
  const { mandate, employeeDebitCents, employeeDebitRails, merchantId, monthlyUsageCents, now, mandateCapable } = input;
  // Validate before any zone can return, including no-mandate/manual and
  // Exception decisions. A rounded principal-plus-fee sum is never payable.
  if (!cents(employeeDebitCents)) throw new Error('employee debit must be nonnegative safe integer cents');
  if (!cents(monthlyUsageCents)) throw new Error('monthly usage must be nonnegative safe integer cents');
  const answer = (authZone: EmployeeAssessment['authZone'], autoPayBlockedReason?: AutoPayBlockedReason): EmployeeAssessment => {
    const a: EmployeeAssessment = { authZone, employeeDebitCents };
    if (mandate) a.mandate = { mandateRef: mandate.mandateRef, version: mandate.version, maxCents: mandate.maxCents };
    if (autoPayBlockedReason) a.autoPayBlockedReason = autoPayBlockedReason;
    return a;
  };
  // Block takes precedence over trust and applies whenever a verified record
  // names the merchant — expired or revoked terms do not unblock it.
  if (mandate?.blockedMerchants.includes(merchantId)) return answer('Blocked', 'blocked_merchant');
  if (!mandate) return answer('Confirm', 'no_employee_mandate');
  // Exceeding the retained maximum is payable only through a signed one-off
  // exception; it is not an absolute ceiling, but it is never automatic.
  if (employeeDebitCents > mandate.maxCents) return answer('Exception', 'exceeds_mandate');
  // The standing terms name the rails they fund: a debit riding any other
  // rail is outside them and can never draw automatic authority — a record
  // predating the binding fails closed rather than permitting everything.
  if (!employeeDebitRails.every((r) => (mandate.allowedRails ?? []).includes(r))) {
    return answer('Confirm', 'rail_not_permitted');
  }
  if (mandate.revoked) return answer('Confirm', 'mandate_revoked');
  if (now > mandate.validUntil) return answer('Confirm', 'mandate_expired');
  // Either automatic limit at zero disables auto-pay outright — including a
  // zero-debit purchase, so a disabled setting can never initiate orders.
  if (mandate.autoPayMaxCents === 0 || mandate.autoPayMonthlyCents === 0) return answer('Confirm', 'auto_off');
  if (employeeDebitCents > mandate.autoPayMaxCents) return answer('Confirm', 'over_auto_limit');
  if (!mandate.trustedMerchants.includes(merchantId)) return answer('Confirm', 'untrusted_merchant');
  // Validated arithmetic (spec §4): a usage-plus-debit sum that cannot be
  // represented as a safe integer can never be shown to fit the cap, so it
  // fails closed as monthly_cap rather than wrapping to a wrong decision.
  const monthlyTotalCents = monthlyUsageCents + employeeDebitCents;
  if (!Number.isSafeInteger(monthlyTotalCents) || monthlyTotalCents > mandate.autoPayMonthlyCents) return answer('Confirm', 'monthly_cap');
  if (!mandateCapable) return answer('Confirm', 'psp_unsupported');
  return answer('Auto');
};
