# Explorer Co-location Plan

> **For agentic workers:** Planning only. Implementation, delegation, commits and publication require the applicable session authorization. Execute the tasks in order once implementation is authorized; use the repo's available execution workflow and preserve unrelated work.

**Goal:** Bring the multi-payer explorer into this repository at `explorer/`: a static site served without a build, with a browser core generated from `src/`, a manifest generated from explicit authored inputs and live source runs, and separate checks for core conformance and actual explorer behavior. The `.dc.html` UI remains externally authored and imported.

**Architecture:** The site contains imported UI/runtime/assets, committed generated `app/core/`, `app/manifest.json` and `app/build.json`, and repo-maintained scheduler, conformance page and crypto shim. Authored manifest inputs live in `tools/explorer/manifest-input.json`, outside the generated tree. Node builtins provide generation, checking and localhost serving; no dependencies are added.

**Tech stack:** Runtime floor remains Node >= 23.6 with native TypeScript stripping; generation alone uses exactly Node 24.6.0. Keep the existing Node 23.6.0/24 compatibility matrix. Use pnpm throughout. No build step is added for `src/` consumers.

## Grounding and scope

The untracked export is currently `export/multipayer-explorer/`. It contains 26 generated browser modules in `app/core-v12/`, a versioned manifest and scheduler, the browser check page, the `.dc.html` UI, runtime, design-system CSS/JS and logo assets.

Review on 2026-11-06 under Node 24.6.0 established that all 36 source and exported-core scenarios pass their checks with equal trace digests. The exported coordinator already implements `operation_in_progress`; the scheduler's `probeNativeGuard()` returns `true`. The UI's fallback note is stale, not evidence that this core predates the guard. These checks do not establish browser acceptance, replay or Reset correctness.

The manifest currently contains authored component descriptions, scenario setup/steps and journey descriptions, alongside two baked presenter digests. `ui-data` does not yet exist. The existing browser check runs core scenarios and journeys; it does not execute the scheduler or UI and does not compare scenario digests to baked values.

Related docs: [experiment-protocol.md](../../experiment-protocol.md), [backlog.md](../../backlog.md), and [interactive-explorer-design-v3.md](../specs/interactive-explorer-design-v3.md). Recheck current instructions, source and export layout before execution; preserve unrelated dirty files.

## Constraints

- Synthetic data only, integer euro cents, no real money or remote runtime calls. Local serving binds only to `127.0.0.1`. External documentation links may remain as links; they must not become runtime dependencies.
- Zero added runtime or development dependencies. Tools use `node:` builtins; no downloaded server or browser package is introduced. Use existing browser tooling or a manual browser for acceptance.
- Preserve all coordinator safety invariants and `src/` semantics. Never adapt source behavior to match an export. A local result always has origin `LOCAL`; nothing here proves an ECB capability.
- Deterministic core code decides eligibility and amounts. The explorer drives synthetic trusted fixture actions and schedules their execution; agent presenter handles retain their existing inability to approve or submit spending.
- Generated output is never hand-edited. The shim is hand-maintained repo code; vendor files retain upstream attribution and are changed only through a documented vendor update.
- Imported `.dc.html` edits are limited to the three module/data path replacements and removal of the stale fallback console-note statement described below. Other UI changes require an upstream export or separately authorized scope.
- No confidential ECB adapter, endorsement claims, licence selection, dependency additions or public publication are authorized by this plan. Confirm branding publication rights before any public delivery.

## Ownership and files

