# multipayer-poc

Mock coordinator for one purchase funded by two payers with different authority (employee approval + employer mandate), against a mock digital euro backend. See [README.md](README.md) and [docs/](docs/).

## Rules

- Zero runtime dependencies. Node.js >= 23.6 with native TypeScript type stripping; no build step. Ask before adding any dependency, including dev dependencies.
- Use `pnpm` (`pnpm test`, `pnpm scenarios`).
- Synthetic data only: no personal data, no real money, no network calls.
- All amounts are integer euro cents.
- Every trace event carries its origin. `LOCAL` for this code; `ECB_API` only for events observed in the ECB test environment. Never report a local pass as an ECB capability.
- Safety invariants, each covered by tests: never complete a purchase unless every leg settled; never shift a failed or expired employer share onto the employee; never retry with new idempotency keys; never treat a timeout as failure.
- Agents (AI) may read and explain; deterministic code decides amounts and eligibility; only authorised parties approve spending. AI code never calls approval or submission functions.
- The ECB adapter must not live in this repository while it is intended to become public (ECB contract confidentiality clause). No text may imply ECB affiliation or endorsement.
- Licence is undecided (tentatively FSL-1.1-ALv2). Do not add a LICENSE file or accept outside contributions without a CLA until it is settled.
- Track defects and planned work in [docs/backlog.md](docs/backlog.md).
