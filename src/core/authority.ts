// Where the coordinator finds an employer's current mandate. The employer
// publishes a new signed version to change terms or revoke; publication is
// the trust decision: a record is schema-checked, verified against the key of
// the employer it names and checked against the reference's version sequence
// before it may replace the accepted terms, so a rejected write can never
// displace them. A mandate ref stays bound to the employer that first
// published it. The coordinator still verifies the retained signature at
// every use and fails closed, so a record corrupted after acceptance can
// only deny funding, never create it.

import { verifyPayload } from './signing.ts';
import type { KeyRegistry, Signed } from './signing.ts';
import type { EmployerMandate } from './types.ts';

// A publication that failed validation or verification. Carries the
// machine-checkable reason plus the parties and proposed revision it names
// when the payload was well-formed enough to identify them.
export class EmployerMandateRejection extends Error {
  readonly reason:
    | 'malformed'
    | 'signature_invalid'
    | 'ref_owned_by_another_employer'
    | 'ref_owned_by_employee'
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
    typeof m.revoked === 'boolean'
  );
};

// The parties and proposed revision a malformed payload still safely names.
// Used for rejection detail and for the coordinator's employee-reference
// check, which runs before the authority module's own validation.
export const namedEmployerMandateFields = (p: unknown): { employerId?: string; mandateRef?: string; version?: number } => {
  if (typeof p !== 'object' || p === null) return {};
  const o = p as Record<string, unknown>;
  return {
    employerId: nonempty(o.employerId) ? o.employerId : undefined,
    mandateRef: nonempty(o.mandateRef) ? o.mandateRef : undefined,
    version: Number.isSafeInteger(o.version) ? (o.version as number) : undefined,
  };
};

export class MandateRegistry {
  // The accepted record per reference — what current() exposes.
  private readonly latest = new Map<string, Signed<EmployerMandate>>();
  // Acceptance-time owner and version per reference. Never exposed through
  // current(): ownership and version decisions consult this, not the mutable
  // record, so corrupting retained data can only deny funding at use — it
  // can never reopen the rollback window or rebind a reference.
  private readonly accepted = new Map<string, { employerId: string; version: number }>();

  private readonly keys: KeyRegistry;

  constructor(keys: KeyRegistry) {
    this.keys = keys;
  }

  // Validate, verify and replace the reference's mandate. Any failure throws
  // EmployerMandateRejection and leaves the accepted record untouched. The
  // employer/employee reference-namespace split is not checked here — it
  // needs both registries, so it is the coordinator's check.
  publish(signed: Signed<EmployerMandate>): void {
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
  }

  // The retained record — the object itself, not a copy. Post-acceptance
  // mutation is the fault-injection seam for the coordinator's check at use:
  // publish() proves only what entered the store, and mandate() must still
  // fail closed on whatever the store now holds.
  current(mandateRef: string): Signed<EmployerMandate> | undefined {
    return this.latest.get(mandateRef);
  }
}
