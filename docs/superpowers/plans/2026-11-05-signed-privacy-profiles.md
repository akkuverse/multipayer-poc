# Signed Privacy Profiles Implementation Plan

> **For agentic workers:** Use an available task-by-task execution workflow only when implementation is explicitly requested. Checkboxes describe future work. This plan does not authorize code changes, removal of the interrupted patch, delegation, commits or publication.

**Goal:** Bind versioned disclosure rules to signed employer mandates and signed split proposals, with splits restricted to known participants under an explicit existing group disclosure agreement.

**Architecture:** A deep privacy module owns supported profile resolution, recipient entitlement checks and detached projections through one interface. The coordinator admits signed sources and freezes their resolved privacy terms with the proposal; authority verification and settlement keep their existing responsibilities. A split proposal selects a profile and a trusted known-group reference, not a spending mandate or an open invitation.

**Tech Stack:** Node.js >= 23.6, native TypeScript stripping, `node:crypto`, `node:test`, pnpm; no dependencies, build step, network calls or personal data.

**Status:** Planning only. The interrupted implementation was discarded on the user's explicit instruction after its recorded fingerprints were verified. Source and test files are restored; documentation is preserved. No implementation of this plan has started. The committed baseline is `54124808e66c2c628fa845feb2185a6236f36a66`.

**Inputs:** The user's agreed design in this conversation; [existing party-handle discussion](../specs/2026-11-04-party-handles-share-visibility.md), which remains an open discussion rather than the selected solution; [field map](../../field-map.md); [deferred cryptographic research](../../research/2026-11-05-private-allocation-verification.md), tracked separately in [issue #1](https://github.com/akkuverse/multipayer-poc/issues/1).

## Scope and decisions

1. Support exactly `employer_benefit_v1` and `split_bill_v1`. The suffix is the rules version, not a mandate revision. Never change an existing profile's disclosure semantics in place.
2. The employer signs its profile inside `EmployerMandate`. A signed benefit request names its requested profile and mandate reference; a verified mandate must agree. The request cannot select split disclosure for an employer benefit.
3. A split creator includes `privacyProfile: 'split_bill_v1'` and `disclosureGroupRef` in the first signed split request. The coordinator already requires that creator to be one of the payers. Other payers still authorize their own spending under existing rules.
4. Every split payer must be a known registered identity and covered by the selected trusted group's disclosure agreement. No unnamed slots, arbitrary audiences, public links, broadcasting, invitation delivery or participant discovery.
5. **Planning assumption A1:** the trusted fixture/session models an existing agreement allowing the known group's members to share their identities and principal contribution amounts within that group. Registration alone is not that agreement. The agreement is a separate explicit configuration input, not a boolean supplied by the proposer. It conveys no spending authority. The user has accepted known participants; the existing-agreement model is the narrow recommendation, not a claim that consent infrastructure exists today.
6. Do not carry forward `acceptPrivacy`, `PrivacyAcceptanceRequest`, `PrivacyConsent`, `privacyConsents`, `sharing.accepted`, `sharing.ready` or automatic inference of disclosure permission from payment approvals. An individual acceptance flow would require a separate product decision.
7. Freeze the actual purchase audience as the distinct payer IDs named in the shares. A group may permit subsets of its known members, but projections disclose only the actual purchase participants, never the group's whole membership. Roster changes require a new split proposal and fresh payment authority; existing split repricing remains unsupported.
8. Merkle trees, ZK, own-share digests, a cryptographic framework, anonymous charity, mixed arrangement purchases, shared employer policy/eligibility credentials, real identity enrollment and migration of signing helpers to party handles are outside this plan.
9. Existing payment semantics remain: integer cents, all required legs settled before completion, no shifting a failed employer share onto the employee, original retry keys, and timeout means uncertainty. Privacy resolution and reads never grant spending authority, reserve money or initiate settlement. Agents remain limited to their existing information/proposal grants.

### Disclosure contracts

