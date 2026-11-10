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
- Licensed under the Business Source License 1.1 (see LICENSE). Do not change the licence terms. Accept no outside contributions without a signed CLA (see CONTRIBUTING.md).
- Never hand-edit generated explorer artifacts: `explorer/app/core/`, `explorer/app/manifest.json` and `explorer/app/build.json` are regenerated with `pnpm explorer:build`, which requires exactly the Node version pinned in `tools/explorer/toolchain.json`.
- `tools/explorer/manifest-input.json` is authored input outside the generated tree. Edit it only deliberately, then regenerate (`pnpm explorer:build`) and re-run `pnpm explorer:check`.
- `explorer/` ownership is split: imported artifacts (`index.html`, `multipayer-explorer.dc.html`, `support.js`, `_ds/`, `assets/`), repo-maintained code (`app/explorer/`, `app/shims/`), vendored upstream (`app/vendor/`) and generated output. Imported `.dc.html` edits are limited to the import transformations recorded in [explorer/README.md](explorer/README.md); a new upstream export never overwrites repo-maintained or generated paths.
- Explorer acceptance has three separate boundaries — the Node gate (`pnpm explorer:check`), the browser core check page (`explorer/app/explorer/check.html`) and real-UI integration runs. A pass at one boundary does not establish the others.
- Track defects and planned work in [docs/backlog.md](docs/backlog.md).
