// Synthetic fixtures and the scenario set. Every actor, account and amount is
// synthetic. Reference purchase: EUR 13 lunch = EUR 8 employee + EUR 5 employer.

import { Coordinator, approvalCents, approvalFeeCents, shareCents } from './core/coordinator.ts';
import type { CoordinatorOptions, OfferChange, ProposeInput } from './core/coordinator.ts';
import { DigitalEuroLedger, HOLD_TTL_MINUTES } from './settlement/digital-euro-ledger.ts';
import { InterbankTransfer } from './settlement/interbank-transfer.ts';
import { PayerProvider, ProviderOwners, ShopProvider, commitAcceptedDigitalEuroGroup } from './settlement/provider.ts';
import { SettlementOrchestrator } from './settlement/orchestrator.ts';
import type { SettlementSnapshot } from './settlement/types.ts';
import { operationKey } from './settlement/operations.ts';
import { keyPairFromSeed, sharesDigestOf, signPayload } from './core/signing.ts';
import type { KeyPair, Signed } from './core/signing.ts';
import { AuthorityRegistry } from './core/authority.ts';
import type { KnownSplitGroup } from './core/privacy.ts';
import { DEFAULT_CALENDAR_EPOCH, DEFAULT_DISPUTE_WINDOW_MINUTES } from './core/autopay-ledger.ts';
import { Trace } from './evidence/trace.ts';
import type { CancelRequest, Cents, ChangeOfferRequest, DelegationGrant, EmployeeMandate, EmployerMandate, EqualSplitRequest, PayerApproval, ProposeRequest, ProposerSplitRequest, PurchaseState, PurchaseView, Rail, RefundRequest, SettlementMode, SplitRequest, SubmitPolicy, SubmitRequestPayload } from './core/types.ts';
import { createPresenterSession } from './presenter/session.ts';
import type { AgentGrant, CatalogOffer, PresenterSession } from './presenter/session.ts';

export const EMPLOYEE = 'employee-1';
export const EMPLOYER = 'employer-1';
export const MERCHANT_A = 'merchant-a';
export const MERCHANT_B = 'merchant-b';
export const MERCHANT_C = 'merchant-c';
export const COLLEAGUE_1 = 'colleague-1';
export const COLLEAGUE_2 = 'colleague-2';
// Delivery platform: the second payee in the multi-payee scenario.
export const PLATFORM = 'platform-1';

// The default known-group disclosure agreement a world supplies: the three
// colleagues already share identities and principal contribution amounts
// within the group under split_bill_v1. Any purchase subset of its members
// is covered; it conveys no spending authority. Tests needing other
// coverage — e.g. a technical employee/employer split — configure their own
// explicit group instead of broadening this one.
export const COLLEAGUES_V1_GROUP: KnownSplitGroup = Object.freeze({
  groupRef: 'colleagues-v1',
  privacyProfile: 'split_bill_v1',
  memberIds: Object.freeze([EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2]),
});

// Bump whenever a fixture value below changes, so recorded runs say which
// fixtures produced them. 2026.11-1: the employer mandate gained a version
// field — published revisions are verified and sequenced at acceptance.
// 2026.11-2: lifecycle calls arrive signed by their caller — proposals
// carry submitPolicy/settlementMode/proposedBy (and amountsFrom on
// splits), and payee/agent signers join the world's key registry.
// 2026.11-3: per-payer provider initiation is the world default; direct
// submission survives as the guarded licensed-provider and test-bypass
// modes, and provider membership groups the simulated PSPs.
// 2026.11-4: provider-owned books and ledger-local settlement replace the
// single balance-owning backend: payer providers hold bank books and
// reserve holds, digital-euro holdings are pseudonymous on the shared
// ledger, and the orchestrator commits across both rails — `atomic` means
// reserve-all with compensation, never cross-ledger atomicity.
// 2026.11-5: signed privacy profiles. Employer mandates, benefit requests,
// split requests and payer approvals carry a versioned disclosure profile;
// splits name a trusted known-group agreement, and the colleagues-v1
// group becomes the world's default disclosure fixture.
export const FIXTURE_VERSION = '2026.11-5';

// The settlement window a leg's hold stays open before expiry resolves the
// intent — the digital-euro hold TTL (thirty seconds as 0.5 simulated
// minutes), re-exported for tests advancing past the deadline.
export { HOLD_TTL_MINUTES };

// Illustrative only: the ECB has not fixed an individual holding limit.
export const HOLDING_LIMIT = 300_000;

// 2026 German ceiling per subsidised meal (Sachbezugswert EUR 4.57 + EUR 3.10),
// one meal per working day. Pending tax/legal confirmation (see backlog).
export const MEAL_BENEFIT_CAP = 767;

// Standing terms enabling automatic payment (spec §12 auto-pay fixture):
// EUR 6 per purchase, EUR 10 ordinary maximum, EUR 30 per month,
// merchant-a trusted. Budget-tight tests override autoPayMonthlyCents.
export const AUTO_EMPLOYEE_TERMS: EmployeeMandate = {
  mandateRef: 'employee-mandate-1',
  employeeId: EMPLOYEE,
  version: 1,
  autoPayMaxCents: 600,
  maxCents: 1_000,
  autoPayMonthlyCents: 3_000,
  trustedMerchants: [MERCHANT_A],
  blockedMerchants: [],
  // The employee's shares ride the digital-euro rail; the terms permit it.
  allowedRails: ['digital_euro'],
  validUntil: 1_000,
  revoked: false,
};

// The employee's fixture seed — the balances and waterfall switch a world
// starts the employee with. Owned here: it replaced the retired aggregate
// account type the old single-ledger backend used.
export interface EmployeeSeed {
  // Digital-euro holdings; default 2_000.
  deCents?: Cents;
  // Linked bank entitlement the reverse waterfall funds from; default 50_000.
  linkedBankCents?: Cents;
  holdingLimitCents?: Cents;
  // false models holdings with no reachable bank funding; default true.
  reverseWaterfall?: boolean;
}

export interface WorldOptions {
  // Initiation mode — how the purchase's legs reach the settlement layer.
  //   'per_payer_psp' (default, the realistic model): each payer's provider
  //     reserves and commits only its own payer's legs; an atomic intent's
  //     digital-euro legs join one same-ledger group across the
  //     per-provider acceptances.
  //   'coordinator_as_psp': the coordinator is the licensed provider for
  //     every payer of the purchase — direct one-call submission, refused
  //     when the purchase's payers belong to different providers.
  //   'test_bypass_psp': test-only — the same direct routing with only the
  //     mixed-provider guard relaxed. Provider checks still apply in full:
  //     PayerProvider validation, authority acceptance, holds, fees and
  //     conservation all run as usual — the bypass never turns them off
  //     and is never shown as a realistic mode.
  initiation?: 'per_payer_psp' | 'coordinator_as_psp' | 'test_bypass_psp';
  // Fixture membership: which provider serves each payer. Groups payers
  // onto shared PayerProvider instances under per-payer mode and feeds the
  // mixed-provider guard under 'coordinator_as_psp'. Default: one
  // provider per payer id.
  providerFor?: (payerId: string) => string;
  // Standing employee terms published at setup. Default: the manual-only
  // terms (EUR 8 maximum, automatic limits zero) — pass terms to override or
  // null for an explicit no-mandate world.
  employeeMandate?: EmployeeMandate | null;
  // Calendar fixture settings for automatic payments; defaults are the spec
  // values (2026-01-01T00:00:00Z epoch, 1,440-minute dispute window).
  calendarEpoch?: string;
  disputeWindowMinutes?: number;
  // Trusted fixture routing: which payers' PSP can carry mandate-initiated
  // payments — a boolean for every payer or a per-payer predicate. Default
  // false: an ordinary fixture never routes automatic payments.
  supportsMandatePayments?: boolean | ((payerId: string) => boolean);
  // The submit policy and settlement mode the world's signing helpers put
  // on signed proposals by default; per-call overrides win. Defaults are
  // the conservative 'on_request' and 'atomic'.
  submitPolicy?: SubmitPolicy;
  settlementMode?: SettlementMode;
  // The trusted known-group disclosure agreements the coordinator admits:
  // explicit synthetic configuration, never manufactured from a request's
  // contents. Default: the colleagues-v1 group alone. An explicit override
  // — including [] — replaces it wholesale, so a fixture with no groups
  // genuinely admits no split groups.
  knownSplitGroups?: readonly KnownSplitGroup[];
}

export interface World {
  trace: Trace;
  // The settlement orchestrator the coordinator was built with — retained
  // for simulation and evidence access (resolveDeferred, snapshots).
  settlement: SettlementOrchestrator;
  // Each payer's provider, keyed by payer id: balances, holds, availability
  // and stage faults are configured on the concrete module.
  providers: Map<string, PayerProvider>;
  // One receive-only shop provider per payee, keyed by payee id.
  shops: Map<string, ShopProvider>;
  // The same shops keyed by provider name — the map every payer provider's
  // destination confirm reads; register ghost payees through both maps.
  shopsByProvider: Map<string, ShopProvider>;
  digitalEuro: DigitalEuroLedger;
  interbank: InterbankTransfer;
  // The group-membership validator every provider and the orchestrator share.
  owners: ProviderOwners;
  // The resolved initiation mode this world was built for.
  mode: 'per_payer_psp' | 'coordinator_as_psp' | 'test_bypass_psp';
  // The frozen destination routing the world gives its coordinators.
  destinationFor: (payeeId: string, rail: Rail) => { dePseudonym?: string; bankProvider?: string };
  // The party → pseudonym mapping the world minted (or a test registered,
  // as ghost payees do); the ledger itself only ever sees pseudonyms.
  pseudonyms: Map<string, string>;
  coordinator: Coordinator;
  mandate: EmployerMandate;
  // Public keys as the coordinator's registry sees them, bound to holders.
  keys: Map<string, { publicKey: KeyPair['publicKey']; holder: string }>;
  // Private keys stay with their holders: one signer per payer, employer,
  // payee and agent.
  signers: Map<string, KeyPair>;
  // The one authority registry: employer allowances and employee standing
  // terms publish through it; the coordinator reads it back and re-verifies.
  authority: AuthorityRegistry;
  // The world's default submission terms for signed proposals.
  submitPolicy: SubmitPolicy;
  settlementMode: SettlementMode;
  // The detached copy of the split-group configuration the coordinator was
  // built with, so coordinatorFor passes the same explicit agreements.
  knownSplitGroups: readonly KnownSplitGroup[];
}

// --- Detached audit reads for scenario checks -----------------------------
// Concrete module reads, never a mutable account facade: each helper names
// exactly the book, holding or shop that owns the balance.

// The payer's spendable bank entitlement at their own provider.
export const payerBankCents = (w: World, payerId: string): Cents =>
  w.providers.get(payerId)!.account(payerId).spendableCents;

// The payer's pseudonymous digital-euro holding on the Eurosystem ledger.
export const payerDeCents = (w: World, payerId: string): Cents => {
  const ps = w.pseudonyms.get(payerId);
  return ps === undefined ? 0 : w.digitalEuro.holding(ps).deCents;
};

// A payee's bank balance at its receive-only shop provider.
export const payeeBankCents = (w: World, payeeId: string): Cents =>
  w.shops.get(payeeId)!.account().bankCents;

// A payee's digital-euro holding — always zero under the business holding
// limit; excess arrives through defunding transit to bank instead.
export const payeeDeCents = (w: World, payeeId: string): Cents =>
  w.digitalEuro.holding(w.pseudonyms.get(payeeId)!).deCents;

