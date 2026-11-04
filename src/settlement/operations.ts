// Operation identity and the immutable keyed-operation store (spec §7).
// Every settlement operation — reserve, commit, release, return, fund,
// defund — is keyed before handoff by a tuple-encoded identity: namespace,
// purchase/proposal identity, operation, stage and destination. The store
// records the intent once, dedupes replays by canonical terms, and refuses
// any reuse of a key under different terms; terminal outcomes are
// immutable. Lost responses stay 'unknown' — never a fabricated failure.

import { canonicalJson } from '../core/signing.ts';
import type { OperationOutcome, OperationRecord, OperationStatus } from './types.ts';

// Encode an operation identity as JSON over its tuple parts, so identifiers
// containing delimiters can never shift a value into a neighbouring slot —
// ('a:b', 1) and ('a', 'b:1') produce different keys. Parts are non-empty
// strings or finite numbers: namespace, identity, operation, stage and
// destination as the caller composes them.
export function operationKey(parts: readonly (string | number)[]): string {
  if (parts.length === 0) throw new Error('operation key needs at least one part');
  for (const part of parts) {
    const ok = typeof part === 'string' ? part.length > 0 : typeof part === 'number' && Number.isFinite(part);
    if (!ok) throw new Error('operation key parts must be non-empty strings or finite numbers');
  }
  return JSON.stringify(parts);
}

const TERMINAL: readonly OperationStatus[] = ['succeeded', 'rejected'];
const RESOLVABLE: readonly OperationStatus[] = ['pending', 'succeeded', 'rejected', 'unknown'];

// canonicalJson silently maps NaN and Infinity to null — '{a:NaN}' and
// '{a:null}' would dedupe to the same recorded terms — so a non-finite
// number anywhere in a payload makes it unfit for canonical comparison.
function containsNonFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFiniteNumber);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsNonFiniteNumber);
  }
  return false;
}

interface OperationEntry {
  // canonicalJson of the terms, for order-insensitive replay comparison.
  canonical: string;
  record: OperationRecord;
}

// The idempotency store each ledger and provider keeps: records stay inside
// the module; callers only ever see detached copies. begin() is the only
// write path for new identities, resolve() the only forward move — and a
// terminal outcome can never be rewritten.
export class OperationStore {
  private readonly entries = new Map<string, OperationEntry>();

  // Record the operation intent before handoff, or return the existing
  // record for an identical replay. A canonically different terms object
  // under the same key is a conclusive refusal: terms are compared through
  // canonicalJson so key order cannot matter, and a copy is retained so the
  // caller's object cannot later alter what was recorded.
  begin(key: string, terms: unknown): OperationRecord {
    if (typeof key !== 'string' || key.length === 0) throw new Error('operation needs a non-empty key');
    let canonical: string;
    try {
      canonical = canonicalJson(terms);
    } catch {
      throw new Error('operation_terms_invalid');
    }
    // canonicalJson returns undefined for an undefined root — no canonical
    // form exists — and maps non-finite numbers to null, which would alias
    // distinct terms under one key; both make the terms unusable.
    if (typeof canonical !== 'string' || containsNonFiniteNumber(terms)) {
      throw new Error('operation_terms_invalid');
    }
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.canonical !== canonical) throw new Error('operation_terms_conflict');
      return structuredClone(existing.record);
    }
    let copy: unknown;
    try {
      copy = structuredClone(terms);
    } catch {
      throw new Error('operation_terms_invalid');
    }
    const record: OperationRecord = { key, terms: copy, status: 'not_started' };
    this.entries.set(key, { canonical, record });
    return structuredClone(record);
  }

  // The retained record for a key, detached, or undefined when the key was
  // never begun — the store's way of saying the operation was never started.
  status(key: string): OperationRecord | undefined {
    const entry = this.entries.get(key);
    return entry === undefined ? undefined : structuredClone(entry.record);
  }

  // Move the operation forward with what is now known. An unknown key is a
  // protocol violation — the intent must be recorded before any outcome can
  // land. 'pending' and 'unknown' keep the operation open and may follow each
  // other as evidence arrives; a terminal record accepts only an identical
  // replay — a different outcome for resolved work is refused.
  resolve(key: string, outcome: OperationOutcome): OperationRecord {
    const entry = this.entries.get(key);
    if (entry === undefined) throw new Error('unknown_operation');
    if (!RESOLVABLE.includes(outcome.status)) throw new Error('operation_outcome_invalid');
    // Reported effects become stored evidence that terminal replays compare
    // through canonicalJson, so like terms they must serialize and detach:
    // an outcome whose effects cannot be canonicalized or cloned is invalid,
    // never a raw TypeError/DataCloneError out of the store.
    let canonicalEffects: string | undefined;
    let effectsCopy: unknown;
    if (outcome.effects !== undefined) {
      try {
        canonicalEffects = canonicalJson(outcome.effects);
        effectsCopy = structuredClone(outcome.effects);
      } catch {
        throw new Error('operation_outcome_invalid');
      }
    }
    const rec = entry.record;
    if (TERMINAL.includes(rec.status)) {
      // The terminal result is immutable: an identical report replays to the
      // same record; any difference — status, reference, reason, effects —
      // is a conflict, never a silent rewrite.
      if (
        outcome.status !== rec.status ||
        (outcome.reference !== undefined && outcome.reference !== rec.reference) ||
        (outcome.reason !== undefined && outcome.reason !== rec.reason) ||
        (canonicalEffects !== undefined && canonicalEffects !== canonicalJson(rec.effects))
      ) {
        throw new Error('operation_outcome_conflict');
      }
      return structuredClone(rec);
    }
    // A reference once learned cannot change while the operation is open:
    // a different reference for the same operation is a new effect, not a
    // correction of the old.
    if (outcome.reference !== undefined && rec.reference !== undefined && outcome.reference !== rec.reference) {
      throw new Error('operation_outcome_conflict');
    }
    rec.status = outcome.status;
    // Evidence accumulates latest-wins, but only where the outcome carries
    // a value: a field left undefined reports nothing and must not erase
    // what earlier outcomes recorded.
    if (outcome.reference !== undefined) rec.reference = outcome.reference;
    if (outcome.reason !== undefined) rec.reason = outcome.reason;
    if (outcome.effects !== undefined) rec.effects = effectsCopy;
    return structuredClone(rec);
  }
}
