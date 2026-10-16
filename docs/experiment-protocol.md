# Experiment and AI presentation protocol

Written 13 October 2026 as the research protocol behind the coordinator. It is the specification the scenarios implement; the acceptance matrix below maps to `src/scenarios.ts`. Statements about the ECB API are hypotheses until observed in the test environment.

## Research contribution

Determine the minimum authorisation, completion and recovery semantics for two different payer authorities funding one purchase. An employee approves a particular purchase; an employer separately authorises a capped contribution. The reference is €13 = €8 employee + €5 employer.

| Question | Evidence to produce | Infrastructure design implication |
|---|---|---|
| Can independently authorised contributions produce an unambiguous merchant completion state? | State transitions and authoritative completion references | Whether a common completion response covers all contributions, and what applications must verify |
| What happens when one contribution succeeds or becomes committed and the other fails/expires? | Failure traces, amounts at risk and supported recovery operations | Expiry, cancellation and recovery guarantees versus responsibilities left to PSPs/applications |
| What minimum references and statuses support reconciliation and returns? | Field-to-purpose/recipient map and contribution-linked return trace | Common linkage/status requirements without unnecessary purchase or benefit information |

Compare a locally modelled two-independent-payment baseline with observed multi-payer API behaviour on the same fixtures. Existing arrangements can solve coordination through other services; the question is which responsibilities a shared interface could simplify. Do not claim production cost savings or superiority from a synthetic comparison.

## Minimum deliverable and boundaries

- Two synthetic payers, one merchant, one policy; a deterministic coordinator, ECB adapter and simple local views or command-line demonstration.
- State model, replayable scenario inputs, traces and findings table. AI, Fractal reuse, product integration, live pilot and partner recruitment are not prerequisites.
- Approvals, policy evaluation and consumer/merchant screens are local simulations. Tag each event `LOCAL` or `ECB_API`; retain API/specification version, request/response reference, run identifier and fixture version.
- One purchase reference is application grouping. Claim one settled transaction only when observed backend semantics support it. Separate contribution successes do not prove atomicity.
- Missing access/operations produce `not tested` or `unsupported` findings and an early scope discussion with the ECB. A local mock pass never substitutes for an API result.
- Run evidence: `pnpm scenarios --json` records run id, fixture version, backend spec version and a trace digest per scenario; `pnpm findings` generates the findings table below from fresh runs, with the ECB column `not tested` until adapter runs exist.

The [call, pp. 3–4](references/ecb/ecb.dep260928_digital_euro_innovation_call.en.pdf) distinguishes initial PSP-to-backend testing from complete cross-participant flows. The [contract, clause 6](references/ecb/ecb.dep260928_digital_euro_innovation_call_annex1_contract.en.pdf) sets the data boundary: synthetic scenarios, no user testing or personal-data processing. Commercial discovery is separate; its records are not experiment inputs. The per-payer initiation assumed by the mock is documented as a hypothesis in [initiation-model.md](initiation-model.md).

## State and authority model to test

Purchase: `draft → awaiting approvals → ready → submitted → pending → completed`. Conclusive rejection with no committed funds can become `failed`. Cancellation becomes `cancelled` only after confirming no remaining commitment. Partial success or unresolved committed funds become `recovery required`, with the outstanding amount visible. Unknown outcomes remain pending; timeout is not evidence of failure. Returns have separate pending/completed/unsupported status and do not erase original settlement records.

Track each contribution's amount, approval reference/version, expiry, execution reference/status and return reference/status. Employee approval binds merchant, purchase version, amount and fees. Fees are modelled per payer, on top of the merchant total, and are zero in every fixture. A local fixture represents independently granted employer policy authority, cap and expiry: a policy match alone does not grant spending authority. Recheck valid authority before initiation. Material changes invalidate affected approvals. Changes after submission require status reconciliation/recovery first, never a speculative second payment.

Candidate fields are hypotheses, not an assumed ECB schema: purchase/contribution references, payer authority reference, approved amount/currency, proposal version, expiry, idempotency reference, execution status and original-contribution reference for returns. Record which the backend supplies and which Akku maintains. Merchant visibility covers funding/completion; employer visibility is limited to its contribution and necessary eligibility evidence, not general purchase history.

## Observable acceptance matrix