| Recipient | `employer_benefit_v1` | `split_bill_v1` |
| --- | --- | --- |
| Payer | Existing payer fields: total, own amount/fee and own leg details; other funding combined; no employer identity, mandate record or routing. | Same own fields, plus actual participant IDs and principal contribution amounts under the known-group agreement. No other payer's fees, rails, routing, signatures or authority records. |
| Sponsor | Its mandate reference, merchant, contribution and own status; no total, employee debit, standing terms, automatic budget or other purchases. | No sponsor facet. |
| Payee | Its own receipts/status and existing contribution references only; no payer identities or funding explanation. | Same restriction. |
| Outsider/wrong facet | Refuse the projection. | Refuse the projection. |

Keep principal contributions itemized by the proposal's stable share order using `{ payerId, amountCents }`; do not project arbitrary free-text `role` values into the shared list. A payer may have several shares. The signed complete-share commitment continues to bind their exact allocation; profile rules do not change amount calculation.

Profile IDs are visible where needed to understand/approve the arrangement, not automatically on every view. In particular, adding `employer_benefit_v1` to a merchant view would reveal funding composition. Preserve the payee view's existing output shape.

## Current code facts and useful patch ideas

At the committed baseline, `propose` and `quote` already take one mandate reference; `proposeSplit` handles explicit/equal splits without a benefit mandate. `AuthorityRegistry` validates and verifies employer records; `VerifiedAuthority` rechecks them in a synchronous decision. `views.ts` exports three independent projections. `payerView` checks payer membership, while payee/sponsor projections rely more heavily on trusted caller context. `approveAs` reads the raw `PurchaseView` and hashes the complete ordered shares array; the coordinator checks that digest at approval and revalidation.

Preserve these ideas from the interrupted patch as requirements, not code to retain wholesale:

- Literal, versioned profile identifiers and a closed catalog.
- Profile references signed in employer mandates, split requests and approvals, and frozen on proposals.
- Missing/unsupported/incompatible profiles rejected rather than silently defaulted at signed entry points.
- Profile-aware projections and safe shared principal amounts.
- Profile context in trusted `LOCAL` audit evidence and a fixture-version change on eventual delivery.
- A distinct rule that disclosure permission is not spending permission.

Discard the patch's acceptance state machine, its shallow catalog of `combined`/`itemized` flags spread across callers, profile IDs on payee views, duplicate sharing checks, unconditional selection of an employer profile from a label, and any claim that its tests passed. The last observed full run failed; corrections were not rerun.

## Deep module, interface and file ownership

Create `src/core/privacy.ts` as the public privacy module. Move the existing recipient view interfaces and projection implementations there, replacing `views.ts` after migrating its consumers. Do not keep two public projection paths or introduce a facade that merely forwards to the old unchecked functions.

The intended interface is small:

```ts
export type PrivacyProfileId = 'employer_benefit_v1' | 'split_bill_v1';

export interface KnownSplitGroup {
  groupRef: string;
  privacyProfile: 'split_bill_v1';
  memberIds: readonly string[];
}

export type PrivacySource =
  | { kind: 'employer_mandate'; requested: unknown;
      mandate: DeepReadonly<EmployerMandate> | undefined }
  | { kind: 'split_request'; requested: unknown; groupRef: string;
      payerIds: readonly string[]; group: KnownSplitGroup | undefined };

export type Recipient = {
  partyId: string;
  facet: 'payer' | 'payee' | 'sponsor';
};

export function resolveProfile(source: PrivacySource): PrivacyTerms;
export function viewFor(purchase: PurchaseView, recipient: Recipient): PartyView;
```

`DeepReadonly`, `EmployerMandate` and `PurchaseView` are existing types from `types.ts`. `PartyView` is the union of the moved `PayerView`, `PayeeView` and `SponsorView`; use facet overloads to retain the presenter's typed payer result. Define `PrivacyTerms` in `types.ts` as the discriminated union below; all cross-imports between domain types and privacy types must be `import type`, avoiding runtime cycles.

```ts
export type PrivacyTerms =
  | { profile: 'employer_benefit_v1'; source: {
      kind: 'employer_mandate'; mandateRef: string;
      mandateVersion: number; employerId: string;
    } }
  | { profile: 'employer_benefit_v1'; source: {
      kind: 'request_only';
    } }
  | { profile: 'split_bill_v1'; source: {
      kind: 'known_group'; groupRef: string;
      participantIds: string[];
    } };
```

