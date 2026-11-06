# Multi-payer explorer

Interactive explorer for `akkuverse/multipayer-poc`: a static site that runs
the PoC core in the browser — no build step to serve it.

## Run

ES modules need HTTP (not `file://`). From the repository root:

```
pnpm explorer:serve        # serves explorer/ on http://127.0.0.1:8080
pnpm explorer:serve 3000   # custom port
```

Open `/` (redirects to `multipayer-explorer.dc.html`). The site is static and
any static host can serve it.

**Runtime CDN note (imported-artifact property):** the imported
`support.js` (the `.dc.html` runtime) loads React 18.3.1, ReactDOM 18.3.1 and
Babel standalone 7.29.0 from unpkg.com when the explorer UI loads. The UI
therefore needs network access to that CDN unless those files are vendored
upstream; `app/explorer/check.html` does not. This is a property of the
imported artifact, not something the co-location introduced — vendoring or
removing the CDN dependency is an upstream/export decision and an open item
before public delivery.

## Ownership

| Path | Ownership |
|---|---|
| `index.html`, `multipayer-explorer.dc.html`, `support.js`, `_ds/`, `assets/` | Imported artifacts, authored by external tooling. The `.dc.html` receives only the import transformations recorded below. |
| `app/core/` | Generated: every `src/**/*.ts` except `src/cli.ts`, type-stripped, `.ts` specifiers rewritten to `.js`, `node:crypto` redirected to the shim. Never hand-edit; regenerate. |
| `app/manifest.json`, `app/build.json` | Generated and committed for static hosting. Never hand-edit. |
| `app/explorer/scheduler.js`, `app/explorer/check.html` | Repo-maintained: explorer-side call holds + replay, and the browser core-conformance page. |
| `app/shims/` | Hand-maintained `node:crypto` shim over the vendored noble modules. |
| `app/vendor/` | Vendored upstream code; changes only through a documented vendor update. |
| `tools/explorer/manifest-input.json` | Authored input (component cards, scenario setup/steps, journey display metadata). Lives outside the generated tree; edit deliberately, then regenerate. |
| `tools/{serve,build-explorer-core,ui-data,check-explorer,explorer-inputs}.mjs`, `tools/explorer/toolchain.json` | Repo tooling, `node:` builtins only. |

## Generation and provenance

Both writers (`build-explorer-core.mjs`, `ui-data.mjs`) require **exactly
Node 24.6.0**, pinned in `tools/explorer/toolchain.json`, and fail before any
write on a mismatch. This is a generator restriction; the repo runtime floor
stays Node >= 23.6. `stripTypeScriptTypes` output can differ between Node
versions, hence the exact pin.

Provenance is content-based, not checkout-based: `build.json` and
`manifest.generatedFrom` carry `inputDigest` (SHA-256 over the sorted source
modules, tool files, toolchain pin, manifest input, shim and vendor files)
plus `generatorNodeVersion`. No timestamps, checkout SHAs or absolute paths
are emitted, so identical inputs reproduce identical bytes in a dirty
checkout, after a commit and on a PR merge checkout.

```
pnpm explorer:build   # regenerate app/core/ + app/build.json, then app/manifest.json
pnpm ui-data          # regenerate app/manifest.json only
pnpm explorer:check   # read-only Node conformance gate (see below)
```

The manifest writer merges authored input with data derived live from `src/`:
scenario ids/titles/questions/responsibilities, fixture versions, and baked
trace digests for every scenario and every journey/mode (fixed run id
`explorer`). It runs each scenario's `check()` and each journey before
writing, so a failure leaves the committed manifest untouched.

## Acceptance boundaries — three separate gates

A pass at one boundary says nothing about the others:

1. **Node conformance** — `pnpm explorer:check`. Read-only: exact scenario
   inventories across `src/`, `app/core/` and the manifest; `run()`+`check()`
   for every scenario and journey/mode in both implementations with
   source digest = generated digest = baked digest; committed provenance
   matching live input bytes.
