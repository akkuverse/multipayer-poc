// The reachable-pairs state machine for a purchase record. Coordinator
// transition() is the only writer of rec.state and refuses any pair absent
// from this table, so an unreachable move fails loudly at the single write
// path instead of drifting into a state no call path can produce.
//
//   draft:              → awaiting_approvals, ready, failed, cancelled
//   awaiting_approvals: → draft, ready, failed, cancelled
//   ready:              → draft, awaiting_approvals, pending, completed,
//                         failed, recovery_required, cancelled
//   pending:            → completed, failed, recovery_required, cancelled
//   recovery_required:  → cancelled
//   completed, failed, cancelled: terminal
//
// The table is permissive over reachable pairs, not per-cause: derive() can
// legally jump ready → completed (all legs settle in one pass) and
// pending → cancelled (a rejected+returned mix). 'completed' is terminal
// because reconcile only queries 'unknown' legs and resubmit is state-gated
// — a settled leg can never be reported 'unknown' by the current call
// paths. If a future adapter produces one, illegal_transition is the
// correct loud failure rather than a silent completed → pending downgrade.

import type { PurchaseState } from './types.ts';

export const TRANSITIONS: Readonly<Record<PurchaseState, readonly PurchaseState[]>> = {
  draft: ['awaiting_approvals', 'ready', 'failed', 'cancelled'],
  awaiting_approvals: ['draft', 'ready', 'failed', 'cancelled'],
  ready: ['draft', 'awaiting_approvals', 'pending', 'completed', 'failed', 'recovery_required', 'cancelled'],
  pending: ['completed', 'failed', 'recovery_required', 'cancelled'],
  recovery_required: ['cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

// The states a record may enter the store in: adoption inserts a purchase
// whose proposal already exists — no purchase is ever adopted in 'draft'.
// 'draft' remains reachable via refreshAuth's blocked-merchant path.
export const ADOPTABLE: readonly PurchaseState[] = ['awaiting_approvals', 'ready'];

export const canTransition = (from: PurchaseState, to: PurchaseState): boolean => TRANSITIONS[from].includes(to);