`resolveProfile` receives already signature-verified source records from the coordinator; it does not authenticate employers or signers itself. It validates the profile/source combination, checks known-group membership, clones its inputs and returns frozen proposal terms. Construction copies and freezes trusted group configuration; request payloads never install or amend that configuration.

`viewFor` checks the frozen profile/source consistency and validates the requested facet against retained records before emitting a detached projection. Payer requires an own `authority: 'payer'` share; payee requires being the merchant of record or an actual share payee; sponsor requires the frozen employer source naming that employer. Never infer ownership from a `role` label or the latest mandate. Handle a party occupying multiple legitimate roles through explicit, individually validated facets, not a union that exposes all information automatically.

Recipient identity comes from the trusted session/fixture. A string parameter is not a login mechanism; this local PoC still assumes identity/key enrollment. `Coordinator.view()` and trusted evaluator snapshots remain raw internal/evaluation surfaces and are never offered to agents or represented as privacy-filtered reads.

| File | Responsibility |
| --- | --- |
| `src/core/privacy.ts` (new) | Closed profile resolution, group/source checks, recipient entitlement and detached projections; exports the small interface above. |
| `src/core/views.ts` | Remove after moving interfaces/projections and migrating all consumers. |
| `src/core/types.ts` | Signed profile/group fields, `PrivacyTerms`, proposal storage and approval bindings. |
| `src/core/authority.ts`, `src/core/verified-authority.ts` | Existing signature/revision verification; employer profile validation at publication and use. |
| `src/core/coordinator.ts` | Trusted groups in `CoordinatorOptions`, source admission, frozen proposal terms, profile/group checks at approval and revalidation; existing state/settlement ownership. |
| `src/scenarios.ts` | Explicit synthetic group agreement, signed helper payloads, world/coordinator wiring and fixture version. |
| `src/presenter/session.ts` | Use the privacy interface for employee observations and supply the profile on signed benefit requests; retain the restricted agent surface. |
| `test/privacy.test.ts` (new) | Owns source resolution and recipient disclosure contracts through the module interface. |
| Existing signing/request/presenter tests | Own signature, lifecycle and transport-specific risks at their current seams. |

## Binding, errors and lifecycle

- `EmployerMandate.privacyProfile` is required and must be `employer_benefit_v1`. Revisions still follow the registry's existing ownership and sequence checks. Signed records without a recognized profile cannot authorize new work; no compatibility branch assigns meaning to an old signature.
- `ProposeRequest.privacyProfile` is required and must be `employer_benefit_v1`. Resolve a usable verified mandate's profile and compare it. `SplitRequestBase` requires `privacyProfile: 'split_bill_v1'` plus nonempty `disclosureGroupRef`.
- `Proposal.privacy: PrivacyTerms` is required. Store a detached copy only through `commitProposal`; `changeOffer` preserves the profile, source and audience rather than resolving new disclosure rules from the latest mandate. A fresh purchase resolves a fresh source. Revalidation can refuse funding under changed authority without changing what historic parties may see.
- `PayerApproval.privacyProfile` is required; split approvals also carry `disclosureGroupRef`. Compare them against frozen `Proposal.privacy` at both `approve` and `authorizationRefusal`. Benefit approvals carry no group reference. The signed complete-share digest already binds the roster; keep its existing algorithm and checks.
- A requested profile must be known even when no employer funding is available. Preserve existing missing/invalid-mandate amount behavior by resolving only the signed, restrictive employer profile to `request_only`, with no employer share authorized and no sponsor entitlement. Do not reinterpret an unsupported requested profile or a verified mandate's incompatible profile as this fallback. Quotes remain non-authorizing and keep existing amount/refusal behavior.
- A known-group reference is trusted configuration, not self-certified permission. The coordinator first verifies the split request, validates share shape, resolves the configured group and ensures every distinct payer belongs to it and has a registered identity key. An empty/unrecognized/missing group, outsider or unknown payer is refused before `commitProposal`, proposer approval or settlement.
- Use `privacy_profile_unsupported`, `privacy_profile_mismatch`, `split_group_unknown`, `split_participant_unknown` and `split_group_mismatch` for admission failures; preserve `request_refused` with `LOCAL` origin for signed-request failures. Malformed employer profiles use the registry's existing `malformed` refusal. Approval mismatches retain `terms_mismatch`. Projection errors are `recipient_not_entitled` or `privacy_profile_invalid`; never return a permissive default view.
- `viewFor` must not perform a write, read a live registry or return mutable references into retained records. Privacy admission has no budget or payment effects. Ordinary profile/group metadata belongs in trusted proposal audit events; raw traces remain evaluator evidence, not recipient messages.

