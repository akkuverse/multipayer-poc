// Privacy: the closed catalog of versioned disclosure profiles, the rules
// that resolve a signed source into frozen proposal terms, and the only
// public projection entry point. One small interface — resolveProfile(),
// viewFor() and the recipient/source configuration types — owns every
// disclosure decision so callers never re-implement them.
//
// resolveProfile() receives already signature-verified source records from
// the coordinator: it validates the profile/source combination and the
// known-group agreement, clones what it names and returns frozen terms a
// proposal retains. It authenticates nobody — employer verification and
// signer checks stay with the authority modules — and it grants nothing:
// disclosure permission is never spending permission.
//
// viewFor() checks the purchase's frozen terms and the recipient's
// entitlement against the retained records before emitting a detached
// projection. It performs no write, reads no live registry and returns no
// mutable reference into retained records — an unentitled or inconsistent
// request is refused, never answered with a permissive default view.

import type { AcceptedPledge, AllowanceMandate, Authorization, AuthZone, AutoPayBlockedReason, CampaignTerms, Cents, DeepReadonly, DisputeOutcome, EmployerMandate, FundingState, Leg, LegStatus, PayerApproval, PrivacyTerms, PurchaseState, PurchaseView, Rail, ReturnStatus } from './types.ts';
import { campaignDigestOf, canonicalJson, sharesDigestOf } from './signing.ts';
import { campaignTermsWellFormed } from './funding.ts';

// The closed profile catalog: literal, versioned identifiers. The suffix is
// the rules version — an existing profile's disclosure semantics never
// change in place; a different contract gets a new identifier.
// 'public_good_pledge_v1' names the conditional-fund profile a signed
// campaign fixes: a fund purchase gets the distinct FundPayerView, never
// the ordinary total-bearing payer view. 'anonymous_donation_v1' names the
// charity profile a buyer-signed request resolves: the buyer sees the donor
// contribution as role and magnitude, never the donor identity, the
// allowance reference or the attestation behind it.
export type PrivacyProfileId = 'employer_benefit_v1' | 'split_bill_v1' | 'public_good_pledge_v1' | 'anonymous_donation_v1';

// A trusted, explicitly configured disclosure agreement: an existing group
// whose listed members may share their identities and principal contribution
// amounts with each other under split_bill_v1. Configuration input, owned by
// the world/coordinator — a signed request can only select a group, never
// install or amend one, and the agreement conveys no spending authority.
export interface KnownSplitGroup {
  groupRef: string;
  privacyProfile: 'split_bill_v1';
  memberIds: readonly string[];
}

// What a signed entry point asks resolution to bind: the profile the signer
// requested (untrusted — unknown values are refused, never defaulted) and
// the already-verified source record it is resolved against.
export type PrivacySource =
  | {
      kind: 'employer_mandate';
      requested: unknown;
      // The latest verified mandate, or undefined when the reference resolves
      // to no usable record — the conservative request_only case.
      mandate: DeepReadonly<EmployerMandate> | undefined;
    }
  | {
      kind: 'split_request';
      requested: unknown;
      groupRef: string;
      // The distinct payer ids the committed shares would name.
      payerIds: readonly string[];
      // The configured group the reference resolves to, or undefined.
      group: KnownSplitGroup | undefined;
    }
  | {
      kind: 'campaign';
      requested: unknown;
      // The campaign digest the coordinator committed for the verified
      // open_fund request — the commitment pledges sign over.
      campaignDigest: string;
      // The campaign table, explicitly selected from that request.
      terms: CampaignTerms;
    }
  | {
      kind: 'allowance';
      requested: unknown;
      // The selected verified allowance, or undefined when no positive
      // candidate matched — the conservative request_only case: the signed
      // restrictive request stands but authorizes no donor share.
      allowance: DeepReadonly<AllowanceMandate> | undefined;
    };

// Who is asking for a projection. Identity is trusted caller context from
// the session/fixture — not a login mechanism (this PoC assumes identity and
// key enrollment). A party holding several legitimate roles requests each
// facet explicitly; no facet unions another's information into its result.
export type Recipient = {
  partyId: string;
  facet: 'payer' | 'payee' | 'sponsor';
};

