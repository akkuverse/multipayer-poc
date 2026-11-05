// Provider-owned settlement books (spec §4.1, §4.2, §6.1, §7). A payer
// provider holds its customers' bank entitlements and maps their
// digital-euro pseudonyms; it runs reserve → commit / release → return
// against the two concrete ledgers, driving every money movement — linked
// bank debit, funding credit, hold, transfer, transit confirm, restore —
// as a keyed child operation so a lost response never repeats a debit and
// open children stay visible as unresolved effects.
//
// A share pays from the customer's digital euro or bank, decided by the
// leg's signed rail. On the DE rail the provider runs the reverse
// waterfall during reserve: debit linked bank, record funding transit,
// credit digital euro, then hold principal (to the payee) and fee (to its
// own fee pseudonym) separately. The fee is charged only on confirmed
// settlement and lands in the provider's own fee account — never a
// shared collector account. A zero-limit destination receives its credit through
// tracked defunding transit, and the leg is settled only once the paired
// bank credit is confirmed.
//
// The shop provider is receive-only: it holds one payee's bank account,
// receives interbank credits and confirms DE defunding transit into bank,
// and debits only for a referenced refund.
//
// Same-ledger atomic DE groups are a LOCAL simulation assumption — never
// an ECB capability claim; every event here is LOCAL.

import type { Cents } from '../core/types.ts';
import type { Trace } from '../evidence/trace.ts';
import { RequestLog } from '../evidence/trace.ts';
import { operationKey, OperationStore } from './operations.ts';
import { DigitalEuroLedger, HOLD_TTL_MINUTES } from './digital-euro-ledger.ts';
import type { InterbankTransfer } from './interbank-transfer.ts';
import type {
  AcceptedAuthority,
  AcceptedHold,
  BankBook,
  BankTransferStage,
  DeCreditEffects,
  DeferredOutcome,
  DeGroupCommitEffects,
  DeGroupCommitMember,
  DeGroupMembership,
  DigitalEuroStage,
  GroupMemberOutcome,
  GroupOutcome,
  HoldStatus,
  OperationRecord,
  ProviderOutcome,
  ProviderStage,
  ReserveOutcome,
  ReturnPolicy,
  SettlementLeg,
  SimulationFault,
} from './types.ts';

const DE_STAGES: readonly DigitalEuroStage[] = ['hold', 'commit', 'release', 'fund', 'defund', 'transfer'];
const BANK_STAGES: readonly BankTransferStage[] = ['debit', 'credit'];
const OPEN: readonly OperationRecord['status'][] = ['not_started', 'pending', 'unknown'];

const open = (s: OperationRecord['status']): boolean => OPEN.includes(s);

// The leg's identity tuple: every operation on it keys under these parts.
const legOpKey = (leg: SettlementLeg, op: string): string =>
  operationKey(['leg', leg.purchaseId, leg.proposalVersion, leg.role, op]);

// A child movement names its stage and destination (spec §7).
const childKey = (leg: SettlementLeg, op: string, stage: string, destination?: string): string =>
  operationKey(['leg', leg.purchaseId, leg.proposalVersion, leg.role, op, stage, ...(destination === undefined ? [] : [destination])]);

// Provider-internal bank-book children announce themselves under these
// request names — the stage is the fault name, the event its request half.
const CHILD_REQUESTS: Record<string, string> = {
  bank_debit: 'bank_debit_requested',
  bank_restore: 'bank_restore_requested',
  hold: 'bank_hold_requested',
  release: 'bank_release_requested',
};

// The provider refused before forwarding anything: conclusively not
// attempted — the same semantic the retired per-payer PSP adapter carried.
export class ProviderUnavailableError extends Error {
  constructor(provider: string) {
    super(`provider ${provider} unavailable`);
  }
}

// The provider's pooled settlement account as the interbank module sees
// it. Customer entitlements, the fee account and the provider float are
// partitions of the pool: pool = Σ spendable + Σ held + fees + float.
class ProviderBook implements BankBook {
  poolCents: Cents = 0;
  debit(amountCents: Cents): void {
    if (this.poolCents < amountCents) throw new Error('insufficient_funds');
    this.poolCents -= amountCents;
  }
  credit(amountCents: Cents): void {
    this.poolCents += amountCents;
  }
}

// Provider-owned paired conversions share once-only applied bookkeeping.
// The ledger invokes the effect at actual application, even when a response
// is lost or its deferred control is resolved before the provider resumes.
class ProviderConversions {
  private readonly booked = new Set<string>();
  private readonly de: DigitalEuroLedger;
  constructor(de: DigitalEuroLedger) {
    this.de = de;
  }

  run(kind: 'fund' | 'defund', req: Parameters<DigitalEuroLedger['fund']>[0] & { transitRef?: string }, apply: () => void): OperationRecord {
    const once = () => {
      if (this.booked.has(req.key)) return;
      apply();
      this.booked.add(req.key);
    };
    return kind === 'fund' ? this.de.fund(req, once) : this.de.defund(req, once);
  }
}

interface CustomerSeed {
  bankCents?: Cents;
  dePseudonym?: string;
}

interface Customer {
  customerId: string;
  // Bank money available for new debits.
  spendableCents: Cents;
  // Reserved by an accepted bank-rail hold.
  heldCents: Cents;
  // Funding bank debits ever applied for this customer — audit evidence
  // that a lost response never caused a second debit.
  bankDebits: number;
  dePseudonym?: string;
}

interface BankHold {
  holdRef: string;
  amountCents: Cents;
  expiresAt: number;
  status: HoldStatus;
}

// The provider's retained record of one accepted leg: the authority
// evidence it was accepted under, the funding waterfall state, the holds
// it created, and the commit/return bookkeeping. Kept as module-internal
// state — outcomes expose detached projections, never this record.
interface Acceptance {
  ref: string;
  leg: SettlementLeg;
  evidence: AcceptedAuthority;
  expiresAt: number;
  // Funding waterfall state for the DE rail.
  fundedCents?: Cents;
  fundingDone: boolean;
  fundingInTransit: Cents;
  fundingRestored: boolean;
  fundExcessApplied: boolean;
  excessRecoveryBooked?: Partial<Record<'fund' | 'return', boolean>>;
  // Holds.
  principalHoldRef?: string;
  feeHoldRef?: string;
  bankHold?: BankHold;
  acceptedHold?: AcceptedHold;
  // Commit bookkeeping.
  committedCredit?: DeCreditEffects;
  committedCents?: Cents;
  holdConsumed?: boolean;
  destinationConfirmed: boolean;
  feeChargedCents?: Cents;
  feeCommittedCents?: Cents;
  feeBooked: boolean;
  executionRef?: string;
  // Return bookkeeping.
  returnKey?: string;
  returnPolicy?: ReturnPolicy;
  returnRef?: string;
  returned: boolean;
  returnFundApplied: boolean;
  cancelledPrincipalCents?: Cents;
  cancelledFeeCents?: Cents;
  returnExcessApplied: boolean;
  principalReturnedCents?: Cents;
  feeReturnedCents?: Cents;
}

// What a drive step reports: every child ran to completion ('done'), a
// conclusive refusal was reached ('reject'), or a child is still open and
// dependent work must stop ('blocked' — never a failure).
type Drive = 'done' | { reject: string } | { blocked: 'pending' | 'unknown' };

interface StageResult {
  reference?: string;
  effects?: unknown;
}

// A receive-only shop provider (spec §4.2): holds one payee's bank
// account, receives interbank credits, confirms digital-euro defunding
// transit into bank, and debits only for a referenced refund — it never
// initiates payments.
export class ShopProvider {
  readonly origin = 'LOCAL' as const;
  readonly specVersion = 'settlement-ledgers-1';
  readonly provider: string;
  readonly payeeId: string;
  readonly book: ProviderBook;
  private readonly dePseudonym?: string;
  private readonly de: DigitalEuroLedger;
  private readonly conversions: ProviderConversions;
  private readonly bank: InterbankTransfer;
  private readonly now: () => number;
  private readonly trace: Trace;
  private readonly requests: RequestLog;
  // Defunding-transit references whose paired bank credit already landed —
  // a replay never credits the bank twice.
  private readonly creditedTransit = new Set<string>();

  constructor(opts: {
    provider: string;
    payeeId: string;
    dePseudonym?: string;
    bankCents?: Cents;
    now: () => number;
    trace: Trace;
    digitalEuro: DigitalEuroLedger;
    interbank: InterbankTransfer;
  }) {
    this.provider = opts.provider;
    this.payeeId = opts.payeeId;
    this.dePseudonym = opts.dePseudonym;
    this.de = opts.digitalEuro;
    this.conversions = new ProviderConversions(this.de);
    this.bank = opts.interbank;
    this.now = opts.now;
    this.trace = opts.trace;
    this.requests = new RequestLog(opts.trace, this.provider);
    this.book = new ProviderBook();
    this.book.poolCents = opts.bankCents ?? 0;
    opts.interbank.registerBook(this.provider, this.book);
  }

  get name(): string {
    return this.provider;
  }

  // Detached account view for evidence.
  account(): { payeeId: string; bankCents: Cents } {
    return { payeeId: this.payeeId, bankCents: this.book.poolCents };
  }

  // Confirm a defunding-transit entry destined for this shop's
  // holding-limit-zero pseudonym: the ledger marks it defunded and the
  // paired bank credit lands exactly once. The keyed defund keeps the
  // operation recoverable under the caller's child key.
  confirmCredit(key: string, transitRef: string): OperationRecord {
    const t = this.de.transit().find((x) => x.transitRef === transitRef);
    if (t === undefined) throw new Error('unknown_transit');
    if (t.pseudonym !== this.dePseudonym) throw new Error('foreign_transit');
    // Forwarded operation: the payer provider's request used this same key,
    // so the onward request's parent resolves to that preceding request.
    this.requests.add('de_defund_requested', key, 'de-ledger', key, {
      pseudonym: t.pseudonym,
      amountCents: t.amountCents,
      transitRef,
    });
    const rec = this.conversions.run('defund', {
      key,
      provider: this.provider,
      pseudonym: t.pseudonym,
      amountCents: t.amountCents,
      transitRef,
    }, () => {
      if (this.creditedTransit.has(transitRef)) return;
      this.creditedTransit.add(transitRef);
      this.book.credit(t.amountCents);
      this.trace.add('LOCAL', this.provider, 'shop_bank_credited', {
        key,
        transitRef,
        payeeId: this.payeeId,
        amountCents: t.amountCents,
        at: this.now(),
      });
    });
    return rec;
  }