Distinguish a missing/unverifiable mandate from a verified record with invalid privacy terms. `VerifiedAuthority.employer` reports the latter as `mandate_privacy_profile_invalid`. The proposal entry point must refuse that problem before passing an absent mandate to `resolveProfile`; otherwise the `request_only` case would accidentally mask incompatible signed terms. Normal absent/unverifiable authority continues through existing zero-contribution handling, and quotes retain their existing non-authorizing semantics. At submission/first handoff, the same problem refuses employer authority rather than rewriting the retained privacy terms or shifting its share.

This work does not resolve the earlier restricted-view signing issue. Signing helpers remain privileged synthetic device fixtures accessing the raw purchase; rewrite their misleading claim that they hash only displayed fields. Do not claim independent correspondence verification, anonymity against the coordinator, or a completed party-handle migration. The cryptographic research issue remains deferred.

## Execution tasks

### Task 0: Preserve findings, then discard only the interrupted patch

**Cleanup completed:** The exact recorded patch was reversed and its new module removed on explicit user instruction. Backups are in the `/tmp` paths below. Skip the cleanup operations already completed; baseline test/scenario validation remains future work.

**Files:** The 14 modified source/test files listed below and untracked `src/core/privacy-profiles.ts`. Preserve all documentation and any subsequent user work.

- [x] Inspect `rtk git status --short` and `rtk git diff -- src test`. Compare with the interrupted patch: source files `authority.ts`, `coordinator.ts`, `types.ts`, `views.ts`, `presenter/session.ts`, `scenarios.ts`; tests `defects`, `employee-mandate`, `presenter-session`, `purchase-store`, `run-record`, `signed-requests`, `signing`, `views`. Stop if new edits overlap; do not restore them wholesale.
- [x] Compare exact raw diff bytes for the ordered allowlist below with recorded SHA-256 `310a0c6f790f4635d7403371c751d2ead9ae2ee330dceaf24c16475e5f531b38`; compare the new module's bytes with `e265dccf3578dd0216fb606ea1e6040020050d13e9ce58db7ab8410f7aa9b5bd`. If either differs, reconcile ownership manually. These hashes identify the planning-time patch, not permanent source contracts.
- [x] Retain an exact patch and the new module outside the repo before removing anything. These commands are future execution instructions, not planning-time actions:

```bash
rtk proxy git diff --binary -- src/core/authority.ts src/core/coordinator.ts \
  src/core/types.ts src/core/views.ts src/presenter/session.ts src/scenarios.ts \
  test/defects.test.ts test/employee-mandate.test.ts test/presenter-session.test.ts \
  test/purchase-store.test.ts test/run-record.test.ts test/signed-requests.test.ts \
  test/signing.test.ts test/views.test.ts > /tmp/multipayer-interrupted-privacy.patch
rtk proxy cp src/core/privacy-profiles.ts /tmp/multipayer-interrupted-privacy-profiles.ts
```

- [x] Reverse only the verified assistant patch, using `rtk proxy git apply --reverse /tmp/multipayer-interrupted-privacy.patch`, then remove only the verified assistant-created `src/core/privacy-profiles.ts`. Preserve `README.md`, `docs/backlog.md`, this plan, the research brief and the pre-existing party-handle document. Do not use a whole-tree reset, checkout or clean.
- [x] Establish the clean code baseline with `rtk pnpm test` and `rtk pnpm scenarios`. Record counts/outcomes rather than copying the interrupted run's numbers. If baseline fails, diagnose separately before treating it as a privacy regression.

### Task 1: Build the privacy module around observable disclosure

**Create:** `src/core/privacy.ts`, `test/privacy.test.ts`. **Modify:** `src/core/types.ts`. Tasks 1–3 form one coordinated cutover; do not commit or publish a partially migrated signed contract.

