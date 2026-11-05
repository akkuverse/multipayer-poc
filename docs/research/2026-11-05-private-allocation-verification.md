# Research brief: verification of partially hidden allocations

Date: 5 November 2026 · Status: deferred research; no implementation approved.

Tracking: [GitHub issue #1](https://github.com/akkuverse/multipayer-poc/issues/1).

## Decision and research question

Keep Merkle trees and zero-knowledge (ZK) proofs out of the current implementation. Preserve this discussion for a later experiment, after the existing authorization, completion and recovery questions in the [experiment protocol](../experiment-protocol.md) have priority. This brief records possibilities and tradeoffs; it does not select a replacement approval protocol, authorize dependencies or expand party visibility.

The question worth revisiting is: **can independently authorized contributors verify their own obligations and the validity of a shared purchase while receiving only the information they need?** Binding an allocation, understanding its disclosed terms, verifying those terms belong to it, and proving hidden terms satisfy policy are separate guarantees.

## Current conflict and module boundaries

The [party-handle discussion](../superpowers/specs/2026-11-04-party-handles-share-visibility.md) exposed a mismatch:

- [`sharesDigestOf`](../../src/core/signing.ts) hashes the canonical complete ordered shares array, including payer, payee, role, principal, fee, rail and authority. [`PayerApproval`](../../src/core/types.ts) carries this digest alongside the purchase, payer, proposal version, merchant, total, own amount, own fee and expiry.
- [`approveAs`](../../src/scenarios.ts) receives the raw purchase view and computes the digest from every share. Its comment describes a device hashing the terms shown to its payer.
- [`viewFor`](../../src/core/privacy.ts) with the `payer` facet exposes the payer's totals and, under `employer_benefit_v1`, combines other contributions as `othersCents`. The [field map](../field-map.md) restricts other payers' fees, rails, routing and authority records under either profile. That permitted projection cannot reconstruct the complete digest.
- The [`Coordinator`](../../src/core/coordinator.ts) checks the digest against retained shares both when accepting approval and during later authorization revalidation. [`VerifiedAuthority`](../../src/core/verified-authority.ts) resolves and verifies signed authority within a synchronous decision; it is not an allocation-proof abstraction.

Extracting commitment construction and matching into an `allocation-commitment.ts` module was discussed as a useful seam. Merkle support would additionally change disclosures and pre-signing verification; it cannot be delivered by changing the hash function alone. Neither that extraction nor an approval-contract change is approved by this brief.

## Options discussed

| Approach | What it would establish | Remaining trust or limitation |
|---|---|---|
| Coordinator-projected opaque complete digest | Signature pins one complete allocation without disclosing it. | Payer trusts correspondence between displayed routing/details and the digest. Own amount and fee remain explicitly signed. |
| Own-share digest only | Payer independently hashes their disclosed terms. | Drops the signature's complete-allocation binding. |
| Own-share digest plus complete-allocation digest | Signature binds independently hashed visible terms and a complete allocation. | Coordinator must check that both refer to corresponding shares; two digests alone do not prove that relationship. |
| Full-share disclosure | Payer recomputes the existing complete digest. | Conflicts with current visibility restrictions; inappropriate where contributor identity must remain hidden. |
| Merkle root plus own-share inclusion proofs | Payer independently verifies disclosed terms belong to the allocation root they sign. | Plain inclusion does not prove completeness, hidden arithmetic, authority or settlement. |

An inclusion proof reconstructs a root from the disclosed leaf and sibling hashes; it proves membership in that committed tree. This supplies independent correspondence verification absent from the two-digest approach. It does not replace the payer's signature. [RFC 9162, §2.1.3](https://www.rfc-editor.org/rfc/rfc9162.html#section-2.1.3)

## Beyond plain inclusion proofs

The following are candidate constructions, not capabilities of this code:

| Desired statement | Candidate approach | Qualification |
|---|---|---|
| Hidden contributions sum to the advertised remainder. | Pedersen commitments and a proof of the sum relation. | Commitments support addition, but the relation must be proved and linked to the allocation. |
| Amounts are nonnegative bounded integer cents. | Range proofs, such as Bulletproofs. | Appropriate bounds must prevent modular arithmetic wrapping; prove principal and fees under their distinct rules. |
| No share naming this payer was omitted from disclosure. | An authenticated map/query-completeness construction, potentially using Merkle trees, or a general ZK proof. | Completeness is relative to the committed allocation, not records the coordinator never committed. |
| Hidden shares have valid signatures/mandates and satisfy policy. | A general ZK circuit checking the chosen authorization rules and evidence. | Requires trusted key-registry, revocation-state and time inputs; signature validity does not itself establish legal authority. |

Pedersen commitments have additive structure. Bulletproofs provide range proofs over committed values and support general arithmetic circuits. [Stanford commitment notes](https://crypto.stanford.edu/cs355/20sp/lec3.pdf), [Bulletproofs paper](https://cs.stanford.edu/people/dabo/pubs/abstracts/bulletproofs.html)

Authenticated query research distinguishes authentic returned entries from complete answers. The earlier discussion's limitation should therefore be read as a limitation of **plain Merkle inclusion proofs**, not every Merkle-based structure. A suitable structure and verification relation are necessary; a list of inclusion proofs is insufficient. [Pang and Tan, 2008](https://ink.library.smu.edu.sg/sis_research/778/)

Hidden-value balance and spending-authority checks have precedents in privacy-preserving payment protocols. Applying them to this project's mandate rules would require a new, explicitly specified proof relation. [Zcash protocol specification, §§4.12–4.15 and 4.18](https://zips.z.cash/protocol/protocol.pdf)

All proofs must bind to the **same allocation and proposal context**. A valid sum proof concerning different shares is irrelevant. A hidden-authorization proof also cannot be available before the necessary approvals exist; distinguish proposal-time disclosure verification from later evidence that all contributions are authorized.

## Boundaries that cryptography does not remove

**Consent freshness.** Capture one snapshot, display its terms, and sign that same snapshot. Reject stale terms rather than silently signing a newer proposal. Reading a live handle at signing time does not establish what the payer saw earlier. Wrapping a detached projection in a read-only proxy also does not make it a live projection.

**Privacy scope.** A coordinator generating proofs from the complete allocation still knows that allocation. Participant privacy is different from privacy against the coordinator. In the reference purchase, `1300 − 800 = 500` already reveals the sole other contribution; identities, routing, fees and mandate details are more meaningful confidentiality targets. Multiple sponsors or anonymous donors could motivate stronger requirements, but those scenarios remain deferred.

**Guessing and metadata.** The current unsalted deterministic hash is a binding, not an anonymity guarantee: known fields can make unknown values guessable. Future Merkle work would need independently randomized leaves, appropriate disclosure of openings, and stable retention of randomness for replay and verification. Public fixture randomness supports reproducibility, not adversarial privacy. Proof size, tree shape and contextual data may also disclose information.

**Settlement and external truth.** No static allocation proof guarantees future payment. Authenticated settlement evidence can establish an outcome already recorded by the relevant system; reservations and atomic execution require protocol support. Proofs cannot turn stale registry data into current authority or a local model into observed backend behavior. Existing invariants still apply: every leg must settle before completion, employer failures never increase the employee's obligation, retry keys remain stable, and timeout remains uncertainty.

## Potential relevance to digital euro research

The ECB's 28 September 2026 call includes multi-payer/multi-payee experimentation and privacy-conscious AI payment experiences. Evaluation includes relevance, innovation, contribution and technical readiness. Its privacy page supports evaluating feasible privacy-enhancing technologies. [ECB innovation call](https://www.ecb.europa.eu/press/intro/news/html/ecb.mipnews260928.en.html), [ECB privacy objectives](https://www.ecb.europa.eu/euro/digital_euro/features/privacy/html/index.en.html)

**Assessment, not ECB feedback:** a bounded experiment demonstrating reduced disclosure with independently verifiable consent could be relevant. These publications do not establish interest in this particular implementation or a preference for Merkle or ZK technology. Core completion, expiry, retry and recovery evidence remains the stronger immediate contribution. No affiliation, endorsement or observed ECB support is implied.

## Conditions for revisiting

Reopen this research when there is a concrete scenario, a named party from whom specific fields must be hidden, and a verification requirement that coordinator checks cannot adequately satisfy. Compare the simplest options before choosing proof machinery.

A future experiment should specify threats, exact proof statements, trusted inputs, allocation format/version, ordering, domain separation, randomness retention, approval-snapshot behavior and evidence lifecycle. Measure recipient disclosures and inferences, detected tampering/omissions, remaining trust, proof size, generation/verification cost and integration effort. Evaluate whether the settlement interface can remain unchanged. Use synthetic data and label local proof results `LOCAL`; only independently observed test-environment events may be `ECB_API`. Dependencies require separate approval.

Sources were reviewed on 5 November 2026. The linked Zcash specification was version `v2026.7.0-427-gd97c23`, dated 3 November 2026; its live URL may change. This brief uses public sources and repository code only, with no confidential adapter material.