2. **Browser core conformance** — `app/explorer/check.html` via
   `pnpm explorer:serve`. The same inventory and digest requirements against
   the browser-loaded core and shim; the title is PASS only when every check
   succeeds. Node has a native `Buffer`; a Node pass alone does not prove
   the shim works in a browser.
3. **Explorer integration** — the real `.dc.html` + scheduler: walkthroughs
   under Hold calls Off/Before send/Before reply, native-guard detection and
   same-purchase mutation refusal at a real hold, replay to the same digest,
   Back/Reset behaviour. Core parity cannot detect a UI or replay bug
   because it never loads those layers.

A session run on 2026-11-06 exercised all three: `explorer:check` passed
(36/36 scenario and 6/6 journey/mode three-way digests), `check.html` showed
PASS, and the integration run completed 36/36 walkthroughs per hold mode
plus guard, replay, Back and Reset cases. The run is recorded in
[../docs/explorer-acceptance-2026-11-06.md](../docs/explorer-acceptance-2026-11-06.md) —
session evidence, not a permanent guarantee; rerun the gates after any
regeneration or import.

## Import transformations applied to the imported `.dc.html`

The imported `multipayer-explorer.dc.html` was edited only to match the
unversioned layout:

- `app/core-v12/` → `app/core/` (module import prefix)
- `app/explorer/scheduler-v9.js` → `app/explorer/scheduler.js` (module import)
- `app/manifest-v11.json` → `app/manifest.json` (fetch)
- Removed the obsolete conditional console-note
  (`if (!this.nativeGuard) console.info('[explorer] app/core-v12 predates …')`).
  The `nativeGuard` probe and the `installContractGuard` fallback are unchanged.

## Future imports

A new upstream export replaces **only** the imported set: `index.html`,
`multipayer-explorer.dc.html`, `support.js`, `_ds/`, `assets/`. Then:

1. Re-apply the recorded path/console-note transformations above to the new
   `.dc.html` (adjusting for whatever names the export uses).
2. Reconcile authored manifest changes in
   `tools/explorer/manifest-input.json` — the writer reads that file, never
   the previous generated manifest, as its authority.
3. Regenerate under the pinned Node: `pnpm explorer:build`.
4. Rerun all three acceptance boundaries: `pnpm explorer:check`, the browser
   check page, and the integration walkthroughs.

Never overwrite repo-maintained code (`app/explorer/`, `app/shims/`,
`app/vendor/`) or generated outputs (`app/core/`, `app/manifest.json`,
`app/build.json`) with a new export's `app/` tree. UI changes beyond the
recorded transformations require an upstream export or separately authorized
scope.

## Vendor audit

Files under `app/vendor/noble/` and the attribution each retains:

| File | Attribution found | Identifiable upstream |
|---|---|---|
| `ed25519.js` | `/*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) */` | `noble-ed25519` (the pre-`@noble`-scoped package, Paul Miller); exports the synchronous `sign`/`verify`/`getPublicKey` API |
| `hashes/utils.js` | `/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */` | `noble-hashes` / `@noble/hashes` (Paul Miller) |
| `hashes/{_u64,_md,sha256,sha512,_assert,crypto}.js` | no licence header | Same noble-hashes module family by import structure and code style; exact package version **not recorded in the export** |

Exact package versions are **not recorded in the export** for any vendored
file — do not guess them; a documented vendor update should pin and record
versions then. The repo's own licence remains undecided; these files retain
their upstream MIT attribution.

## Historical export check results (2026-11-06)

Recorded in the export's original README before co-location; kept as export
provenance, superseded as acceptance evidence by the repo's own gates above:

- Core: 36/36 scenarios pass `check()`; 6/6 presenter journeys run;
  funding-loss digests match baked values.
- Explorer: all 36 guided walkthroughs complete with check() pass, no
  deviation, and live trace digest = `scenario.run()` digest — under Hold
  calls Off, Before reply and Before send (294 holds released per mode). No
  console errors.

## Publication status

Branding and `_ds/` / `assets/` (Akku design system, Akku Labs mark)
publication rights are an **open user decision** required before any public
delivery. Nothing here records publication approval, and this repo's licence
is undecided.