  cancelUncredited(key: string, transitRef: string, rejectedKey: string): OperationRecord {
    this.requests.add('de_cancel_requested', key, 'de-ledger', key, { transitRef, rejectedKey });
    return this.de.cancelUncredited({ key, provider: this.provider, transitRef, rejectedKey });
  }

  // The only debit a receive-only shop ever performs: a referenced refund
  // transfer back to the payer's provider (spec §4.2, S33).
  debitForRefund(req: { key: string; to: string; amountCents: Cents }): OperationRecord {
    this.requests.add('bank_transfer_requested', req.key, 'bank-transfer', req.key, {
      from: this.provider,
      destination: req.to,
      amountCents: req.amountCents,
    });
    return this.bank.transfer({
      key: req.key,
      initiator: this.provider,
      from: this.provider,
      to: req.to,
      amountCents: req.amountCents,
    });
  }
}

// The world-scoped registry binding an AcceptedHold's opaque owner token
// to its accepting provider (decision 11). Tokens mint inside the world
// that owns the providers — never process-global — so a hold minted in one
// composed world cannot resolve or guess a provider in another.
export class ProviderOwners {
  // Process-wide counter used only to keep minted tokens unique across
  // composed worlds — resolution stays inside this registry, so a token
  // minted in one world can never name a provider in another.
  private static tokenSeq = 0;
  private readonly providers = new Map<string, PayerProvider>();

  at(owner: string): PayerProvider | undefined {
    return this.providers.get(owner);
  }

  // Minted by PayerProvider's constructor only; not part of the
  // payer-facing interface.
  register(provider: PayerProvider): string {
    const token = `provider-${++ProviderOwners.tokenSeq}`;
    this.providers.set(token, provider);
    return token;
  }
}

// One payer provider (spec §4.1): owns its customers' bank entitlements
// and pseudonym mapping, validates ownership/rail/terms/evidence at
// reserve, and drives the keyed child work on both ledgers.
export class PayerProvider {
  readonly origin = 'LOCAL' as const;
  readonly specVersion = 'settlement-ledgers-1';
  readonly provider: string;
  // Opaque instance token minted at construction inside the world's
  // ProviderOwners registry: how the module-level group helper finds this
  // provider for an AcceptedHold — provider ids alone are not unique
  // across composed worlds.
  private readonly owner: string;
  readonly book: ProviderBook;
  // Destination providers this provider can reach for waterfall confirms
  // and referenced returns; the world populates it.
  readonly shops = new Map<string, ShopProvider>();
  available = true;
  // Trusted fixture routing property: whether this provider can carry
  // mandate-initiated (automatic) payments for its payer — the fixture
  // semantics the earlier per-payer PSP adapter carried.
  supportsMandatePayments = false;

  private readonly store = new OperationStore();
  private readonly customers = new Map<string, Customer>();
  private readonly workByLeg = new Map<string, Acceptance>();
  private readonly workByHold = new Map<string, Acceptance>();
  private readonly workByExec = new Map<string, Acceptance>();
  // Provider-internal faults for bookkeeping stages the ledgers never see;
  // ledger stages are forwarded to the owning module under the same key.
  private readonly faults = new Map<string, Map<string, SimulationFault>>();
  private readonly deferred = new Map<string, { apply: () => StageResult }>();
  private fees: Cents = 0;
  private nextAcceptance = 1;
  private nextBankHold = 1;
  private nextExec = 1;
  private nextReturn = 1;
  private readonly feePseudonym?: string;
  private readonly de: DigitalEuroLedger;
  private readonly conversions: ProviderConversions;
  private readonly bank: InterbankTransfer;
  private readonly now: () => number;
  private readonly trace: Trace;
  private readonly requests: RequestLog;
  // The top-level operation key a converge drive is answering — the parent
  // every ledger/bank/shop request the drive emits links back to. Set only
  // for the synchronous stretch of one converge() call.
  private drivingKey?: string;

  constructor(opts: {
    provider: string;
    customers: Record<string, CustomerSeed>;
    feePseudonym?: string;
    now: () => number;
    trace: Trace;
    digitalEuro: DigitalEuroLedger;
    interbank: InterbankTransfer;
    shops?: ReadonlyMap<string, ShopProvider>;
    owners: ProviderOwners;
  }) {
    this.provider = opts.provider;
    this.owner = opts.owners.register(this);
    this.de = opts.digitalEuro;
    this.conversions = new ProviderConversions(this.de);
    this.bank = opts.interbank;
    this.now = opts.now;
    this.trace = opts.trace;
    this.requests = new RequestLog(opts.trace, this.provider);
    this.feePseudonym = opts.feePseudonym;
    this.book = new ProviderBook();
    for (const [customerId, seed] of Object.entries(opts.customers)) {
      const bankCents = seed.bankCents ?? 0;
      if (!Number.isInteger(bankCents) || bankCents < 0) throw new Error('customer_terms_invalid');
      this.customers.set(customerId, {
        customerId,
        spendableCents: bankCents,
        heldCents: 0,
        bankDebits: 0,
        dePseudonym: seed.dePseudonym,
      });
      this.book.poolCents += bankCents;
    }
    opts.interbank.registerBook(this.provider, this.book);
    if (opts.shops !== undefined) {
      for (const [id, shop] of opts.shops) this.shops.set(id, shop);
    }
  }

  get name(): string {
    return this.provider;
  }

  // ---- payer-facing interface (spec §4.1) -------------------------------

  async reserve(intent: SettlementLeg, evidence: AcceptedAuthority): Promise<ReserveOutcome> {
    const key = legOpKey(intent, 'reserve');
    this.check('reserve', key);
    const rec = this.store.begin(key, reserveTerms(intent));
    const legId = legIdKey(intent);
    let w = this.workByLeg.get(legId);
    if (w === undefined && rec.status === 'not_started') {
      const problem = this.validate(intent, evidence);
      if (problem !== undefined) {
        this.store.resolve(key, { status: 'rejected', reason: problem });
        // A refusal before any money moved is still the request's outcome.
        this.trace.add('LOCAL', this.provider, 'provider_reserve_rejected', {
          key,
          reason: problem,
          payerId: intent.payerId,
          role: intent.role,
          rail: intent.rail,
        });
      } else {
        w = {
          ref: `acc-${this.nextAcceptance++}`,
          leg: structuredClone(intent),
          evidence: structuredClone(evidence),
          expiresAt: this.now() + HOLD_TTL_MINUTES,
          fundingDone: false,
          fundingInTransit: 0,
          fundingRestored: false,
          fundExcessApplied: false,
          destinationConfirmed: false,
          feeBooked: false,
          returned: false,
          returnFundApplied: false,
          returnExcessApplied: false,
        };
        this.workByLeg.set(legId, w);
      }
    }
    if (w !== undefined) this.converge('reserve', key, w);
    return this.reserveOutcome(key, w);
  }

  async commit(holdRef: string): Promise<ProviderOutcome> {
    const w = this.workByHold.get(holdRef);
    this.check('commit', w === undefined ? undefined : legOpKey(w.leg, 'commit'));
    if (w === undefined) throw new Error('unknown_hold');
    const key = legOpKey(w.leg, 'commit');
    this.store.begin(key, { holdRef });
    this.converge('commit', key, w);
    return this.outcomeFor(key, w);
  }

  async release(holdRef: string): Promise<ProviderOutcome> {
    const w = this.workByHold.get(holdRef);
    this.check('release', w === undefined ? undefined : legOpKey(w.leg, 'release'));
    if (w === undefined) throw new Error('unknown_hold');
    const key = legOpKey(w.leg, 'release');
    this.store.begin(key, { holdRef });
    this.converge('release', key, w);
    return this.outcomeFor(key, w);
  }

  // Status is also the resume hook: querying an open operation drives its
  // recorded child work under the original keys — an intentional read
  // that may move money toward the operation's recorded outcome.
  async status(operationKey: string): Promise<ProviderOutcome> {
    // Status is a read, not a money-moving request: its refusal carries no
    // operation key because no request pairs with it.
    this.check('status');
    const rec = this.store.status(operationKey);
    if (rec !== undefined) {
      const found = this.workForKey(operationKey);
      if (found !== undefined) {
        this.converge(found.op, operationKey, found.w);
        return found.op === 'reserve'
          ? this.reserveOutcome(operationKey, found.w)
          : this.outcomeFor(operationKey, found.w);
      }
      // A provider-internal child operation record.
      return this.wrapRecord(rec);
    }
    const deRec = this.de.status(operationKey);
    if (deRec !== undefined) return this.wrapRecord(deRec);
    const bankRec = this.bank.status(operationKey);
    if (bankRec !== undefined) return this.wrapRecord(bankRec);
    throw new Error('unknown_operation');
  }

  async refund(executionRef: string, returnKey: string, policy: ReturnPolicy): Promise<ProviderOutcome> {
    this.check('refund', returnKey);
    const w = this.workByExec.get(executionRef);
    if (w === undefined) throw new Error('unknown_execution');
    const rec = this.store.begin(returnKey, {
      executionRef,
      policy,
      principalCents: w.leg.principalCents,
      feeCents: w.feeChargedCents ?? w.feeCommittedCents ?? 0,
    });
    if (open(rec.status)) {
      if (w.returned) {
        // The same original execution can never be returned twice across
        // reasons or scopes (decision 9).
        this.store.resolve(returnKey, { status: 'rejected', reason: 'already_returned' });
        this.trace.add('LOCAL', this.provider, 'provider_return_rejected', { key: returnKey, reason: 'already_returned' });
      } else if (w.returnKey !== undefined && w.returnKey !== returnKey) {
        this.store.resolve(returnKey, { status: 'rejected', reason: 'return_in_progress' });
        this.trace.add('LOCAL', this.provider, 'provider_return_rejected', { key: returnKey, reason: 'return_in_progress' });
      } else if (!this.returnsSupported) {
        // A conclusive refusal of support — never proof money returned.
        this.store.resolve(returnKey, { status: 'rejected', reason: 'unsupported' });
        this.trace.add('LOCAL', this.provider, 'provider_return_rejected', { key: returnKey, reason: 'unsupported' });
      } else {
        w.returnKey = returnKey;
        w.returnPolicy = policy;
        this.converge('return', returnKey, w);
        // A conclusive rejection before any money moved releases the
        // latch: the failed attempt stays terminal under its own key
        // while the execution may be returned again — same or new key.
        // The once-guard binds successes (w.returned), not refusals; a
        // rejection after money moved keeps the latch so the exposure
        // stays bound to its evidence (spec §6 failed-return exposure).
        const out = this.store.status(returnKey);
        if (out?.status === 'rejected' && this.bank.transferAudit(childKey(w.leg, 'return', 'bank'))?.debited !== true) {
          w.returnKey = undefined;
          w.returnPolicy = undefined;
        }
      }
    }
    return this.outcomeFor(returnKey, w);
  }