// A second coordinator over the same settlement modules — how two
// coordinators sharing providers are modeled. Each coordinator gets its own
// orchestrator; the providers and ledgers are shared, so colliding
// operation keys still meet the provider-level idempotency defense and one
// shared clock drives every module.
export function coordinatorFor(w: World, opts: CoordinatorOptions = {}): Coordinator {
  return new Coordinator(
    (authorize) =>
      new SettlementOrchestrator({
        providers: w.providers,
        owners: w.owners,
        commitDeGroup: commitAcceptedDigitalEuroGroup,
        digitalEuro: w.digitalEuro,
        now: () => w.coordinator.now,
        trace: w.trace,
        authorizeFirstHandoff: authorize,
      }),
    w.trace,
    {
      now: w.coordinator.now,
      keys: w.keys,
      authority: w.authority,
      destinationFor: w.destinationFor,
      supportsMandatePaymentsFor: w.coordinator.supportsMandatePaymentsFor,
      knownSplitGroups: w.knownSplitGroups,
      ...opts,
    },
  );
}

// The stable child operation key a fault attaches to, mirroring the
// provider's own childKey — tests inject stage faults under the same
// identity the module records.
export const legChildKey = (purchaseId: string, proposalVersion: number, role: string, op: string, stage: string, destination?: string): string =>
  operationKey(['leg', purchaseId, proposalVersion, role, op, stage, ...(destination === undefined ? [] : [destination])]);

// The frozen digital-euro group key for an atomic intent, mirroring the
// orchestrator's minted binding.
export const deGroupKey = (purchaseId: string, proposalVersion: number, members: readonly string[]): string =>
  operationKey(['de-group', purchaseId, proposalVersion, 'commit', ...members]);

// The settlement snapshot a purchase last reported, for scenario evidence.
export const settlementOf = (w: World, purchaseId: string): SettlementSnapshot | undefined =>
  w.coordinator.view(purchaseId).settlement;

// Build an isolated fixture: a fresh trace, ledgers, providers and
// coordinator per call. Defaults are the reference lunch world; each
// scenario overrides one account field or mandate term to create its
// failure condition.
export function world(employee: EmployeeSeed = {}, mandate: Partial<EmployerMandate> = {}, opts: WorldOptions = {}): World {
  const trace = new Trace();
  // The resolved mode stamps the run before anything else happens: recorded
  // runs say which initiation produced them. An unrecognized value is a
  // stale fixture literal — refuse it loudly rather than silently picking a
  // mode for it.
  const mode = opts.initiation ?? 'per_payer_psp';
  if (mode !== 'per_payer_psp' && mode !== 'coordinator_as_psp' && mode !== 'test_bypass_psp') {
    throw new Error(`unknown initiation mode ${mode}`);
  }
  trace.add('LOCAL', 'world', 'initiation_mode', { mode });

  // One shared minute clock: every ledger, provider and the orchestrator
  // read the coordinator's simulated time, so advance() moves them all.
  let coordinator: Coordinator;
  const now = () => coordinator.now;
  const digitalEuro = new DigitalEuroLedger(now, trace);
  const interbank = new InterbankTransfer(now, trace);
  const owners = new ProviderOwners();

  // Which provider serves each payer — real provider separation under
  // per-payer mode, membership data for the mixed-provider guard under
  // the direct modes.
  const providerFor = opts.providerFor ?? ((id: string) => `psp-${id}`);

  // Pseudonymous holdings on the Eurosystem ledger: individuals at the
  // fixture holding limit, every business destination at zero (they hold
  // no digital euro — excess arrives through defunding transit). Tokens are
  // opaque — minted in registration order, never derived from the party id
  // — and the party ↔ pseudonym mapping lives in this fixture map and the
  // providers' own books; the ledger itself only ever sees pseudonyms.
  const pseudonyms = new Map<string, string>();
  let pseudonymSeq = 0;
  const mintPseudonym = (): string => `ps-${++pseudonymSeq}`;
  const individualSeeds: Record<string, { deCents: Cents; bankCents: Cents; holdingLimitCents: Cents; reverseWaterfall: boolean }> = {};
  const employeeDe = employee.deCents ?? 2_000;
  const employeeBank = employee.linkedBankCents ?? 50_000;
  const employeeLimit = employee.holdingLimitCents ?? HOLDING_LIMIT;
  // reverseWaterfall: false models holdings with no reachable bank funding:
  // the provider's waterfall simply finds an empty bank entitlement.
  individualSeeds[EMPLOYEE] = {
    deCents: employeeDe,
    bankCents: employee.reverseWaterfall === false ? 0 : employeeBank,
    holdingLimitCents: employeeLimit,
    reverseWaterfall: employee.reverseWaterfall !== false,
  };
  for (const id of [COLLEAGUE_1, COLLEAGUE_2]) {
    individualSeeds[id] = { deCents: 2_000, bankCents: 50_000, holdingLimitCents: HOLDING_LIMIT, reverseWaterfall: true };
  }
  for (const [id, seed] of Object.entries(individualSeeds)) {
    const ps = mintPseudonym();
    pseudonyms.set(id, ps);
    digitalEuro.registerHolding({
      pseudonym: ps,
      provider: providerFor(id),
      holdingLimitCents: seed.holdingLimitCents,
      deCents: seed.deCents,
    });
  }

  // One receive-only shop provider per payee: bank account plus a
  // zero-limit pseudonymous holding that defunds straight to bank.
  const payees = [MERCHANT_A, MERCHANT_B, MERCHANT_C, PLATFORM];
  const shops = new Map<string, ShopProvider>();
  const shopsByProvider = new Map<string, ShopProvider>();
  for (const payeeId of payees) {
    const shopProvider = `psp-shop-${payeeId}`;
    const ps = mintPseudonym();
    pseudonyms.set(payeeId, ps);
    digitalEuro.registerHolding({ pseudonym: ps, provider: shopProvider, holdingLimitCents: 0 });
    const shop = new ShopProvider({
      provider: shopProvider,
      payeeId,
      dePseudonym: ps,
      bankCents: 0,
      now,
      trace,
      digitalEuro,
      interbank,
    });
    shops.set(payeeId, shop);
    shopsByProvider.set(shopProvider, shop);
  }

  // Group the fixture payers onto provider instances; two payers the
  // fixture places on one provider share its books. The employer is a
  // business customer — bank money only, no pseudonym.
  const customerSeeds = new Map<string, Map<string, { bankCents: Cents; dePseudonym?: string }>>();
  const payerIds = [EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2];
  const seedFor = (id: string): { bankCents: Cents; dePseudonym?: string } => {
    if (id === EMPLOYER) return { bankCents: 100_000 };
    const seed = individualSeeds[id];
    return seed === undefined ? { bankCents: 0 } : { bankCents: seed.bankCents, dePseudonym: pseudonyms.get(id) };
  };
  const supportsMandatePaymentsFor = (id: string): boolean =>
    typeof opts.supportsMandatePayments === 'function'
      ? opts.supportsMandatePayments(id) === true
      : opts.supportsMandatePayments === true;
  const providerByName = new Map<string, PayerProvider>();
  const providers = new Map<string, PayerProvider>();
  for (const id of payerIds) {
    const name = providerFor(id);
    let byCustomer = customerSeeds.get(name);
    if (byCustomer === undefined) customerSeeds.set(name, (byCustomer = new Map()));
    byCustomer.set(id, seedFor(id));
  }
  for (const [name, customers] of customerSeeds) {
    const feePseudonym = mintPseudonym();
    digitalEuro.registerHolding({ pseudonym: feePseudonym, provider: name, holdingLimitCents: 0 });
    const provider = new PayerProvider({
      provider: name,
      customers: Object.fromEntries(customers),
      feePseudonym,
      now,
      trace,
      digitalEuro,
      interbank,
      shops: shopsByProvider,
      owners,
    });
    providerByName.set(name, provider);
  }
  for (const id of payerIds) {
    const provider = providerByName.get(providerFor(id))!;
    const capable = supportsMandatePaymentsFor(id);
    if (provider.supportsMandatePayments !== capable) {
      if (providers.size > 0 && [...providers.values()].includes(provider) && provider.supportsMandatePayments !== capable) {
        throw new Error(`conflicting supportsMandatePayments for shared provider ${providerFor(id)}`);
      }
      provider.supportsMandatePayments = capable;
    }
    providers.set(id, provider);
  }

  // Default mandate: up to EUR 5 per purchase, one subsidised meal per day,
  // at any of the three merchants, valid for the whole scenario clock.
  const m: EmployerMandate = {
    mandateRef: 'mandate-1',
    employerId: EMPLOYER,
    version: 1,
    beneficiaryRef: EMPLOYEE,
    maxPerPurchaseCents: 500,
    maxPerDayCents: MEAL_BENEFIT_CAP,
    maxPurchasesPerDay: 1,
    eligibleMerchants: [MERCHANT_A, MERCHANT_B, MERCHANT_C],
    validFrom: 0,
    validUntil: 1_000,
    revoked: false,
    // The employer signs the benefit profile into its mandate.
    privacyProfile: 'employer_benefit_v1',
    ...mandate,
  };
  // Synthetic signing keys from fixed seeds, one per payer, the employer,
  // the payees (merchants and the platform sign refund and offer-change
  // requests) and the agent handle ('agent-1' signs proposals under an
  // employee's delegation grant). Private keys stay with their holder.
  const signers = new Map<string, KeyPair>();
  const keys = new Map<string, { publicKey: KeyPair['publicKey']; holder: string }>();
  for (const id of [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2, EMPLOYER, MERCHANT_A, MERCHANT_B, MERCHANT_C, PLATFORM, 'agent-1']) {
    const k = keyPairFromSeed(`key-${id}`, `synthetic-seed-${id}`);
    signers.set(id, k);
    keys.set(k.keyId, { publicKey: k.publicKey, holder: id });
  }
  // The one registry every authority publication flows through: it audits
  // publish/reject events (actor 'registry') on the shared trace at the
  // coordinator's simulated clock — a lazy read, since the coordinator is
  // constructed right after it.
  const authority = new AuthorityRegistry(keys, trace, () => coordinator.now);
  // Frozen destination routing for every known payee: the DE rail names the
  // payee's zero-limit pseudonym, the bank rail its shop provider's book.
  // An unmapped payee is a fixture error, refused loudly at admission
  // rather than stranded mid-settlement.
  const destinationFor = (payeeId: string, rail: Rail): { dePseudonym?: string; bankProvider?: string } => {
    const shop = shops.get(payeeId);
    if (shop === undefined) throw new Error(`unknown payee ${payeeId}`);
    return rail === 'digital_euro' ? { dePseudonym: pseudonyms.get(payeeId) } : { bankProvider: shop.provider };
  };
  // The trusted split-group agreements the coordinator admits — explicit
  // synthetic configuration, detached before it is handed over, so neither
  // request payloads nor later fixture edits can amend it.
  const knownSplitGroups = structuredClone(opts.knownSplitGroups ?? [COLLEAGUES_V1_GROUP]);
  // The world retains the orchestrator the coordinator's factory returns —
  // built exactly once, inside the coordinator's constructor, with the
  // bound first-handoff authority recheck.
  let settlement!: SettlementOrchestrator;
  coordinator = new Coordinator(
    (authorize) => {
      settlement = new SettlementOrchestrator({
        providers,
        owners,
        commitDeGroup: commitAcceptedDigitalEuroGroup,
        digitalEuro,
        now,
        trace,
        authorizeFirstHandoff: authorize,
      });
      return settlement;
    },
    trace,
    {
      now: 10,
      keys,
      authority,
      calendarEpoch: opts.calendarEpoch,
      disputeWindowMinutes: opts.disputeWindowMinutes,
      // Mandate capability reads the live provider flag under per-payer
      // initiation, the trusted fixture lookup under direct modes — both
      // readings come from the same fixture configuration.
      supportsMandatePaymentsFor:
        mode === 'per_payer_psp' ? (id) => providers.get(id)?.supportsMandatePayments === true : supportsMandatePaymentsFor,
      destinationFor,
      initiation:
        mode === 'per_payer_psp'
          ? { kind: 'per_payer_psp' }
          : { kind: 'direct', providerFor, allowMixedProviders: mode === 'test_bypass_psp' },
      knownSplitGroups,
    },
  );
  // The employer's initial mandate publishes through the same audited
  // registry path every later revision uses — verified at acceptance,
  // rejected visibly.
  authority.publishEmployerMandate(signPayload(m, signers.get(EMPLOYER)!));
  // The manual-only standing terms every ordinary world publishes: the
  // employee's own EUR 8 maximum, automatic payment fully off, no blocks and
  // no trusted merchants. Explicit opts replace them; null opts out.
  const employeeMandate: EmployeeMandate | null =
    opts.employeeMandate === undefined
      ? {
          mandateRef: 'employee-mandate-1',
          employeeId: EMPLOYEE,
          version: 1,
          autoPayMaxCents: 0,
          maxCents: 800,
          autoPayMonthlyCents: 0,
          trustedMerchants: [],
          blockedMerchants: [],
          allowedRails: ['digital_euro'],
          validUntil: 1_000,
          revoked: false,
        }
      : opts.employeeMandate;
  if (employeeMandate) {
    authority.publishEmployeeMandate(signPayload(employeeMandate, signers.get(employeeMandate.employeeId)!));
  }
  return {
    trace,
    settlement,
    providers,
    shops,
    shopsByProvider,
    digitalEuro,
    interbank,
    owners,
    mode,
    destinationFor,
    pseudonyms,
    coordinator,
    mandate: m,
    keys,
    signers,
    authority,
    submitPolicy: opts.submitPolicy ?? 'on_request',
    settlementMode: opts.settlementMode ?? 'atomic',
    knownSplitGroups,
  };
}