| Path | Ownership and purpose |
|---|---|
| `explorer/{index.html,multipayer-explorer.dc.html,support.js,_ds/,assets/}` | Imported artifacts; `.dc.html` receives only the documented import transformations |
| `explorer/app/core/` | Generated browser modules from all `src/**/*.ts` except `src/cli.ts` |
| `explorer/app/{manifest.json,build.json}` | Generated, valid JSON, committed for static hosting |
| `explorer/app/explorer/{scheduler.js,check.html}` | Repo-maintained scheduling and browser core conformance page |
| `explorer/app/shims/` | Hand-maintained crypto shim |
| `explorer/app/vendor/` | Vendored upstream code and attribution |
| `tools/explorer/manifest-input.json` | Authored component map, scenario setup/steps and journey display metadata |
| `tools/explorer/toolchain.json` | Exact generator pin: `{ "nodeVersion": "24.6.0" }` |
| `tools/explorer-inputs.mjs` | Shared inventory, input hashing and manifest validation helpers |
| `tools/build-explorer-core.mjs` | Generates browser core and deterministic build metadata |
| `tools/ui-data.mjs` | Generates the complete manifest from authored input plus source scenarios/journeys |
| `tools/check-explorer.mjs` | Read-only core, manifest inventory and digest conformance gate |
| `tools/serve.mjs` | Localhost static server rooted at `explorer/` |
| `package.json`, `.github/workflows/ci.yml` | Commands, pinned generation gate and compatibility checks |
| `explorer/README.md`, `AGENTS.md`, `README.md`, protocol/backlog docs | Ownership, workflow, acceptance evidence and release boundary |

## Contract decisions

### 1. Reproducible generation and provenance

Commit generated output so the site can be served by a static host without generation. JavaScript files retain the existing `// GENERATED ... never hand-edit` header. JSON uses a `generatedFrom` property, never comment headers.

