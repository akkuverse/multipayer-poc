// Where the coordinator finds an employer's current mandate. The employer
// publishes a new signed version to change terms or revoke; the coordinator
// checks the latest one at proposal and again at initiation. A mandate ref
// stays bound to the employer that first published it. The registry stores
// signed payloads unverified: publish is not the trust decision — the
// coordinator verifies the signature at every use and fails closed, so a bad
// payload can only deny funding, never create it.

import type { Signed } from './signing.ts';
import type { EmployerMandate } from './types.ts';

export class MandateRegistry {
  private readonly latest = new Map<string, Signed<EmployerMandate>>();

  publish(m: Signed<EmployerMandate>): void {
    const prev = this.latest.get(m.payload.mandateRef);
    if (prev && prev.payload.employerId !== m.payload.employerId) {
      throw new Error(`mandate ${m.payload.mandateRef} belongs to ${prev.payload.employerId}`);
    }
    this.latest.set(m.payload.mandateRef, m);
  }

  current(mandateRef: string): Signed<EmployerMandate> | undefined {
    return this.latest.get(mandateRef);
  }
}
