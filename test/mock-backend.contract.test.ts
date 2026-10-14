import { settlementBackendContract } from './contract/settlement-backend.contract.ts';
import { world, EMPLOYEE, EMPLOYER, MERCHANT_A } from '../src/scenarios.ts';

settlementBackendContract('MockBackend', () => {
  const w = world();
  return {
    backend: w.backend,
    payeeId: MERCHANT_A,
    payers: [EMPLOYEE, EMPLOYER],
    decline: (id) => w.backend.faults.set(id, 'decline'),
    loseResponse: (id, outcome) =>
      w.backend.faults.set(id, outcome === 'settle' ? 'timeout_then_settle' : 'timeout_then_reject'),
    disableRefunds: () => {
      w.backend.refundsSupported = false;
    },
  };
});
