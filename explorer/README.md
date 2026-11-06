# Multi-payer explorer

Interactive explorer for `akkuverse/multipayer-poc`. Static files, no build step.

## Run

ES modules need HTTP (not `file://`). From the repository root:

```
pnpm explorer:serve        # serves explorer/ on http://127.0.0.1:8080
pnpm explorer:serve 3000   # custom port
```

Open `/` (redirects to `multipayer-explorer.dc.html`). Any static host works (GitHub Pages, Netlify).

## Layout

- `multipayer-explorer.dc.html` — the explorer (UI + logic, one file)
- `support.js` — runtime for the `.dc.html` format
- `app/core-v12/` — browser build of the PoC core (`src/`, types stripped), as of main 2026-11-05
- `app/explorer/scheduler-v9.js` — explorer-side call holds ("Hold calls")
- `app/manifest-v11.json` — scenario steps, components, journeys, baked digests
- `app/shims/`, `app/vendor/noble/` — `node:crypto` shim over @noble/ed25519 + hashes
- `_ds/…` — Akku design-system tokens and component bundle
- `app/explorer/v12-check.html` — headless check: runs every scenario + presenter journey against core-v12

## Regenerating core

`app/core-v12` is `src/**/*.ts` with types stripped and imports rewritten to `.js`. After changing `src/`, regenerate into a new folder and update the import path in the explorer's `componentDidMount` (`app/core-vNN/`), then open `app/explorer/v12-check.html` (title shows PASS/FAIL).

## Check results (2026-11-06)

- Core: 36/36 scenarios pass `check()`; 6/6 presenter journeys run; funding-loss digests match baked values.
- Explorer: all 36 guided walkthroughs complete with check() pass, no deviation, and live trace digest = `scenario.run()` digest — under Hold calls Off, Before reply and Before send (294 holds released per mode). No console errors.
