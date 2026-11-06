// GENERATED from src/core/verified-authority.ts — type-stripped build artifact; never hand-edit.
// One synchronous decision's view of published authority. A coordinator
// operation — proposal, offer change, approval, refresh, admission, a
// deferred first handoff — may touch the same signed records at several
// helpers that compose into one decision. Within a single uninterrupted
// stretch no publication, corruption or key-registry change can interleave,
// so each record is fetched and verified on first access and the verdict is
// memoized for the rest of the decision: helpers share one verified read
// instead of every reader paying for its own.
//
// A scope must never outlive its stretch. Create it at the start of the
// operation and drop it before the first await — never across operations —
// so the next decision verifies against whatever the registry and keys then
// hold: a stored record corrupted or a signing key removed between two
// operations is still caught at the next decision, because nothing here is
// remembered that long.
//
// Verdicts are keyed by signed CONTENT — holder, key id, signature and the
// canonical payload — never by object identity. The registry's retained
// records are fault-injection seams that tests mutate in place: a mutation
// produces a different key and is verified again, so memoization cannot
// launder tampering into acceptance.

import { canonicalJson, verifyPayload } from './signing.js';




// What an employer reference resolves to in this scope: the verified
// mandate and its signed record when usable, else the refusal problem.
 



export class VerifiedAuthority {
    authority;
    keys;
  // Signed-content verdicts computed this scope. The key registry cannot
  // change inside a synchronous stretch, so one content key has one verdict.
    verdicts = new Map();
  // The reference's resolution this scope: fetch and signature included.
    employers = new Map();
  // The verified standing record per employee this scope.
    employees = new Map();

  constructor(authority, keys) {
    this.authority = authority;
    this.keys = keys;
  }

  // The memoization key for a verdict, or undefined when the payload is
  // outside the signed domain — then verifyPayload itself decides (its own
  // early outs may return false without ever canonicalising).
   static verdictKey(s, holder) {
    try {
      return JSON.stringify([holder, s.keyId, s.signature, canonicalJson(s.payload)]);
    } catch {
      return undefined;
    }
  }

  // The verdict for exactly this signed content under this holder, computed
  // at most once per scope. Identical bytes carried by different objects —
  // a retained snapshot and the record it copied — share one verdict; a
  // mutated record is different content and is verified again.
  verify(s, holder) {
    const key = VerifiedAuthority.verdictKey(s, holder);
    if (key !== undefined && this.verdicts.has(key)) return this.verdicts.get(key);
    const verdict = verifyPayload(s, this.keys, holder);
    if (key !== undefined) this.verdicts.set(key, verdict);
    return verdict;
  }

  // The latest published employer mandate for a reference — the retained
  // record itself, verified on first access this scope — or the problem
  // that makes it unusable. Callers retaining evidence clone it themselves.
  employer(ref) {
    const memo = this.employers.get(ref);
    if (memo !== undefined) return memo;
    const s = this.authority.employerMandate(ref);
    const result = !s
      ? { problem: 'mandate_unknown' }
      : !this.verify(s, s.payload.employerId)
        ? { problem: 'mandate_signature_invalid' }
        : // A verified record carrying incompatible signed privacy terms is
          // its own problem — distinct from a missing or unverifiable
          // mandate, so the caller can refuse it rather than quietly fall
          // back to the request-only case and mask what was signed.
          s.payload.privacyProfile !== 'employer_benefit_v1'
          ? { problem: 'mandate_privacy_profile_invalid' }
          : { mandate: s.payload, signed: s };
    this.employers.set(ref, result);
    return result;
  }

  // The employee's verified standing terms as the registry's detached read
  // returns them, once per scope: undefined when they never published,
  // employee_mandate_invalid thrown on retained data that no longer
  // verifies — never silently absent.
  employee(employeeId) {
    if (this.employees.has(employeeId)) return this.employees.get(employeeId);
    const s = this.authority.employeeMandate(employeeId);
    // The registry read just verified this content under the employee it
    // names: record the verdict so evidence carrying the same signed bytes —
    // a retained mandate snapshot — does not pay a second verification.
    if (s !== undefined) {
      const key = VerifiedAuthority.verdictKey(s, s.payload.employeeId);
      if (key !== undefined) this.verdicts.set(key, true);
    }
    this.employees.set(employeeId, s);
    return s;
  }

  // The signature verdict for one recorded authorization — mandate evidence
  // under its named payer, a device or exception approval under its signer —
  // shared with every other use of the same signed content this decision.
  authorization(a) {
    return a.basis === 'mandate'
      ? this.verify(a.mandate, a.payerId)
      : this.verify(a.approval, a.approval.payload.payerId);
  }
}
