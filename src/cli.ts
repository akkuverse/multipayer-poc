// Run every scenario (or those whose id contains the first argument) and print
// the trace plus final balances.

import { scenarios, EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_C } from './scenarios.ts';
import { euro } from './trace.ts';

const filter = process.argv[2] ?? '';

for (const s of scenarios.filter((x) => x.id.includes(filter))) {
  const { w, p } = s.run();
  console.log(`\n=== ${s.id}: ${s.title}`);
  console.log(w.trace.format());
  const outstanding = w.coordinator.outstandingCents(p);
  console.log(
    `--> state=${p.state}${p.reason ? ` (${p.reason})` : ''} returns=${p.returnStatus} outstanding=${euro(outstanding)}`,
  );
  for (const id of [EMPLOYEE, EMPLOYER, MERCHANT_A, MERCHANT_C]) {
    const a = w.backend.account(id);
    console.log(`    ${id.padEnd(11)} digital euro ${euro(a.deCents).padStart(12)}   linked bank ${euro(a.linkedBankCents).padStart(12)}`);
  }
}
