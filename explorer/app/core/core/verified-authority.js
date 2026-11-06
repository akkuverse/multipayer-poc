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
                                                        
import { attestationKey, wellFormedAllowance, wellFormedAttestation } from './authority.js';
                                                        
                                                                                                                            

// What an employer reference resolves to in this scope: the verified
// mandate and its signed record when usable, else the refusal problem.
                                
                                                                                      
                                                                 

// What an allowance reference resolves to in this scope: the verified
// allowance and its signed record when usable, else the refusal problem.
// A resolved record is cryptographically and binding-valid only —
// revocation, validity windows and remaining budget are policy inputs the
// caller evaluates, not signature absence.
                                 
                                                                                          
                                                                   

// What a (subject, class) attestation lookup resolves to in this scope.
// 'attestation_absent' means nothing was ever published for the pair — a
// genuinely missing record the caller may treat as no-match; every other
// problem is retained-but-invalid authority, which fails closed.
                                   
                                                                                                        
                                                                     

export class VerifiedAuthority {
                   authority                   ;
                   keys             ;
  // Signed-content verdicts computed this scope. The key registry cannot
  // change inside a synchronous stretch, so one content key has one verdict.
                   verdicts = new Map                 ();
  // The reference's resolution this scope: fetch and signature included.
                   employers = new Map                            ();
  // The verified standing record per employee this scope.
                   employees = new Map                                             ();
  // The allowance reference's resolution this scope.
                   allowances = new Map                             ();
  // The (subject, class) pair's resolution this scope.
                   attestations = new Map                               ();

  constructor(authority                   , keys             ) {
    this.authority = authority;
    this.keys = keys;
  }

  // The memoization key for a verdict, or undefined when the payload is
  // outside the signed domain — then verifyPayload itself decides (its own
  // early outs may return false without ever canonicalising).
          static verdictKey   (s           , holder        )                     {
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
  verify   (s           , holder        )          {
    const key = VerifiedAuthority.verdictKey(s, holder);
    if (key !== undefined && this.verdicts.has(key)) return this.verdicts.get(key) ;
    const verdict = verifyPayload(s, this.keys, holder);
    if (key !== undefined) this.verdicts.set(key, verdict);
    return verdict;
  }

  // The latest published employer mandate for a reference — the retained
  // record itself, verified on first access this scope — or the problem
  // that makes it unusable. Callers retaining evidence clone it themselves.
  employer(ref        )                     {
    const memo = this.employers.get(ref);
    if (memo !== undefined) return memo;
    const s = this.authority.employerMandate(ref);
    const result                     = !s
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
  employee(employeeId        )                                      {
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

  // The latest published donor allowance for a reference — the retained
  // record itself, verified on first access this scope — or the problem
  // that makes it unusable. Unlike an absent record ('allowance_unknown',
  // which a caller may treat as no-match), a retained record that fails
  // schema, signature or the immutable acceptance-time binding fails
  // closed: corrupt or superseded authority can never masquerade as no
  // allowance. Callers retaining evidence clone it themselves.
  allowance(ref        )                      {
    const memo = this.allowances.get(ref);
    if (memo !== undefined) return memo;
    const r = this.authority.allowanceMandate(ref);
    let result                     ;
    try {
      result =
        r === undefined
          ? { problem: 'allowance_unknown' }
          : !wellFormedAllowance(r.signed.payload)
            ? { problem: 'allowance_malformed' }
            : !this.verify(r.signed, r.signed.payload.donorId)
              ? { problem: 'allowance_signature_invalid' }
              : // The lookup binding and the immutable acceptance-time facts,
                // re-verified at use: a retained record swapped for another
                // validly signed one still cannot name a different
                // reference, donor, class or revision than the reference was
                // accepted under.
                r.signed.payload.allowanceRef !== ref ||
                  r.signed.payload.donorId !== r.accepted.donorId ||
                  r.signed.payload.beneficiaryClass !== r.accepted.beneficiaryClass ||
                  r.signed.payload.version !== r.accepted.version
                ? { problem: 'allowance_binding_invalid' }
                : { allowance: r.signed.payload, signed: r.signed };
    } catch {
      // A retained record outside the signed domain — e.g. a BigInt
      // fault-injected past publication — makes verification throw rather
      // than return false. Publish converts that throw to malformed; the
      // verified read fails closed the same way, never a raw TypeError.
      result = { problem: 'allowance_malformed' };
    }
    this.allowances.set(ref, result);
    return result;
  }

  // The attestation published for one (subject, class) pair — verified on
  // first access this scope — or the problem that makes it unusable.
  // Nothing stored for the pair is 'attestation_absent': a genuinely
  // missing record that policy may treat as no-match. A retained record
  // that fails schema, lookup binding, issuer trust, signature or the
  // accepted issuer/revision is invalid authority, not absence — it fails
  // closed. A resolved record still carries its own temporal terms;
  // validity window and revocation are policy inputs, checked by the
  // caller, not signature facts.
  attestation(subjectId        , classId        )                        {
    const key = attestationKey(subjectId, classId);
    const memo = this.attestations.get(key);
    if (memo !== undefined) return memo;
    const r = this.authority.eligibilityAttestation(subjectId, classId);
    const trusted = this.authority.trustedAttestor(classId);
    let result                       ;
    try {
      result =
        r === undefined
          ? { problem: 'attestation_absent' }
          : !wellFormedAttestation(r.signed.payload)
            ? { problem: 'attestation_malformed' }
            : // The stored record must still bind the pair it was looked up
              // under — a retained payload corrupted or swapped into another
              // subject's slot is invalid, not a miss.
              r.signed.payload.subjectId !== subjectId || r.signed.payload.classId !== classId
              ? { problem: 'attestation_binding_invalid' }
              : trusted === undefined || r.signed.payload.attestorId !== trusted
                ? { problem: 'attestor_not_trusted' }
                : !this.verify(r.signed, r.signed.payload.attestorId)
                  ? { problem: 'attestation_signature_invalid' }
                  : r.signed.payload.attestorId !== r.accepted.attestorId ||
                      r.signed.payload.version !== r.accepted.version
                    ? { problem: 'attestation_binding_invalid' }
                    : { attestation: r.signed.payload, signed: r.signed };
    } catch {
      // Same uncanonicalizable-retained-record guard as allowance(): the
      // throw verification produces on out-of-domain content reads as
      // malformed authority, not an uncaught TypeError.
      result = { problem: 'attestation_malformed' };
    }
    this.attestations.set(key, result);
    return result;
  }

  // The signature verdict for one recorded authorization — mandate evidence
  // under its named payer, a contributor's pledge under the pledger its
  // payload names, a device or exception approval under its signer —
  // shared with every other use of the same signed content this decision.
  authorization(a               )          {
    return a.basis === 'mandate'
      ? this.verify(a.mandate, a.payerId)
      : a.basis === 'pledge'
        ? this.verify(a.pledge, a.pledge.payload.by)
        : this.verify(a.approval, a.approval.payload.payerId);
  }
}