  // Returns can be switched off to model a provider with no return
  // operation; a refusal is then 'unsupported', not a return.
  returnsSupported = true;

  // ---- simulation controls (decision 12) ---------------------------------

  // Arm a one-shot fault on an operation's named stage. Ledger stages are
  // forwarded to the module that runs them under the same child key;
  // provider-internal stages ('bank_debit', 'bank_restore', and
  // 'hold'/'release' on the bank rail's internal hold keys) stay here.
  setFault(operationKey: string, stage: ProviderStage, fault: SimulationFault): void {
    if (DE_STAGES.includes(stage as DigitalEuroStage)) {
      this.de.setFault(operationKey, stage as DigitalEuroStage, fault);
    }
    if (BANK_STAGES.includes(stage as BankTransferStage)) {
      this.bank.setFault(operationKey, stage as BankTransferStage, fault);
    }
    let byStage = this.faults.get(operationKey);
    if (byStage === undefined) {
      byStage = new Map();
      this.faults.set(operationKey, byStage);
    }
    byStage.set(stage, fault);
  }

  // Explicit simulation resolution of parked work — the only way a
  // deferred operation progresses, on whichever module parked it.
  resolveDeferred(operationKey: string, outcome: DeferredOutcome, reason?: string): OperationRecord {
    const work = this.deferred.get(operationKey);
    if (work !== undefined) {
      this.deferred.delete(operationKey);
      if (outcome === 'reject') {
        const rejected = this.store.resolve(operationKey, { status: 'rejected', reason: reason ?? 'deferred_rejected' });
        this.trace.add('LOCAL', this.provider, 'provider_op_rejected', { key: operationKey, reason: rejected.reason });
        return rejected;
      }
      try {
        const applied = work.apply();
        const rec = this.store.resolve(operationKey, {
          status: 'succeeded',
          reference: applied.reference,
          effects: applied.effects,
        });
        return rec;
      } catch (err) {
        return this.store.resolve(operationKey, {
          status: 'rejected',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const module of [this.de, this.bank] as const) {
      try {
        return module.resolveDeferred(operationKey, outcome, reason);
      } catch (err) {
        if (!(err instanceof Error && err.message === 'no_deferred_operation')) throw err;
      }
    }
    throw new Error('no_deferred_operation');
  }

  // ---- detached audit reads ----------------------------------------------

  account(customerId: string): {
    customerId: string;
    spendableCents: Cents;
    heldCents: Cents;
    bankDebits: number;
  } {
    const c = this.customerAt(customerId);
    return {
      customerId: c.customerId,
      spendableCents: c.spendableCents,
      heldCents: c.heldCents,
      bankDebits: c.bankDebits,
    };
  }

  // The provider's own fee revenue, charged on confirmed settlement only.
  get feesCents(): Cents {
    return this.fees;
  }

  get poolCents(): Cents {
    return this.book.poolCents;
  }

  // Bank money debited for digital-euro funding whose ledger credit is
  // not yet confirmed — the explicit conversion transit.
  fundingTransitCents(): Cents {
    let total = 0;
    for (const w of this.workByLeg.values()) total += w.fundingInTransit;
    return total;
  }

  bankHolds(): { holdRef: string; amountCents: Cents; expiresAt: number; status: HoldStatus }[] {
    const out: { holdRef: string; amountCents: Cents; expiresAt: number; status: HoldStatus }[] = [];
    for (const w of this.workByLeg.values()) {
      if (w.bankHold !== undefined) out.push({ ...w.bankHold });
    }
    return out;
  }

  // ---- internal access for the module-level group helper -----------------

  // Called only by commitAcceptedDigitalEuroGroup: vouch that the offered
  // AcceptedHold names an acceptance this provider still honours — owned,
  // unexpired and carrying the frozen group membership it claims. Not part
  // of the payer-facing interface.
  vouchForGroup(
    hold: AcceptedHold,
  ): { member: DeGroupCommitMember; groupKey: string; ledger: DigitalEuroLedger } | { problem: string } {
    if (hold.provider !== this.provider) return { problem: 'foreign_provider' };
    const w = this.workByHold.get(hold.holdRef);
    if (w === undefined || w.ref !== hold.acceptanceRef) return { problem: 'acceptance_unknown' };
    const g = w.leg.deGroup;
    if (g === undefined || g.self !== hold.leg || g.key !== hold.groupKey) {
      return { problem: 'group_membership_invalid' };
    }
    if (hold.expiresAt !== w.expiresAt) return { problem: 'acceptance_expired' };
    // Once the group operation is recorded under its key its outcome
    // replays from that record: acceptance expiry after the handoff must
    // not make a recorded group unrecoverable by its key (spec §7).
    const recorded = this.de.status(g.key);
    if ((recorded === undefined || recorded.status === 'not_started') && this.now() >= w.expiresAt) {
      return { problem: 'acceptance_expired' };
    }
    return {
      member: { leg: hold.leg, holdRef: hold.holdRef, provider: this.provider },
      groupKey: g.key,
      ledger: this.de,
    };
  }

  // ---- internals -----------------------------------------------------------

  private check(op: string, key?: string): void {
    if (this.available) return;
    this.trace.add('LOCAL', this.provider, 'provider_unavailable', { op, key });
    throw new ProviderUnavailableError(this.provider);
  }

  private customerAt(customerId: string): Customer {
    const c = this.customers.get(customerId);
    if (c === undefined) throw new Error('unknown_customer');
    return c;
  }

  // Reserve validates provider ownership, rail, amounts, routing and that
  // the accepted authority evidence matches the leg it claims to fund.
  private validate(leg: SettlementLeg, evidence: AcceptedAuthority): string | undefined {
    const c = this.customers.get(leg.payerId);
    if (c === undefined) return 'not_customer';
    if (!Number.isInteger(leg.principalCents) || leg.principalCents < 0) return 'amount_invalid';
    if (!Number.isInteger(leg.feeCents) || leg.feeCents < 0) return 'amount_invalid';
    if (leg.principalCents + leg.feeCents <= 0) return 'amount_invalid';
    if (leg.rail === 'digital_euro') {
      if (c.dePseudonym === undefined) return 'rail_unavailable';
      if (leg.destination.dePseudonym === undefined) return 'destination_missing';
      if (leg.feeCents > 0 && this.feePseudonym === undefined) return 'fee_route_missing';
      // A malformed group descriptor is a conclusive terms refusal,
      // surfaced at validation rather than crashing the ledger call.
      if (leg.deGroup !== undefined && !membershipShapeOk(leg.deGroup)) return 'group_membership_invalid';
      // The destination's waterfall confirm must be reachable: either the
      // provider's own holding or a known shop provider.
      let destProvider: string;
      try {
        destProvider = this.de.holding(leg.destination.dePseudonym).provider;
      } catch {
        return 'destination_unknown';
      }
      // A leg cannot pay its own provider's book: the waterfall confirm
      // needs a reachable destination provider (findings — self-payment
      // would strand the entitlement mid-commit).
      if (destProvider === this.provider) return 'self_destination';
      if (!this.shops.has(destProvider)) return 'destination_unknown';
    } else if (leg.rail === 'bank') {
      if (leg.deGroup !== undefined) return 'group_on_bank_rail';
      if (leg.destination.bankProvider === undefined) return 'destination_missing';
      // A provider cannot transfer bank money to its own book.
      if (leg.destination.bankProvider === this.provider) return 'self_destination';
      if (!this.shops.has(leg.destination.bankProvider)) return 'destination_unknown';
    } else {
      return 'rail_invalid';
    }
    // The evidence must echo the leg it authorizes exactly (decision 7).
    if (
      evidence.purchaseId !== leg.purchaseId ||
      evidence.proposalVersion !== leg.proposalVersion ||
      evidence.role !== leg.role ||
      evidence.payerId !== leg.payerId ||
      evidence.rail !== leg.rail ||
      evidence.principalCents !== leg.principalCents ||
      evidence.feeCents !== leg.feeCents ||
      evidence.authority !== leg.authority
    ) {
      return 'authority_evidence_mismatch';
    }
    return undefined;
  }

  // Emit the request half of a cross-party call immediately before its
  // dispatch; the driving operation key is the parent link.
  private requested(event: string, key: string, to: string, detail: Record<string, unknown> = {}): void {
    this.requests.add(event, key, to, this.drivingKey ?? null, detail);
  }

  private workForKey(key: string): { w: Acceptance; op: 'reserve' | 'commit' | 'release' | 'return' } | undefined {
    for (const w of this.workByLeg.values()) {
      if (key === legOpKey(w.leg, 'reserve')) return { w, op: 'reserve' };
      if (key === legOpKey(w.leg, 'commit')) return { w, op: 'commit' };
      if (key === legOpKey(w.leg, 'release')) return { w, op: 'release' };
      if (key === w.returnKey) return { w, op: 'return' };
    }
    return undefined;
  }

  // Resume an open top-level operation: child work reconciles through the
  // recorded truth under original keys — never a fresh operation.
  private converge(op: 'reserve' | 'commit' | 'release' | 'return', key: string, w: Acceptance): void {
    const rec = this.store.status(key);
    if (rec === undefined || !open(rec.status)) return;
    this.expireBankHold(w);
    // The drive below is synchronous; its outbound requests parent on the
    // operation key that caused them.
    const previous = this.drivingKey;
    this.drivingKey = key;
    let drive: Drive;
    try {
      if (op === 'reserve') {
        drive = w.leg.rail === 'digital_euro' ? this.deReserve(w) : this.bankReserve(w);
      } else if (op === 'commit') {
        // Committing against an unconfirmed reserve would mutate around
        // unfinished reserve children (e.g. a fee hold that does not exist
        // yet): park until the reserve operation confirms — never throw
        // mid-mutation.
        drive =
          this.store.status(legOpKey(w.leg, 'reserve'))?.status === 'succeeded'
            ? w.leg.rail === 'digital_euro'
              ? this.deCommit(w)
              : this.bankCommit(w)
            : { blocked: 'pending' };
      } else if (op === 'release') {
        drive = w.leg.rail === 'digital_euro' ? this.deRelease(w) : this.bankRelease(w);
      } else {
        drive = w.leg.rail === 'digital_euro' ? this.deReturn(w) : this.bankReturn(w);
      }
    } finally {
      this.drivingKey = previous;
    }
    if (drive === 'done') {
      const reference =
        op === 'reserve'
          ? w.principalHoldRef ?? w.bankHold?.holdRef
          : op === 'commit'
            ? w.executionRef
            : op === 'return'
              ? w.returnRef
              : w.principalHoldRef ?? w.bankHold?.holdRef;
      this.store.resolve(key, { status: 'succeeded', reference });
      this.trace.add('LOCAL', this.provider, `provider_${op}_done`, {
        key,
        reference,
        payerId: w.leg.payerId,
        role: w.leg.role,
        rail: w.leg.rail,
      });
    } else if ('reject' in drive) {
      this.store.resolve(key, { status: 'rejected', reason: drive.reject });
      this.trace.add('LOCAL', this.provider, `provider_${op}_rejected`, {
        key,
        reason: drive.reject,
        payerId: w.leg.payerId,
        role: w.leg.role,
        rail: w.leg.rail,
      });
    } else {
      this.store.resolve(key, { status: drive.blocked });
    }
  }

  // ---- reserve: digital-euro reverse waterfall -----------------------------

  private deReserve(w: Acceptance): Drive {
    const leg = w.leg;
    const c = this.customerAt(leg.payerId);
    const ps = c.dePseudonym!;
    const need = leg.principalCents + leg.feeCents;

    // Reserve/debit linked-bank funds, record funding transit, credit
    // digital euro, then establish the payment hold (spec §6.1). Each step
    // keeps its own stable child identity; replayed drives reconcile by
    // key and never repeat a completed step. The funded amount is fixed
    // once, before the first child runs — recomputing it on a resume would
    // see the already credited digital euro and under-report the intent's
    // funding.
    if (!w.fundingDone) {
      if (w.fundedCents === undefined) {
        w.fundedCents = Math.max(0, need - this.de.holding(ps).spendableCents);
      }
      const shortfall = w.fundedCents;
      if (shortfall > 0) {
        const debitKey = childKey(leg, 'fund', 'bank');
        if (this.store.status(debitKey) === undefined && c.spendableCents < shortfall) {
          return { reject: 'insufficient_funds' };
        }
        const debit = this.child(debitKey, 'bank_debit', { amountCents: shortfall, customerId: leg.payerId }, () => {
          if (c.spendableCents < shortfall) throw new Error('insufficient_funds');
          c.spendableCents -= shortfall;
          c.bankDebits += 1;
          this.book.debit(shortfall);
          w.fundingInTransit += shortfall;
          this.trace.add('LOCAL', this.provider, 'provider_bank_debited', {
            key: debitKey,
            customerId: leg.payerId,
            amountCents: shortfall,
          });
          return {};
        });
        if (debit.status === 'rejected') return { reject: debit.reason ?? 'bank_debit_rejected' };
        const debitBlocked = blockedOf(debit);
        if (debitBlocked !== undefined) return { blocked: debitBlocked };

        this.requested('de_fund_requested', childKey(leg, 'fund', 'digital_euro'), 'de-ledger', {
          pseudonym: ps,
          amountCents: shortfall,
        });
        const fund = this.conversions.run('fund', {
          key: childKey(leg, 'fund', 'digital_euro'),
          provider: this.provider,
          pseudonym: ps,
          amountCents: shortfall,
        }, () => {
          w.fundingInTransit -= shortfall;
        });
        if (fund.status === 'rejected') {
          // Funding failed conclusively: restore the bank debit once.
          const restored = this.restoreFundingTransit(w);
          if (restored !== undefined) return restored;
          return { reject: `fund_rejected:${fund.reason}` };
        }
        const fundBlocked = blockedOf(fund);
        if (fundBlocked !== undefined) return { blocked: fundBlocked };
        // Funding above the payer's holding limit routes excess to the
        // provider's own transit; confirm it back to bank before holding.
        const fx = fund.effects as DeCreditEffects;
        if (fx.defundedCents > 0 && fx.transitRef !== undefined && !w.fundExcessApplied) {
          this.requested('de_defund_requested', childKey(leg, 'fund', 'defund'), 'de-ledger', {
            pseudonym: ps,
            amountCents: fx.defundedCents,
            transitRef: fx.transitRef,
          });
          const confirm = this.conversions.run('defund', {
            key: childKey(leg, 'fund', 'defund'),
            provider: this.provider,
            pseudonym: ps,
            amountCents: fx.defundedCents,
            transitRef: fx.transitRef,
          }, () => this.book.credit(fx.defundedCents));
          const confirmBlocked = blockedOf(confirm);
          if (confirmBlocked !== undefined) return { blocked: confirmBlocked };
          if (confirm.status === 'rejected') {
            // This conversion never credited bank. Cancel its uncredited
            // transit, restore that excess once, then unwind only the
            // intent's actual holding credit. The original refusal stays
            // immutable; pending/lost confirmations never enter recovery.
            const restored = this.restoreRejectedExcess(w, fx, 'fund');
            if (restored !== undefined) return restored;
            const unwound = this.unwindFunding(w, 'defund');
            if (unwound !== undefined) return unwound;
            return { reject: `fund_excess_rejected:${confirm.reason}` };
          }
          c.spendableCents += fx.defundedCents;
          w.fundExcessApplied = true;
        }
      }
      w.fundingDone = true;
    }

    if (leg.principalCents > 0 && w.principalHoldRef === undefined) {
      this.requested('de_hold_requested', childKey(leg, 'hold', leg.destination.dePseudonym!), 'de-ledger', {
        pseudonym: ps,
        amountCents: leg.principalCents,
        destination: leg.destination.dePseudonym!,
      });
      const hold = this.de.hold({
        key: childKey(leg, 'hold', leg.destination.dePseudonym!),
        provider: this.provider,
        pseudonym: ps,
        amountCents: leg.principalCents,
        destination: leg.destination.dePseudonym!,
        group: leg.deGroup,
      });
      if (hold.status === 'rejected') {
        // The payment hold failed after funding: defund only the amount
        // funded for this intent back to bank — pre-existing digital euro
        // is never touched by the unwind.
        const unwound = this.unwindFunding(w, 'defund');
        if (unwound !== undefined) return unwound;
        return { reject: `hold_rejected:${hold.reason}` };
      }
      const holdBlocked = blockedOf(hold);
      if (holdBlocked !== undefined) return { blocked: holdBlocked };
      const effects = hold.effects as { holdRef: string; reservedAt: number; expiresAt: number };
      w.principalHoldRef = effects.holdRef;
      w.expiresAt = effects.expiresAt;
      this.workByHold.set(effects.holdRef, w);
    }

    if (leg.feeCents > 0 && w.feeHoldRef === undefined) {
      this.requested('de_hold_requested', childKey(leg, 'hold', this.feePseudonym!), 'de-ledger', {
        pseudonym: ps,
        amountCents: leg.feeCents,
        destination: this.feePseudonym!,
      });
      const feeHold = this.de.hold({
        key: childKey(leg, 'hold', this.feePseudonym!),
        provider: this.provider,
        pseudonym: ps,
        amountCents: leg.feeCents,
        destination: this.feePseudonym!,
      });
      if (feeHold.status === 'rejected') {
        const released = this.releaseDeHolds(w, 'reserve');
        if (released !== undefined) return released;
        const unwound = this.unwindFunding(w, 'defund');
        if (unwound !== undefined) return unwound;
        return { reject: `hold_rejected:${feeHold.reason}` };
      }
      const feeBlocked = blockedOf(feeHold);
      if (feeBlocked !== undefined) return { blocked: feeBlocked };
      w.feeHoldRef = (feeHold.effects as { holdRef: string }).holdRef;
      if (leg.principalCents === 0) {
        w.expiresAt = this.de.holdAudit(w.feeHoldRef).expiresAt;
        this.workByHold.set(w.feeHoldRef, w);
      }
    }

    if (leg.deGroup !== undefined && w.acceptedHold === undefined) {
      w.acceptedHold = {
        owner: this.owner,
        provider: this.provider,
        leg: leg.deGroup.self,
        acceptanceRef: w.ref,
        holdRef: w.principalHoldRef!,
        groupKey: leg.deGroup.key,
        expiresAt: w.expiresAt,
      };
    }
    return 'done';
  }

  // ---- reserve: bank-rail hold -------------------------------------------

  private bankReserve(w: Acceptance): Drive {
    const leg = w.leg;
    const c = this.customerAt(leg.payerId);
    const total = leg.principalCents + leg.feeCents;
    if (w.bankHold === undefined) {
      const holdKey = childKey(leg, 'hold', 'bank');
      if (this.store.status(holdKey) === undefined && c.spendableCents < total) {
        return { reject: 'insufficient_funds' };
      }
      const rec = this.child(holdKey, 'hold', { amountCents: total, customerId: leg.payerId }, () => {
        if (c.spendableCents < total) throw new Error('insufficient_funds');
        const holdRef = `bhold-${this.nextBankHold++}`;
        c.spendableCents -= total;
        c.heldCents += total;
        w.bankHold = {
          holdRef,
          amountCents: total,
          expiresAt: this.now() + HOLD_TTL_MINUTES,
          status: 'active',
        };
        w.expiresAt = w.bankHold.expiresAt;
        this.workByHold.set(holdRef, w);
        this.trace.add('LOCAL', this.provider, 'provider_bank_hold', {
          key: holdKey,
          holdRef,
          customerId: leg.payerId,
          amountCents: total,
          expiresAt: w.bankHold.expiresAt,
        });
        return { reference: holdRef };
      });
      if (rec.status === 'rejected') return { reject: rec.reason ?? 'hold_rejected' };
      const blocked = blockedOf(rec);
      if (blocked !== undefined) return { blocked };
    }
    return 'done';
  }

  // ---- commit --------------------------------------------------------------

  private deCommit(w: Acceptance): Drive {
    const leg = w.leg;
    if (leg.principalCents === 0) {
      w.committedCredit ??= { creditedCents: 0, defundedCents: 0 };
    }
    if (leg.principalCents === 0 && this.de.holdAudit(w.feeHoldRef!).status === 'expired') return { reject: 'hold_expired' };
    const holdRef = w.principalHoldRef!;
    const hold = holdRef === undefined ? { status: 'committed', commitPending: false } : this.de.holdAudit(holdRef);
    if (hold.status === 'expired') return { reject: 'hold_expired' };
    if (hold.commitPending) return { blocked: 'pending' };
    let credit = w.committedCredit;
    if (hold.status === 'committed') {
      // Committed through the group helper: recover this member's credit
      // evidence from the original group key rather than debiting again.
      credit ??= this.groupCredit(w);
      // A lost non-group commit response: the hold committed but the
      // credit evidence never arrived — recover it from the recorded
      // commit child under its original key.
      if (credit === undefined) {
        const fx = this.de.status(childKey(leg, 'commit', 'principal'))?.effects as DeCreditEffects | undefined;
        credit =
          fx === undefined
            ? undefined
            : { creditedCents: fx.creditedCents, defundedCents: fx.defundedCents, transitRef: fx.transitRef };
      }
      if (credit === undefined) return { blocked: 'pending' };
      w.committedCredit = credit;
    } else {
      if (leg.deGroup !== undefined) return { reject: 'group_hold' };
      this.requested('de_commit_requested', childKey(leg, 'commit', 'principal'), 'de-ledger', { holdRef });
      const rec = this.de.commitHold({
        key: childKey(leg, 'commit', 'principal'),
        provider: this.provider,
        holdRef,
      });
      if (rec.status === 'rejected') return { reject: rec.reason ?? 'commit_rejected' };
      const blocked = blockedOf(rec);
      if (blocked !== undefined) return { blocked };
      const effects = rec.effects as DeCreditEffects;
      credit = { creditedCents: effects.creditedCents, defundedCents: effects.defundedCents, transitRef: effects.transitRef };
      w.committedCredit = credit;
    }
    w.committedCents = leg.principalCents;
    // A recovery reference identifies partial committed money too. Its
    // existence never permits a return while the original commit is open.
    w.executionRef ??= `${leg.purchaseId}-exec-${this.nextExec++}`;
    this.workByExec.set(w.executionRef, w);

    // A holding-limited destination receives its excess into defunding
    // transit; the leg is settled only after the paired bank credit is
    // confirmed by the destination's provider (decision 10, spec §6).
    if (!w.destinationConfirmed) {
      if (credit.defundedCents > 0 && credit.transitRef !== undefined) {
        const destProvider = this.de.holding(leg.destination.dePseudonym!).provider;
        const shop = this.shops.get(destProvider);
        if (shop === undefined) return { blocked: 'unknown' };
        this.requested('confirm_credit_requested', childKey(leg, 'commit', 'destination'), shop.provider, {
          transitRef: credit.transitRef,
        });
        const confirm = shop.confirmCredit(childKey(leg, 'commit', 'destination'), credit.transitRef);
        const confirmBlocked = blockedOf(confirm);
        if (confirmBlocked !== undefined) return { blocked: confirmBlocked };
        if (confirm.status === 'rejected') return { reject: `destination_rejected:${confirm.reason}` };
      }
      w.destinationConfirmed = true;
    }

    // The fee is charged only on confirmed settlement: commit the fee hold
    // to the provider's own fee pseudonym and confirm the defund into the
    // provider's fee account.
    if (leg.feeCents > 0 && w.feeChargedCents === undefined) {
      this.requested('de_commit_requested', childKey(leg, 'commit', 'fee'), 'de-ledger', { holdRef: w.feeHoldRef! });
      const feeCommit = this.de.commitHold({
        key: childKey(leg, 'commit', 'fee'),
        provider: this.provider,
        holdRef: w.feeHoldRef!,
      });
      if (feeCommit.status === 'rejected') {
        w.feeChargedCents = 0;
      } else {
        const feeBlocked = blockedOf(feeCommit);
        if (feeBlocked !== undefined) return { blocked: feeBlocked };
        w.feeCommittedCents = leg.feeCents;
        const fx = feeCommit.effects as DeCreditEffects;
        if (fx.defundedCents > 0 && fx.transitRef !== undefined && !w.feeBooked) {
          this.requested('de_defund_requested', childKey(leg, 'commit', 'fee-defund'), 'de-ledger', {
            pseudonym: this.feePseudonym!,
            amountCents: fx.defundedCents,
            transitRef: fx.transitRef,
          });
          const confirm = this.conversions.run('defund', {
            key: childKey(leg, 'commit', 'fee-defund'),
            provider: this.provider,
            pseudonym: this.feePseudonym!,
            amountCents: fx.defundedCents,
            transitRef: fx.transitRef,
          }, () => this.book.credit(fx.defundedCents));
          const confirmBlocked = blockedOf(confirm);
          if (confirmBlocked !== undefined) return { blocked: confirmBlocked };
          // A refused conversion leaves committed fee money in transit:
          // expose the refusal for compensation without booking revenue.
          if (confirm.status === 'rejected') return { reject: `fee_conversion_rejected:${confirm.reason}` };
        }
        if (!w.feeBooked) {
          this.fees += leg.feeCents;
          w.feeBooked = true;
          this.trace.add('LOCAL', this.provider, 'provider_fee_charged', {
            customerId: leg.payerId,
            amountCents: leg.feeCents,
            rail: leg.rail,
          });
        }
        w.feeChargedCents = leg.feeCents;
      }
    } else if (w.feeChargedCents === undefined) {
      w.feeChargedCents = 0;
    }

    return 'done';
  }

  private bankCommit(w: Acceptance): Drive {
    const leg = w.leg;
    const c = this.customerAt(leg.payerId);
    const hold = w.bankHold!;
    if (hold.status === 'expired') return { reject: 'hold_expired' };
    if (hold.status === 'committed') return 'done';
    if (hold.status !== 'active') return { reject: 'hold_not_active' };
    const total = leg.principalCents + leg.feeCents;
    if (w.holdConsumed !== true) {
      c.heldCents -= total;
      w.holdConsumed = true;
    }
    const payKey = childKey(leg, 'pay', leg.destination.bankProvider!);
    if (leg.principalCents > 0) {
      this.requested('bank_transfer_requested', payKey, 'bank-transfer', {
        from: this.provider,
        destination: leg.destination.bankProvider!,
        amountCents: leg.principalCents,
      });
    }
    const res = leg.principalCents === 0 ? { status: 'succeeded' as const } : this.bank.transfer({
      key: payKey,
      initiator: this.provider,
      from: this.provider,
      to: leg.destination.bankProvider!,
      amountCents: leg.principalCents,
    });
    if (res.status === 'rejected') {
      const audit = this.bank.transferAudit(payKey);
      // A debit that reached transit is cancelled back to the source book
      // — the uncredited amount is never a payment (decision 10) — and the
      // customer's hold is restored either way.
      if (audit?.debited === true && audit.cancelled !== true) {
        this.requested('bank_cancel_requested', payKey, 'bank-transfer', { transferRef: audit.transferRef });
        this.bank.cancelUncredited(payKey);
      }
      c.heldCents += total;
      w.holdConsumed = false;
      return { reject: res.reason ?? 'pay_rejected' };
    }
    const blocked = blockedOf(res);
    if (blocked !== undefined) return { blocked };
    hold.status = 'committed';
    if (!w.feeBooked) {
      // The fee stayed in the pool when the entitlement was consumed; it
      // now becomes provider revenue — charged on confirmed settlement.
      this.fees += leg.feeCents;
      w.feeBooked = true;
      this.trace.add('LOCAL', this.provider, 'provider_fee_charged', {
        customerId: leg.payerId,
        amountCents: leg.feeCents,
        rail: leg.rail,
      });
    }
    w.feeChargedCents = leg.feeCents;
    w.committedCents = leg.principalCents;
    w.destinationConfirmed = true;
    // Per-provider execution numbering scoped to the purchase: the ref
    // carries no payer identity and can never alias another purchase's
    // execution on this provider.
    w.executionRef ??= `${w.leg.purchaseId}-exec-${this.nextExec++}`;
    this.workByExec.set(w.executionRef, w);
    return 'done';
  }

  // Recover a group member's destination-credit evidence from the original
  // group operation record.
  private groupCredit(w: Acceptance): DeCreditEffects | undefined {
    const g = w.leg.deGroup;
    if (g === undefined) return undefined;
    const rec = this.de.status(g.key);
    const effects = rec?.effects as DeGroupCommitEffects | undefined;
    const member = effects?.members.find((m) => m.holdRef === w.principalHoldRef);
    if (member === undefined) return undefined;
    return { creditedCents: member.creditedCents, defundedCents: member.defundedCents, transitRef: member.transitRef };
  }

  // ---- release -------------------------------------------------------------

  private deRelease(w: Acceptance): Drive {
    const released = this.releaseDeHolds(w, 'release');
    if (released !== undefined) return released;
    const unwound = this.unwindFunding(w, 'release');
    if (unwound !== undefined) return unwound;
    return 'done';
  }

  private bankRelease(w: Acceptance): Drive {
    const leg = w.leg;
    const c = this.customerAt(leg.payerId);
    const hold = w.bankHold!;
    if (hold.status === 'committed') return { reject: 'hold_committed' };
    if (w.holdConsumed === true) return { blocked: 'pending' };
    const releaseKey = childKey(leg, 'release', 'bank');
    const rec = this.child(releaseKey, 'release', { holdRef: hold.holdRef }, () => {
      if (hold.status === 'active') {
        c.spendableCents += hold.amountCents;
        c.heldCents -= hold.amountCents;
        hold.status = 'released';
        this.trace.add('LOCAL', this.provider, 'provider_bank_hold_released', {
          key: releaseKey,
          holdRef: hold.holdRef,
        });
      }
      return { reference: hold.holdRef };
    });
    if (rec.status === 'rejected') return { reject: rec.reason ?? 'release_rejected' };
    const blocked = blockedOf(rec);
    if (blocked !== undefined) return { blocked };
    return 'done';
  }

  // ---- returns ---------------------------------------------------------------

  // Money goes back the way it came: the payee's provider debits its bank
  // account for the principal, the interbank transfer credits this
  // provider's book, and the customer is restored on the original rail —
  // funded back to digital euro (subject to the holding limit) or credited
  // to their bank entitlement. 'principal_and_fee' additionally returns
  // the charged fee from the provider's fee account (decision 9).
  private deReturn(w: Acceptance): Drive {
    const leg = w.leg;
    const c = this.customerAt(leg.payerId);
    const ps = c.dePseudonym!;
    const feeBack = w.returnPolicy === 'principal_and_fee' ? (w.feeChargedCents ?? w.feeCommittedCents ?? 0) : 0;
    let total = leg.principalCents + feeBack;
    const destProvider = this.de.holding(leg.destination.dePseudonym!).provider;
    const shop = this.shops.get(destProvider);
    if (shop === undefined) return { reject: 'destination_unknown' };
    const credit = w.committedCredit;
    if (!w.destinationConfirmed && credit?.transitRef !== undefined && w.cancelledPrincipalCents === undefined) {
      this.requested('cancel_uncredited_requested', childKey(leg, 'return', 'cancel-destination'), shop.provider, {
        transitRef: credit.transitRef,
      });
      const cancel = shop.cancelUncredited(childKey(leg, 'return', 'cancel-destination'), credit.transitRef, childKey(leg, 'commit', 'destination'));
      if (cancel.status !== 'succeeded') return { reject: cancel.reason ?? 'cancel_rejected' };
      w.cancelledPrincipalCents = credit.defundedCents;
      this.book.credit(credit.defundedCents);
    }
    // A refused fee conversion committed the fee hold but never booked
    // revenue. Cancel its transit and restore it during recovery.
    const feeFx = this.de.status(childKey(leg, 'commit', 'fee'))?.effects as DeCreditEffects | undefined;
    if (!w.feeBooked && feeFx?.transitRef !== undefined && w.cancelledFeeCents === undefined) {
      this.requested('de_cancel_requested', childKey(leg, 'return', 'cancel-fee'), 'de-ledger', {
        transitRef: feeFx.transitRef,
        rejectedKey: childKey(leg, 'commit', 'fee-defund'),
      });
      const cancel = this.de.cancelUncredited({ key: childKey(leg, 'return', 'cancel-fee'), provider: this.provider, transitRef: feeFx.transitRef, rejectedKey: childKey(leg, 'commit', 'fee-defund') });
      if (cancel.status !== 'succeeded') return { reject: cancel.reason ?? 'cancel_rejected' };
      w.cancelledFeeCents = feeFx.defundedCents;
      this.book.credit(feeFx.defundedCents);
    }
    total += Math.max(0, (w.cancelledFeeCents ?? 0) - feeBack);
    const merchantPrincipal = leg.principalCents - (w.cancelledPrincipalCents ?? 0);
    if (merchantPrincipal > 0) {
      this.requested('debit_for_refund_requested', childKey(leg, 'return', 'bank'), shop.provider, {
        destination: this.provider,
        amountCents: merchantPrincipal,
      });
    }
    const pay = merchantPrincipal === 0 ? { status: 'succeeded' as const } : shop.debitForRefund({
      key: childKey(leg, 'return', 'bank'),
      to: this.provider,
      amountCents: merchantPrincipal,
    });
    if (pay.status === 'rejected') return { reject: pay.reason ?? 'return_rejected' };
    const payBlocked = blockedOf(pay);
    if (payBlocked !== undefined) return { blocked: payBlocked };

    // The paired conversion pays the Eurosystem from the provider pool:
    // check it can cover the credit before the ledger applies it — a
    // refused pool debit after the credit lands would strand a funded
    // customer with no settled liability.
    if (!w.returnFundApplied && this.book.poolCents < total) return { reject: 'insufficient_funds' };
    if (total > 0) {
      this.requested('de_fund_requested', childKey(leg, 'return', 'digital_euro'), 'de-ledger', {
        pseudonym: ps,
        amountCents: total,
      });
    }
    const fund = total === 0 ? { status: 'succeeded' as const, effects: { creditedCents: 0, defundedCents: 0 } } : this.conversions.run('fund', {
      key: childKey(leg, 'return', 'digital_euro'),
      provider: this.provider,
      pseudonym: ps,
      amountCents: total,
    }, () => {
      this.book.debit(total);
      if (feeBack > 0 && w.feeBooked) this.fees -= feeBack;
      w.returnFundApplied = true;
    });
    if (fund.status === 'rejected') return { reject: `return_rejected:${fund.reason}` };
    const fundBlocked = blockedOf(fund);
    if (fundBlocked !== undefined) return { blocked: fundBlocked };
    const fx = fund.effects as DeCreditEffects;
    if (fx.defundedCents > 0 && fx.transitRef !== undefined && !w.returnExcessApplied) {
      this.requested('de_defund_requested', childKey(leg, 'return', 'defund'), 'de-ledger', {
        pseudonym: ps,
        amountCents: fx.defundedCents,
        transitRef: fx.transitRef,
      });
      const confirm = this.conversions.run('defund', {
        key: childKey(leg, 'return', 'defund'),
        provider: this.provider,
        pseudonym: ps,
        amountCents: fx.defundedCents,
        transitRef: fx.transitRef,
      }, () => this.book.credit(fx.defundedCents));
      const confirmBlocked = blockedOf(confirm);
      if (confirmBlocked !== undefined) return { blocked: confirmBlocked };
      if (confirm.status === 'rejected') {
        const restored = this.restoreRejectedExcess(w, fx, 'return');
        if (restored !== undefined) return restored;
      } else {
        c.spendableCents += fx.defundedCents;
      }
      w.returnExcessApplied = true;
    }
    // A fee hold whose commit was conclusively refused was never charged:
    // release it during this cleanup so the reservation cannot leak to
    // expiry beside a completed return (§6.1 cleanup confirmation).
    if (w.feeHoldRef !== undefined && (w.feeChargedCents ?? 0) === 0) {
      if (this.de.holdAudit(w.feeHoldRef).status === 'active') {
        this.requested('de_release_requested', childKey(leg, 'return', 'hold', this.feePseudonym!), 'de-ledger', {
          holdRef: w.feeHoldRef,
        });
        const rel = this.de.releaseHold({
          key: childKey(leg, 'return', 'hold', this.feePseudonym!),
          provider: this.provider,
          holdRef: w.feeHoldRef,
        });
        if (rel.status === 'rejected') return { reject: rel.reason ?? 'release_rejected' };
        const relBlocked = blockedOf(rel);
        if (relBlocked !== undefined) return { blocked: relBlocked };
      }
    }
    w.principalReturnedCents = leg.principalCents;
    w.feeReturnedCents = Math.max(feeBack, w.cancelledFeeCents ?? 0);
    w.returned = true;
    w.returnRef ??= `ret-${this.nextReturn++}`;
    return 'done';
  }

  private bankReturn(w: Acceptance): Drive {
    const leg = w.leg;
    const c = this.customerAt(leg.payerId);
    const feeBack = w.returnPolicy === 'principal_and_fee' ? (w.feeChargedCents ?? 0) : 0;
    const shop = this.shops.get(leg.destination.bankProvider!);
    if (shop === undefined) return { reject: 'destination_unknown' };
    if (leg.principalCents > 0) {
      this.requested('debit_for_refund_requested', childKey(leg, 'return', 'bank'), shop.provider, {
        destination: this.provider,
        amountCents: leg.principalCents,
      });
    }
    const pay = leg.principalCents === 0 ? { status: 'succeeded' as const } : shop.debitForRefund({
      key: childKey(leg, 'return', 'bank'),
      to: this.provider,
      amountCents: leg.principalCents,
    });
    if (pay.status === 'rejected') return { reject: pay.reason ?? 'return_rejected' };
    const payBlocked = blockedOf(pay);
    if (payBlocked !== undefined) return { blocked: payBlocked };
    const restoreKey = childKey(leg, 'return', 'restore');
    const restore = this.child(
      restoreKey,
      'bank_restore',
      { amountCents: leg.principalCents + feeBack, customerId: leg.payerId },
      () => {
        c.spendableCents += leg.principalCents + feeBack;
        if (feeBack > 0) this.fees -= feeBack;
        this.trace.add('LOCAL', this.provider, 'provider_bank_restored', {
          key: restoreKey,
          customerId: leg.payerId,
          amountCents: leg.principalCents + feeBack,
        });
        return {};
      },
    );
    if (restore.status === 'rejected') return { reject: restore.reason ?? 'return_rejected' };
    const restoreBlocked = blockedOf(restore);
    if (restoreBlocked !== undefined) return { blocked: restoreBlocked };
    w.principalReturnedCents = leg.principalCents;
    w.feeReturnedCents = feeBack;
    w.returned = true;
    w.returnRef ??= `ret-${this.nextReturn++}`;
    return 'done';
  }

  // ---- shared child helpers ---------------------------------------------------

  // Begin a provider-internal child operation and run it under its stage
  // fault; a replay under the same key and terms returns the recorded
  // operation and never re-applies the effect.
  private child(key: string, stage: string, terms: unknown, apply: () => StageResult): OperationRecord {
    // The provider's own bank book is the receiving side of these
    // children — the request's `to` is the provider itself.
    const event = CHILD_REQUESTS[stage];
    if (event !== undefined && terms !== null && typeof terms === 'object') {
      this.requested(event, key, this.provider, terms as Record<string, unknown>);
    }
    const rec = this.store.begin(key, terms);
    if (rec.status !== 'not_started') return rec;
    return this.runStage(key, stage, apply);
  }

  private runStage(key: string, stage: string, apply: () => StageResult): OperationRecord {
    const fault = this.faultAt(key, stage);
    if (fault === 'reject_before_effect') {
      const rec = this.store.resolve(key, { status: 'rejected', reason: `${stage}_rejected` });
      this.trace.add('LOCAL', this.provider, 'provider_op_rejected', { key, stage, reason: rec.reason });
      return rec;
    }
    if (fault === 'defer') {
      this.deferred.set(key, { apply });
      return this.store.resolve(key, { status: 'pending' });
    }
    const out = apply();
    const rec = this.store.resolve(key, { status: 'succeeded', reference: out.reference, effects: out.effects });
    if (fault === 'lose_response_after_effect') {
      return { key: rec.key, terms: rec.terms, status: 'unknown' };
    }
    return rec;
  }

  // A terminal refused excess conversion can never be retried. Recover
  // only its uncredited transit into the customer's bank, using separate
  // stable keys; replay of either recovery child cannot credit twice.
  private restoreRejectedExcess(w: Acceptance, fx: DeCreditEffects, op: 'fund' | 'return'): Drive | undefined {
    const leg = w.leg;
    const stage = op === 'fund' ? 'funding' : 'return';
    this.requested('de_cancel_requested', childKey(leg, 'restore', `cancel-${stage}-excess`), 'de-ledger', {
      transitRef: fx.transitRef!,
      rejectedKey: childKey(leg, op, 'defund'),
    });
    const cancelled = this.de.cancelUncredited({
      key: childKey(leg, 'restore', `cancel-${stage}-excess`),
      provider: this.provider,
      transitRef: fx.transitRef!,
      rejectedKey: childKey(leg, op, 'defund'),
    });
    if (cancelled.status !== 'succeeded') return { reject: cancelled.reason ?? 'cancel_rejected' };
    // Cancellation moves the money out of ledger transit now. Book its
    // paired pool credit synchronously, retaining once-only ownership
    // before customer restoration can defer or lose its response.
    w.excessRecoveryBooked ??= {};
    if (!w.excessRecoveryBooked[op]) {
      this.book.credit(fx.defundedCents);
      w.excessRecoveryBooked[op] = true;
    }
    const restoreKey = childKey(leg, 'restore', `${stage}-excess`);
    const restored = this.child(
      restoreKey,
      'bank_restore',
      { amountCents: fx.defundedCents, customerId: leg.payerId },
      () => {
        this.customerAt(leg.payerId).spendableCents += fx.defundedCents;
        this.trace.add('LOCAL', this.provider, 'provider_bank_restored', {
          key: restoreKey,
          customerId: leg.payerId,
          amountCents: fx.defundedCents,
        });
        return {};
      },
    );
    const blocked = blockedOf(restored);
    if (blocked !== undefined) return { blocked };
    if (restored.status === 'rejected') return { reject: restored.reason ?? 'restore_rejected' };
    return undefined;
  }

  // The bank debit parked in funding transit when the ledger credit was
  // conclusively refused is restored once (spec §6.1).
  private restoreFundingTransit(w: Acceptance): Drive | undefined {
    const amount = w.fundingInTransit;
    if (amount <= 0) return undefined;
    const restoreKey = childKey(w.leg, 'restore', 'bank');
    const rec = this.child(
      restoreKey,
      'bank_restore',
      { amountCents: amount, customerId: w.leg.payerId },
      () => {
        const c = this.customerAt(w.leg.payerId);
        c.spendableCents += amount;
        this.book.credit(amount);
        w.fundingInTransit -= amount;
        w.fundingRestored = true;
        this.trace.add('LOCAL', this.provider, 'provider_bank_restored', {
          key: restoreKey,
          customerId: w.leg.payerId,
          amountCents: amount,
        });
        return {};
      },
    );
    if (rec.status === 'rejected') return { reject: rec.reason ?? 'restore_rejected' };
    const blocked = blockedOf(rec);
    if (blocked !== undefined) return { blocked };
    return undefined;
  }

  // After a failed hold or a release, defund only the amount funded for
  // this intent back to bank — pre-existing digital euro is preserved.
  // The quantum is what the fund child actually credited to the holding
  // (fundedCents − excess defunded): funding above the holding limit
  // already returned to bank through the excess transit confirm, so the
  // recorded credit effects — never the bank shortfall — decide the
  // unwind amount (spec §6.1 conservation).
  private unwindFunding(w: Acceptance, op: string): Drive | undefined {
    if (w.fundingRestored || (w.fundedCents ?? 0) <= 0) return undefined;
    const leg = w.leg;
    const fx = this.de.status(childKey(leg, 'fund', 'digital_euro'))?.effects as DeCreditEffects | undefined;
    const amount = fx?.creditedCents ?? 0;
    if (amount <= 0) return undefined;
    const ps = this.customerAt(leg.payerId).dePseudonym!;
    this.requested('de_defund_requested', childKey(leg, op, 'digital_euro'), 'de-ledger', {
      pseudonym: ps,
      amountCents: amount,
    });
    const defund = this.conversions.run('defund', {
      key: childKey(leg, op, 'digital_euro'),
      provider: this.provider,
      pseudonym: ps,
      amountCents: amount,
    }, () => this.book.credit(amount));
    const blocked = blockedOf(defund);
    if (blocked !== undefined) return { blocked };
    // A refused defund leaves the funded amount claimable in the holding:
    // stay unresolved until status confirms it — never report cleanup
    // beside stranded funded digital euro (§6.1).
    if (defund.status !== 'succeeded') return { blocked: 'unknown' };
    const restore = this.child(
      childKey(leg, op, 'bank'),
      'bank_restore',
      { amountCents: amount, customerId: leg.payerId },
      () => {
        const c = this.customerAt(leg.payerId);
        c.spendableCents += amount;
        w.fundingRestored = true;
        this.trace.add('LOCAL', this.provider, 'provider_funding_restored', {
          key: childKey(leg, op, 'bank'),
          customerId: leg.payerId,
          amountCents: amount,
        });
        return {};
      },
    );
    if (restore.status === 'rejected') return { reject: restore.reason ?? 'restore_rejected' };
    const restoreBlocked = blockedOf(restore);
    if (restoreBlocked !== undefined) return { blocked: restoreBlocked };
    return undefined;
  }

  private releaseDeHolds(w: Acceptance, op: string): Drive | undefined {
    const leg = w.leg;
    const targets: [string | undefined, string][] = [
      [w.principalHoldRef, leg.destination.dePseudonym ?? 'principal'],
      [w.feeHoldRef, this.feePseudonym ?? 'fee'],
    ];
    for (const [holdRef, destination] of targets) {
      if (holdRef === undefined) continue;
      let rec: OperationRecord;
      this.requested('de_release_requested', childKey(leg, op, 'hold', destination), 'de-ledger', { holdRef });
      try {
        rec = this.de.releaseHold({
          key: childKey(leg, op, 'hold', destination),
          provider: this.provider,
          holdRef,
        });
      } catch (err) {
        // A commit already handed off must resolve first — dependent work
        // stops while an operation is unresolved.
        if (err instanceof Error && err.message === 'hold_commit_pending') return { blocked: 'pending' };
        throw err;
      }
      if (rec.status === 'rejected') return { reject: rec.reason ?? 'release_rejected' };
      const blocked = blockedOf(rec);
      if (blocked !== undefined) return { blocked };
    }
    return undefined;
  }

  private faultAt(key: string, stage: string): SimulationFault | undefined {
    const byStage = this.faults.get(key);
    const fault = byStage?.get(stage);
    if (fault !== undefined) byStage!.delete(stage);
    return fault;
  }

  // A bank-rail hold past its deadline expires lazily — unless a commit is
  // already consuming it, mirroring the ledger's commit/expiry race rule.
  private expireBankHold(w: Acceptance): void {
    const hold = w.bankHold;
    if (hold === undefined || hold.status !== 'active' || w.holdConsumed === true) return;
    if (this.now() >= hold.expiresAt) {
      const c = this.customerAt(w.leg.payerId);
      c.spendableCents += hold.amountCents;
      c.heldCents -= hold.amountCents;
      hold.status = 'expired';
      this.trace.add('LOCAL', this.provider, 'provider_bank_hold_expired', {
        holdRef: hold.holdRef,
        expiresAt: hold.expiresAt,
      });
    }
  }

  // ---- outcome projections ----------------------------------------------------

  private blockedKeys(w: Acceptance): string[] {
    const leg = w.leg;
    const keys = [
      legOpKey(leg, 'reserve'),
      legOpKey(leg, 'commit'),
      legOpKey(leg, 'release'),
      childKey(leg, 'fund', 'bank'),
      childKey(leg, 'fund', 'digital_euro'),
      childKey(leg, 'fund', 'defund'),
      childKey(leg, 'defund', 'digital_euro'),
      childKey(leg, 'defund', 'bank'),
      childKey(leg, 'restore', 'bank'),
      childKey(leg, 'restore', 'funding-excess'),
      childKey(leg, 'restore', 'return-excess'),
      childKey(leg, 'release', 'digital_euro'),
      childKey(leg, 'release', 'bank'),
      childKey(leg, 'commit', 'principal'),
      childKey(leg, 'commit', 'destination'),
      childKey(leg, 'commit', 'fee'),
      childKey(leg, 'commit', 'fee-defund'),
      childKey(leg, 'return', 'bank'),
      childKey(leg, 'return', 'digital_euro'),
      childKey(leg, 'return', 'defund'),
      childKey(leg, 'return', 'restore'),
    ];
    if (leg.destination.dePseudonym !== undefined) keys.push(childKey(leg, 'hold', leg.destination.dePseudonym));
    if (this.feePseudonym !== undefined) keys.push(childKey(leg, 'hold', this.feePseudonym));
    keys.push(childKey(leg, 'hold', 'bank'), childKey(leg, 'release', 'bank'));
    // A fixed hold stage separates external destination pseudonyms from
    // conversion stages such as digital_euro — under 'release'
    // for the release drive, under 'reserve' for the unwind after a failed
    // fee hold, and under 'return' for the uncharged-fee release during
    // compensation cleanup — so unresolved release children surface too.
    for (const op of ['reserve', 'release', 'return']) {
      if (leg.destination.dePseudonym !== undefined) keys.push(childKey(leg, op, 'hold', leg.destination.dePseudonym));
      if (this.feePseudonym !== undefined) keys.push(childKey(leg, op, 'hold', this.feePseudonym));
    }
    if (leg.destination.bankProvider !== undefined) keys.push(childKey(leg, 'pay', leg.destination.bankProvider));
    if (leg.deGroup !== undefined) keys.push(leg.deGroup.key);
    if (w.returnKey !== undefined) keys.push(w.returnKey);
    return keys;
  }

  // Open child operations with their recorded evidence — callers never
  // schedule deferred work themselves.
  private unresolvedFor(w: Acceptance | undefined): OperationRecord[] {
    if (w === undefined) return [];
    const out: OperationRecord[] = [];
    for (const key of this.blockedKeys(w)) {
      const rec = this.store.status(key) ?? this.de.status(key) ?? this.bank.status(key);
      if (rec !== undefined && (rec.status === 'pending' || rec.status === 'unknown')) out.push(rec);
    }
    return out;
  }

  // Cleanup is confirmed when no funding sits in transit, every created
  // hold is released or expired, and any funded amount was restored (or
  // consumed by a confirmed commit). "Funded" means what the fund child
  // actually credited — a reserve refused before that child ran has
  // nothing to restore, however large the computed shortfall was.
  private cleanupDone(w: Acceptance): boolean {
    if (w.fundingInTransit > 0) return false;
    if (!w.returned && ((w.committedCents !== undefined && !w.destinationConfirmed)
      || ((w.feeCommittedCents ?? 0) > 0 && !w.feeBooked))) return false;
    // Ledger conversion may have settled while its response was lost;
    // customer restoration and return bookkeeping must also finish.
    if (w.returnKey !== undefined && !w.returned) return false;
    const credits = [
      w.committedCredit ?? this.groupCredit(w),
      ...[
        childKey(w.leg, 'fund', 'digital_euro'),
        childKey(w.leg, 'commit', 'principal'),
        childKey(w.leg, 'commit', 'fee'),
        childKey(w.leg, 'return', 'digital_euro'),
      ].map((key) => this.de.status(key)?.effects as DeCreditEffects | undefined),
    ];
    const transitRefs = new Set(credits.map((credit) => credit?.transitRef).filter((ref) => ref !== undefined));
    if (this.de.transit().some((entry) => transitRefs.has(entry.transitRef) && entry.status === 'in_transit')) return false;
    if (!w.fundingRestored && w.committedCents === undefined) {
      const fx = this.de.status(childKey(w.leg, 'fund', 'digital_euro'))?.effects as DeCreditEffects | undefined;
      if ((fx?.creditedCents ?? 0) > 0) return false;
    }
    if (w.principalHoldRef !== undefined) {
      const status = this.de.holdAudit(w.principalHoldRef).status;
      if (status === 'active') return false;
    }
    if (w.feeHoldRef !== undefined) {
      const status = this.de.holdAudit(w.feeHoldRef).status;
      if (status === 'active') return false;
    }
    if (w.bankHold !== undefined) {
      this.expireBankHold(w);
      if (w.bankHold.status === 'active') return false;
    }
    return true;
  }

  private outcomeFor(key: string, w: Acceptance | undefined): ProviderOutcome {
    const rec = this.store.status(key);
    const base = rec ?? { key, terms: undefined, status: 'not_started' as const };
    return {
      key,
      status: base.status,
      reason: base.reason,
      reference: base.reference ?? (w !== undefined && key === legOpKey(w.leg, 'commit') ? w.executionRef : undefined),
      committedCents: w?.committedCents,
      destinationCreditConfirmed: w === undefined ? undefined : w.destinationConfirmed,
      feeChargedCents: w?.feeChargedCents ?? w?.feeCommittedCents,
      feeReturnedCents: w?.feeReturnedCents,
      principalReturnedCents: w?.principalReturnedCents,
      // A conclusive validation refusal created no acceptance record and
      // moved nothing: cleanup is trivially confirmed, not unknown.
      cleanupConfirmed: w === undefined ? (base.status === 'rejected' ? true : undefined) : this.cleanupDone(w),
      unresolved: this.unresolvedFor(w),
    };
  }

  private reserveOutcome(key: string, w: Acceptance | undefined): ReserveOutcome {
    const outcome = this.outcomeFor(key, w);
    return {
      ...outcome,
      acceptanceRef: w?.ref,
      holdRef: w?.principalHoldRef ?? w?.bankHold?.holdRef ?? w?.feeHoldRef,
      expiresAt: w?.expiresAt,
      acceptedHold: w?.acceptedHold === undefined ? undefined : { ...w.acceptedHold },
    };
  }

  private wrapRecord(rec: OperationRecord): ProviderOutcome {
    return {
      key: rec.key,
      status: rec.status,
      reason: rec.reason,
      reference: rec.reference,
      unresolved: rec.status === 'pending' || rec.status === 'unknown' ? [rec] : [],
    };
  }
}

// The leg identity tuple used to index accepted work.
function legIdKey(leg: SettlementLeg): string {
  return operationKey(['leg', leg.purchaseId, leg.proposalVersion, leg.role]);
}

// The immutable reserve terms a replay must reproduce: the whole frozen leg.
function reserveTerms(leg: SettlementLeg): unknown {
  return structuredClone(leg);
}

function blockedOf(rec: OperationRecord): 'pending' | 'unknown' | undefined {
  return rec.status === 'pending' || rec.status === 'unknown' ? rec.status : undefined;
}

// The membership shape the ledger enforces before recording a hold
// (mirrors the ledger's own check): a nonempty duplicate-free member list
// containing the leg's own member identity. Pre-validated at reserve so a
// malformed descriptor is a rejected outcome, never a mid-drive crash.
function membershipShapeOk(group: DeGroupMembership): boolean {
  if (typeof group.key !== 'string' || group.key.length === 0) return false;
  if (typeof group.self !== 'string' || group.self.length === 0) return false;
  if (!Array.isArray(group.members)) return false;
  const members = new Set(group.members);
  return members.has(group.self) && members.size === group.members.length;
}

// Commit every accepted hold of a frozen digital-euro group in one step
// (decision 11; spec §4.3). For the orchestrator's internal use: each
// provider vouches for its own unexpired acceptance and frozen membership,
// then the ledger validates and commits all members synchronously — this
// helper deliberately performs no await before commitGroup so the group
// can never be half-handed-off across providers. The result stays
// recoverable under the original group key; each owning provider then
// finishes fee and waterfall bookkeeping through commit(holdRef).
//
// The caller's request log records the real path: a vouch request per
// member under the caller's actor before each vouchForGroup, the provider's
// vouched/refused answer under its own actor, and — only once every vouch
// succeeds — the providers' single commit request to the ledger that
// de_group_committed / de_op_rejected pairs with.
export async function commitAcceptedDigitalEuroGroup(
  holds: readonly AcceptedHold[],
  owners: ProviderOwners,
  requests: RequestLog,
): Promise<GroupOutcome> {
  const fail = (key: string | undefined, reason: string, members: GroupMemberOutcome[] = []): GroupOutcome => ({
    key: key ?? 'group-unknown',
    status: 'rejected',
    reason,
    members,
  });
  if (holds.length === 0) return fail(undefined, 'group_members_empty');
  const members: DeGroupCommitMember[] = [];
  let groupKey: string | undefined;
  let ledger: DigitalEuroLedger | undefined;
  for (const hold of holds) {
    requests.add('de_group_vouch_requested', hold.holdRef, hold.provider, hold.groupKey, {
      provider: hold.provider,
      leg: hold.leg,
    });
    const owner = owners.at(hold.owner);
    if (owner === undefined) {
      // No provider resolved to answer for the addressed receiver: the
      // collective refuses on its behalf, naming the claimed provider.
      requests.for('de-providers').emit('de_group_vouch_refused', {
        key: hold.holdRef,
        provider: hold.provider,
        holdRef: hold.holdRef,
        reason: 'unknown_provider',
      });
      return fail(hold.groupKey, 'unknown_provider');
    }
    const vouch = owner.vouchForGroup(hold);
    if ('problem' in vouch) {
      requests.for(owner.provider).emit('de_group_vouch_refused', {
        key: hold.holdRef,
        provider: hold.provider,
        holdRef: hold.holdRef,
        reason: vouch.problem,
      });
      return fail(hold.groupKey, vouch.problem, [
        { leg: hold.leg, holdRef: hold.holdRef, provider: hold.provider, status: 'rejected', reason: vouch.problem },
      ]);
    }
    requests.for(owner.provider).emit('de_group_vouched', {
      key: hold.holdRef,
      provider: hold.provider,
      holdRef: hold.holdRef,
    });
    if (groupKey === undefined) {
      groupKey = vouch.groupKey;
      ledger = vouch.ledger;
    } else if (vouch.groupKey !== groupKey || vouch.ledger !== ledger) {
      return fail(hold.groupKey, 'group_membership_invalid');
    }
    members.push(vouch.member);
  }
  // One ledger commit for the whole group, dispatched by the providers
  // collectively — parented to the group commit request under the same key,
  // like every forwarded hop that keeps its caller's key.
  requests.for('de-providers').add('de_group_ledger_commit_requested', groupKey!, 'de-ledger', groupKey!, {
    members: members.map((m) => ({ provider: m.provider, holdRef: m.holdRef })),
  });
  const rec = ledger!.commitGroup({ key: groupKey!, members });
  const effects = rec.effects as DeGroupCommitEffects | undefined;
  const memberOutcomes: GroupMemberOutcome[] = members.map((m) => {
    const e = effects?.members.find((x) => x.holdRef === m.holdRef);
    return {
      leg: m.leg,
      holdRef: m.holdRef,
      provider: m.provider,
      status: rec.status,
      reason: rec.status === 'succeeded' ? undefined : rec.reason,
      credit:
        e === undefined
          ? undefined
          : { creditedCents: e.creditedCents, defundedCents: e.defundedCents, transitRef: e.transitRef },
    };
  });
  const unresolved = rec.status === 'pending' || rec.status === 'unknown' ? rec : undefined;
  return { key: groupKey!, status: rec.status, reason: rec.reason, members: memberOutcomes, unresolved };
}
