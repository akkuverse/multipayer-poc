// GENERATED from src/core/privacy.ts — type-stripped build artifact; never hand-edit.





















// The closed profile catalog: literal, versioned identifiers. The suffix is
// the rules version — an existing profile's disclosure semantics never
// change in place; a different contract gets a new identifier.
 










































// Deep-freeze a plain-data value: resolution returns terms nothing — not the
// source object, not a later caller — can mutate.
const deepFreeze = (v) => {
  if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

const PRIVACY_PROFILES = ['employer_benefit_v1', 'split_bill_v1'];

// Resolve a verified signed source into frozen disclosure terms for one
// proposal. Explicit branches only: an unrecognized requested profile, a
// verified source whose own profile disagrees, an unconfigured or
// non-covering group are all refused — nothing is silently defaulted. The
// request itself can never supply group configuration or the audience a
// request might prefer over the committed shares.
export function resolveProfile(source) {
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
  if (source.requested !== 'split_bill_v1') throw new Error('privacy_profile_unsupported');
  if (!source.group || source.group.groupRef !== source.groupRef) throw new Error('split_group_unknown');
  if (source.group.privacyProfile !== source.requested) throw new Error('privacy_profile_mismatch');
  // The actual purchase audience: the distinct payers the shares name — the
  // group's whole membership is never disclosed. A group may cover any
  // subset of its members, so every participant must belong.
  const participants = [...new Set(source.payerIds)];
  if (participants.length === 0 || participants.some((id) => !source.group.memberIds.includes(id))) {
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












































































// Which payer an authorization record belongs to.
const authorizationPayer = (a) => (a.basis === 'mandate' ? a.payerId : a.approval.payload.payerId);

// Validate that retained terms are a well-formed member of the closed
// union before any projection is built on them — a corrupted record is
// refused as privacy_profile_invalid, never reinterpreted or defaulted.
const checkedTerms = (t) => {
  const nonempty = (v) => typeof v === 'string' && v.length > 0;
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
      (t.source.kind === 'request_only' && t.profile === 'employer_benefit_v1') ||
      (t.source.kind === 'known_group' &&
        t.profile === 'split_bill_v1' &&
        nonempty(t.source.groupRef) &&
        Array.isArray(t.source.participantIds) &&
        t.source.participantIds.length > 0 &&
        t.source.participantIds.every(nonempty)));
  if (!valid) throw new Error('privacy_profile_invalid');
  return t;
};

// The distinct payers the committed shares name — the frozen audience a
// projection may disclose to, in share order.
const distinctPayers = (p) => [...new Set(p.proposal.shares.map((s) => s.payerId))];

// A known-group split's frozen audience must match the actual distinct
// share payers: terms naming fewer, more or different participants than the
// shares they claim to cover are inconsistent — refused, never quietly
// narrowed or broadened.
const checkedAudience = (p, terms) => {
  if (terms.source.kind !== 'known_group') return;
  const actual = new Set(distinctPayers(p));
  const frozen = terms.source.participantIds;
  if (frozen.length !== actual.size || new Set(frozen).size !== frozen.length || frozen.some((id) => !actual.has(id))) throw new Error('privacy_profile_invalid');
};

const payerProjection = (p, payerId, terms) => {
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
  const view = {
    purchaseId: p.purchaseId,
    state: p.state,
    merchantId: p.proposal.merchantId,
    totalCents: p.proposal.totalCents,
    ownCents,
    ownFeeCents: own.reduce((t, s) => t + s.feeCents, 0),
    othersCents: p.proposal.totalCents - ownCents,
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
    authorizationRef: auth === undefined || auth.basis === 'mandate' ? undefined : auth.approval.payload.approvalRef,
    returnStatus: p.returnStatus,
    // Once a settlement snapshot exists the money truth comes from its
    // per-leg evidence — compensation returns charged fees too, so a
    // 'returned' leg does not imply a retained fee. The leg-status math is
    // only the pre-submission fallback, before any snapshot exists.
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
  return view;
};

const payeeProjection = (p, payeeId) => {
  // The merchant of record or an actual share payee — anyone else learns
  // nothing. No profile id, payer identity or funding explanation ever
  // appears on this view.
  if (p.proposal.merchantId !== payeeId && !p.proposal.shares.some((s) => s.payeeId === payeeId)) {
    throw new Error('recipient_not_entitled');
  }
  const legs = p.legs.filter((l) => l.payeeId === payeeId);
  return {
    purchaseId: p.purchaseId,
    state: p.state,
    receivedCents: legs.filter((l) => l.status === 'settled').reduce((t, l) => t + l.amountCents, 0),
    contributions: legs.map((l) => ({ executionRef: l.executionRef, amountCents: l.amountCents, status: l.status })),
  };
};

const sponsorProjection = (p, sponsorId, terms) => {
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
// a detached view. Facet overloads keep each caller's typed result.




export function viewFor(purchase, recipient) {
  const terms = checkedTerms(purchase.proposal.privacy);
  checkedAudience(purchase, terms);
  if (recipient.facet === 'payer') return payerProjection(purchase, recipient.partyId, terms);
  if (recipient.facet === 'payee') return payeeProjection(purchase, recipient.partyId);
  if (recipient.facet === 'sponsor') return sponsorProjection(purchase, recipient.partyId, terms);
  // A facet outside the union is refused like any unentitled request.
  throw new Error('recipient_not_entitled');
}
