# Field map

Status: **22 October 2026, updated 5 November 2026.** Which party may legitimately see which purchase field, and why. `viewFor` in `src/core/privacy.ts` implements the party columns as projections — currently a subset of what the map permits (for example, the employee's own mandate *reference* is permitted but deliberately withheld; only the observed revision is surfaced). The payer column is split by the purchase's signed disclosure profile (see [Signed disclosure profiles](#signed-disclosure-profiles) below): a benefit purchase runs under `employer_benefit_v1`, a peer split under `split_bill_v1`. Tests in `test/privacy.test.ts` pin the per-profile disclosure contract; `test/views.test.ts` retains the shared projection arithmetic. "Settlement" is what the orchestrator's `SettlementIntent` hands to providers: leg terms and routing only — signed authority stays with the coordinator.

| Field | Purpose | Payer — `employer_benefit_v1` | Payer — `split_bill_v1` | Payee (merchant) | Employer (sponsor) | Settlement |
|---|---|---|---|---|---|---|
| purchaseId | Group the contributions of one purchase | yes | yes | yes | yes | yes, as purchaseId/purchaseRef |
| state | Completion, pending, recovery | yes | yes | yes | no; own leg status only | snapshot phases only |
| merchantId | Eligibility and display | yes | yes | itself | yes, eligibility evidence | yes, as payeeId per leg |
| totalCents | Check that the shares add up | yes | yes | as the sum of its own legs | no | no |
| Own share | What this party pays or contributes | yes | yes | no | yes | principalCents per leg |
| Payer fee | Paid to the payer's own PSP, bound in the approval; part of the fee-inclusive employee debit | own only | own only | no | no | feeCents per leg |
| Other payers' shares | Check that the total is covered | combined only | the actual participants' principal contributions, itemized as `{ payerId, amountCents }` in share order under the group agreement — never their fees, rails, routing or authority records | no | no | the intent's other legs |
| Payer identities | Debit the right account; disclose the split's participants | own only | the actual purchase participants only — the group's wider membership is never disclosed | no | no | payerId per leg at providers; pseudonyms on the DE ledger |
| Employee standing terms | Ordinary maximum, automatic per-purchase/monthly limits, trusted/blocked merchants, expiry, revocation | own only — limits, lists and revision, never the mandate reference or signature | n/a — a split carries no employee assessment | no | no | no |
| Employee assessment | The current authorization answer for this purchase: zone (`Blocked`/`Auto`/`Confirm`/`Exception`), fee-inclusive debit, reason it is not Auto | own only | n/a | no | no | no |
| Authorization basis + reference | Which authority funded this payer's shares: device signature (approvalRef), signed one-off exception (approvalRef) or standing terms (no reference surfaced) | own only | own only | no | no | the leg's authority kind only — never the signed record |
| Disclosure profile | Which signed disclosure contract the proposal froze — a payer needs it to understand and approve the arrangement | yes (`employer_benefit_v1`) | yes (`split_bill_v1`) | no — a profile ID on the payee view would reveal funding composition | no | no |
| Employer mandate reference | Authority evidence | no | no | no | own mandate | no |
| executionRef | Status queries and returns | own legs | own legs | own legs | no | provider operation references |
| idempotencyKey | Safe retries | no | no | no | no | yes, as operation keys |
| Benefit eligibility and usage | Decide the employer share | no | no | no | own mandate's usage | admitted budget metadata only |
| Automatic-payment usage | The employee's monthly reserved/consumed automatic budget | own only; not yet surfaced as a raw figure — visible today only through the assessment's `monthly_cap` reason | n/a | no | no | admitted budget metadata only |
| Return outcome | Return status plus confirmed returned principal, kept separate from settlement | own legs | own legs | own legs' contribution status | own contribution's returned status | yes, as the provider refund outcome |
| Unreturned fee | The charged fee a principal-only return never gives back — reported separately so "principal returned; fee retained" is not folded into returned principal | own only | own only | no | no | `retainedFeeCents` on the snapshot |
| Auto receipt | The one receipt a mandate-authorized completed purchase earns: observation time, original amounts, used terms revision, fixed dispute deadline | own only (time, deadline, used mandate version — not the mandate reference) | n/a | no | no | no |
| Dispute case | The employee's accepted dispute and its return-request outcome (`opened`/`unresolved`/`unsupported`/`returned`) | own only | own only | no | no | no |

Finding: the settlement layer needs no benefit or authority information beyond each leg's authority kind to settle, so benefit conditions stay in the application. The employer never sees the purchase total, the employee's share, the employee's standing terms or automatic budget, or other purchases.

## Signed disclosure profiles

Every proposal freezes one member of a closed, versioned catalog — `employer_benefit_v1` or `split_bill_v1` — resolved from signed sources at admission and held on `Proposal.privacy` for the version's whole life. The suffix is the rules version: an existing profile's disclosure semantics never change in place. `resolveProfile()` in `src/core/privacy.ts` is the only resolution path; `viewFor()` is the only public projection entry point. Neither privacy resolution nor a projection ever grants spending authority, reserves money or initiates settlement.

**Who signs the profile.** The employer signs `privacyProfile: 'employer_benefit_v1'` inside its `EmployerMandate`. The split creator signs `privacyProfile: 'split_bill_v1'` plus a `disclosureGroupRef` in the initial split request. Each payer signs the profile again in their `PayerApproval` (split approvals additionally carry the group reference), and the coordinator compares it against the frozen terms both at approval and at authorization revalidation — a mismatch is `terms_mismatch`, never a reinterpretation.

**Source precedence and `request_only`.** Resolution works on already signature-verified records, not caller claims: a benefit request's signed profile must equal the verified mandate's own signed profile, and a split request's group reference must resolve to a configured group that covers the actual share payers. When no usable verified mandate exists, the signed restrictive profile alone resolves to conservative `request_only` terms — no employer share is authorized and no sponsor entitlement exists — while a verified mandate carrying an invalid profile is refused outright (`mandate_privacy_profile_invalid`) rather than masked by that fallback. Selecting a profile, and the disclosure agreement itself, conveys no spending authority: each payer still authorizes only their own shares under the existing authority rules.

**The known-group agreement.** `split_bill_v1` peer disclosure exists only under an explicit, existing group disclosure agreement supplied as trusted configuration (`CoordinatorOptions.knownSplitGroups`, default `colleagues-v1` in the fixtures): an existing group whose members may share their identities and principal contribution amounts within that group. It is a separate configuration input — a signed request can select a group but never install or amend one — and registration alone is not that agreement. A group may cover any purchase subset of its members; every distinct payer must belong to the named group *and* hold a registered identity key, or the request is refused before any purchase exists (`split_group_unknown`, `split_participant_unknown`, `split_group_mismatch`).

**Frozen actual audience.** The disclosed audience is frozen as the distinct payer IDs the committed shares name — a projection shows the actual purchase participants, never the group's whole membership, and `viewFor` refuses frozen terms that no longer match the shares. A roster change means a new split proposal and fresh payment authority; repricing a live split stays unsupported.

**Merchant profile-ID exclusion.** The payee view keeps its existing shape and carries no profile ID: naming `employer_benefit_v1` to the merchant would reveal funding composition. No payer identity or funding explanation appears on it either way.

**Identity enrollment assumption.** Recipient identity is trusted caller context from the session/fixture — a party ID parameter is not a login mechanism; this local PoC still assumes identity and key enrollment. A party holding several legitimate roles requests each facet separately; no facet unions another's data.

**Agent restrictions unchanged.** The agent handle still holds only `discover`, `evaluate`, `selectOffer` and `explain`; it never selects a disclosure profile (presenter benefit requests carry the fixed `employer_benefit_v1`), and no group membership, raw mandate or spending capability reaches the agent interface. `Coordinator.view()` and trusted evaluator snapshots remain raw internal surfaces — evaluator evidence, never offered to agents or represented as privacy-filtered reads.

## Presenter projections

The scripted synthetic presenter (`src/presenter/session.ts`) adds a further-reduced projection for the employee-side recipient and the agent handle. These fields are *safe eligibility results* — the outcome of policy and assessment evaluation — not the underlying policy, mandate or usage data behind them.

| Field | Content | Agent handle | Employee recipient |
|---|---|---|---|
| OfferView | Sourced catalog fields (offer reference, title, tags, price, availability, source, walking time) plus retrieval time | yes | yes |
| QuoteView amounts | Deterministic split from `Coordinator.quote`: own share, combined other contributions, own fee | yes | yes |
| QuoteView assessment | Current `authZone` and `autoPayBlockedReason`, the standing maximum (absent means never published — never an infinite limit), the observed mandate version | yes | yes |
| reasons | Safe eligibility result, allowlist only: `benefit_unavailable`, `merchant_ineligible`, `merchant_blocked`, `personal_limit_exceeded`, `offer_expired`, `approval_expired` | yes | yes |
| PresenterView | Payer view plus selected offer, proposal version/expiry, observed assessment and recorded authorizations | yes | yes |
| RecordedAuthorizationView | Basis (`device`, `exception`, `mandate`), the employee's own approvalRef for signed bases or the cited standing-terms revision for mandate basis, proposal version, whether it binds the current proposal and is currently valid — never the signature or key | yes | yes |
| EmployeeTermsView | The employee's own standing terms: limits, merchant lists, expiry, revocation, revision — never the mandate reference, signature or key | no — trusted user flow only | yes |
| eventSeqs | Observation references into the audit trace; they grant no access to the raw records behind them | yes | yes |

Session observation events retain detached copies of the safe projections, with the assessment and, for discovery, the applied preferences. Agent results reference only these observation events. Trusted user-flow results may additionally reference coordinator/settlement audit events for evaluator use. The trusted `snapshot()` export remains a detached raw purchase for run recording; it is never exposed as an agent observation. A third trusted handle, `runner`, advances the session purchase deterministically; it is never offered as an agent tool.

Never surfaced through recipient projections: mandate references (employee or employer), signatures and keys, raw ledger usage, operation keys or unfiltered settlement errors. The presenter only runs `employer_benefit_v1` purchases, so other payers' identities stay hidden here too; a known-group split discloses the actual participants only to the split's own payers as the profile rules above describe. Neither handle exposes the coordinator, the live purchase or the raw trace. The employee's standing terms and monthly automatic usage are visible to the employee's own surfaces only — the employer's minimisation above is unchanged: it still sees its own contribution and eligibility evidence, never the purchase total, the employee's share or other purchases.