// The employer changes its mandate terms (cap, beneficiary, revocation) by
// signing and publishing the next version. Identity and version are not
// editable — passing them in changes has no effect; the revision always
// moves forward so a stale signed record cannot roll the allowance back.
export function updateMandate(w: World, changes: Partial<EmployerMandate>): void {
  const { mandateRef: _mandateRef, employerId: _employerId, version: _version, ...editable } = changes;
  // The next version follows the registry's accepted record, not the local
  // fixture copy, so an out-of-band publish on the same reference cannot
  // desync the sequence. A corrupted retained record yields a non-integer —
  // the publish then rejects it loudly rather than guessing a revision.
  const version = (w.authority.employerMandate(w.mandate.mandateRef)?.payload.version ?? w.mandate.version) + 1;
  w.mandate = { ...w.mandate, ...editable, version };
  w.authority.publishEmployerMandate(signPayload(w.mandate, w.signers.get(w.mandate.employerId)!));
}

// The employee edits their standing terms on their own device: merge the
// editable fields into the current verified record, bump the version, sign
// with the employee's key and publish to the registry. Owner and
// version are not editable — passing them in changes has no effect; the
// reference itself may move to a new value. Trusted fixture/device code,
// not an agent capability.
export function updateEmployeeMandate(w: World, changes: Partial<EmployeeMandate>, employeeId = EMPLOYEE): void {
  const current = w.authority.employeeMandate(employeeId);
  if (!current) throw new Error('no published employee mandate to update');
  const { employeeId: _employeeId, version: _version, ...editable } = changes;
  const next: EmployeeMandate = {
    ...current.payload,
    ...editable,
    employeeId: current.payload.employeeId,
    version: current.payload.version + 1,
  };
  w.authority.publishEmployeeMandate(signPayload(next, w.signers.get(current.payload.employeeId)!));
}

// The payer approves exactly the terms shown to them and signs on their own
// device. This is a privileged synthetic device fixture: it reads the raw
// purchase and computes the digest over the WHOLE ordered allocation —
// every share's role, payer, payee, rail, principal, fee and authority —
// which is not proof that a restricted payer view independently
// reconstructed every hidden share. A payer without a registered key signs
// with an unregistered one, which the coordinator rejects.
// `choice.exception` is the trusted device's explicit one-off
// acknowledgment, built from the current verified standing terms — the
// coordinator receives only the signed payload.
export function approveAs(
  w: Pick<World, 'coordinator' | 'signers'>,
  p: PurchaseView,
  payerId = EMPLOYEE,
  choice?: { exception?: boolean },
): Signed<PayerApproval> {
  const q = p.proposal;
  const a: PayerApproval = {
    approvalRef: `appr-${p.purchaseId}-v${q.version}-${payerId}`,
    purchaseId: p.purchaseId,
    payerId,
    proposalVersion: q.version,
    merchantId: q.merchantId,
    totalCents: q.totalCents,
    amountCents: approvalCents(q, payerId),
    feeCents: approvalFeeCents(q, payerId),
    // The complete-share binding: the device digests the exact ordered
    // shares — rail, payee and fee included — before signing.
    sharesDigest: sharesDigestOf(q.shares),
    // The approval echoes the proposal's frozen disclosure terms: the
    // profile, and the group reference on a known-group split only —
    // benefit approvals carry none.
    privacyProfile: q.privacy.profile,
    ...(q.privacy.source.kind === 'known_group' ? { disclosureGroupRef: q.privacy.source.groupRef } : {}),
    expiresAt: q.expiresAt,
    basis: choice?.exception ? 'exception' : 'device',
  };
  if (choice?.exception) {
    // The device reads the coordinator's verified standing terms and signs
    // the acknowledgment: the mandate revision, the acknowledged maximum and
    // the exact overage of this debit.
    const current = p.benefit && w.coordinator.employeeMandate(p.benefit.employeeId);
    if (!current) throw new Error('no verified employee mandate to acknowledge an exception against');
    const debit = approvalCents(q, payerId) + approvalFeeCents(q, payerId);
    a.exception = true;
    a.mandateRef = current.payload.mandateRef;
    a.mandateVersion = current.payload.version;
    a.maxCents = current.payload.maxCents;
    a.overByCents = debit - current.payload.maxCents;
  }
  const key = w.signers.get(payerId) ?? keyPairFromSeed(`unregistered-${payerId}`, payerId);
  const signed = signPayload(a, key);
  w.coordinator.approve(p.purchaseId, signed);
  return signed;
}

// The named party's registered signing key, or an unregistered fixture key
// when they hold none — the fallback is how a bad-signature negative is
// produced: the request signs cleanly, the coordinator still rejects it.
const signerKey = (w: Pick<World, 'signers'>, id: string): KeyPair =>
  w.signers.get(id) ?? keyPairFromSeed(`unregistered-${id}`, id);

// A world the request-signing helpers need: the coordinator, the holders'
// keys and the default submission terms signed proposals carry.
type SigningWorld = Pick<World, 'coordinator' | 'signers' | 'submitPolicy' | 'settlementMode'>;

// The employee (or an agent under their grant) proposes an employer-benefit
// purchase, signing the ProposeRequest that binds the purchase id and the
// submission terms — an unsigned transitional lunch() does not.
export function proposeAs(
  w: SigningWorld,
  input: ProposeInput & { submitPolicy?: SubmitPolicy; settlementMode?: SettlementMode; grant?: Signed<DelegationGrant> },
  by = input.employeeId,
): PurchaseView {
  const payload: ProposeRequest = {
    kind: 'propose',
    purchaseId: input.purchaseId,
    proposalVersion: 1,
    by,
    employeeId: input.employeeId,
    merchantId: input.merchantId,
    totalCents: input.totalCents,
    feesCents: input.feesCents,
    mandateRef: input.mandateRef,
    expiresAt: input.expiresAt,
    submitPolicy: input.submitPolicy ?? w.submitPolicy,
    settlementMode: input.settlementMode ?? w.settlementMode,
    privacyProfile: 'employer_benefit_v1',
    grant: input.grant,
  };
  w.coordinator.propose(signPayload(payload, signerKey(w, by)));
  return w.coordinator.view(input.purchaseId);
}

// A share as the caller names it: the device fills the funding rail for a
// share that names none — individuals pay in digital euro — so every signed
// request still carries an explicit rail per share.
type SplitShareInput =
  | (Omit<ProposerSplitRequest['shares'][number], 'rail'> & { rail?: Rail })
  | (Omit<EqualSplitRequest['shares'][number], 'rail'> & { rail?: Rail });

// A payer proposes a split purchase, signing the SplitRequest bound to the
// shares they pay into. Under 'proposer' the shares carry explicit amounts
// and the signature doubles as the proposer's approval; under 'equal_split'
// the shares name only payers and totalCents — the coordinator computes
// the amounts.
export function proposeSplitAs(
  w: SigningWorld,
  input: (
    | (Omit<ProposerSplitRequest, 'kind' | 'proposalVersion' | 'by' | 'submitPolicy' | 'settlementMode' | 'shares' | 'privacyProfile' | 'disclosureGroupRef'> & { shares: SplitShareInput[] })
    | (Omit<EqualSplitRequest, 'kind' | 'proposalVersion' | 'by' | 'submitPolicy' | 'settlementMode' | 'shares' | 'privacyProfile' | 'disclosureGroupRef'> & { shares: SplitShareInput[] })
  ) & {
    submitPolicy?: SubmitPolicy;
    settlementMode?: SettlementMode;
    // An explicit group override names a different configured agreement —
    // never searched from payer names and never auto-created. Default: the
    // fixture's own colleagues-v1 agreement only.
    disclosureGroupRef?: string;
  },
  by: string,
): PurchaseView {
  const payload = {
    ...input,
    shares: input.shares.map((s) => ({ rail: 'digital_euro' as Rail, ...s })),
    kind: 'propose_split',
    proposalVersion: 1,
    by,
    submitPolicy: input.submitPolicy ?? w.submitPolicy,
    settlementMode: input.settlementMode ?? w.settlementMode,
    privacyProfile: 'split_bill_v1',
    disclosureGroupRef: input.disclosureGroupRef ?? 'colleagues-v1',
  } as SplitRequest;
  w.coordinator.proposeSplit(signPayload(payload, signerKey(w, by)));
  return w.coordinator.view(input.purchaseId);
}

// An authorised caller — the merchant of record, the current proposer or
// the employee — signs the offer change bound to the current version.
export function changeOfferAs(
  w: SigningWorld,
  p: PurchaseView,
  offer: { merchantId: string; totalCents: Cents; expiresAt: number },
  by: string,
): OfferChange {
  const payload: ChangeOfferRequest = { kind: 'change_offer', purchaseId: p.purchaseId, proposalVersion: p.proposal.version, by, ...offer };
  return w.coordinator.changeOffer(p.purchaseId, signPayload(payload, signerKey(w, by)));
}

// A payer of the purchase signs the pre-submission cancellation bound to
// the current version.
export function cancelAs(w: SigningWorld, p: PurchaseView, by: string): void {
  const payload: CancelRequest = { kind: 'cancel', purchaseId: p.purchaseId, proposalVersion: p.proposal.version, by };
  w.coordinator.cancel(p.purchaseId, signPayload(payload, signerKey(w, by)));
}

// A payee of the purchase signs the post-completion return request bound
// to the current version; a payer's return path is dispute(), not this.
export function refundAs(w: SigningWorld, p: PurchaseView, by: string): Promise<void> {
  const payload: RefundRequest = { kind: 'refund', purchaseId: p.purchaseId, proposalVersion: p.proposal.version, by };
  return w.coordinator.refund(p.purchaseId, signPayload(payload, signerKey(w, by)));
}