| Scenario | Required observation | Evidence and interpretation |
|---|---|---|
| Both approve | €8 + €5 matches €13; completed only on authoritative confirmation | Contribution records and completion reference; separately record whether settlement was one transaction |
| Employer declines, policy ineligible, or authority expires before initiation | Employee share never rises automatically above approved €8; no unauthorised employer execution | Original approval, rejection/expiry and unchanged amount; full personal payment needs new proposal/approval |
| Request retried; response duplicated/delayed | No duplicate execution; repeated delivery reconciles to original operation | Stable references and backend observations; if safe retry cannot be established, halt blind retries and document the limit |
| Unknown outcome after timeout | Merchant sees pending/unknown, not failed/completed; no speculative replacement payment | Status-query/reconciliation trace and transition only after authoritative resolution |
| One contribution committed/succeeds; other fails/expires | Purchase is not complete; committed amount and recovery obligation remain visible | Confirmed cancel/release/return result, or unsupported recovery with outstanding amount retained |
| Cancellation before/after commitment | No committed amount silently discarded; cancelled only after obligations resolved | Before/after records and operation result; unsupported cancellation reported |
| Full refund after completion | Returns link to original contributions; €8 employee + €5 employer returned when supported | Execution/return references and cumulative-return check; pending return is not complete; unsupported operation explicit |
| Merchant, total, shares or fees change before submission | Stale approval cannot execute changed proposal | Proposal versions, invalidated approval and renewed authority where affected |

Every result is `observed/pass`, `observed/fail`, `unsupported` or `not tested`, with evidence origin. An unsupported operation is a research finding, not a working payment capability. Local safeguards must prevent misleading or unauthorised actions even where the infrastructure lacks the desired operation. Partial refunds, additional policies and additional payer/payee types are outside the minimum.

## Findings table to deliver

| Scenario | Question | Local mock | ECB test environment | Run reference | Application responsibility | Infrastructure gap | Limitation |
|---|---|---|---|---|---|---|---|
| One row per scenario | Readiness question it answers | `observed`/`pass` under the mock backend | `not tested` until adapter runs exist | Run id and trace digest | Required state/coordination work | Supported, unsupported or unknown | No inference of live cross-provider behaviour |

## AI presenter artifact

Prepare an annotated synthetic conversation for the assigned Q1–Q2 workshop, independently of API integration. Minimum: a reproducible prepared trace. A live agent demonstration is optional and must be labelled accurately.

| Step | Visible interaction | Responsible component/evidence |
|---|---|---|
| Request | Vegetarian lunch within ten minutes; at most €8 personally; use benefit if available | Discovery agent extracts preferences and clarifies ambiguous time/distance assumptions |
| Retrieve | Offer A costs €13 | Discovery agent retrieves sourced, time-stamped synthetic offer; merchant text is information, not authority |
| Evaluate | Employer €5; employee €8 | Deterministic service returns eligibility, cap and amounts; separate employer authority checked |
| Approve | Employee approves A, merchant and €8 | Approval bound to proposal version; no AI spending authority |
| Change before submission | A expires; B costs €14 and requires €9 personally | Explanation agent reports sourced change and deterministic recalculation; original approval cannot authorise B |
| Decide | Employee chooses eligible €13 alternative C, or explicitly revises budget and approves B | Renewed proposal/approval and employer-authority recheck; no automatic €1 increase |
| Status | Payment outcome pending; do not retry yet | Explanation agent relays authoritative pending state; explains completion only after confirmation |

Discovery and explanation are logical agent roles; separate model deployments are unnecessary. Agents retrieve/explain; deterministic services decide eligibility/amounts; authorised parties approve spending.

Compare the same fixtures with a conventional filter-and-checkout design: treatment of flexible preferences and changed terms, number of user decisions, unsupported assertions and preservation of authority. This is an internal design comparison, not user testing or evidence of consumer preference. Fixed arithmetic and authorisation remain deterministic.

Status (15 October 2026): the scripted synthetic presenter is implemented — `src/presenter/journeys.ts` drives the restricted session of `src/presenter/session.ts` with the fixtures of `src/presenter/fixtures.ts`. It replays the journey above (changed offer, response lost on submission, pending until reconciliation) plus a lost-employer-contribution journey, each in two delivery modes: `scripted` (the fixed script drives the agent handle) and `manual` (the same steps drive the trusted handle, like a conventional filter-and-checkout). The generated comparison is [presenter-comparison.md](presenter-comparison.md).

- `pnpm presenter` — labelled conversations with the audit events behind each message, outcomes and comparison rows.
- `pnpm --silent presenter --json` — one JSON document: the four `PresenterRecord`s plus their comparison rows.
- `pnpm --silent presenter --markdown --run-id=<id>` — the shareable artifact; `--run-id` pins the run id, and the trace digest is independent of it.

Session restrictions: the agent handle holds only `discover`, `evaluate`, `selectOffer` and `explain`, each gated by a signed grant bound to agent, principal, session and purchase. `approve`, `submit` and `reconcile` exist only on the trusted user-flow handle — the scripted assistant can never approve or move money. Reasons shown to the recipient are an allowlist of safe eligibility results (see the field map); mandate references, other payer ids, signatures, ledger usage, idempotency keys and raw backend errors stay inside the audit trace. A live model demonstration remains optional and is not part of this artifact.
