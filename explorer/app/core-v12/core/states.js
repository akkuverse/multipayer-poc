// GENERATED from src/core/states.ts — type-stripped build artifact; never hand-edit.




























export const TRANSITIONS = {
  draft: ['awaiting_approvals', 'ready', 'failed', 'cancelled'],
  awaiting_approvals: ['draft', 'ready', 'failed', 'cancelled'],
  ready: ['draft', 'awaiting_approvals', 'pending', 'completed', 'failed', 'recovery_required', 'compensated', 'cancelled'],
  pending: ['completed', 'failed', 'recovery_required', 'compensated', 'cancelled'],
  recovery_required: ['pending', 'compensated', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  compensated: [],
};

// The states a record may enter the store in: adoption inserts a purchase
// whose proposal already exists — no purchase is ever adopted in 'draft'.
// 'draft' remains reachable via refreshAuth's blocked-merchant path.
export const ADOPTABLE = ['awaiting_approvals', 'ready'];

export const canTransition = (from, to) => TRANSITIONS[from].includes(to);
