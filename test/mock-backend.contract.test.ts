// The retained legacy SettlementBackend implementation still satisfies the
// port contract. Task 6 removes this module and this file with it; until
// then the contract is run against a directly constructed fixture — the
// production world no longer exposes a backend.

import { settlementBackendContract } from './contract/settlement-backend.contract.ts';
import { MockBackend } from '../src/settlement/mock-backend.ts';
import { Trace } from '../src/evidence/trace.ts';
import { EMPLOYEE, EMPLOYER, MERCHANT_A } from '../src/scenarios.ts';

const backend = () => {
  const b = new MockBackend(new Trace());
  b.addAccount({ id: EMPLOYEE, kind: 'individual', deCents: 2_000, holdingLimitCents: 300_000, linkedBankCents: 50_000, reverseWaterfall: true });
  b.addAccount({ id: EMPLOYER, kind: 'individual', deCents: 2_000, holdingLimitCents: 300_000, linkedBankCents: 100_000, reverseWaterfall: true });
  b.addAccount({ id: MERCHANT_A, kind: 'business', deCents: 0, holdingLimitCents: 0, linkedBankCents: 0, reverseWaterfall: true });
  return b;
};

settlementBackendContract('MockBackend', () => {
  const b = backend();
  return {
    backend: b,
    payeeId: MERCHANT_A,
    payers: [EMPLOYEE, EMPLOYER],
    decline: (id) => b.faults.set(id, 'decline'),
    loseResponse: (id, outcome) =>
      b.faults.set(id, outcome === 'settle' ? 'timeout_then_settle' : 'timeout_then_reject'),
    disableRefunds: () => {
      b.refundsSupported = false;
    },
  };
});
