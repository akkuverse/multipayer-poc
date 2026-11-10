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

**Runtime dependencies:** the explorer runs fully offline. The imported
`support.js` names React 18.3.1, ReactDOM 18.3.1 and Babel standalone 7.29.0
on unpkg.com, but a `window.__resources` hook in `multipayer-explorer.dc.html`
(one of the recorded import transformations below) redirects all three to
vendored copies in `app/vendor/` — verified byte-identical to the upstream
files by the SRI hashes `support.js` already carried. Fonts (Outfit, Playfair
Display) are likewise vendored in `app/vendor/fonts/` instead of loading from
fonts.googleapis.com.

## Ownership

| Path | Ownership |
|---|---|
| `index.html`, `multipayer-explorer.dc.html`, `support.js`, `_ds/`, `assets/` | Imported artifacts, authored by external tooling. The `.dc.html` receives only the import transformations recorded below. |
| `app/core/` | Generated: every `src/**/*.ts` except `src/cli.ts`, type-stripped, `.ts` specifiers rewritten to `.js`, `node:crypto` redirected to the shim. Never hand-edit; regenerate. |
| `app/manifest.json`, `app/build.json` | Generated and committed for static hosting. Never hand-edit. |
| `licenses.html` | Generated from the root licence/notices and vendored licence texts by `tools/build-explorer-licenses.mjs`. Included in `pnpm explorer:build`; freshness checked by `pnpm explorer:check`. Never hand-edit. |
| `app/explorer/scheduler.js`, `app/explorer/check.html` | Repo-maintained: explorer-side call holds + replay, and the browser core-conformance page. |
| `app/shims/` | Hand-maintained `node:crypto` shim over the vendored noble modules. |
| `app/vendor/` | Vendored upstream code; changes only through a documented vendor update. |
| `tools/explorer/manifest-input.json` | Authored input (component cards, scenario setup/steps, journey display metadata, the `deferredScenarioIds` inventory). Lives outside the generated tree; edit deliberately, then regenerate. |
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
pnpm explorer:build   # regenerate core, provenance, manifest and licence page
pnpm ui-data          # regenerate app/manifest.json only
pnpm explorer:check   # read-only Node conformance gate (see below)
```

The manifest writer merges authored input with data derived live from `src/`:
scenario ids/titles/questions/responsibilities, fixture versions, and baked
trace digests for every scenario and every journey/mode (fixed run id
`explorer`). It runs each scenario's `check()` and each journey before
writing, so a failure leaves the committed manifest untouched.

`manifest.scenarios` holds one entry per authored walkthrough.
`manifest.deferredScenarioIds` names the source scenarios whose interactive
walkthrough is deliberately **deferred** (currently S37–S45, the
conditional-funding and charity scenarios): they still run, `check()` and
bake a digest under both `src/` and the generated core — the Node gate
enforces that for every source scenario — but they carry no authored steps
and get no `manifest.scenarios` entry, so the explorer UI offers no guided
walkthrough for them. Deferred never means unverified: it means walkthrough
coverage is postponed, not that parity was skipped. The two lists must
partition the source scenario set exactly — unique non-empty ids, disjoint,
union equal to every source scenario id — so no scenario is silently dropped
or listed twice.

## Acceptance boundaries — three separate gates

A pass at one boundary says nothing about the others:

1. **Node conformance** — `pnpm explorer:check`. Read-only: exact scenario
   inventories across `src/` and `app/core/`; the manifest's walkthrough
   ids ∪ `deferredScenarioIds` equal to the source set, disjoint and
   duplicate-free; `run()`+`check()` for every scenario (deferred ones
   included) and journey/mode in both implementations with
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
regeneration or import. Note the scenario set grew after that session:
`explorer:check` now reports 45 scenario comparisons (36 walkthroughs
plus the 9 deferred S37–S45 scenarios, which still run and bake digests),
so "36/36" above is the count at the time, not the current expectation.

## Import transformations applied to the imported `.dc.html`

The imported `multipayer-explorer.dc.html` was edited only to match the
unversioned layout:

- `app/core-v12/` → `app/core/` (module import prefix)
- `app/explorer/scheduler-v9.js` → `app/explorer/scheduler.js` (module import)
- `app/manifest-v11.json` → `app/manifest.json` (fetch)
- Removed the obsolete conditional console-note
  (`if (!this.nativeGuard) console.info('[explorer] app/core-v12 predates …')`).
  The `nativeGuard` probe and the `installContractGuard` fallback are unchanged.
- Added a `window.__resources` map before `./support.js` loading, redirecting
  the runtime's three unpkg.com script URLs to `app/vendor/` copies.
- Separately authorized, 2026-11-10 (publication notices): added a `Licences`
  link beside `About`, opening the local `licenses.html` in a new tab; the
  header actions use a 10px gap and centred alignment.
- In `_ds/…/colors_and_type.css`: the fonts.googleapis.com `@import` was
  replaced by `../../app/vendor/fonts/fonts.css` (vendored latin + latin-ext
  woff2 subsets).
- Separately authorized, 2026-11-08 (scenario-scoped worlds):
  `buildWorld(setup, parties)` forwards the manifest entry's derived
  `parties` (each scenario's declared `parties` in `src/scenarios.ts`) into
  `world()`/`autopayWorld()`; party cards absent from the world's party set
  render greyed-out "Not in this scenario" even under the default Used reveal
  setting instead of disappearing (the colleagues slot is now always
  reserved, so the layout is identical across scenarios); the setup narration names only parties the world contains and
  the employer-allowance beats appear only when the mandate was actually
  published; colleague wallets, actor captions, payee/fault/move lists and
  pre-purchase provider tiles derive from the present world (captions use
  the replayed scenario’s membership in replay). The existing action guard
  disables operations needing absent signers, accounts or payees, including
  split presets and agent selections; declared but unauthorized signers
  remain available for refusal scenarios, as do intentionally unregistered
  signing identities for bad-signature checks. The setup overview derives its
  authority claims from the actual publication beats. `colOn()` prefers
  `meta.parties` over the step-scanning heuristic.

Known limitation in the imported `.dc.html`: it reads authorization details
through `au.approval.payload` without a `basis === 'pledge'` guard (e.g.
~line 2954). Harmless today — fund/charity purchases only exist in the
deferred S37–S45 scenarios, which have no walkthroughs — but when fund or
charity walkthroughs are authored, this reader (and any sibling `.approval`
reads in the imported surface) needs the pledge discriminant, via an
upstream fix or a separately authorized import transformation.

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
| `hashes/{_u64,_md,sha256,sha512,_assert,crypto}.js` | no licence header | `@noble/hashes` **1.5.0** — verified byte-identical to the published `esm/` files; `utils.js` differs only in the `@noble/hashes/crypto` → `./crypto.js` specifier rewrite |
| `react/react.production.min.js` | `LICENSE` (MIT) vendored alongside | `react` **18.3.1**, verified byte-identical to upstream by the SRI hash `support.js` carried |
| `react-dom/react-dom.production.min.js` | `LICENSE` (MIT) vendored alongside | `react-dom` **18.3.1**, same SRI verification |
| `babel-standalone/babel.min.js` | `LICENSE` (MIT) vendored alongside | `@babel/standalone` **7.29.0**, same SRI verification |
| `fonts/{fonts.css,*.woff2}` | vendored; OFL-licensed fonts | Outfit + Playfair Display, latin + latin-ext subsets fetched 2026-11-06 from fonts.googleapis.com |

`ed25519.js` matches no published `noble-ed25519` tarball byte-for-byte — it is
a source-derived build of the 1.x lineage (same `Point`/`sign`/`verify` API),
so its exact version is **not recorded**; do not guess it. The repo's own
code uses BSL 1.1; these files retain their upstream MIT licences.

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
publication rights: **approved by the repository owner on 2026-11-06**.
The repository's own code uses [BSL 1.1](../LICENSE). Bundled third-party
licences and the permission for displaying and redistributing unchanged
Akku assets with the explorer are recorded in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

The header's **Licences** link opens [licenses.html](licenses.html), which
contains the complete BSL, third-party notices (including noble MIT and
font OFL texts), and React, React DOM and Babel MIT licences. It is
self-contained and must accompany every standalone `explorer/` deployment.
Edit the source notices, then run `pnpm explorer:build`; `pnpm explorer:check`
rejects a stale licence page. Its freshness is checked separately from the
browser-core input digest because it contains documentation, not core inputs.