Both writers require exactly Node 24.6.0 from `tools/explorer/toolchain.json` before making any writes. A mismatch fails with the required and actual versions. This is a generator restriction, not a change to the package runtime floor. Pin the CI generation job to the same version; retain semantic conformance checks on both existing matrix versions. Node explicitly warns that [`stripTypeScriptTypes` output can vary between versions](https://github.com/nodejs/node/blob/main/doc/api/module.md#modulestriptypescripttypescode-options).

Use content provenance instead of checkout HEAD. A shared helper computes `inputDigest` using SHA-256 over a sorted, length-framed sequence of repository-relative POSIX paths and raw file bytes. Include all source modules except the CLI, the generator scripts/shared helper, toolchain pin, manifest input, shim and vendor files. Exclude generated outputs, git metadata and unrelated documentation. Identical inputs must produce the same digest in a dirty checkout, after a commit and on a PR merge checkout.

`app/build.json` contains only `{ generatedFrom: { inputDigest, generatorNodeVersion }, fileCount }`. `manifest.generatedFrom` contains that same digest and generator version plus live `FIXTURE_VERSION` and `PRESENTER_FIXTURE_VERSION`. Do not emit timestamps, absolute paths, checkout SHAs or the executing compatibility-check Node version. Print optional checkout diagnostics to the terminal only.

### 2. Core generation

`buildExplorerCore({ srcDir, outDir, shimPath })` strips sorted source modules with `stripTypeScriptTypes(code, { mode: 'strip' })`, rewrites surviving module specifiers from `.ts` to `.js`, redirects `node:crypto` to the relative shim, and prepends the generated header. Preserve semantics and comments. Fail with the source filename on unsupported syntax or unresolved module specifiers.

Generate into a staging directory, validate the output inventory and imports, then replace the old generated `app/core/` tree. This removes obsolete modules and avoids nested old trees. Never delete authored directories. Default output paths resolve relative to the repository, not the caller's working directory; scratch output is supported for validation without altering the site.

### 3. Complete manifest generation

Extract an initial authored input from the exported manifest before replacing generated data. Preserve component descriptions and paths, scenario ids/setup/steps, journey ids/display descriptions and any other UI-consumed authored fields. Define and validate allowed fields after inspecting the UI's manifest reads; reject unknown fields that would otherwise be silently discarded.

The writer derives scenario `id`, `title`, `question` and `responsibility` from `src/scenarios.ts`, merging only the authored setup/steps by id. Source scenarios are executable functions, so do not try to infer step scripts by parsing their function text. Components and journey display descriptions remain authored input. Fixture versions, input digest, inventories and all baked digests are derived.

Require exact set equality and unique ids between authored scenarios and source scenarios. Require the journey set to equal `PRESENTER_JOURNEYS` plus `auto-pay`, and use `PRESENTER_MODES` for both regular and auto-pay journeys. Fail before replacing the output on missing/extra/duplicate ids or invalid setup/step structure. Current expected coverage is 36 scenarios and 3 journeys × 2 modes; derive future counts from the source contract rather than hard-coding 36.

Run every source scenario and require `check()` success. Record scenario digests under the scenario id. Run each journey/mode using a fixed run id `explorer`; record digests under `presenter-${journey}-${mode}`. Replace the complete `bakedDigests` map and stale `bakedDigestSource` notes with deterministic provenance naming the exact command and run-id convention. Serialize with stable ordering, two-space indentation and a final newline. The writer reads authored input, never the previous generated manifest as its authority.

### 4. Three distinct acceptance boundaries

**Node conformance:** `explorer:check` reads committed artifacts without writing or re-baselining. Require exact source/generated/manifest scenario inventories and complete expected baked-digest keys. Run `run()` + `check()` for every scenario in source and generated core; require source digest = generated digest = baked digest. Run every journey/mode in both implementations with run id `explorer` and require the same three-way equality. Missing entries, extra entries, duplicates, load errors, failed scenario checks and digest differences exit nonzero. Also verify committed provenance against current input bytes. Use native `node:crypto` to hash both traces so a broken generated hash helper cannot validate itself.

**Browser core conformance:** Update `check.html` to enforce the same inventories, required baked digests and scenario/journey coverage against the browser-loaded core. Its title is PASS only when every required check succeeds. This checks browser loading and the shim path, not the UI or scheduler. The Node process has a native global Buffer, so a Node pass alone does not establish browser shim correctness.

**Explorer integration:** Exercise the actual `.dc.html` and scheduler, independently of the two core checks. Verify no-intervention walkthroughs under holds Off, Before send and Before reply; assert complete scenario coverage, `check()` success and equality to reference digests. Explicitly check native guard detection and same-purchase mutation refusal at a real hold, release to completion, other-purchase independence, replay to the same digest, Back preserving interventions, Reset discarding them, and a missing replay anchor stopping with an explanation. Record modified-run differences separately from baseline conformance. Node/core parity cannot detect a UI fallback or replay bug because it never loads those layers.

Current exported core already has the guard. Keep the existing conditional fallback during this move; assert `probeNativeGuard() === true` with the regenerated core and that the UI uses it. Do not remove or redesign the fallback as an incidental refactor. If integration fails outside the allowed import edits, record the exact blocker and obtain an upstream export or separate authorization; do not claim complete explorer acceptance.

## Task order and validation

Execute Tasks 1–6 sequentially after implementation authorization. Add package scripts before invoking them. Use `rtk` for shell commands per repo instructions. `pnpm test`, `pnpm scenarios` and `pnpm findings` must remain green. Do not commit unless separately authorized.

### Task 1: Relocate and serve the unchanged export

**Files:** `export/multipayer-explorer/` → `explorer/`, `tools/serve.mjs`, `package.json`, `explorer/README.md`.

- [x] Verify the destination is absent, inspect the export inventory and confirm `explorer/` is not ignored. Move the tree once. Remove the empty `export/` parent only if it contains no unrelated files.
- [x] Implement a builtin HTTP server bound to `127.0.0.1`, default port 8080 with a validated port argument. Resolve `/` explicitly to `index.html`; disable directory listing. Serve HTML, JavaScript, JSON, CSS, SVG and any additional asset types actually present with correct MIME types.
- [x] Restrict decoded and resolved paths, including symlink targets, to the static root. Return controlled 400/404 responses for malformed paths/missing files and reject traversal outside the root. Do not expose repo source or environment files.
- [x] Add `explorer:serve`. Start on a temporary port and verify `/`, the `.dc.html`, `support.js`, both design-system CSS files, the design-system JS bundle, logo and versioned module/manifest URLs return appropriate content types and bodies. Verify missing files and traversal cannot escape the root. Stop the server reliably after checks.
- [x] Update run instructions to `pnpm explorer:serve`. Do not claim UI acceptance from HTTP responses.

### Task 2: Normalize names before generation

**Files:** Versioned paths under `explorer/app/`, `.dc.html`, `explorer/README.md`.

- [ ] Before creating any generated replacement, verify all unversioned destinations are absent, then rename `core-v12/` to `core/`, `manifest-v11.json` to `manifest.json`, `scheduler-v9.js` to `scheduler.js`, and `v12-check.html` to `check.html`. Refuse destination collisions rather than nesting directories.
- [ ] In `.dc.html`, apply only `app/core-v12/` → `app/core/`, `app/manifest-v11.json` → `app/manifest.json`, and `app/explorer/scheduler-v9.js` → `app/explorer/scheduler.js`. Remove the entire obsolete conditional console-note statement about the core predating the guard; retain the probe and fallback logic.
- [ ] Update the corresponding relative imports/fetch paths in `check.html`; update stale scheduler comments and README paths. Verify no executable reference points at a versioned path and the four old paths are absent.
- [ ] Record the exact import transformations in README and compare the `.dc.html` against the original export to prove no unrelated UI edits. Retain an execution-time comparison copy outside the committed tree if needed.
- [ ] Serve and smoke-load the normalized site. Full browser conformance waits for Task 4; no generation or directory renaming occurs out of order.

### Task 3: Implement deterministic core and manifest writers

**Files:** `tools/explorer/{toolchain.json,manifest-input.json}`, shared helper, both generator scripts, package scripts and generated artifacts.

- [ ] Inspect all manifest reads and extract the authored input per contract 3. Establish required fields and scenario/journey id validation before marking the emitted manifest generated.
- [ ] Add the exact generator pin and shared input hash helper. Verify the stripping API is available under the pinned toolchain. The runtime matrix need not generate bytes.
- [ ] Implement staged core generation per contract 2. Validate scratch output inventory against source paths (currently 26 modules), rewritten imports and `core/states.js`; then replace the renamed `app/core/` and emit deterministic `app/build.json`.
- [ ] Implement the complete manifest writer per contract 3, including successful source scenario checks and all journey modes. Add `ui-data` and `explorer:build` scripts before invoking them.
- [ ] Define `explorer:build` as `node tools/build-explorer-core.mjs && node tools/ui-data.mjs`, so one command regenerates every committed derived artifact. Keep `ui-data` as the standalone complete manifest writer.
- [ ] Run `rtk pnpm explorer:build` twice with Node 24.6.0. Compare the full generated file inventory and bytes, including both JSON files; require no change. Parse both JSON outputs with `JSON.parse`.
- [ ] Verify a non-pinned Node fails before writes. In scratch copies, verify added/removed source modules update the output inventory, and missing/extra authored ids or unsuccessful scenario checks fail generation. These must be isolated checks, not edits to real `src/`.

### Task 4: Conformance and real explorer acceptance

**Files:** `tools/check-explorer.mjs`, `explorer/app/explorer/check.html`, package scripts; session/PR evidence.

- [ ] Add `explorer:check` implementing the read-only Node gate in contract 4. It must derive expected coverage independently of the manifest so deleted entries cannot reduce the checked population.
- [ ] Run `rtk pnpm explorer:check`. Current expected coverage is 36 scenario comparisons and six journey/mode comparisons, all with three-way digest equality and exact inventories.
- [ ] In scratch artifact copies, prove the checker rejects a changed module, stale/removed baked digest, missing manifest scenario, duplicate id and stale provenance. Do not mutate canonical baselines during the check.
- [ ] Update `check.html` per the browser conformance contract. Open it through the local server; require PASS, complete coverage and no load/console errors. Then open the actual explorer and execute the integration acceptance cases in contract 4.
- [ ] Reuse existing browser tooling if available; do not add a browser dependency. Record command/tool or manual procedure, Node/browser version, input digest, actual coverage, hold modes, errors and replay/reset outcomes. Historical export README claims are not current acceptance evidence.
- [ ] Run `rtk pnpm test`, `rtk pnpm scenarios` and `rtk pnpm findings`. Keep core results separate from browser evidence. If browser access is unavailable, explicitly leave browser/integration acceptance pending; this does not satisfy final completion.

### Task 5: CI enforcement

**Files:** `.github/workflows/ci.yml`.

- [ ] Preserve existing matrix steps. Add `pnpm explorer:check` on Node 23.6.0 and 24, using committed artifacts without regeneration.
- [ ] Add a separate generation job using the existing checkout/pnpm/setup-node actions and exactly Node 24.6.0. Verify this agrees with `tools/explorer/toolchain.json`; require coordinated updates when changing the pin.
- [ ] In that job run `pnpm explorer:build`, `git diff --exit-code -- explorer/app/core explorer/app/manifest.json explorer/app/build.json`, and `pnpm explorer:check`.
- [ ] Also fail on newly untracked files in those generated paths, using `git ls-files --others --exclude-standard -- ...` and an explicit nonempty-output failure. Plain `git diff` cannot detect new generated modules omitted from a commit.
- [ ] Validate on a clean disposable checkout after any authorized commit: the pinned job produces no generated changes even when checkout HEAD differs from the pre-commit generation HEAD. In scratch copies, source changes without regeneration, missing generated files, new untracked modules and authored-input changes must fail the gate.
- [ ] Keep byte reproducibility restricted to the pinned generator; compatibility matrix checks are semantic checks. CI passes do not substitute for Task 4 browser/integration evidence. No new actions, services or dependencies.

### Task 6: Docs, import policy and release hygiene

**Files:** `explorer/README.md`, `AGENTS.md`, `README.md`, protocol/backlog docs; vendor audit.

- [ ] Document imported, authored and generated ownership; the exact generator version and content provenance; `pnpm explorer:build`, standalone `pnpm ui-data`, `pnpm explorer:check` and `pnpm explorer:serve`; and the separate browser acceptance boundary.
- [ ] Document future imports: replace only imported UI/runtime/design-system/assets, apply the recorded path/note transformations, reconcile any authored manifest changes in `tools/explorer/manifest-input.json`, regenerate and rerun all acceptance gates. Never overwrite repo-maintained scheduler/check/shim/vendor or generated outputs wholesale with a new export's `app/` tree.
- [ ] Add AGENTS rules for generated artifacts and authored manifest inputs; retain the repo's zero-dependency and authority boundaries. Add a concise README explorer section.
- [ ] Update protocol/backlog wording: external tooling authors the `.dc.html`, while this repo delivers the site, core, manifest, scheduler and checks. Audit B32 follow-ups against the imported UI before re-homing them; the export already includes a Purchase-store card, so do not reopen delivered work solely from stale wording. Record only confirmed remaining gaps and this co-location work.
- [ ] Audit every vendor file for retained licence/attribution and document identifiable upstream package versions/provenance. Mark unavailable provenance explicitly; do not invent versions or alter the repository's undecided licence.
- [ ] Keep branding publication approval unresolved until answered by the user. No public push, deployment or publication is part of this implementation plan.
- [ ] Run `rtk git diff --check`. Report scoped changes, core checks, pinned reproducibility, CI verification and browser/integration results separately. Final acceptance requires every required boundary above; do not label a pending browser run complete.

## Assumptions and remaining decisions

- Committed generated artifacts and unversioned paths are chosen for static hosting; this plan does not introduce a deployment pipeline.
- Node 24.6.0 is the initial exact generator pin because it is available in the reviewed environment. Updating it is a deliberate artifact regeneration and review; the package compatibility floor remains unchanged.
- The authored manifest extraction preserves existing walkthrough scripts. Their behavior is validated through actual UI runs; metadata/digest regeneration alone cannot prove the scripts match source execution.
- Branding and `_ds/` publication rights require a user decision only before public delivery. Vendor provenance gaps, if found, must be reported before release.
- Any integration repair requiring additional `.dc.html` behavior changes remains a concrete upstream/separate-scope blocker; it does not authorize core semantic changes or expansion of the allowed import edits.

## Plan review record

- Iteration 1: incorporated the six review findings: deterministic generation/CI, real explorer acceptance, complete manifest ownership, rename ordering, valid JSON metadata and static asset serving.
- Iteration 2: checked task dependencies and failure coverage; added detection of untracked generated files, shared content provenance, exact manifest inventories, independent trace hashing and a future-import policy that preserves repo-maintained code.
- Planning questions: none. Stop condition: no remaining substantial inconsistency found in the repo-grounded review; implementation and live browser acceptance remain unperformed.