- [x] Add the literal profile types, `KnownSplitGroup`, `PrivacySource`, `PrivacyTerms`, `Recipient` and facet overloads specified above. Move the existing projection arithmetic unchanged into private implementations in `privacy.ts`; define `viewFor` as the only new public projection entry point.
- [x] Implement resolution with explicit branches, not caller-supplied field lists. The core branch shape is:

```ts
if (source.kind === 'employer_mandate') {
  if (source.requested !== 'employer_benefit_v1') throw new Error('privacy_profile_unsupported');
  if (source.mandate && source.mandate.privacyProfile !== source.requested) {
    throw new Error('privacy_profile_mismatch');
  }
  return source.mandate
    ? { profile: 'employer_benefit_v1', source: {
        kind: 'employer_mandate', mandateRef: source.mandate.mandateRef,
        mandateVersion: source.mandate.version, employerId: source.mandate.employerId,
      } }
    : { profile: 'employer_benefit_v1', source: { kind: 'request_only' } };
} else {
  if (source.requested !== 'split_bill_v1') throw new Error('privacy_profile_unsupported');
  if (!source.group || source.group.groupRef !== source.groupRef) throw new Error('split_group_unknown');
  if (source.group.privacyProfile !== source.requested) throw new Error('privacy_profile_mismatch');
  const participants = [...new Set(source.payerIds)];
  if (participants.length === 0 || participants.some((id) => !source.group!.memberIds.includes(id))) {
    throw new Error('split_group_mismatch');
  }
  return { profile: 'split_bill_v1', source: {
    kind: 'known_group', groupRef: source.groupRef, participantIds: participants,
  } };
}
```

- [x] Employer-source success constructs `{ profile: 'employer_benefit_v1', source: { kind: 'employer_mandate', mandateRef: mandate.mandateRef, mandateVersion: mandate.version, employerId: mandate.employerId } }`; the absent verified mandate constructs `{ profile: 'employer_benefit_v1', source: { kind: 'request_only' } }`. Source verification belongs to the coordinator/authority modules.
- [x] Extend `PayerView` with `privacyProfile` and optional `sharedContributions: { payerId: string; amountCents: Cents }[]`. Emit shared contributions only for an admitted known-group split. Validate its frozen participants match the actual distinct share payers. Keep merchant view fields unchanged and employer view restricted to the signed employer provenance.
- [x] Add contract tests before implementation using admitted purchases from Task 2 fixtures. Assert exact hand-written shared contributions, restricted benefit output, detached nested arrays, wrong facet/outsider refusal, and no sponsor projection from `request_only`. Existing return/fee/receipt arithmetic stays covered by moved view tests, not duplicated.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, EMPLOYEE, EMPLOYER, COLLEAGUE_1, COLLEAGUE_2 } from '../src/scenarios.ts';
import { viewFor } from '../src/core/privacy.ts';

