// The in-memory settlement modules satisfy the orchestrator contract.
// This fixture composes the concrete providers, ledgers and orchestrator
// exactly as the world does — the contract itself asserts only the public
// interface's behaviour.

import { settlementOrchestratorContract } from './contract/settlement-orchestrator.contract.ts';
import type { OrchestratorFaultTarget, OrchestratorFixture } from './contract/settlement-orchestrator.contract.ts';
import { Trace } from '../src/evidence/trace.ts';
import { operationKey } from '../src/settlement/operations.ts';
import { DigitalEuroLedger } from '../src/settlement/digital-euro-ledger.ts';
import { InterbankTransfer } from '../src/settlement/interbank-transfer.ts';
import {
  PayerProvider,
  ProviderOwners,
  ShopProvider,
  commitAcceptedDigitalEuroGroup,
} from '../src/settlement/provider.ts';
import { SettlementOrchestrator } from '../src/settlement/orchestrator.ts';
import type {
  DeferredOutcome,
  DigitalEuroStage,
  ProviderStage,
  SettlementIntent,
  SettlementLeg,
} from '../src/settlement/types.ts';

// The fixture world: the DE payer's provider owns a bank entitlement and
// pseudonym 'ps-de', the bank payer's provider a bank-only customer, and
// one receive-only shop provider at holding limit zero — every digital
// euro it receives defunds to its bank account.
function contractWorld() {
  const trace = new Trace();
  let t = 10;
  const de = new DigitalEuroLedger(() => t, trace);
  const bank = new InterbankTransfer(() => t, trace);
  const owners = new ProviderOwners();
  de.registerHolding({ pseudonym: 'ps-de', provider: 'psp-de', holdingLimitCents: 300_000, deCents: 0 });
  de.registerHolding({ pseudonym: 'ps-fee-de', provider: 'psp-de', holdingLimitCents: 0 });
  de.registerHolding({ pseudonym: 'ps-shop', provider: 'psp-shop', holdingLimitCents: 0 });
  const shop = new ShopProvider({
    provider: 'psp-shop',
    payeeId: 'shop-1',
    dePseudonym: 'ps-shop',
    bankCents: 0,
    now: () => t,
    trace,
    digitalEuro: de,
    interbank: bank,
  });
  const shops = new Map<string, ShopProvider>([['psp-shop', shop]]);
  const deProvider = new PayerProvider({
    provider: 'psp-de',
    customers: { 'de-payer': { bankCents: 100_000, dePseudonym: 'ps-de' } },
    feePseudonym: 'ps-fee-de',
    now: () => t,
    trace,
    digitalEuro: de,
    interbank: bank,
    shops,
    owners,
  });
  const bankProvider = new PayerProvider({
    provider: 'psp-bank',
    customers: { 'bank-payer': { bankCents: 50_000 } },
    now: () => t,
    trace,
    digitalEuro: de,
    interbank: bank,
    shops,
    owners,
  });
  const providers = new Map<string, PayerProvider>([
    ['de-payer', deProvider],
    ['bank-payer', bankProvider],
  ]);
  const orchestrator = new SettlementOrchestrator({
    providers,
    owners,
    commitDeGroup: commitAcceptedDigitalEuroGroup,
    digitalEuro: de,
    now: () => t,
    trace,
    // The coordinator's first-handoff recheck, stubbed: every leg is
    // accepted with evidence echoing its exact terms.
    authorizeFirstHandoff: (leg: SettlementLeg) => ({
      accepted: true,
      evidence: {
        purchaseId: leg.purchaseId,
        proposalVersion: leg.proposalVersion,
        role: leg.role,
        payerId: leg.payerId,
        rail: leg.rail,
        principalCents: leg.principalCents,
        feeCents: leg.feeCents,
        authority: leg.authority,
        authorityRef: `authority-${leg.role}`,
      },
    }),
  });
  return { trace, de, bank, shop, deProvider, bankProvider, orchestrator, set: (v: number) => { t = v; }, now: () => t };
}

