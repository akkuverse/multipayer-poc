# Party handles: the complete-share digest vs the field map

Date: 4 November 2026 · Status: open — for review

## Task that surfaced this

Introduce `partyHandle(w, purchaseId, partyId)` (`src/core/party-handle.ts`): a
live, read-only projection of a purchase through the party's column of
`views.ts` (payer → `payerView`, payee → `payeeView`, sponsor →
`sponsorView`, wrapped by `readonlyView`). The scenario signing helpers
(`approveAs`, `submitAs`, `cancelAs`, `refundAs`, `changeOfferAs`) then take a
handle instead of the raw `PurchaseView` — today they read
`p.proposal.*` directly, which hands the simulated party device data the
field map says it may not hold.

The spec instructed: extend `payerView` with exactly what a payer must sign
over (`proposalVersion`, `proposalExpiresAt`, and the share fields the
approval digest binds — assumed to be rail, payee, fee of the payer's own
share), **and check against `docs/field-map.md` first; if the digest needs
another payer's share detail, stop and report**. The check failed; work
stopped. This note records where the discussion stands.

## The conflict

`PayerApproval.sharesDigest` = `sharesDigestOf(proposal.shares)` — SHA-256
over the canonical JSON of the *complete ordered shares array*: every
share's `role`, `payerId`, `payeeId`, `amountCents`, `feeCents`, `rail`,
`authority` (`signing.ts`, `types.ts`). `approve()` recomputes it from the
retained shares and rejects a mismatch as `terms_mismatch`
(`coordinator.ts:1366`).

The field map's payer column says: other payers' shares → *combined only*;
payer identities → *own only*. A device holding only its field-map-compliant
view **cannot compute the digest it must sign**. The spec's premise — that
the digest binds only the payer's own rail/payee/fee — is false.

Everything else in the task is buildable from a permitted view:
submit/cancel/refund/change-offer need only `purchaseId`,
`proposalVersion`, and signer identity; the rest of `approveAs`'s fields are
already in or safely addable to `payerView`. The single blocker is
`sharesDigest`. (`approveAs` also reads `p.benefit.employeeId` on the
exception path; the signer can substitute its own id — not a blocker.)

## Analysis: "who may see shares" is four questions, not one

The field map's single "combined only" rule covers four distinct
relationships with different right answers:

| Relationship | Right answer | Why |
|---|---|---|
| Employee → employer's share | Visible (role + magnitude) | Employer is a legal person — no GDPR interest. The subsidy is the employee's *own benefit data* (payslip, Sachbezugswert tax). Every real meal-voucher scheme shows it. |
| Employer → employee's share | Hidden | The genuinely sensitive direction: employee spending to the employer (BDSG §26, power imbalance, minimisation must be structural). `sponsorView` already correct. |
| Peer → peer in a split | Fully visible incl. identities | The split *is* the deal — "I pay 13.34, you two pay 13.33." Cannot consent to terms you can't see; contract-necessary disclosure (Art. 6(1)(b)). |
| Payer → payee, anyone → strangers | Hidden | `payeeView` already right: funding composition is none of the merchant's business. |

Two sharp observations fell out of this:

- In the two-payer lunch, "combined only" hides almost nothing:
  `totalCents − ownCents` already leaks the employer's exact EUR 5. What the
  map *actually* protects is composition and identity (payerId, rail, fee,
  authority kind) — not magnitude.
- PSD2-style transparency requires the payer to see *their own* charges —
  already satisfied. Others' shares create no liability for the payer
  (never-shift invariant), so informed consent arguably needs "the rest is
  committed and can't migrate to me," not the detail.

## The charity scenario — why it matters beyond itself

Discussed use case: a donor publishes a standing mandate to subsidise
lunches for strangers an eligibility oracle attests are in need. Mutual
anonymity is a *requirement* (cf. caffè sospeso, hardship funds, sadaqah
tradition, SNAP/EBT stigma design).

It maps onto the core with two deltas — recorded for the backlog, **not**
for implementation now:

1. Beneficiary is an attested class, not a `beneficiaryRef` — needs a
   verified `EligibilityAttestation` document in the authority layer.
2. `sponsorView` must aggregate — per-purchase `merchantId + amount +
   timestamp` is a re-identification vector against an unknown stranger.

The load-bearing consequence for *this* fork: **under mutual anonymity, no
human party can legitimately see the complete share list at all**, yet the
digest still binds it. The charity case is an existence proof that "the
signer digested the shares they saw" was never a sound invariant — only an
accident of the employer being a visible sponsor.

## Options

- **A — view carries a coordinator-projected `sharesDigest`.** One opaque
  field on `payerView`; the device signs the commitment without recomputing
  it. Coordinator contract and field map untouched (digest is a new opaque
  field — needs a field-map line noting it as a commitment, not share
  data). Traces identical. Re-specifies the signature's meaning: "I
  countersign the coordinator's commitment to this allocation" rather than
  "I hashed what I saw."
- **B — per-share digest.** Digest only the payer's own shares. Restores
  honest "sign what you see," but changes the coordinator's verification
  contract (declared out of scope) and drops the complete-allocation
  binding — a payer's signature would no longer pin the other legs (the
  coordinator's own checks still do; what changes is what the signature
  *evidences*).
- **C — amend the field map to permit full shares.** Honest signing,
  untouched protocol — but relaxes minimisation and paints the charity case
  into a corner: payerIds are exactly what must stay hidden there, so the
  view would be re-split later anyway.
- **D — partial migration.** Migrate the four non-approval helpers now;
  leave `approveAs` on the raw record. Leaves the largest leak in place.

## Current position (to be challenged)

Option A, **with the payer view's share decomposition refined**: own shares
verbatim; others decomposed by *role + magnitude* (`employer: EUR 5`,
`diner-2: EUR 13.33`) rather than bare `othersCents`; no payerIds, no other
rails/fees. `sharesDigest` rides as the opaque wire-level commitment.

Rationale: splits the digest into two honest halves — machine-level terms
(the coordinator's commitment, which the digest genuinely binds) and
human-level terms (what the signer is told). It serves today's lunch, the
peer split (where roles may map to names socially anyway), and the donor
case, without touching the coordinator or the field map's intent.

## What a reviewer should pressure-test

1. Is "countersigning an opaque commitment" actually acceptable as a
   simulation claim? The current comments say the device "digests the exact
   ordered shares it shows" — under A it cannot, so that claim must be
   rewritten; is the PoC then still evidencing what it was built to show?
2. Role + magnitude decomposition: is showing `employer: EUR 5` an
   unacknowledged field-map amendment rather than a faithful projection?
   (Argued above that magnitude leaks anyway; a reviewer may disagree that
   role attribution is safe — e.g. multi-sponsor futures.)
3. Option B was rejected partly on scope, not merits. If the digest's
   meaning is being re-specified anyway, is that scope boundary still
   right? Per-share digests would make the signer-visible view and the
   signed terms coincide again.
4. Does adding `sharesDigest` to a *view* create a footgun — a stale
   projection could bind the signer to terms never shown? (Mitigation: the
   handle projects live per read, so the digest always reflects the current
   record — same freshness guarantee as `proposalVersion`.)
5. The charity deltas were parked in the backlog — is that the right call
   vs. shaping `authority: 'employer_mandate'` toward a general sponsor
   kind now?

## Open questions recorded for the backlog

- Fully-sponsored purchase (donor covers 100%): is a purchase with no
  `'payer'` share and no approver valid?
- `sponsorView` per-purchase granularity assumes the sponsor knows the
  beneficiary — false for anonymous donors; needs an aggregate reporting
  shape.
- `EligibilityAttestation` as a third verified-authority document type
  alongside employer/employee mandates.
- Should peer splits expose payer identities (the social contract) while
  benefit purchases stay role-labelled? The current position conflates them
  under role decomposition.