// A payer of the purchase signs the submission request a caller's submit()
// requires under either policy; the settlement mode is the proposal's own,
// so this helper passes no mode.
export function submitAs(w: SigningWorld, p: PurchaseView, by: string): Promise<void> {
  const payload: SubmitRequestPayload = { kind: 'submit', purchaseId: p.purchaseId, proposalVersion: p.proposal.version, by };
  return w.coordinator.submit(p.purchaseId, signPayload(payload, signerKey(w, by)));
}

// Move the shared minute clock forward, and only forward: time is monotonic
// within a world — replaying earlier means building a fresh world, not
// rewinding reservations and deadlines. Every ledger and provider reads the
// coordinator's clock, so this moves them all.
export function advance(w: World, t: number): void {
  w.coordinator.advance(t);
}

// A presenter session wired to this world: a signed session grant for the
// agent handle (information and proposal capabilities only), the shared
// coordinator/trace/key registry, and device callbacks that sign with the
// session employee's fixture key. Scenarios and Auto presenter tests share
// this wiring; the runner itself is implemented once in session.ts. The
// catalog arrives as full synthetic offers — this helper deliberately knows
// nothing about the manual presenter fixtures.
export function createScenarioSession(
  w: World,
  opts: {
    purchaseId: string;
    catalog: readonly CatalogOffer[];
    sessionId?: string;
    agentId?: string;
    employeeId?: string;
    employeeFeeCents?: Cents;
    grantExpiresAt?: number;
  },
): PresenterSession {
  const sessionId = opts.sessionId ?? `session-${opts.purchaseId}`;
  const agentId = opts.agentId ?? 'agent-1';
  const employeeId = opts.employeeId ?? EMPLOYEE;
  const grant = signPayload(
    {
      grantRef: `grant-${opts.purchaseId}`,
      agentId,
      principalId: employeeId,
      sessionId,
      purchaseId: opts.purchaseId,
      capabilities: ['discover', 'propose', 'explain'],
      expiresAt: opts.grantExpiresAt ?? 10_000,
    } satisfies AgentGrant,
    w.signers.get(employeeId)!,
  );
  return createPresenterSession({
    sessionId,
    purchaseId: opts.purchaseId,
    agentId,
    employeeId,
    employeeFeeCents: opts.employeeFeeCents ?? 0,
    mandateRef: w.mandate.mandateRef,
    grant,
    catalog: opts.catalog,
    coordinator: w.coordinator,
    trace: w.trace,
    keys: w.keys,
    submitPolicy: 'on_request',
    settlementMode: 'atomic',
    signAsPrincipal: (payload) => signPayload(payload, w.signers.get(employeeId)!),
    signAsAgent: (payload) => signPayload(payload, w.signers.get(agentId)!),
    approveOnDevice: (p, choice) => approveAs(w, p, employeeId, choice),
    updateEmployeeMandateOnDevice: (changes, id) => updateEmployeeMandate(w, changes, id),
  });
}

// --- Automatic-payment scenario fixtures (spec §12) ------------------------
// The catalog the S19–S27 sessions share: the EUR 9 lunch at the trusted
// merchant splits EUR 4 employee + EUR 5 employer — inside the AUTO terms'
// EUR 6 per-purchase automatic limit; EUR 13 puts EUR 8 on the employee —
// over the automatic limit but inside the EUR 10 standing maximum; EUR 16
// puts EUR 11 over the maximum — a signed one-off exception or nothing.
// merchant-b is benefit-eligible but untrusted; merchant-c is the merchant
// fixture terms can block. The second lunch is a distinct offer for the
// lost-subsidy/monthly-cap scenarios.

export const OFFER_AUTO_9: CatalogOffer = {
  offerRef: 'offer-auto-9',
  merchantId: MERCHANT_A,
  title: 'Vegetarian lunch bowl',
  tags: ['lunch', 'vegetarian'],
  priceCents: 900,
  availability: { from: 0, until: 600 },
  source: 'merchant-a-menu-feed',
  walkingMinutes: 5,
};

export const OFFER_AUTO_13: CatalogOffer = {
  offerRef: 'offer-auto-13',
  merchantId: MERCHANT_A,
  title: 'Vegetarian lunch plate',
  tags: ['lunch', 'vegetarian'],
  priceCents: 1_300,
  availability: { from: 0, until: 600 },
  source: 'merchant-a-menu-feed',
  walkingMinutes: 7,
};

export const OFFER_AUTO_16: CatalogOffer = {
  offerRef: 'offer-auto-16',
  merchantId: MERCHANT_A,
  title: 'Vegetarian tasting menu',
  tags: ['lunch', 'vegetarian'],
  priceCents: 1_600,
  availability: { from: 0, until: 600 },
  source: 'merchant-a-menu-feed',
  walkingMinutes: 9,
};

// EUR 11 total: with the day's benefit already consumed it debits the
// employee EUR 11 — over the EUR 10 standing maximum, so an Exception zone
// again (S22's next-purchase check).
export const OFFER_AUTO_11: CatalogOffer = {
  offerRef: 'offer-auto-11',
  merchantId: MERCHANT_A,
  title: 'Vegetarian mezze lunch',
  tags: ['lunch', 'vegetarian'],
  priceCents: 1_100,
  availability: { from: 0, until: 600 },
  source: 'merchant-a-menu-feed',
  walkingMinutes: 6,
};

export const OFFER_AUTO_SECOND: CatalogOffer = {
  offerRef: 'offer-auto-second',
  merchantId: MERCHANT_A,
  title: 'Vegetarian pasta lunch',
  tags: ['lunch', 'vegetarian'],
  priceCents: 900,
  availability: { from: 0, until: 600 },
  source: 'merchant-a-menu-feed',
  walkingMinutes: 6,
};

export const OFFER_AUTO_NEW: CatalogOffer = {
  offerRef: 'offer-auto-new',
  merchantId: MERCHANT_B,
  title: 'Vegetarian soup and salad',
  tags: ['lunch', 'vegetarian'],
  priceCents: 900,
  availability: { from: 0, until: 600 },
  source: 'merchant-b-menu-feed',
  walkingMinutes: 6,
};

export const OFFER_AUTO_BLOCKED: CatalogOffer = {
  offerRef: 'offer-auto-blocked',
  merchantId: MERCHANT_C,
  title: 'Vegetarian wrap',
  tags: ['lunch', 'vegetarian'],
  priceCents: 900,
  availability: { from: 0, until: 600 },
  source: 'merchant-c-menu-feed',
  walkingMinutes: 4,
};

export const AUTOPAY_CATALOG: readonly CatalogOffer[] = [
  OFFER_AUTO_9,
  OFFER_AUTO_13,
  OFFER_AUTO_16,
  OFFER_AUTO_11,
  OFFER_AUTO_SECOND,
  OFFER_AUTO_NEW,
  OFFER_AUTO_BLOCKED,
];

// The fixture parameters an Auto journey may vary: initiation mode and the
// trusted mandate-capability route, plus standing-terms/allowance overrides.
// Parameterizing here — rather than in the public scenario list — keeps the
// advertised IDs canonical while tests exercise direct/per-PSP and
// capability-off variants of the same journeys.
export interface AutopayWorldOptions {
  employee?: EmployeeSeed;
  employer?: Partial<EmployerMandate>;
  employeeMandate?: EmployeeMandate | null;
  initiation?: WorldOptions['initiation'];
  supportsMandatePayments?: WorldOptions['supportsMandatePayments'];
}

// The spec §12 auto-pay world: enabled standing terms, mandate-capable
// routing and the explicit calendar epoch/window — the canonical fixture
// every S19–S27 run starts from before its own override.
export function autopayWorld(opts: AutopayWorldOptions = {}): World {
  return world(opts.employee ?? {}, opts.employer ?? {}, {
    initiation: opts.initiation,
    employeeMandate: opts.employeeMandate === undefined ? AUTO_EMPLOYEE_TERMS : opts.employeeMandate,
    supportsMandatePayments: opts.supportsMandatePayments ?? true,
    calendarEpoch: DEFAULT_CALENDAR_EPOCH,
    disputeWindowMinutes: DEFAULT_DISPUTE_WINDOW_MINUTES,
  });
}

// One session over the shared Auto catalog for the named scenario purchase.
export const autopaySession = (w: World, purchaseId: string): PresenterSession =>
  createScenarioSession(w, { purchaseId, catalog: AUTOPAY_CATALOG });

// Bounded no-tap progression: explicit runner steps until the session's
// purchase reaches the expected state. Per-PSP completion can need a second
// step — the first forwards the legs and comes back pending, the second
// reconciles them. Fail loudly when the state never arrives: a stalled run
// is a finding, not a silent wait.
export const stepToState = async (session: PresenterSession, state: PurchaseState, maxSteps = 3): Promise<void> => {
  for (let i = 0; i < maxSteps; i++) {
    const v = await session.runner.step();
    if (v.value.payer.state === state) return;
  }
  throw new Error(`runner steps did not reach ${state} within ${maxSteps}`);
};

// The reference purchase: a EUR 13 lunch at merchant-a with the employee's
// standing instruction capped at EUR 8 — which is what makes the split
// EUR 8 employee + EUR 5 employer. The employee signs the proposal under
// the world's default submission terms unless opts override them.
export function lunch(
  w: World,
  total = 1_300,
  merchantId = MERCHANT_A,
  opts: { purchaseId?: string; expiresAt?: number; feesCents?: number; submitPolicy?: SubmitPolicy; settlementMode?: SettlementMode } = {},
): PurchaseView {
  return proposeAs(w, {
    purchaseId: opts.purchaseId ?? 'purchase-1',
    employeeId: EMPLOYEE,
    merchantId,
    totalCents: total,
    feesCents: opts.feesCents,
    mandateRef: w.mandate.mandateRef,
    expiresAt: opts.expiresAt ?? 100,
    submitPolicy: opts.submitPolicy,
    settlementMode: opts.settlementMode,
  });
}

// The research questions of docs/experiment-protocol.md.
export const QUESTIONS = {
  Q1: 'Unambiguous completion state',
  Q2: 'One contribution fails, expires or loses authority',
  Q3: 'References for reconciliation and returns',
} as const;
export type QuestionId = keyof typeof QUESTIONS;

// Each run() builds a fresh world, drives one purchase through its success or
// failure path, and returns both so the CLI can print the trace and tests can
// assert on final balances. check() states the observation the scenario must
// show; the findings table reports it as observed/pass or observed/fail.
export interface Scenario {
  id: string;
  title: string;
  question: QuestionId;
  // What application code had to do, as shown by the local run.
  responsibility: string;
  check: (r: { w: World; p: PurchaseView }) => string | undefined;
  run: () => Promise<{ w: World; p: PurchaseView }>;
}

export const expectState = (p: PurchaseView, state: PurchaseState): string | undefined =>
  p.state === state ? undefined : `state ${p.state}, expected ${state}`;
const stateHistory = (w: World): unknown[] => w.trace.events.filter((e) => e.event === 'state').map((e) => e.detail?.to);

// True when every coordinator send in the run followed the last recorded
// non-mandate authorization — no send ran while the purchase's only
// evidence was stale or mandate-based (S24). Checking every 'submit' event
// rather than counting one send keeps the guarantee for runs whose runner
// or reconcile path may produce further submissions.
const sentOnlyAfterApproval = (w: World): boolean => {
  const submits = w.trace.events.filter((e) => e.event === 'submit' && e.actor === 'coordinator');
  const lastManual = Math.max(
    0,
    ...w.trace.events.filter((e) => e.event === 'approval_recorded' && e.detail?.basis !== 'mandate').map((e) => e.seq),
  );
  return submits.length > 0 && lastManual > 0 && submits.every((e) => e.seq > lastManual);
};