test('a known-group split discloses principal shares only to entitled payers', async () => {
  const { p } = await scenarios.find((s) => s.id === 'S03-bill-split')!.run();
  const peerView = viewFor(p, { partyId: COLLEAGUE_1, facet: 'payer' });
  assert.deepEqual(peerView.sharedContributions, [
    { payerId: EMPLOYEE, amountCents: 1_334 },
    { payerId: COLLEAGUE_1, amountCents: 1_333 },
    { payerId: COLLEAGUE_2, amountCents: 1_333 },
  ]);
  assert.throws(() => viewFor(p, { partyId: EMPLOYER, facet: 'payer' }), /recipient_not_entitled/);
});
```

**Focused command after Task 3:** `rtk pnpm exec node --test test/privacy.test.ts test/views.test.ts`. Expected: both suites pass; no fixture raw trace is exposed to a recipient.

### Task 2: Admit signed profiles and known groups, then freeze their terms

**Modify:** `src/core/authority.ts`, `src/core/verified-authority.ts`, `src/core/coordinator.ts`, `src/core/types.ts`, `src/scenarios.ts`; existing `test/signing.test.ts`, `test/signed-requests.test.ts`, `test/verified-authority.test.ts`, `test/split.test.ts`, `test/quote.test.ts`.

- [x] Require the signed fields described under Binding. Registry publication rejects a missing, unknown, charity or split profile on an employer mandate before replacing any accepted record. `VerifiedAuthority` must not report a retained signed employer record with an unsupported profile as usable; retain content-based memoization and no cross-operation cache.
- [x] Extend `CoordinatorOptions` with `knownSplitGroups?: readonly KnownSplitGroup[]`. Clone/freeze the provided records on construction. Index by unique nonempty `groupRef`; reject duplicate references and malformed member arrays. This is explicit synthetic disclosure-agreement configuration, not a new authority registry or network service.
- [x] Make `world()` explicitly supply a `colleagues-v1` group whose members are `EMPLOYEE`, `COLLEAGUE_1`, `COLLEAGUE_2`, allowing any purchase subset under the same profile. Add `knownSplitGroups` to `WorldOptions` and retain a detached copy on `World` so `coordinatorFor` can pass the same explicit configuration; helpers must not manufacture consent/group membership from whatever a request happens to contain. Fixture overrides with no groups must genuinely admit no split groups.
- [x] Preserve technical split coverage that uses the `EMPLOYER` fixture as an ordinary payer. In `test/invariants.property.test.ts`, `test/coordinator-concurrency.test.ts` and the split cases in `test/defects.test.ts`, configure an explicit additional `{ groupRef: 'employee-employer-fixture', privacyProfile: 'split_bill_v1', memberIds: [EMPLOYEE, EMPLOYER] }` and name that reference in those split requests. Keep the normal colleagues group unchanged. This is a test's stated disclosure agreement, not an inferred employer-benefit arrangement; its bank/DE failure cases must still reach their original settlement guards.
- [x] In `propose`, after existing caller/delegation verification, call `resolveProfile` using the signed requested profile and `scope.employer(mandateRef).mandate`. In `proposeSplit`, after signature and share-shape checks, resolve the trusted group and reject unregistered payer identities before committing. Use distinct payer IDs so a payer with multiple legs is checked once. A role string grants no membership.
- [x] Preserve the employer resolution's problem code until after checking for `mandate_privacy_profile_invalid`; refuse it instead of converting it to `request_only`. Keep the existing `resolveBenefit`/first-handoff refusal paths for invalid spending authority. Known-payer checks consult registered key holders without invoking signature verification again, preserving the existing synchronous-scope verification contract.
- [x] Pass `privacy: resolvedTerms` into `commitProposal`; it copies nested provenance/audience as well as shares. Log `privacyProfile` and, for splits, the group reference in the trusted `proposal` event. Keep `request_only` conservative when no employer authority is usable; it never authorizes an employer debit.
- [x] Preserve privacy terms explicitly in `changeOffer` using `privacy: p.proposal.privacy`. Existing proposal version bumps invalidate old payment approvals. No roster editing, profile switching or new arrangement mutation operation is added.
- [x] Add signed refusal cases for missing/unknown/cross-arrangement profiles, missing/unknown group, a registered outsider, and an unknown payer. Each case asserts no purchase/proposer approval/settlement effect. Tamper with a valid signed profile to exercise signature rejection separately from a valid signature over an unsupported profile.
- [x] Extend employer publication tests with omitted/unsupported profiles and preserve the prior accepted record; extend scope verification tests to prove the added checks do not multiply signature verification.

**Focused command after Task 3:** `rtk pnpm exec node --test test/signing.test.ts test/signed-requests.test.ts test/verified-authority.test.ts test/split.test.ts test/quote.test.ts`. Expected: profile/refusal cases and existing mandate/amount semantics pass.

### Task 3: Bind approvals and migrate recipient consumers

**Modify:** `src/core/coordinator.ts`, `src/scenarios.ts`, `src/presenter/session.ts`, all direct payload fixtures in `test/`. **Remove:** `src/core/views.ts` once no production or test import remains.

- [x] Build helper approval payloads with the exact frozen profile, and a group reference on split approvals only:

```ts
privacyProfile: q.privacy.profile,
...(q.privacy.source.kind === 'known_group'
  ? { disclosureGroupRef: q.privacy.source.groupRef }
  : {}),
```

- [x] Add the equivalent comparisons in both approval acceptance and retained authorization revalidation, alongside existing version/digest/amount checks:

```ts
const expectedGroup = q.privacy.source.kind === 'known_group'
  ? q.privacy.source.groupRef : undefined;