// Deep-freeze a plain-data value: resolution returns terms nothing — not the
// source object, not a later caller — can mutate.
const deepFreeze = <T>(v: T): T => {
  if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const PRIVACY_PROFILES: readonly PrivacyProfileId[] = ['employer_benefit_v1', 'split_bill_v1', 'public_good_pledge_v1', 'anonymous_donation_v1'];

// Resolve a verified signed source into frozen disclosure terms for one
// proposal. Explicit branches only: an unrecognized requested profile, a
// verified source whose own profile disagrees, an unconfigured or
// non-covering group are all refused — nothing is silently defaulted. The
// request itself can never supply group configuration or the audience a
// request might prefer over the committed shares.
export function resolveProfile(source: PrivacySource): PrivacyTerms {
  if (source.kind === 'employer_mandate') {
    if (source.requested !== 'employer_benefit_v1') throw new Error('privacy_profile_unsupported');
    if (source.mandate && source.mandate.privacyProfile !== source.requested) {
      throw new Error('privacy_profile_mismatch');
    }
    // A verified mandate binds its own signed terms to the proposal; an
    // absent or unverifiable one authorizes no employer share and grants no
    // sponsor entitlement — only the signed, restrictive request stands.
    return deepFreeze(
      source.mandate
        ? {
            profile: 'employer_benefit_v1',
            source: {
              kind: 'employer_mandate',
              mandateRef: source.mandate.mandateRef,
              mandateVersion: source.mandate.version,
              employerId: source.mandate.employerId,
            },
          }
        : { profile: 'employer_benefit_v1', source: { kind: 'request_only' } },
    );
  }
  if (source.kind === 'campaign') {
    // The verified open_fund request is the whole source: the profile it
    // signed is the only acceptable request, and the frozen terms carry
    // the complete campaign table pledges bound by digest — never a
    // re-resolution against a later request.
    if (source.requested !== 'public_good_pledge_v1') throw new Error('privacy_profile_unsupported');
    return deepFreeze({
      profile: 'public_good_pledge_v1',
      source: { kind: 'campaign', campaignDigest: source.campaignDigest, terms: structuredClone(source.terms) },
    });
  }
  if (source.kind === 'allowance') {
    // The verified selected allowance is the whole source: the profile the
    // buyer signed is the only acceptable request, and the allowance's own
    // signed profile must agree — a cross-arrangement record is refused,
    // not quietly bound. An absent candidate resolves to request_only:
    // the signed restrictive request stands but entitles no donor share
    // and discloses no donor.
    if (source.requested !== 'anonymous_donation_v1') throw new Error('privacy_profile_unsupported');
    if (source.allowance && source.allowance.privacyProfile !== source.requested) {
      throw new Error('privacy_profile_mismatch');
    }
    return deepFreeze(
      source.allowance
        ? {
            profile: 'anonymous_donation_v1',
            source: {
              kind: 'allowance',
              allowanceRef: source.allowance.allowanceRef,
              version: source.allowance.version,
              donorId: source.allowance.donorId,
            },
          }
        : { profile: 'anonymous_donation_v1', source: { kind: 'request_only' } },
    );
  }
  if (source.requested !== 'split_bill_v1') throw new Error('privacy_profile_unsupported');
  if (!source.group || source.group.groupRef !== source.groupRef) throw new Error('split_group_unknown');
  if (source.group.privacyProfile !== source.requested) throw new Error('privacy_profile_mismatch');
  // The actual purchase audience: the distinct payers the shares name — the
  // group's whole membership is never disclosed. A group may cover any
  // subset of its members, so every participant must belong.
  const participants = [...new Set(source.payerIds)];
  if (participants.length === 0 || participants.some((id) => !source.group!.memberIds.includes(id))) {
    throw new Error('split_group_mismatch');
  }
  return deepFreeze({
    profile: 'split_bill_v1',
    source: { kind: 'known_group', groupRef: source.groupRef, participantIds: participants },
  });
}

// --- Recipient projections ---------------------------------------------------
// What each party may see of a purchase: projections, not copies. Every field
// is one its recipient needs (docs/field-map.md). The payer sees the purchase
// total and their own contribution; a split under a known-group agreement
// additionally shares the actual participant ids and principal contributions.
// The payee sees what it received, never who paid or which profile funded it —
// a profile id on this view would reveal funding composition. The sponsor sees
// its own contribution and the merchant it went to, never the purchase total
// or the employee's share.
//
// A conditional-fund purchase never gets the ordinary payer view: the
// campaign's own FundPayerView shows each contributor only its signed
// pledge, its acceptance and lapse/settlement outcome, the public campaign
// terms and the progress counters the signed condition itself exposes —
// never the purchase total, other contributors or their amounts.

// The detached approval projection a payer's device countersigns: every
// term the approval binds, computed by the coordinator from the retained
// proposal — purchase, version, payer, merchant, total, own principal, own
// fee, expiry, profile, the split's group reference when one exists, and
// the opaque allocation commitment sharesDigest. It contains no raw
// shares, no donor identity or allowance reference and no internal source
// — under mutual anonymity the device cannot reconstruct the hidden
// allocation, it can only sign the commitment it was shown (spec §3.3:
// the unsalted deterministic digest is a binding, not an anonymity
// guarantee).
export type ApprovalTerms = Pick<
  PayerApproval,
  | 'purchaseId'
  | 'proposalVersion'
  | 'payerId'
  | 'merchantId'
  | 'totalCents'
  | 'amountCents'
  | 'feeCents'
  | 'expiresAt'
  | 'privacyProfile'
  | 'disclosureGroupRef'
  | 'sharesDigest'
>;

export interface PayerView {
  purchaseId: string;
  state: PurchaseState;
  merchantId: string;
  totalCents: Cents;
  ownCents: Cents;
  // Payer fees on top of the own share.
  ownFeeCents: Cents;
  // Everyone else's contributions combined, so the payer can check the total.
  othersCents: Cents;
  // The exact terms this payer's device approves: the coordinator's own
  // detached commitment — the device signs what it was shown, including
  // the opaque sharesDigest, and never re-reads the raw allocation. Absent
  // on a fund's FundPayerView: pledges are a fund's only authorization.
  approval: ApprovalTerms;
  // Anonymous-charity purchases only: the sponsor-funded contribution as
  // role and magnitude ('donor: €5'). The donor's identity, the allowance
  // reference and the attestation behind it stay out of the view.
  donorContribution?: { role: string; amountCents: Cents };
  ownLegs: { executionRef?: string; payeeId: string; amountCents: Cents; status: LegStatus }[];
  // The disclosure profile the proposal froze — needed to understand and
  // approve the arrangement, not a claim about what this payer may see.
  privacyProfile: PrivacyProfileId;
  // Known-group splits only: the actual participants and their principal
  // contributions in the proposal's stable share order — the disclosure the
  // group's existing agreement permits. Never other payers' fees, rails,
  // routing or authority records.
  sharedContributions?: { payerId: string; amountCents: Cents }[];
  // The purchase's last recorded employee assessment — present eligibility
  // as of the last mutation (benefit purchases only). Kept strictly
  // separate from the frozen authority below that funded the shares. The
  // observed mandate version and maximum are safe; the mandate reference
  // itself stays out of the payer column.
  assessment?: {
    authZone: AuthZone;
    employeeDebitCents: Cents;
    autoPayBlockedReason?: AutoPayBlockedReason;
    mandateVersion?: number;
    employeeMaxCents?: Cents;
  };
  // The basis of the authorization record funding this payer's shares: a
  // device signature, a signed one-off exception, standing mandate
  // evidence or a fund pledge — the authority that paid, not today's
  // eligibility answer.
  authorizationBasis?: 'device' | 'exception' | 'mandate' | 'pledge';
  // The signed record's own approvalRef — or the contributor's pledgeRef
  // on a fund. Mandate evidence names no reference here: docs/field-map.md
  // keeps mandate references out of the payer column.
  authorizationRef?: string;
  // Whether returns were attempted on this purchase and how they ended.
  returnStatus: ReturnStatus;
  // Confirmed returned principal on this payer's own legs.
  returnedCents: Cents;
  // The charged fee principal-returns never give back — reported separately
  // so "principal returned; fee retained" is not folded into returnedCents.
  unreturnedFeeCents: Cents;
  // The Auto receipt's observation time and fixed dispute deadline —
  // present only on a mandate-authorized purchase once completed. The
  // observed mandate version is safe; the mandate reference stays out of
  // the payer column (docs/field-map.md).
  receipt?: { receiptAt: number; disputeUntil: number; mandateVersion: number };
  // This payer's own dispute case and the latest outcome of its return
  // request — absent when none was ever accepted.
  dispute?: { openedAt: number; outcome: DisputeOutcome };
}

// A fund contributor's distinct projection (public_good_pledge_v1): an
// explicit allowlist, built so no ordinary PayerView field — totalCents,
// othersCents, sharedContributions — can leak into it. Entitlement comes
// from the retained acceptance history, active or lapsed, never from the
// active payer index: a lapsed pledger keeps read access to its outcome.
export interface FundPayerView {
  purchaseId: string;
  state: PurchaseState;
  // The campaign payee is the purchase's merchant of record — public.
  merchantId: string;
  privacyProfile: 'public_good_pledge_v1';
  // The complete public campaign table the pledge bound — every term the
  // pledger signed over (condition, cutoff, settleBy, closing rule,
  // submission policy and mode). Never internal funding history.
  campaign: CampaignTerms;
  // This contributor's own signed pledge terms — no signature material.
  pledge: { pledgeRef: string; amountCents: Cents; feeCents: Cents; rail: Rail; expiresAt: number };
  // The detached acceptance acknowledgment: when it was recorded and
  // under which roster version — unchanged by a later lapse.
  acceptance: { acceptedAt: number; proposalVersion: number };
  // The pledge's current participation outcome: 'active' or 'lapsed'.
  outcome: 'active' | 'lapsed';
  // Own settlement outcome: this pledge's legs only.
  ownLegs: { executionRef?: string; payeeId: string; amountCents: Cents; status: LegStatus }[];
  // Confirmed returned principal and the charged fee returns never give
  // back — on this pledge's own legs only, same semantics as PayerView.
  returnedCents: Cents;
  unreturnedFeeCents: Cents;
  // Progress limited to what the signed condition exposes (spec §4):
  // minPayers authorizes the live contributor count, minTotalCents the
  // live pledged principal total, both authorize both. 'met' carries
  // nothing the authorized counters plus the public condition do not
  // already reveal. The counters are the funding decision's retained
  // values — this read never evaluates or lapses anything.
  progress: { contributors?: number; pledgedCents?: Cents; met: boolean };
}

export interface PayeeView {
  purchaseId: string;
  state: PurchaseState;
  // Settled legs paid to this payee and not returned.
  receivedCents: Cents;
  // Anonymous contribution items — no payer identity ever appears.
  contributions: { executionRef?: string; amountCents: Cents; status: LegStatus }[];
  // Conditional-fund purchases only: the funding phase and condition
  // outcome the campaign resolved to — never contributor detail.
  fundingOutcome?: { phase: 'collecting' | 'closed' | 'admitted'; met: boolean };
}

export interface SponsorView {
  mandateRef: string;
  purchaseId: string;
  // Eligibility evidence: the employer can check it against its own list.
  merchantId: string;
  contributionCents: Cents;
  status: LegStatus | 'not_submitted';
}

export type PartyView = PayerView | FundPayerView | PayeeView | SponsorView;

// The campaign privacy source variant, already narrowed.
type CampaignSource = Extract<PrivacyTerms['source'], { kind: 'campaign' }>;

// Which payer an authorization record belongs to: mandate evidence names
// its payer directly, a pledge belongs to the pledger its payload names,
// an approval to its signed payer.
const authorizationPayer = (a: DeepReadonly<Authorization>): string =>
  a.basis === 'mandate' ? a.payerId : a.basis === 'pledge' ? a.pledge.payload.by : a.approval.payload.payerId;

// A retained campaign source's digest must still commit to its own frozen
// terms — a digest that recomputes differently is corrupted evidence.
// Canonicalisation failures are treated as inconsistency, never thrown.
const campaignDigestConsistent = (source: { campaignDigest: string; terms: CampaignTerms }): boolean => {
  try {
    return campaignDigestOf(source.terms) === source.campaignDigest;
  } catch {
    return false;
  }
};

// Validate that retained terms are a well-formed member of the closed
// union before any projection is built on them — a corrupted record is
// refused as privacy_profile_invalid, never reinterpreted or defaulted.
const checkedTerms = (t: DeepReadonly<PrivacyTerms>): PrivacyTerms => {
  const valid =
    t !== null &&
    typeof t === 'object' &&
    PRIVACY_PROFILES.includes(t.profile) &&
    t.source !== null &&
    typeof t.source === 'object' &&
    ((t.source.kind === 'employer_mandate' &&
      t.profile === 'employer_benefit_v1' &&
      nonempty(t.source.mandateRef) &&
      nonempty(t.source.employerId) &&
      Number.isSafeInteger(t.source.mandateVersion) &&
      t.source.mandateVersion >= 1) ||
      (t.source.kind === 'request_only' && (t.profile === 'employer_benefit_v1' || t.profile === 'anonymous_donation_v1')) ||
      (t.source.kind === 'known_group' &&
        t.profile === 'split_bill_v1' &&
        nonempty(t.source.groupRef) &&
        Array.isArray(t.source.participantIds) &&
        t.source.participantIds.length > 0 &&
        t.source.participantIds.every(nonempty)) ||
      (t.source.kind === 'campaign' &&
        t.profile === 'public_good_pledge_v1' &&
        nonempty(t.source.campaignDigest) &&
        campaignTermsWellFormed(t.source.terms) &&
        campaignDigestConsistent(t.source)) ||
      (t.source.kind === 'allowance' &&
        t.profile === 'anonymous_donation_v1' &&
        nonempty(t.source.allowanceRef) &&
        nonempty(t.source.donorId) &&
        Number.isSafeInteger(t.source.version) &&
        t.source.version >= 1));
  if (!valid) throw new Error('privacy_profile_invalid');
  return t;
};

// The distinct payers the committed shares name — the frozen audience a
// projection may disclose to, in share order.
const distinctPayers = (p: PurchaseView): string[] => [...new Set(p.proposal.shares.map((s) => s.payerId))];

// A known-group split's frozen audience must match the actual distinct
// share payers: terms naming fewer, more or different participants than the
// shares they claim to cover are inconsistent — refused, never quietly
// narrowed or broadened.
const checkedAudience = (p: PurchaseView, terms: PrivacyTerms): void => {
  // Campaign sources carry no frozen participant list — the fund's
  // audience is its retained pledge history, validated separately below.
  if (terms.source.kind !== 'known_group') return;
  const actual = new Set(distinctPayers(p));
  const frozen = terms.source.participantIds;
  if (frozen.length !== actual.size || new Set(frozen).size !== frozen.length || frozen.some((id) => !actual.has(id))) throw new Error('privacy_profile_invalid');
};

// A campaign-source proposal must agree with the retained funding record
// it claims to describe, and the history its projections read must be
// structurally sound: the frozen source terms name this purchase and its
// merchant, the stored digest commits to the very same campaign table,
// and each history entry carries a coherent signed payload and detached
// acknowledgment. Roster signature/binding verification stays with the
// funding module — here anything malformed or disagreeing is corrupted
// evidence, refused for every facet, never quietly re-read. Returns the
// validated funding record, or undefined for a non-campaign purchase.
const checkedCampaign = (p: PurchaseView, terms: PrivacyTerms): DeepReadonly<FundingState> | undefined => {
  const f = p.funding;
  if (terms.source.kind !== 'campaign') {
    // A funding record under another profile is inconsistent evidence.
    if (f !== undefined) throw new Error('privacy_profile_invalid');
    return undefined;
  }
  // The retained campaign table must commit to the digest the frozen
  // source names — a digest that recomputes differently is corrupted
  // evidence; canonicalisation failure is inconsistency, never thrown.
  const digestCommits = (v: unknown): boolean => {
    try {
      return campaignTermsWellFormed(v) && campaignDigestOf(v) === terms.source.campaignDigest;
    } catch {
      return false;
    }
  };
  // The frozen source's campaign table — already well-formed and
  // digest-consistent (checkedTerms ran first). It is the binding every
  // retained pledge must still satisfy; f.terms must digest-commit to the
  // same campaign digest below, so both tables carry the same fields.
  const campaignTerms = terms.source.terms;
  // The signature-free content and binding checks a retained pledge must
  // still satisfy — the read-side echo of the funding module's
  // pledgeContentProblem/checkRetained, minus signature and materialized-
  // roster verification. Anything malformed, rebound or altered since
  // acceptance is corrupted evidence, refused for every facet.
  const validEntry = (e: unknown): e is DeepReadonly<AcceptedPledge> => {
    if (!isRecord(e) || (e.outcome !== 'active' && e.outcome !== 'lapsed')) return false;
    if (!isRecord(e.signed) || !nonempty(e.signed.keyId) || !nonempty(e.signed.signature)) return false;
    const payload = e.signed.payload;
    if (!isRecord(payload) || payload.kind !== 'pledge') return false;
    // A pledge is not a SignedRequest: a retained roster binding or
    // withdrawal grant is corruption, never reinterpreted.
    if ('proposalVersion' in payload || 'cancelUntil' in payload) return false;
    if (!nonempty(payload.by) || !nonempty(payload.pledgeRef)) return false;
    if (payload.purchaseId !== p.purchaseId) return false;
    if (payload.campaignDigest !== f?.campaignDigest) return false;
    if (payload.privacyProfile !== 'public_good_pledge_v1') return false;
    const share = payload.share;
    if (!isRecord(share)) return false;
    // The pledger is the share's payer; the role is derived from the
    // pledge reference, never freely chosen.
    if (share.payerId !== payload.by) return false;
    if (share.role !== `pledge:${payload.pledgeRef}`) return false;
    if (share.payeeId !== campaignTerms.payeeId) return false;
    if (!nonempty(share.rail)) return false;
    if (!Number.isSafeInteger(share.amountCents) || (share.amountCents as number) <= 0) return false;
    if (!Number.isSafeInteger(share.feeCents) || (share.feeCents as number) < 0) return false;
    if (!Number.isSafeInteger((share.amountCents as number) + (share.feeCents as number))) return false;
    // A retained expiry was only ever acceptable within the campaign
    // window: never past settleBy, and under 'deadline' strictly beyond
    // the collection cutoff.
    if (!Number.isFinite(payload.expiresAt)) return false;
    if ((payload.expiresAt as number) > campaignTerms.settleBy) return false;
    if (campaignTerms.acceptPledgesUntil === 'deadline' && (payload.expiresAt as number) <= campaignTerms.fundingEndsAt) return false;
    // The stored canonical bytes are the acceptance-time payload: a
    // payload that recomputes differently was altered after the fact.
    // Canonicalisation failure is inconsistency, never thrown.
    if (!nonempty(e.canonicalPayload)) return false;
    try {
      if (canonicalJson(payload) !== e.canonicalPayload) return false;
    } catch {
      return false;
    }
    return (
      isRecord(e.acknowledgment) &&
      e.acknowledgment.purchaseId === p.purchaseId &&
      e.acknowledgment.pledgeRef === payload.pledgeRef &&
      Number.isFinite(e.acknowledgment.acceptedAt) &&
      Number.isSafeInteger(e.acknowledgment.proposalVersion) &&
      (e.acknowledgment.proposalVersion as number) >= 1
    );
  };
  if (
    !isRecord(f) ||
    !nonempty(f.campaignDigest) ||
    (f.phase !== 'collecting' && f.phase !== 'closed' && f.phase !== 'admitted') ||
    !Array.isArray(f.history) ||
    !f.history.every(validEntry) ||
    // One accepted pledge per reference and per payer, ever — the funding
    // module's acceptance rule; duplicated entries are corrupted evidence.
    new Set(f.history.map((e) => e.signed.payload.pledgeRef)).size !== f.history.length ||
    new Set(f.history.map((e) => e.signed.payload.by)).size !== f.history.length ||
    !isRecord(f.progress) ||
    !Number.isSafeInteger(f.progress.livePayers) ||
    f.progress.livePayers < 0 ||
    !Number.isSafeInteger(f.progress.liveTotalCents) ||
    f.progress.liveTotalCents < 0 ||
    typeof f.progress.met !== 'boolean' ||
    f.campaignDigest !== terms.source.campaignDigest ||
    terms.source.terms.purchaseId !== p.purchaseId ||
    terms.source.terms.payeeId !== p.proposal.merchantId ||
    !digestCommits(f.terms)
  ) {
    throw new Error('privacy_profile_invalid');
  }
  return f;
};

// An anonymous-donation proposal must agree with the retained charity
// record it claims to describe, and its shares must carry only the
// arrangement the record and source name: the buyer's own 'payer'-authority
// share and — on an allowance source — the 'donor' sponsor share bound to
// the frozen reference and donor. A charity record under another profile,
// a sponsor share under request_only or foreign terms, or a record
// disagreeing with the frozen source is corrupted evidence — refused for
// every facet, never quietly re-read.
const checkedCharity = (p: PurchaseView, terms: PrivacyTerms): void => {
  const c = p.charity;
  if (terms.profile !== 'anonymous_donation_v1') {
    // A charity record — or any sponsor-authority share — under another
    // profile is inconsistent evidence.
    if (c !== undefined || p.proposal.shares.some((s) => s.authority === 'sponsor_mandate')) {
      throw new Error('privacy_profile_invalid');
    }
    return;
  }
  if (
    !isRecord(c) ||
    !nonempty(c.buyerId) ||
    !nonempty(c.benefitClass) ||
    (c.allowanceRef !== undefined && !nonempty(c.allowanceRef)) ||
    (c.donorId !== undefined && !nonempty(c.donorId)) ||
    (c.unmatchedReason !== undefined && !nonempty(c.unmatchedReason))
  ) {
    throw new Error('privacy_profile_invalid');
  }
  if (terms.source.kind === 'allowance') {
    if (c.allowanceRef !== terms.source.allowanceRef || c.donorId !== terms.source.donorId) {
      throw new Error('privacy_profile_invalid');
    }
    // The source records a match: its donor share must exist on the
    // proposal — a recorded match without the share is corrupted evidence
    // like any other disagreement.
    if (!p.proposal.shares.some((s) => s.authority === 'sponsor_mandate')) {
      throw new Error('privacy_profile_invalid');
    }
  } else if (c.allowanceRef !== undefined || c.donorId !== undefined) {
    // A request_only proposal froze no donor provenance: a recorded match
    // beside it is corrupted evidence.
    throw new Error('privacy_profile_invalid');
  }
  for (const s of p.proposal.shares) {
    const ok =
      (s.authority === 'payer' && s.payerId === c.buyerId) ||
      (s.authority === 'sponsor_mandate' &&
        terms.source.kind === 'allowance' &&
        s.role === 'donor' &&
        s.payerId === c.donorId &&
        s.authorityRef === c.allowanceRef);
    if (!ok) throw new Error('privacy_profile_invalid');
  }
};

// Confirmed returned principal and the charged fee a return never gives
// back, over this payer's own legs only — shared by the ordinary and fund
// payer projections. Once a settlement snapshot exists its per-leg
// evidence is the money truth (compensation returns charged fees too, so
// a 'returned' leg does not imply a retained fee); the leg-status math is
// the pre-submission fallback, before any snapshot exists.
const ownReturnTotals = (p: PurchaseView, payerId: string, ownLegs: readonly DeepReadonly<Leg>[]): { returnedCents: Cents; unreturnedFeeCents: Cents } => ({
  returnedCents:
    p.settlement === undefined
      ? ownLegs.filter((l) => l.status === 'returned').reduce((t, l) => t + l.amountCents, 0)
      : p.settlement.legs
          .filter((sl) => sl.payerId === payerId)
          .reduce((t, sl) => t + (sl.principalReturnedCents ?? 0), 0),
  unreturnedFeeCents:
    p.settlement === undefined
      ? ownLegs.filter((l) => l.status === 'returned').reduce((t, l) => t + l.feeCents, 0)
      : p.settlement.legs
          .filter((sl) => sl.payerId === payerId)
          .reduce((t, sl) => t + Math.max(0, (sl.feeChargedCents ?? 0) - (sl.feeReturnedCents ?? 0)), 0),
});

// A contributor's own fund view: an explicit allowlist of fields — its
// signed pledge terms, acceptance, lapse and settlement outcome, the
// public campaign table, and the progress counters the signed condition
// itself authorizes. Reading never evaluates, lapses, reserves, emits
// events or submits: the counters are the funding decision's retained
// values, copied out detached.
const fundPayerProjection = (p: PurchaseView, payerId: string, source: CampaignSource, funding: DeepReadonly<FundingState>): FundPayerView => {
  // The retained acceptance history — active or lapsed — is the
  // entitlement source, never the active payer index: a lapsed
  // contributor keeps read access to its own outcome.
  const entry = funding.history.find((e) => e.signed.payload.by === payerId);
  if (entry === undefined) throw new Error('recipient_not_entitled');
  const pledge = entry.signed.payload;
  const ownLegs = p.legs.filter((l) => l.payerId === payerId);
  const t = source.terms;
  return {
    purchaseId: p.purchaseId,
    state: p.state,
    merchantId: p.proposal.merchantId,
    privacyProfile: 'public_good_pledge_v1',
    // The complete public campaign table, copied field by field — the
    // purchase view's records are proxied, never cloned wholesale.
    campaign: {
      purchaseId: t.purchaseId,
      payeeId: t.payeeId,
      condition: {
        ...(t.condition.minPayers === undefined ? {} : { minPayers: t.condition.minPayers }),
        ...(t.condition.minTotalCents === undefined ? {} : { minTotalCents: t.condition.minTotalCents }),
      },
      fundingEndsAt: t.fundingEndsAt,
      settleBy: t.settleBy,
      acceptPledgesUntil: t.acceptPledgesUntil,
      submitPolicy: t.submitPolicy,
      settlementMode: t.settlementMode,
      privacyProfile: t.privacyProfile,
    },
    pledge: {
      pledgeRef: pledge.pledgeRef,
      amountCents: pledge.share.amountCents,
      feeCents: pledge.share.feeCents,
      rail: pledge.share.rail,
      expiresAt: pledge.expiresAt,
    },
    acceptance: { acceptedAt: entry.acknowledgment.acceptedAt, proposalVersion: entry.acknowledgment.proposalVersion },
    outcome: entry.outcome,
    ownLegs: ownLegs.map((l) => ({ executionRef: l.executionRef, payeeId: l.payeeId, amountCents: l.amountCents, status: l.status })),
    ...ownReturnTotals(p, payerId, ownLegs),
    // Absent, not zeroed: a counter the signed condition does not
    // authorize is no key at all on the projection.
    progress: {
      ...(t.condition.minPayers === undefined ? {} : { contributors: funding.progress.livePayers }),
      ...(t.condition.minTotalCents === undefined ? {} : { pledgedCents: funding.progress.liveTotalCents }),
      met: funding.progress.met,
    },
  };
};

const payerProjection = (p: PurchaseView, payerId: string, terms: PrivacyTerms): PayerView => {
  // Ordinary purchases only: viewFor routes campaign profiles to the fund
  // projection and checkedCampaign refuses a funding record under any
  // other profile — a fund must never be cast into this total-bearing
  // shape. The guard stays as the last line behind the routing.
  if (terms.profile === 'public_good_pledge_v1' || p.funding !== undefined) throw new Error('privacy_profile_invalid');
  // Payer participants only — an own share funded by the payer's own
  // authority, never inferred from a role label. A sponsor's mandate-backed
  // share does not qualify: through this view it would learn the purchase
  // total and the employee's share, which docs/field-map.md says it must
  // not. The payer's authorization basis (device, exception or standing
  // terms) does not change their visibility.
  const own = p.proposal.shares.filter((s) => s.payerId === payerId);
  if (!own.some((s) => s.authority === 'payer')) throw new Error('recipient_not_entitled');
  const ownCents = own.reduce((t, s) => t + s.amountCents, 0);
  const auth = p.authorizations.find((a) => authorizationPayer(a) === payerId);
  const ownLegs = p.legs.filter((l) => l.payerId === payerId);
  // The shares this payer's own approval covers: payer-authority shares
  // only — the same set approve() binds — so the displayed commitment can
  // never drift from the admitted one.
  const ownApproved = own.filter((s) => s.authority === 'payer');
  const view: PayerView = {
    purchaseId: p.purchaseId,
    state: p.state,
    merchantId: p.proposal.merchantId,
    totalCents: p.proposal.totalCents,
    ownCents,
    ownFeeCents: own.reduce((t, s) => t + s.feeCents, 0),
    othersCents: p.proposal.totalCents - ownCents,
    // The detached approval snapshot: the coordinator computes the opaque
    // sharesDigest over the full retained allocation — the only commitment
    // a device can safely countersign when other shares stay hidden.
    approval: {
      purchaseId: p.purchaseId,
      proposalVersion: p.proposal.version,
      payerId,
      merchantId: p.proposal.merchantId,
      totalCents: p.proposal.totalCents,
      amountCents: ownApproved.reduce((t, s) => t + s.amountCents, 0),
      feeCents: ownApproved.reduce((t, s) => t + s.feeCents, 0),
      expiresAt: p.proposal.expiresAt,
      privacyProfile: terms.profile,
      ...(terms.source.kind === 'known_group' ? { disclosureGroupRef: terms.source.groupRef } : {}),
      sharesDigest: sharesDigestOf(p.proposal.shares),
    },
    ownLegs: ownLegs.map((l) => ({ executionRef: l.executionRef, payeeId: l.payeeId, amountCents: l.amountCents, status: l.status })),
    privacyProfile: terms.profile,
    assessment:
      p.employeeAssessment === undefined
        ? undefined
        : {
            authZone: p.employeeAssessment.authZone,
            employeeDebitCents: p.employeeAssessment.employeeDebitCents,
            autoPayBlockedReason: p.employeeAssessment.autoPayBlockedReason,
            mandateVersion: p.employeeAssessment.mandate?.version,
            employeeMaxCents: p.employeeAssessment.mandate?.maxCents,
          },
    authorizationBasis: auth?.basis,
    authorizationRef:
      auth === undefined || auth.basis === 'mandate'
        ? undefined
        : auth.basis === 'pledge'
          ? auth.pledge.payload.pledgeRef
          : auth.approval.payload.approvalRef,
    returnStatus: p.returnStatus,
    ...ownReturnTotals(p, payerId, ownLegs),
    receipt:
      p.receipt && p.receipt.employeeId === payerId
        ? { receiptAt: p.receipt.receiptAt, disputeUntil: p.receipt.disputeUntil, mandateVersion: p.receipt.mandateVersion }
        : undefined,
    dispute:
      p.dispute && p.dispute.employeeId === payerId
        ? { openedAt: p.dispute.openedAt, outcome: p.dispute.outcome }
        : undefined,
  };
  if (terms.source.kind === 'known_group') {
    // The group agreement permits exactly the actual participants'
    // identities and principal contributions — one entry per share in
    // proposal order, including repeated payers.
    // Role labels, fees, rails and authority detail stay out.
    view.sharedContributions = p.proposal.shares.map(({ payerId, amountCents }) => ({ payerId, amountCents }));
  }
  if (terms.source.kind === 'allowance') {
    // The anonymous pairing: the donor's contribution is safe as role and
    // magnitude — the identity behind it, the allowance reference and the
    // attestation are not.
    const donor = p.proposal.shares.find((s) => s.authority === 'sponsor_mandate');
    if (donor !== undefined) view.donorContribution = { role: donor.role, amountCents: donor.amountCents };
  }
  return view;
};

const payeeProjection = (p: PurchaseView, payeeId: string, funding: DeepReadonly<FundingState> | undefined): PayeeView => {
  // The merchant of record or an actual share payee — anyone else learns
  // nothing. No profile id, payer identity or funding explanation ever
  // appears on this view; a fund adds only its anonymous outcome.
  if (p.proposal.merchantId !== payeeId && !p.proposal.shares.some((s) => s.payeeId === payeeId)) {
    throw new Error('recipient_not_entitled');
  }
  const legs = p.legs.filter((l) => l.payeeId === payeeId);
  const view: PayeeView = {
    purchaseId: p.purchaseId,
    state: p.state,
    receivedCents: legs.filter((l) => l.status === 'settled').reduce((t, l) => t + l.amountCents, 0),
    contributions: legs.map((l) => ({ executionRef: l.executionRef, amountCents: l.amountCents, status: l.status })),
  };
  if (funding !== undefined) view.fundingOutcome = { phase: funding.phase, met: funding.progress.met };
  return view;
};

const sponsorProjection = (p: PurchaseView, sponsorId: string, terms: PrivacyTerms): SponsorView => {
  // Only the frozen employer provenance entitles a sponsor view: a verified
  // mandate named that employer at commit time. Request-only terms grant no
  // sponsor entitlement — there is no employer to name — and a latest
  // mandate is never re-consulted.
  if (terms.source.kind !== 'employer_mandate' || terms.source.employerId !== sponsorId) {
    throw new Error('recipient_not_entitled');
  }
  // 'employer' is the fixed role the benefit split gives the mandate-backed
  // share; the contribution is the approved proposal amount, the status the
  // leg's.
  const leg = p.legs.find((l) => l.leg === 'employer');
  return {
    mandateRef: terms.source.mandateRef,
    purchaseId: p.purchaseId,
    merchantId: p.proposal.merchantId,
    contributionCents: p.proposal.shares.find((s) => s.role === 'employer')?.amountCents ?? 0,
    status: leg?.status ?? 'not_submitted',
  };
};

// The only public projection entry point: validate the frozen terms, then
// the requested facet's entitlement against the retained records, then emit
// a detached view. Facet overloads keep each caller's typed result; the
// payer facet's result is the ordinary PayerView or — for a campaign
// profile — the distinct FundPayerView, so callers narrow by profile and a
// fund is never cast into the ordinary total-bearing view.
export function viewFor(purchase: PurchaseView, recipient: Recipient & { facet: 'payer' }): PayerView | FundPayerView;
export function viewFor(purchase: PurchaseView, recipient: Recipient & { facet: 'payee' }): PayeeView;
export function viewFor(purchase: PurchaseView, recipient: Recipient & { facet: 'sponsor' }): SponsorView;
export function viewFor(purchase: PurchaseView, recipient: Recipient): PartyView;
export function viewFor(purchase: PurchaseView, recipient: Recipient): PartyView {
  const terms = checkedTerms(purchase.proposal.privacy);
  checkedAudience(purchase, terms);
  const funding = checkedCampaign(purchase, terms);
  checkedCharity(purchase, terms);
  if (recipient.facet === 'payer') {
    // The disclosure profile selects the projection — the ordinary
    // total-bearing view for benefit/split purchases, the allowlisted
    // fund view for a campaign.
    if (terms.source.kind === 'campaign') {
      // checkedCampaign only returns undefined for non-campaign terms.
      if (funding === undefined) throw new Error('privacy_profile_invalid');
      return fundPayerProjection(purchase, recipient.partyId, terms.source, funding);
    }
    return payerProjection(purchase, recipient.partyId, terms);
  }
  if (recipient.facet === 'payee') return payeeProjection(purchase, recipient.partyId, funding);
  if (recipient.facet === 'sponsor') return sponsorProjection(purchase, recipient.partyId, terms);
  // A facet outside the union is refused like any unentitled request.
  throw new Error('recipient_not_entitled');
}
