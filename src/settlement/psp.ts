// A payer's PSP as the coordinator reaches it under per-payer initiation. In
// the ECB test environment every participant acts as a simulated PSP; this
// makes explicit which PSP initiates which leg. It forwards to the backend and
// can be switched off to model an unavailable PSP.

import type { ExecutionStatus, LegResponse, SettlementBackend, SubmitRequest } from './backend.ts';
import type { Trace } from '../evidence/trace.ts';
import type { Origin } from '../core/types.ts';

// The PSP refused before forwarding anything: conclusively not submitted.
export class PspUnavailableError extends Error {
  constructor(pspId: string) {
    super(`psp ${pspId} unavailable`);
  }
}

export class SimulatedPsp implements SettlementBackend {
  readonly pspId: string;
  private readonly backend: SettlementBackend;
  private readonly trace: Trace;
  available = true;
  // Trusted fixture routing property: whether this PSP can carry
  // mandate-initiated (automatic) payments for its payer. It models a
  // fixture assumption, never real provider support; fixtures set it from
  // the same option that feeds the coordinator's direct-route lookup, and
  // absence means false.
  supportsMandatePayments = false;

  constructor(pspId: string, backend: SettlementBackend, trace: Trace) {
    this.pspId = pspId;
    this.backend = backend;
    this.trace = trace;
  }

  get name(): string {
    return this.pspId;
  }

  get origin(): Origin {
    return this.backend.origin;
  }

  get specVersion(): string {
    return this.backend.specVersion;
  }

  private check(op: string): void {
    if (this.available) return;
    this.trace.add('LOCAL', this.pspId, 'psp_unavailable', { op });
    throw new PspUnavailableError(this.pspId);
  }

  async submit(req: SubmitRequest): Promise<LegResponse[]> {
    this.check('submit');
    this.trace.add('LOCAL', this.pspId, 'forward', { groupRef: req.groupRef, keys: req.legs.map((l) => l.idempotencyKey) });
    return this.backend.submit(req);
  }

  async status(executionRef: string): Promise<ExecutionStatus> {
    this.check('status');
    return this.backend.status(executionRef);
  }

  async refund(executionRef: string): Promise<'returned' | 'unsupported'> {
    this.check('refund');
    return this.backend.refund(executionRef);
  }
}
