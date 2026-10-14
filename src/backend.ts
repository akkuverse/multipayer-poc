// The seam between the coordinator and whatever settles money. MockBackend
// implements it here; the ECB adapter, kept outside this repository, will
// implement the same interface and tag its events ECB_API.

import type { Cents, Origin, SettlementMode } from './types.ts';

export interface LegRequest {
  payerId: string;
  // Usually the merchant; differs per leg in multi-payee purchases.
  payeeId: string;
  amountCents: Cents;
  // Payer fee on top of amountCents, paid to the payer's PSP. Zero in every fixture.
  feeCents: Cents;
  idempotencyKey: string;
}

export interface LegResponse {
  idempotencyKey: string;
  executionRef: string;
  status: 'settled' | 'rejected' | 'unknown';
  reason?: string;
}

export type ExecutionStatus = 'settled' | 'rejected' | 'unknown' | 'returned';

export interface SubmitRequest {
  // Application grouping of the legs of one purchase. Not proof of atomicity.
  groupRef: string;
  mode: SettlementMode;
  legs: LegRequest[];
  // Set when each payer's PSP submits its own leg of an atomic group (one leg
  // per request). The backend holds the legs until `size` have arrived and
  // rejects the whole group if that has not happened by `assembleBy` on the
  // backend clock. Mock hypothesis; ECB behaviour unknown.
  assembly?: { size: number; assembleBy: number };
}

export interface SettlementBackend {
  readonly name: string;
  // Evidence origin of this backend's events: LOCAL for the mock.
  readonly origin: Origin;
  // The semantics version this backend implements: the mock's assumption set,
  // or the ECB specification version for an adapter. Recorded with every run.
  readonly specVersion: string;
  submit(req: SubmitRequest): Promise<LegResponse[]>;
  // Authoritative status; resolves outcomes whose response was lost.
  status(executionRef: string): Promise<ExecutionStatus>;
  // Return a settled leg to its original payer, or report the operation unsupported.
  refund(executionRef: string): Promise<'returned' | 'unsupported'>;
}