export const scenarios: Scenario[] = [
  {
    id: 'S01-both-approve',
    title: 'Both authorities hold: EUR 8 on digital euro + EUR 5 by bank, reserved then committed across two ledgers',
    question: 'Q1',
    responsibility: 'Bind the approval to the proposal version; derive completion only from every leg settled',
    check: ({ p }) => expectState(p, 'completed'),
    run: async () => {
      const w = world();
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S02-employee-reverse-waterfall',
    title: 'Employee holds EUR 3; reverse waterfall funds the rest of the EUR 8 share',
    question: 'Q1',
    responsibility: 'None beyond S01: the reverse waterfall is provider funding work during reserve',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (w.trace.events.some((e) => e.event === 'provider_bank_debited' && e.detail?.customerId === EMPLOYEE) ? undefined : 'no reverse waterfall'),
    run: async () => {
      // EUR 3 in holdings: the remaining EUR 5 of the employee share is pulled
      // from the linked bank account by the reverse waterfall.
      const w = world({ deCents: 300 });
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S03-bill-split',
    title: 'Three colleagues split a EUR 40 dinner: EUR 13.34 + 13.33 + 13.33 commit as one digital-euro group',
    question: 'Q1',
    responsibility: 'Split in integer cents with a fixed remainder rule; complete only when every payer approved and every leg settled',
    check: ({ p }) => expectState(p, 'completed'),
    run: async () => {
      const w = world();
      const payers = [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2];
      const p = proposeSplitAs(
        w,
        {
          purchaseId: 'purchase-1',
          merchantId: MERCHANT_B,
          amountsFrom: 'equal_split',
          totalCents: 4_000,
          expiresAt: 100,
          shares: payers.map((payerId, i) => ({ role: `diner-${i + 1}`, payerId })),
        },
        EMPLOYEE,
      );
      for (const id of payers) approveAs(w, p, id);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S04-per-psp-atomic',
    title: "The employer's provider is down at submission: the employee's digital-euro hold waits, the purchase passes through pending, and completes when the provider recovers",
    question: 'Q1',
    responsibility: "Keep an open reserve 'pending' while a payer's provider is down; resume the frozen intent under its original keys and reconcile before reporting completion",
    check: ({ w, p }) => expectState(p, 'completed') ?? (stateHistory(w).includes('pending') ? undefined : 'never pending'),
    run: async () => {
      const w = world();
      // The employer's provider is down when submission starts: its reserve
      // is conclusively not handed off and stays 'pending' — never a
      // refusal — while the employee leg's digital-euro hold is accepted.
      w.providers.get(EMPLOYER)!.available = false;
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      // The provider recovers: the replay resumes the same intent under its
      // original keys — the employer reserve rechecks live authority at its
      // first handoff — and reconcile reports the completed purchase.
      w.providers.get(EMPLOYER)!.available = true;
      await w.coordinator.resubmit(p.purchaseId);
      await w.coordinator.reconcile(p.purchaseId);
      return { w, p };
    },
  },
  {
    id: 'S05-partial-failure-independent',
    title: 'Two-payment baseline: employer leg settles, employee leg fails, recovery returns EUR 5',
    question: 'Q2',
    responsibility: 'Detect partial success, keep the EUR 5 outstanding visible, return it to the employer before cancelling',
    check: ({ w, p }) => expectState(p, 'cancelled') ?? (stateHistory(w).includes('recovery_required') ? undefined : 'never entered recovery'),
    run: async () => {
      // EUR 3 in holdings and no reverse waterfall: the employee leg cannot
      // fund its EUR 8 share, but the employer leg still settles.
      const w = world({ deCents: 300, reverseWaterfall: false });
      const p = lunch(w, 1_300, MERCHANT_A, { settlementMode: 'independent' });
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      await w.coordinator.recover(p.purchaseId);
      return { w, p };
    },
  },
  {
    id: 'S06-partial-failure-atomic',
    title: 'Same failure with atomic multi-payer settlement: nothing moves, no recovery needed',
    question: 'Q2',
    responsibility: 'None: atomic settlement leaves nothing committed to recover',
    check: ({ w, p }) => expectState(p, 'failed') ?? (w.coordinator.outstandingCents(p.purchaseId) === 0 ? undefined : 'money outstanding'),
    run: async () => {
      // Same funding hole as S05; the settlement mode is the only difference.
      const w = world({ deCents: 300, reverseWaterfall: false });
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S07-recovery-unsupported',
    title: 'Partial failure where returns are unsupported: outstanding EUR 5 stays visible',
    question: 'Q2',
    responsibility: 'Keep the purchase in recovery with the outstanding amount visible when no return operation exists',
    check: ({ w, p }) => expectState(p, 'recovery_required') ?? (w.coordinator.outstandingCents(p.purchaseId) === 500 ? undefined : 'outstanding is not EUR 5'),
    run: async () => {
      // Same failure as S05, on a provider that has no return operation.
      const w = world({ deCents: 300, reverseWaterfall: false });
      w.providers.get(EMPLOYER)!.returnsSupported = false;
      const p = lunch(w, 1_300, MERCHANT_A, { settlementMode: 'independent' });
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      await w.coordinator.recover(p.purchaseId);
      return { w, p };
    },
  },
  {
    id: 'S08-employer-authority-expired',
    title: 'Employer mandate expires between approval and initiation: no leg executes, EUR 8 share unchanged',
    question: 'Q2',
    responsibility: 'Recheck employer authority at initiation and stop without raising the employee share',
    check: ({ w, p }) =>
      expectState(p, 'failed') ??
      (payeeBankCents(w, MERCHANT_A) === 0 && shareCents(p.proposal, 'employee') === 800 ? undefined : 'executed or share changed'),
    run: async () => {
      // The mandate is valid only until t=15.
      const w = world({}, { validUntil: 15 });
      const p = lunch(w);
      approveAs(w, p);
      // t=20: authority expired between approval and initiation.
      advance(w, 20);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S09-offer-changed',
    title: 'Offer A expires; B costs EUR 14 (EUR 9 personal) so approval lapses; employee picks C at EUR 13',
    question: 'Q2',
    responsibility: 'Version proposals, invalidate approvals on any change, require renewed approval',
    check: ({ p }) => expectState(p, 'completed') ?? (p.proposal.version === 3 ? undefined : `version ${p.proposal.version}`),
    run: async () => {
      const w = world();
      const p = lunch(w);
      approveAs(w, p);
      // Offer B costs EUR 14: the employer still contributes EUR 5, so EUR 9
      // would fall to the employee — above their EUR 8 instruction. The
      // merchant of record signs the reprice; it invalidates the v1 approval
      // and the purchase stays in draft.
      changeOfferAs(w, p, { merchantId: MERCHANT_B, totalCents: 1_400, expiresAt: 100 }, MERCHANT_A);
      // The employee picks offer C at EUR 13 instead and re-approves v3.
      changeOfferAs(w, p, { merchantId: MERCHANT_C, totalCents: 1_300, expiresAt: 100 }, EMPLOYEE);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S10-second-meal-same-day',
    title: 'Second lunch on the same working day: no employer share, EUR 13 needs a signed exception',
    question: 'Q2',
    responsibility: 'Track benefit use per mandate and day; leave the decision to pay more with the employee',
    check: ({ p }) =>
      expectState(p, 'awaiting_approvals') ??
      (shareCents(p.proposal, 'employer') === 0 ? undefined : 'employer still contributes') ??
      (p.employeeAssessment?.authZone === 'Exception' ? undefined : 'not in Exception'),
    run: async () => {
      const w = world();
      // The first lunch completes and uses the day's subsidised meal.
      const first = lunch(w);
      approveAs(w, first);
      await submitAs(w, first, EMPLOYEE);
      // A second lunch the same day gets no employer share; EUR 13 is above
      // the standing EUR 8 maximum, so it awaits a signed one-off exception.
      const p = lunch(w, 1_300, MERCHANT_A, { purchaseId: 'purchase-2' });
      return { w, p };
    },
  },
  {
    id: 'S11-employer-declines',
    title: "Employer's PSP declines its leg: atomic group rejected, employee is not charged EUR 13",
    question: 'Q2',
    responsibility: 'Never re-split a declined employer share onto the employee',
    check: ({ w, p }) => expectState(p, 'failed') ?? (payerDeCents(w, EMPLOYEE) === 2_000 ? undefined : 'employee charged'),
    run: async () => {
      const w = world();
      // The employer's provider declines its leg at reserve; atomic mode
      // must release the employee's accepted hold rather than charge them.
      w.providers.get(EMPLOYER)!.setFault(legChildKey('purchase-1', 1, 'employer', 'hold', 'bank'), 'hold', 'reject_before_effect');
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S12-group-gift-decline',
    title: "Group gift EUR 25: one colleague's PSP declines; the atomic group is rejected and nobody covers the missing EUR 5",
    question: 'Q2',
    responsibility: 'Never re-split a declined share across the remaining payers; a new split needs a new proposal and approvals',
    check: ({ w, p }) =>
      expectState(p, 'failed') ??
      (payerDeCents(w, EMPLOYEE) === 2_000 && payerDeCents(w, COLLEAGUE_1) === 2_000 ? undefined : 'a remaining payer was charged'),
    run: async () => {
      const w = world();
      w.providers.get(COLLEAGUE_2)!.setFault(legChildKey('purchase-1', 1, 'giver-3', 'hold', w.pseudonyms.get(MERCHANT_C)!), 'hold', 'reject_before_effect');
      // The employee proposes explicit shares: their signature over the
      // terms doubles as their own approval; the colleagues approve theirs.
      const p = proposeSplitAs(
        w,
        {
          purchaseId: 'purchase-1',
          merchantId: MERCHANT_C,
          amountsFrom: 'proposer',
          expiresAt: 100,
          shares: [
            { role: 'giver-1', payerId: EMPLOYEE, amountCents: 1_000 },
            { role: 'giver-2', payerId: COLLEAGUE_1, amountCents: 1_000 },
            { role: 'giver-3', payerId: COLLEAGUE_2, amountCents: 500 },
          ],
        },
        EMPLOYEE,
      );
      for (const id of [COLLEAGUE_1, COLLEAGUE_2]) approveAs(w, p, id);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S13-per-psp-employer-psp-down',
    title: "Employer's provider is unavailable, then declines: the employee's hold is released and its funding restored — nothing settles",
    question: 'Q2',
    responsibility: 'Keep the open reserve pending while the provider is down; on a conclusive refusal release holds and restore funding before reporting failed',
    check: ({ w, p }) =>
      expectState(p, 'failed') ??
      (payerDeCents(w, EMPLOYEE) === 2_000 && settlementOf(w, p.purchaseId)?.cleanupConfirmed === true ? undefined : 'employee charged or cleanup unresolved'),
    run: async () => {
      const w = world();
      w.providers.get(EMPLOYER)!.available = false;
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      // The provider returns but declines the reserve: the conclusive
      // refusal stops new work and unwinds the employee's accepted hold.
      w.providers.get(EMPLOYER)!.available = true;
      w.providers.get(EMPLOYER)!.setFault(legChildKey('purchase-1', 1, 'employer', 'hold', 'bank'), 'hold', 'reject_before_effect');
      await w.coordinator.reconcile(p.purchaseId);
      return { w, p };
    },
  },
  {
    id: 'S14-per-psp-independent-down',
    title: "Two-payment baseline with the employer's provider refusing: the employee's EUR 8 settles alone and is returned",
    question: 'Q2',
    responsibility: 'Return the settled employee leg; never ask the employee to cover the employer share',
    check: ({ w, p }) =>
      expectState(p, 'cancelled') ??
      (stateHistory(w).includes('recovery_required') && payerDeCents(w, EMPLOYEE) === 2_000 ? undefined : 'employee not made whole'),
    run: async () => {
      const w = world();
      // The employer's provider is down at submission — its reserve stays
      // open while the employee leg settles — then declines conclusively.
      w.providers.get(EMPLOYER)!.available = false;
      const p = lunch(w, 1_300, MERCHANT_A, { settlementMode: 'independent' });
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      w.providers.get(EMPLOYER)!.available = true;
      w.providers.get(EMPLOYER)!.setFault(legChildKey('purchase-1', 1, 'employer', 'hold', 'bank'), 'hold', 'reject_before_effect');
      await w.coordinator.reconcile(p.purchaseId);
      await w.coordinator.recover(p.purchaseId);
      return { w, p };
    },
  },
  {
    id: 'S15-duplicate-request',
    title: 'Submission retried with the same keys: no duplicate execution',
    question: 'Q3',
    responsibility: 'Keep idempotency keys stable across retries; never mint new keys to retry',
    check: ({ w, p }) => expectState(p, 'completed') ?? (payeeBankCents(w, MERCHANT_A) === 1_300 ? undefined : 'duplicate execution'),
    run: async () => {
      const w = world();
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      // Same intent and keys: the orchestrator dedupes and still runs
      // exactly one execution per leg.
      await w.coordinator.resubmit(p.purchaseId);
      return { w, p };
    },
  },
  {
    id: 'S16-timeout-unknown',
    title: 'Response lost: purchase stays pending, retry is deduplicated, status query resolves it',
    question: 'Q3',
    responsibility: 'Treat a lost response as pending; resolve it only through status queries',
    check: ({ w, p }) => expectState(p, 'completed') ?? (stateHistory(w).includes('pending') ? undefined : 'never pending'),
    run: async () => {
      const w = world();
      // The employer leg's transfer response is lost after its effect: the
      // commit is 'unknown' until an authoritative status query resolves it.
      w.providers.get(EMPLOYER)!.setFault(legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a'), 'credit', 'lose_response_after_effect');
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      await w.coordinator.resubmit(p.purchaseId);
      await w.coordinator.reconcile(p.purchaseId);
      return { w, p };
    },
  },
  {
    id: 'S17-refund-holding-limit',
    title: 'Full refund: EUR 8 to employee (excess over holding limit waterfalls to bank), EUR 5 to employer',
    question: 'Q3',
    responsibility: 'Keep one execution reference per contribution to return each share to its own payer',
    check: ({ p }) => (p.returnStatus === 'completed' ? undefined : `returns ${p.returnStatus}`),
    run: async () => {
      const w = world({ deCents: 299_800 });
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      // Other payments leave the employee at EUR 2,999 of the EUR 3,000
      // holding limit: of the EUR 8 refund only EUR 1 fits in holdings and
      // EUR 7 waterfalls to the bank.
      w.digitalEuro.fund({
        key: 's17-topup',
        provider: w.providers.get(EMPLOYEE)!.provider,
        pseudonym: w.pseudonyms.get(EMPLOYEE)!,
        amountCents: 900,
      });
      await refundAs(w, p, MERCHANT_A);
      return { w, p };
    },
  },
  {
    id: 'S18-multi-payee',
    title: 'One payer, two payees: a EUR 15 order pays EUR 12.50 to the restaurant and EUR 2.50 to the delivery platform',
    question: 'Q3',
    responsibility: 'Approve one total; keep one execution reference per payee leg so each can be reconciled and returned on its own',
    check: ({ w, p }) => expectState(p, 'completed') ?? (payeeBankCents(w, PLATFORM) === 250 ? undefined : 'platform not paid'),
    run: async () => {
      const w = world();
      // The only payer is the proposer: their signature over the explicit
      // shares is the purchase's whole approval — it is ready at proposal.
      const p = proposeSplitAs(
        w,
        {
          purchaseId: 'purchase-1',
          merchantId: MERCHANT_A,
          amountsFrom: 'proposer',
          expiresAt: 100,
          shares: [
            { role: 'restaurant', payerId: EMPLOYEE, payeeId: MERCHANT_A, amountCents: 1_250 },
            { role: 'delivery', payerId: EMPLOYEE, payeeId: PLATFORM, amountCents: 250 },
          ],
        },
        EMPLOYEE,
      );
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  // S19–S27: employee standing terms and automatic payment (spec §12). The
  // canonical runs use the auto-pay world (enabled AUTO terms + capable
  // route); every purchase advances through a presenter session — agent
  // selection, trusted runner steps and the trusted user flow — never a
  // hidden approveAs()+submit shortcut. `p` is the session's detached
  // snapshot.
  {
    id: 'S19-autopay-within',
    title: 'Standing terms pay EUR 4 automatically: the runner settles with no tap and issues one receipt',
    question: 'Q1',
    responsibility: 'Record mandate evidence at selection; submit it on a trusted step; issue exactly one receipt with a fixed dispute deadline',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (p.receipt && p.receipt.mandateVersion === 1 && p.receipt.disputeUntil === 1_450 && p.receipt.debitCents === 400
        ? undefined
        : 'missing or incorrect receipt') ??
      (w.trace.events.filter((e) => e.event === 'autopay_receipt').length === 1 ? undefined : 'receipt not emitted exactly once') ??
      (w.trace.events.some((e) => e.event === 'autopay_consumed' && e.detail?.cents === 400 && e.detail?.month === '2026-01')
        ? undefined
        : 'automatic debit not consumed') ??
      (!w.trace.events.some(
        (e) => e.event === 'presenter_approve' || (e.event === 'approval_recorded' && e.detail?.basis !== 'mandate'),
      )
        ? undefined
        : 'a device signature funded it') ??
      (payerDeCents(w, EMPLOYEE) === 1_600 &&
      payerBankCents(w, EMPLOYER) === 99_500 &&
      payeeBankCents(w, MERCHANT_A) === 900
        ? undefined
        : 'balances wrong'),
    run: async () => {
      const w = autopayWorld();
      const session = autopaySession(w, 'purchase-1');
      session.agent.selectOffer(OFFER_AUTO_9.offerRef);
      await stepToState(session, 'completed');
      return { w, p: session.userFlow.snapshot() };
    },
  },
  {
    id: 'S20-autopay-new-merchant',
    title: 'Eligible but untrusted merchant needs a tap: Confirm, a device signature settles, no terms change',
    question: 'Q2',
    responsibility: 'Stop automatic payment at the signed trusted list; require ordinary device authority; publish nothing until the employee signs a change',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (w.trace.events.some(
        (e) => e.event === 'auth_zone' && e.detail?.purchaseId === 'purchase-1' && e.detail?.reason === 'untrusted_merchant',
      )
        ? undefined
        : 'untrusted_merchant reason missing') ??
      (p.authorizations.some((a) => a.basis === 'device') ? undefined : 'no device authorization') ??
      (!w.trace.events.some((e) => e.event.startsWith('autopay_')) ? undefined : 'automatic accounting appeared') ??
      // A trust suggestion changes nothing by itself: the standing terms are
      // still the setup revision and merchant-b stays untrusted.
      (w.trace.events.filter((e) => e.event === 'employee_mandate_published').length === 1 &&
      w.coordinator.employeeMandate(EMPLOYEE)!.payload.trustedMerchants.join() === MERCHANT_A
        ? undefined
        : 'standing terms changed') ??
      (payerDeCents(w, EMPLOYEE) === 1_600 && payerBankCents(w, EMPLOYER) === 99_500
        ? undefined
        : 'balances wrong'),
    run: async () => {
      const w = autopayWorld();
      const session = autopaySession(w, 'purchase-1');
      session.agent.selectOffer(OFFER_AUTO_NEW.offerRef);
      // A step never dispatches a manual purchase: still awaiting the tap.
      await session.runner.step();
      session.userFlow.approve(1);
      await session.userFlow.submit(1);
      return { w, p: session.userFlow.snapshot() };
    },
  },
  {
    id: 'S21-autopay-over-auto',
    title: 'EUR 8 debit exceeds the EUR 6 automatic limit: Confirm for over_auto_limit; a tap settles it',
    question: 'Q2',
    responsibility: 'Distinguish the per-purchase automatic limit from the monthly cap and route capability; fall back to ordinary approval',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (p.employeeAssessment?.autoPayBlockedReason === 'over_auto_limit' ? undefined : 'wrong blocked reason') ??
      (p.authorizations.some((a) => a.basis === 'device') ? undefined : 'no device authorization') ??
      (!w.trace.events.some((e) => e.event.startsWith('autopay_')) ? undefined : 'automatic accounting appeared') ??
      (payerDeCents(w, EMPLOYEE) === 1_200 && payerBankCents(w, EMPLOYER) === 99_500
        ? undefined
        : 'balances wrong'),
    run: async () => {
      const w = autopayWorld();
      const session = autopaySession(w, 'purchase-1');
      session.agent.selectOffer(OFFER_AUTO_13.offerRef);
      session.userFlow.approve(1);
      await session.userFlow.submit(1);
      return { w, p: session.userFlow.snapshot() };
    },
  },
  {
    id: 'S22-exception-one-euro',
    title: 'EUR 11 over the EUR 10 maximum: a plain signature is refused; a signed EUR 1 exception pays once',
    question: 'Q2',
    responsibility: 'Reject a plain approval over the standing maximum; honor only the signed exception acknowledgment; leave standing terms and the automatic budget untouched',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (p.authorizations.some((a) => a.basis === 'exception' && a.approval.payload.overByCents === 100)
        ? undefined
        : 'no signed EUR 1 exception') ??
      (w.trace.events.some((e) => e.event === 'approval_rejected' && e.detail?.reason === 'exceeds_mandate')
        ? undefined
        : 'the plain approval was not refused') ??
      // The next purchase still uses the EUR 10 maximum: the day's benefit is
      // consumed, so its EUR 11 fully personal debit is Exception again.
      (w.trace.events.some(
        (e) =>
          e.event === 'auth_zone' &&
          e.detail?.purchaseId === 'purchase-2' &&
          e.detail?.authZone === 'Exception' &&
          e.detail?.employeeDebitCents === 1_100,
      )
        ? undefined
        : 'the next purchase did not reuse the EUR 10 maximum') ??
      (w.coordinator.employeeMandate(EMPLOYEE)!.payload.maxCents === 1_000 ? undefined : 'the standing maximum changed') ??
      (!w.trace.events.some((e) => e.event.startsWith('autopay_')) ? undefined : 'automatic usage changed') ??
      (payerDeCents(w, EMPLOYEE) === 900 && payerBankCents(w, EMPLOYER) === 99_500
        ? undefined
        : 'balances wrong'),
    run: async () => {
      const w = autopayWorld();
      const session = autopaySession(w, 'purchase-1');
      session.agent.selectOffer(OFFER_AUTO_16.offerRef);
      // A plain signature is not authority above the standing maximum.
      let refused = false;
      try {
        session.userFlow.approve(1);
      } catch {
        refused = true; // approval_rejected: exceeds_mandate — the trace shows it
      }
      if (!refused) throw new Error('a plain over-limit approval was accepted');
      session.userFlow.approve(1, { exception: true });
      await session.userFlow.submit(1);
      // A next purchase proposes under the unchanged EUR 10 maximum — like
      // S23/S25 through its own session: its EUR 11 debit (no benefit left
      // that day) is Exception again.
      const s2 = autopaySession(w, 'purchase-2');
      s2.agent.selectOffer(OFFER_AUTO_11.offerRef);
      return { w, p: session.userFlow.snapshot() };
    },
  },
  {
    id: 'S23-monthly-cap',
    title: 'EUR 6 monthly automatic budget: the second EUR 4 lunch needs a tap for monthly_cap alone',
    question: 'Q2',
    responsibility: 'Share one monthly budget across purchases; fall back to ordinary approval without touching automatic usage',
    check: ({ w, p }) =>
      // p is the second purchase: kept its EUR 5 benefit, Confirm solely for
      // the monthly cap, and paid manually without new automatic usage.
      expectState(p, 'completed') ??
      (p.employeeAssessment?.autoPayBlockedReason === 'monthly_cap' ? undefined : 'the second lunch was not capped') ??
      (shareCents(p.proposal, 'employer') === 500 ? undefined : 'the second lunch lost its employer share') ??
      (p.authorizations.some((a) => a.basis === 'device') ? undefined : 'the second lunch paid without a device signature') ??
      (w.trace.events.filter((e) => e.event === 'autopay_reserved').length === 1 &&
      w.trace.events.filter((e) => e.event === 'autopay_consumed').length === 1
        ? undefined
        : 'the manual payment touched automatic usage') ??
      (!w.trace.events.some((e) => e.event.startsWith('autopay_') && e.detail?.purchaseId === 'purchase-2')
        ? undefined
        : 'the second lunch booked automatic usage') ??
      (payerDeCents(w, EMPLOYEE) === 1_200 && payerBankCents(w, EMPLOYER) === 99_000
        ? undefined
        : 'balances wrong'),
    run: async () => {
      // Monthly cap EUR 6; the employer's daily allowance is widened to two
      // purchases/EUR 10 so the second lunch keeps its EUR 5 benefit and the
      // monthly budget alone decides.
      const w = autopayWorld({
        employeeMandate: { ...AUTO_EMPLOYEE_TERMS, autoPayMonthlyCents: 600 },
        employer: { maxPurchasesPerDay: 2, maxPerDayCents: 1_000 },
      });
      const s1 = autopaySession(w, 'purchase-1');
      s1.agent.selectOffer(OFFER_AUTO_9.offerRef);
      await stepToState(s1, 'completed');
      // EUR 4 more would exceed the cap — EUR 2 automatic budget is left.
      const s2 = autopaySession(w, 'purchase-2');
      s2.agent.selectOffer(OFFER_AUTO_SECOND.offerRef);
      s2.userFlow.approve(1);
      await s2.userFlow.submit(1);
      return { w, p: s2.userFlow.snapshot() };
    },
  },
  {
    id: 'S24-offer-change-leaves-auto',
    title: 'Replacing the offer before the step drops Auto authority: the EUR 8 proposal waits for a tap',
    question: 'Q2',
    responsibility: 'Invalidate mandate evidence on an offer change; never send under the stale authorization; wait for ordinary approval',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (p.proposal.version === 2 ? undefined : `version ${p.proposal.version}`) ??
      (p.authorizations.some((a) => a.basis === 'device') ? undefined : 'no device authorization') ??
      (w.trace.events.some((e) => e.event === 'approval_invalidated' && e.detail?.basis === 'mandate')
        ? undefined
        : 'the mandate evidence was not invalidated') ??
      (w.trace.events.some(
        (e) =>
          e.event === 'auth_zone' &&
          e.detail?.proposalVersion === 2 &&
          e.detail?.authZone === 'Confirm' &&
          e.detail?.reason === 'over_auto_limit',
      )
        ? undefined
        : 'v2 was not Confirm/over_auto_limit') ??
      // The only submission follows the v2 device approval — nothing was
      // sent while the evidence was invalidated.
      (sentOnlyAfterApproval(w) ? undefined : 'a send ran before renewed authority') ??
      (!w.trace.events.some((e) => e.event.startsWith('autopay_')) ? undefined : 'automatic accounting appeared'),
    run: async () => {
      const w = autopayWorld();
      const session = autopaySession(w, 'purchase-1');
      session.agent.selectOffer(OFFER_AUTO_9.offerRef); // v1: Auto-authorized
      // The offer changes before the runner steps: EUR 8 debit needs a tap.
      session.agent.selectOffer(OFFER_AUTO_13.offerRef);
      await session.runner.step(); // stays awaiting — no dispatch under stale evidence
      session.userFlow.approve(2);
      await session.userFlow.submit(2);
      return { w, p: session.userFlow.snapshot() };
    },
  },
  {
    id: 'S25-employer-share-lost-auto',
    title: 'Second lunch without subsidy: EUR 9 fully personal is Confirm; the EUR 13 variant is Exception',
    question: 'Q2',
    responsibility: 'Evaluate each purchase against the daily allowance; never reprice the first purchase to fund the second',
    check: ({ w, p }) =>
      // p is the second purchase, repriced to the EUR 13 variant.
      expectState(p, 'awaiting_approvals') ??
      (p.proposal.version === 2 && shareCents(p.proposal, 'employer') === 0 ? undefined : 'unexpected proposal') ??
      (p.employeeAssessment?.authZone === 'Exception' ? undefined : 'the EUR 13 variant was not Exception') ??
      (w.trace.events.some(
        (e) =>
          e.event === 'auth_zone' &&
          e.detail?.purchaseId === 'purchase-2' &&
          e.detail?.proposalVersion === 1 &&
          e.detail?.authZone === 'Confirm' &&
          e.detail?.reason === 'over_auto_limit' &&
          e.detail?.employeeDebitCents === 900,
      )
        ? undefined
        : 'the EUR 9 second lunch was not Confirm') ??
      // The completed first purchase was never repriced: one v1 assessment,
      // one receipt for the original EUR 9/EUR 5 split.
      (w.trace.events.every(
        (e) => e.event !== 'auth_zone' || e.detail?.purchaseId !== 'purchase-1' || e.detail?.proposalVersion === 1,
      )
        ? undefined
        : 'the first purchase was repriced') ??
      (w.trace.events.some(
        (e) =>
          e.event === 'autopay_receipt' &&
          e.detail?.purchaseId === 'purchase-1' &&
          e.detail?.totalCents === 900 &&
          e.detail?.employerCents === 500,
      )
        ? undefined
        : 'the first purchase changed') ??
      (payerDeCents(w, EMPLOYEE) === 1_600 &&
      payerBankCents(w, EMPLOYER) === 99_500 &&
      payeeBankCents(w, MERCHANT_A) === 900
        ? undefined
        : 'balances wrong'),
    run: async () => {
      const w = autopayWorld();
      const s1 = autopaySession(w, 'purchase-1');
      s1.agent.selectOffer(OFFER_AUTO_9.offerRef);
      await stepToState(s1, 'completed');
      // A distinct EUR 9 lunch the same day: the one-meal allowance is used,
      // so EUR 9 falls fully on the employee — Confirm under the EUR 10 max.
      const s2 = autopaySession(w, 'purchase-2');
      s2.agent.selectOffer(OFFER_AUTO_SECOND.offerRef);
      // The EUR 13 second-lunch variant needs a signed one-off exception.
      s2.agent.selectOffer(OFFER_AUTO_13.offerRef);
      return { w, p: s2.userFlow.snapshot() };
    },
  },
  {
    id: 'S26-blocked-merchant',
    title: 'Selecting the blocked merchant is refused: the retained proposal is unchanged and nothing is paid',
    question: 'Q2',
    responsibility: 'Reject a blocked offer before it replaces a valid proposal; no exception can authorize a blocked merchant',
    check: ({ w, p }) =>
      // p is the retained proposal at the allowed but untrusted merchant B.
      expectState(p, 'awaiting_approvals') ??
      (p.proposal.version === 1 && p.proposal.merchantId === MERCHANT_B ? undefined : 'the prior proposal changed') ??
      (p.authorizations.length === 0 ? undefined : 'an authorization exists') ??
      (w.trace.events.some(
        (e) => e.event === 'proposal_rejected' && e.detail?.reason === 'blocked_merchant' && e.detail?.merchantId === MERCHANT_C,
      )
        ? undefined
        : 'the blocked rejection was not recorded') ??
      (payeeBankCents(w, MERCHANT_C) === 0 && payeeBankCents(w, MERCHANT_B) === 0 ? undefined : 'a payment was sent'),
    run: async () => {
      const w = autopayWorld({ employeeMandate: { ...AUTO_EMPLOYEE_TERMS, blockedMerchants: [MERCHANT_C] } });
      const session = autopaySession(w, 'purchase-1');
      // First select the allowed but untrusted merchant B: the retained
      // proposal awaits confirmation with no authorization recorded.
      session.agent.selectOffer(OFFER_AUTO_NEW.offerRef);
      // The blocked replacement is refused outright — no new proposal, no
      // authorization, no payment; an exception cannot override a block.
      let refused = false;
      try {
        session.agent.selectOffer(OFFER_AUTO_BLOCKED.offerRef);
      } catch {
        refused = true; // proposal_rejected: blocked_merchant — the trace shows it
      }
      if (!refused) throw new Error('a blocked-merchant selection was accepted');
      return { w, p: session.userFlow.snapshot() };
    },
  },
  {
    id: 'S27-psp-no-mandate',
    title: 'Route without mandate capability: the otherwise eligible Auto purchase waits for a device signature',
    question: 'Q2',
    responsibility: 'Require routed PSP capability for automatic payment; fall back to ordinary approval without automatic evidence or accounting',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (p.employeeAssessment?.autoPayBlockedReason === 'psp_unsupported' ? undefined : 'not refused for capability') ??
      (p.authorizations.some((a) => a.basis === 'device') ? undefined : 'no device authorization') ??
      (!w.trace.events.some((e) => e.event.startsWith('autopay_')) &&
      !w.trace.events.some((e) => e.event === 'approval_recorded' && e.detail?.basis === 'mandate')
        ? undefined
        : 'automatic evidence or accounting appeared') ??
      (payerDeCents(w, EMPLOYEE) === 1_600 && payerBankCents(w, EMPLOYER) === 99_500
        ? undefined
        : 'balances wrong'),
    run: async () => {
      // Capability false on the employee's route; the terms are otherwise
      // fully eligible for automatic payment.
      const w = autopayWorld({ supportsMandatePayments: false });
      const session = autopaySession(w, 'purchase-1');
      session.agent.selectOffer(OFFER_AUTO_9.offerRef);
      await session.runner.step(); // a step never invents a manual dispatch
      session.userFlow.approve(1);
      await session.userFlow.submit(1);
      return { w, p: session.userFlow.snapshot() };
    },
  },
  {
    id: 'S28-autopay-dispute',
    title: 'Disputing the automatic purchase returns EUR 4 + EUR 5 and releases the monthly budget once',
    question: 'Q3',
    responsibility: 'Open a dispute only inside the receipt window; return each share to its original payer; release the booking on the confirmed return',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (p.returnStatus === 'completed' ? undefined : `returns ${p.returnStatus}`) ??
      (p.dispute?.outcome === 'returned' ? undefined : 'dispute did not reach returned') ??
      (w.trace.events.filter((e) => e.event === 'dispute_opened').length === 1 ? undefined : 'dispute_opened count wrong') ??
      (w.trace.events.filter((e) => e.event === 'autopay_released').length === 1 &&
      w.trace.events.some((e) => e.event === 'autopay_released' && e.detail?.cents === 400 && e.detail?.retainedCents === 0)
        ? undefined
        : 'the booking was not released exactly once') ??
      (payerDeCents(w, EMPLOYEE) === 2_000 &&
      payerBankCents(w, EMPLOYER) === 100_000 &&
      payeeBankCents(w, MERCHANT_A) === 0
        ? undefined
        : 'the shares were not returned to their payers'),
    run: async () => {
      const w = autopayWorld();
      const session = autopaySession(w, 'purchase-1');
      session.agent.selectOffer(OFFER_AUTO_9.offerRef);
      await stepToState(session, 'completed');
      await session.userFlow.dispute();
      return { w, p: session.userFlow.snapshot() };
    },
  },
  // S29–S34: signed caller requests. Every call that starts or ends a
  // purchase names its caller and carries that caller's signature, verified
  // against a registered key and bound to the purchase and proposal
  // version; the refusal scenarios catch the thrown reason inside run()
  // and prove the evidence through the trace — request_refused names the
  // kind, the caller and the reason.
  {
    id: 'S29-submit-on-ready',
    title: "Signed 'on_ready' proposal: the approval is the last tap — the coordinator submits the moment the purchase is ready",
    question: 'Q1',
    responsibility: "Self-submit at the ready transition under 'on_ready'; log the coordinator's own trigger instead of a fabricated caller",
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (w.trace.events.some((e) => e.event === 'submit' && e.actor === 'coordinator' && e.detail?.trigger === 'auto')
        ? undefined
        : 'no coordinator auto-submit'),
    run: async () => {
      const w = world();
      const p = lunch(w, 1_300, MERCHANT_A, { submitPolicy: 'on_ready' });
      // The signed proposal already fixed the submission terms: the
      // employee's approval completes the authority, and the coordinator
      // fires its own submission at the ready transition — no submit
      // request exists to sign. idle() drains the self-fired submission.
      approveAs(w, p);
      await w.coordinator.idle();
      return { w, p };
    },
  },
  {
    id: 'S30-proposal-bad-signature',
    title: 'A proposal signed under an unregistered key is refused: bad_signature, and no purchase is created',
    question: 'Q2',
    responsibility: 'Verify the request signature against a registered key before reading its content; log the refusal and leave no record',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (w.trace.events.some(
        (e) => e.event === 'request_refused' && e.detail?.kind === 'propose' && e.detail?.reason === 'bad_signature' && e.detail?.by === 'mallory-1',
      )
        ? undefined
        : 'no bad_signature refusal') ??
      (w.trace.events.every((e) => e.event === 'request_refused' || e.detail?.purchaseId !== 'purchase-forged')
        ? undefined
        : 'the forged proposal left a record'),
    run: async () => {
      const w = world();
      // 'mallory-1' holds no registered key: the request signs cleanly with
      // an unregistered fixture key, and the coordinator still cannot bind
      // it to any caller it knows.
      let refused = false;
      try {
        proposeAs(
          w,
          {
            purchaseId: 'purchase-forged',
            employeeId: EMPLOYEE,
            merchantId: MERCHANT_A,
            totalCents: 1_300,
            mandateRef: w.mandate.mandateRef,
            expiresAt: 100,
          },
          'mallory-1',
        );
      } catch {
        refused = true; // request_refused: bad_signature — the trace shows it
      }
      if (!refused) throw new Error('a forged proposal was accepted');
      // The refusal left nothing behind: the ordinary lunch still completes.
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S31-split-nonpayer-proposer',
    title: 'A split proposed by someone who pays no share is refused; the same purchaseId commits once the proposer pays in',
    question: 'Q2',
    responsibility: 'Require the split proposer to be one of its share payers; a refused proposal leaves no record and frees the purchaseId',
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (w.trace.events.some(
        (e) =>
          e.event === 'request_refused' &&
          e.detail?.kind === 'propose_split' &&
          e.detail?.reason === 'proposer_not_a_payer' &&
          e.detail?.by === EMPLOYEE,
      )
        ? undefined
        : 'no proposer_not_a_payer refusal') ??
      (w.trace.events.filter((e) => e.event === 'proposal').length === 1 ? undefined : 'more than one proposal was committed'),
    run: async () => {
      const w = world();
      // The employee proposes a dinner only the colleagues pay into: a
      // proposer must hold a share in the purchase they propose.
      let refused = false;
      try {
        proposeSplitAs(
          w,
          {
            purchaseId: 'purchase-1',
            merchantId: MERCHANT_B,
            amountsFrom: 'equal_split',
            totalCents: 4_000,
            expiresAt: 100,
            shares: [
              { role: 'diner-1', payerId: COLLEAGUE_1 },
              { role: 'diner-2', payerId: COLLEAGUE_2 },
            ],
          },
          EMPLOYEE,
        );
      } catch {
        refused = true; // request_refused: proposer_not_a_payer — the trace shows it
      }
      if (!refused) throw new Error('a non-payer split proposal was accepted');
      // The refusal left no record: the same purchaseId commits with the
      // proposer among the payers, and all three diners approve and settle.
      const p = proposeSplitAs(
        w,
        {
          purchaseId: 'purchase-1',
          merchantId: MERCHANT_B,
          amountsFrom: 'equal_split',
          totalCents: 4_000,
          expiresAt: 100,
          shares: [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2].map((payerId, i) => ({ role: `diner-${i + 1}`, payerId })),
        },
        EMPLOYEE,
      );
      for (const id of [EMPLOYEE, COLLEAGUE_1, COLLEAGUE_2]) approveAs(w, p, id);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S32-cancel-nonpayer',
    title: "A cancellation signed by someone who pays no share is refused; a payer's signature cancels the purchase",
    question: 'Q2',
    responsibility: 'Verify the cancel signer is a payer of the purchase, bound to the current version; log the refusal and keep the purchase open',
    check: ({ w, p }) =>
      expectState(p, 'cancelled') ??
      (w.trace.events.some(
        (e) => e.event === 'request_refused' && e.detail?.kind === 'cancel' && e.detail?.reason === 'not_authorized' && e.detail?.by === COLLEAGUE_1,
      )
        ? undefined
        : 'no not_authorized refusal') ??
      (w.trace.events.some((e) => e.event === 'state' && e.detail?.to === 'cancelled' && e.detail?.by === EMPLOYEE)
        ? undefined
        : 'no payer-signed cancellation'),
    run: async () => {
      const w = world();
      const p = lunch(w);
      // A colleague holds a registered key but no share in this purchase:
      // the signature verifies, and the caller rule still refuses it.
      let refused = false;
      try {
        cancelAs(w, p, COLLEAGUE_1);
      } catch {
        refused = true; // request_refused: not_authorized — the trace shows it
      }
      if (!refused) throw new Error('a non-payer cancellation was accepted');
      // The refused request changed nothing: a payer's signed cancel ends it.
      cancelAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S33-refund-by-payer',
    title: "A payer's signed refund request is refused — payers return through dispute(); the payee's request returns every share",
    question: 'Q3',
    responsibility: 'Restrict refund requests to the purchase payees; name dispute() in the refusal a paying signer receives',
    check: ({ w, p }) =>
      (p.returnStatus === 'completed' ? undefined : `returns ${p.returnStatus}`) ??
      (w.trace.events.some(
        (e) =>
          e.event === 'request_refused' &&
          e.detail?.kind === 'refund' &&
          e.detail?.reason === 'not_authorized' &&
          e.detail?.by === EMPLOYEE &&
          String(e.detail?.hint).includes('dispute'),
      )
        ? undefined
        : 'no refusal naming the dispute path') ??
      (w.trace.events.some((e) => e.event === 'refund_requested' && e.detail?.by === MERCHANT_A) ? undefined : 'no payee refund request'),
    run: async () => {
      const w = world();
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      // The employee pays into this purchase but is no payee: their return
      // path is a dispute, not a refund request — the refusal says so.
      let refused = false;
      try {
        await refundAs(w, p, EMPLOYEE);
      } catch {
        refused = true; // request_refused: not_authorized + dispute() hint — the trace shows it
      }
      if (!refused) throw new Error('a payer-signed refund was accepted');
      // The merchant of record signs the return: every share goes back to
      // its own payer.
      await refundAs(w, p, MERCHANT_A);
      return { w, p };
    },
  },
  {
    id: 'S34-submit-nonpayer',
    title: "Under 'on_request' only a payer's signature submits: a non-payer's request is refused, a payer's completes",
    question: 'Q2',
    responsibility: "Verify the submit request's signer is a payer of the purchase, bound to the current version; log who triggered the send",
    check: ({ w, p }) =>
      expectState(p, 'completed') ??
      (w.trace.events.some(
        (e) => e.event === 'request_refused' && e.detail?.kind === 'submit' && e.detail?.reason === 'not_authorized' && e.detail?.by === COLLEAGUE_1,
      )
        ? undefined
        : 'no not_authorized refusal') ??
      (w.trace.events.some(
        (e) => e.event === 'submit' && e.actor === 'coordinator' && e.detail?.trigger === 'request' && e.detail?.by === EMPLOYEE,
      )
        ? undefined
        : 'no payer-signed submission'),
    run: async () => {
      const w = world();
      const p = lunch(w);
      approveAs(w, p);
      // A colleague's validly signed request still names no payer of this
      // purchase — verified against a registered key, then refused.
      let refused = false;
      try {
        await submitAs(w, p, COLLEAGUE_1);
      } catch {
        refused = true; // request_refused: not_authorized — the trace shows it
      }
      if (!refused) throw new Error('a non-payer submit was accepted');
      // The refused request never reached the settlement layer: a payer's
      // signed request submits the still-ready purchase.
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
  {
    id: 'S35-hold-expires-before-commit',
    title: 'A hold expires before commit: no merchant payment ever committed; holds and funding are cleaned up before failed',
    question: 'Q2',
    responsibility: 'Let holds lapse at their half-minute deadline; confirm releases and funding cleanup before reporting failed',
    check: ({ w, p }) =>
      expectState(p, 'failed') ??
      (payeeBankCents(w, MERCHANT_A) === 0 && payerDeCents(w, EMPLOYEE) === 2_000 ? undefined : 'money moved') ??
      (settlementOf(w, p.purchaseId)?.cleanupConfirmed === true ? undefined : 'cleanup unresolved'),
    run: async () => {
      const w = world();
      // The employer leg's transfer debit is parked: both reserves accept
      // their holds, but no commit reaches the merchant.
      w.providers.get(EMPLOYER)!.setFault(legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a'), 'debit', 'defer');
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      // Thirty simulated seconds — one hold TTL: every accepted hold is
      // exactly at its deadline, where expiry already refuses commit.
      advance(w, 10 + HOLD_TTL_MINUTES);
      // The parked debit resolves to a conclusive rejection: holds expire,
      // funding is restored, and the purchase fails with nothing committed.
      w.providers.get(EMPLOYER)!.resolveDeferred(legChildKey('purchase-1', 1, 'employer', 'pay', 'psp-shop-merchant-a'), 'reject');
      await w.coordinator.reconcile(p.purchaseId);
      return { w, p };
    },
  },
  {
    id: 'S36-commit-diverges-compensated',
    title: 'The bank share commits but the digital-euro group fails: the bank share is returned and the purchase ends compensated',
    question: 'Q2',
    responsibility: 'Compensate a committed bank leg when the digital-euro group refuses; report compensated only after principal, fees and cleanup confirm',
    check: ({ w, p }) =>
      expectState(p, 'compensated') ??
      (payerBankCents(w, EMPLOYER) === 100_000 && payeeBankCents(w, MERCHANT_A) === 0 ? undefined : 'bank share not restored') ??
      (settlementOf(w, p.purchaseId)?.cleanupConfirmed === true && settlementOf(w, p.purchaseId)?.exposureCents === 0 ? undefined : 'exposure remains'),
    run: async () => {
      const w = world();
      // The employee's digital-euro group commit is conclusively refused:
      // the employer's bank leg already settled and must be compensated.
      w.digitalEuro.setFault(deGroupKey('purchase-1', 1, ['employee']), 'commit', 'reject_before_effect');
      const p = lunch(w);
      approveAs(w, p);
      await submitAs(w, p, EMPLOYEE);
      return { w, p };
    },
  },
];