// EUR 8 digital euro + EUR 0.25 fee on the DE rail.
function deLeg(intent: SettlementIntent): SettlementLeg {
  return {
    purchaseId: intent.purchaseId,
    proposalVersion: intent.proposalVersion,
    role: 'de',
    payerId: 'de-payer',
    payeeId: 'shop-1',
    rail: 'digital_euro',
    principalCents: 800,
    feeCents: 25,
    authority: 'payer',
    destination: { dePseudonym: 'ps-shop' },
  };
}

// EUR 5 bank + EUR 0.15 fee on the bank rail.
function bankLeg(intent: SettlementIntent): SettlementLeg {
  return {
    purchaseId: intent.purchaseId,
    proposalVersion: intent.proposalVersion,
    role: 'bank',
    payerId: 'bank-payer',
    payeeId: 'shop-1',
    rail: 'bank',
    principalCents: 500,
    feeCents: 15,
    authority: 'employer_mandate',
    destination: { bankProvider: 'psp-shop' },
  };
}

// The child operation key a fault attaches to — the same convention the
// provider and ledger modules record under (spec §7).
const childKey = (leg: SettlementLeg, op: string, destination: string): string =>
  operationKey(['leg', leg.purchaseId, leg.proposalVersion, leg.role, op, destination]);

settlementOrchestratorContract('settlement-ledgers-1 (in-memory modules)', (): OrchestratorFixture => {
  const w = contractWorld();
  let n = 0;
  // Maps a contract fault target to the concrete module operation key and
  // stage — the fixture's own child-key convention.
  const keyOf = (target: OrchestratorFaultTarget): { key: string; stage: ProviderStage; provider: PayerProvider } => {
    if (target.kind === 'group') {
      const members = target.intent.legs.filter((l) => l.rail === 'digital_euro').map((l) => l.role);
      return {
        key: operationKey(['de-group', target.intent.purchaseId, target.intent.proposalVersion, 'commit', ...members]),
        stage: 'commit',
        // The group commit is recorded on the DE ledger; any provider's
        // fault path forwards to it under the same key.
        provider: w.deProvider,
      };
    }
    const { leg, stage } = target;
    const provider = leg.payerId === 'de-payer' ? w.deProvider : w.bankProvider;
    switch (stage) {
      case 'hold':
        return {
          key: childKey(leg, 'hold', leg.destination.dePseudonym ?? 'bank'),
          stage: 'hold',
          provider,
        };
      case 'pay':
        return { key: childKey(leg, 'pay', leg.destination.bankProvider!), stage: 'credit', provider };
      case 'release':
        return { key: childKey(leg, 'release', 'bank'), stage: 'release', provider };
    }
  };
  const fault = (target: OrchestratorFaultTarget, f: 'reject_before_effect' | 'lose_response_after_effect' | 'defer') => {
    const { key, stage, provider } = keyOf(target);
    provider.setFault(key, stage as DigitalEuroStage, f);
  };
  return {
    orchestrator: w.orchestrator,
    intent: (mode = 'atomic') => {
      n += 1;
      const intent: SettlementIntent = {
        purchaseRef: `contract-${n}`,
        purchaseId: `contract-${n}`,
        proposalVersion: 1,
        mode,
        legs: [],
      };
      intent.legs = [deLeg(intent), bankLeg(intent)];
      return intent;
    },
    audit: () => ({
      shopBankCents: w.shop.account().bankCents,
      bankTransfers: w.bank.transfers().length,
      now: w.now(),
    }),
    rejectBeforeEffect: (target) => fault(target, 'reject_before_effect'),
    loseResponseAfterEffect: (target) => fault(target, 'lose_response_after_effect'),
    defer: (target) => fault(target, 'defer'),
    resolveDeferred: (target: OrchestratorFaultTarget, outcome: DeferredOutcome) => {
      keyOf(target).provider.resolveDeferred(keyOf(target).key, outcome);
    },
    setProviderAvailable: (payerId, available) => {
      (payerId === 'de-payer' ? w.deProvider : w.bankProvider).available = available;
    },
    setReturnsSupported: (payerId, supported) => {
      (payerId === 'de-payer' ? w.deProvider : w.bankProvider).returnsSupported = supported;
    },
    setNow: (now) => w.set(now),
  };
});