const privacyMatches = a.privacyProfile === q.privacy.profile &&
  a.disclosureGroupRef === expectedGroup;
```

- [x] Include `privacyMatches` in `approve`'s binding check and return `terms_mismatch` from `authorizationRefusal` on mismatch. Keep mandate-backed Auto authorization and proposal-backed proposer authorization on their existing spending paths. Neither group membership nor profile selection counts as approval of other payers' shares.
- [x] Default profile/group choices only in trusted fixture helpers before signing; signed coordinator entry points require explicit fields. Supply `privacyProfile` in presenter-generated benefit requests. Do not put group membership, raw mandates or new spending capabilities on the agent interface.
- [x] Let `proposeSplitAs` accept an explicit `disclosureGroupRef` override and default only to the fixture's configured `colleagues-v1` agreement. Do not search for a group based on payer names or auto-create a group when the default does not cover the request. Technical employee/employer split fixtures must use their explicit reference from Task 2.
- [x] Replace `payerView(p, employeeId)` in the presenter with `viewFor(p, { partyId: employeeId, facet: 'payer' })` and import its moved `PayerView` type. Migrate consumers in `test/views.test.ts` and `test/autopay-dispute.test.ts`, including explicit employer IDs for sponsor projections. Raw `view`/snapshot remains explicitly evaluator-only. Avoid a broad presenter redesign.
- [x] Update direct signed payload fixtures so each existing negative test still fails for its intended reason; do not let a missing profile mask fee, expiry, exception, rail or signature checks. Update the single raw purchase shape test for `Proposal.privacy`. Move profile/disclosure contracts to `test/privacy.test.ts`; preserve existing arithmetic/status coverage without duplicates.
- [x] Test a correctly signed approval with wrong/missing profile or wrong group, plus retained-evidence revalidation after its signed content/profile no longer matches. Test that publishing a later employer mandate does not rewrite the profile/provenance of an already committed purchase or historic receipt.
- [x] Rewrite the `approveAs` comment: it is a privileged synthetic device fixture computing the whole allocation digest, not proof that a restricted payer independently reconstructed every hidden share.

**Validation:** Run all focused commands above, then `rtk pnpm test` and `rtk pnpm scenarios`. Expected: all tests pass; the existing scenario outcomes and settlement references/keys preserve their contracts. Review one benefit and one known split before/after proposal and approval. Commit the coordinated Tasks 1–3 only once the whole migration is green and commits have been authorized.

### Task 4: Record the disclosure contracts and refresh evidence

**Modify:** `docs/field-map.md`, `docs/initiation-model.md`, `docs/experiment-protocol.md`, `docs/backlog.md`, `README.md`, `src/scenarios.ts`, `test/run-record.test.ts`, generated `docs/presenter-comparison.md`.

- [x] Split the payer field-map rules by profile. Document the known-group agreement input, allowed purchase subsets, frozen actual audience, merchant profile-ID exclusion, identity enrollment assumption and unchanged agent restrictions. Keep sponsor minimization explicit.
- [x] Document who signs the profile: employer in its mandate, split creator in the initial request, each payer in their approval. Describe the source precedence, conservative `request_only` case and the fact that neither profile selection nor disclosure agreement grants spending authority.
- [x] Record this implementation as separate from the deferred Merkle/ZK issue and the unresolved party-handle migration. The older party-handle discussion stays historical; link to the delivered profile contract instead of silently treating all its claims as adopted decisions.
- [x] After delivery, bump `FIXTURE_VERSION` from the restored `2026.11-4` to an unused version; `2026.11-5` is the planned value only if still unused at execution. Update its owner assertion with the reason. Reproduce the presenter artifact using its existing run ID:

```bash
rtk pnpm --silent presenter --markdown --run-id=employee-mandate-v1 > docs/presenter-comparison.md
```

- [x] Review generated differences: profile audit fields and digests may change; payment outcomes, amounts, no-shift behavior and `LOCAL` origins must remain correct. No new backend/API capability or affiliation claim.

### Task 5: Final verification and scope audit

- [ ] Run `rtk pnpm test`, `rtk pnpm scenarios`, `rtk pnpm --silent findings`, `rtk pnpm --silent presenter --json` and `rtk git diff --check`. Expect all tests/scenario checks to pass, valid generated evidence and ECB findings still `not tested`.
- [ ] Check that direct recipient observations all use the privacy module and that removed `views.ts` functions cannot bypass entitlement/profile checks. Raw evaluator exports stay explicitly privileged.
- [ ] Verify an outsider, unknown participant, unknown group and unsupported charity profile cannot obtain a view or create an admitted split; a signed profile cannot be changed after signing or broadened through a new mandate lookup.
- [ ] Confirm there is no `accept_privacy` request kind, disclosure acceptance state, invitation/broadcast interface, new dependency, Merkle/ZK code, employee policy migration or settlement implementation change.
- [ ] Report what was implemented, focused/full proof actually run, remaining trust assumptions and any baseline failures separately. Do not describe the current interrupted run as validation of this plan.

## Test ownership and acceptance criteria

Apply the test-audit authoring gate when execution begins: protect externally observable behavior, name a credible regression, prefer one owner per contract, and introduce no test-only production seam. Profile resolution/output is owned by `test/privacy.test.ts`; signed admission by existing registry/request tests; authorization lifetime by signing tests; restricted presenter observations by presenter tests. Existing property and settlement suites continue to own the payment safety invariants.

Acceptance requires both supported profiles to resolve from the proper verified source; peer disclosure only for admitted known groups; employer/payee minimization unchanged; absent/unknown input refused at signed entry points; frozen audience/provenance; matching signed approvals at acceptance and revalidation; detached projections; unchanged payment outcomes; zero new dependencies and no invitation/acceptance workflow.

## Assumptions and unresolved decisions

- **A1 — existing group agreement:** explicitly modeled by trusted synthetic configuration, not cryptographically proved and not inferred from a registered key. If the user instead wants fresh individual consent per purchase, revise this plan before execution; do not resurrect the interrupted patch automatically.
- **A2 — split fields:** share participant identifiers and principal amounts, keeping other payer routing, fees, roles and authority data private. These are product disclosure rules, not a legal conclusion.
- **A3 — unavailable benefits:** preserve current zero-employer-contribution behavior using only the requested restrictive profile and no sponsor entitlement. Unsupported/incompatible profiles are errors, not reasons to broaden disclosure.
- **A4 — planning authorization:** this turn writes the plan and a backlog link only. Patch removal and implementation are future tasks and require an explicit execution request.
- Anonymous charity needs a new signed authority model and aggregate reporting as well as a profile; the module provides locality for that change without promising that one catalog entry alone implements it.

## Plan improvement loop report

- Maximum iterations: 10. Maximum clarification questions: 3. Clarification mode: bounded.
- Iteration 1: created with `superpowers:writing-plans`, grounded in baseline `54124808e66c2c628fa845feb2185a6236f36a66` and the separately inspected interrupted patch.
- Iteration 2: read-only code-grounded review found and fixed an authority fallback that could mask invalid signed profiles, an overly broad rollback command, incomplete known-group wiring through `World`/`coordinatorFor`, and missed view consumers in `test/autopay-dispute.test.ts`. Added exact patch fingerprints, conservative fallback ordering, a complete interface-level test example and explicit migration paths.
- Iteration 3: checked general-split consumers and found technical property/concurrency/regression fixtures that use `EMPLOYER` as an ordinary split payer. Added explicit test-group configuration and signed group-reference overrides; the default peer group is not broadened, and existing settlement-negative controls keep reaching the intended guards.
- Iteration 4: rechecked signed-source ownership, group audience and configuration, frozen provenance, unavailable-benefit behavior, approval/revalidation bindings, recipient entitlement, caller migration, generated outputs, rollback scope and task ordering. No further substantial improvement identified.
- Iterations run: **4 of 10**. Iteration 1 mode: **created with superpowers:writing-plans**. Questions asked: **1 of 3**. Stop reason: **stabilized**.
- The clarification about existing group disclosure agreement had no response during planning; the recommended model is recorded as A1. It remains a product assumption for review before execution, not newly established consent. A2–A4 are the other explicit assumptions. There are no unrecorded implementation choices requiring a new privacy workflow.
- Planning validation: relative document links, existing referenced file paths, placeholder scan and `git diff --check`. No implementation tests were run and the interrupted source/test files were not edited, reverted, committed or published during planning.
