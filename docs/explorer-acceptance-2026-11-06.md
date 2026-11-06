# Explorer acceptance evidence — 2026-11-06

Recorded session evidence for the three acceptance boundaries in [../explorer/README.md](../explorer/README.md). This records one run, not a standing guarantee — rerun the gates after any regeneration or import. Raw per-run JSON was session-local (gitignored `tmp/`); this document is the durable record.


- Date: 2026-11-06 · Repo: multipayer-poc (worktree)
- Tool: `playwright-cli` 0.1.5 (global @playwright/cli), driving HeadlessChrome/157.0.0.0
  `navigator.userAgent`: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.0.0 Safari/537.36`
- Node: v24.6.0
- Server: `pnpm explorer:serve 0` → `node tools/serve.mjs` on `http://127.0.0.1:45057` (loopback only)
- `manifest.generatedFrom.inputDigest`: `09f01829739f525a7275b556d4cc1f1afacd2400bc5ca8e9a3de31866c5fee5b`
- CDN: unpkg.com reachable (support.js React/Babel loaded; UI mounted)
- Console: exactly 1 error across both pages — `GET /favicon.ico` 404 on check.html (benign). No page/script errors.

## A. Core conformance page — PASS

`GET /app/explorer/check.html` → `document.title` **PASS** after async run.
`window.__lines`: 44 lines, all `pass`, 0 FAIL/ERR/DIFF/LOAD:

- `pass inventory: 36 scenarios, manifest = core`
- `pass baked keys: 42 expected, all present`
- 36 × `pass Sxx-… <state> <digest> ev=N` — each scenario `run()`+`check()` ok, digest == baked
- 6 × `pass presenter-<j>-<m> <digest>` — each journey/mode under run id `explorer`, digest == baked

## B. Guard probe — PASS

`window.__mpxExplorer.nativeGuard === true` → core refuses competing mutations itself;
`installContractGuard` fallback is **not** installed.

## C. No-intervention walkthroughs — PASS (108/108)

Grid: 36 manifest scenarios × hold phases `off`, `request` (`Before send`), `response` (`Before reply`).
Per run: localStorage `multipayer-explorer:hold-phase` set before `loadScenario`; `continueOne({silent:true})`
looped while `canContinue()` (≤600 iters). Results: **108 complete** (stepIdx == steps), **108 check() pass**
(via `c.runCheck()` → `resultPid` purchase), **108 three-way digest equality**
`traceDigest(events) == state.refDigest == manifest.bakedDigests[id]`, 0 stalls, 0 errors.
Per-run data captured in session scratch files (not committed).

## D. Real-hold integration — PASS (S01, phase `request`)

- Hold reached: wait `a3:submit:psp-employee-1.status:[…]#1@request` outstanding during `submit`.
- Same-purchase mutation at hold: `act(cancel)` → `turn.error 'operation_in_progress'`;
  direct `sc.cancelAs(w, p1, EMPLOYEE)` → threw `operation_in_progress` (native; `c.guard` had returned null,
  so the refusal came from the core).
- Other purchase at hold: `act(lunch purchase-2)` → succeeded (`awaiting_approvals`), hold untouched.
- Released the wait → purchase-1 `completed`, waits drained. Final digest `915c019318eb1d60`
  (≠ baseline `f3e68e05e19ec105` — correctly a modified run).

## E. Replay / Back / Reset — PASS

- Modified run: inserted `advance` (clock 10→40) anchored at the request hold → completed,
  digest **D = `71674a5cd2c77205`** (≠ baked `f3e68e05e19ec105`); `modified()` true; log = 12 entries.
- Replay: fresh `loadScenario`, `exp.future = captured log`, 12 × `redoNext` → digest **== D**; the
  anchored intervention re-executed (`inserted` turn, no error).
- Back: `rewindTo(2, 0)` → log shrank to 2 entries, future = 10; forward `continueOne` → digest **== D**,
  intervention preserved (re-executed, not re-invented).
- Reset: `loadScenario` → `exp.log`/`future` empty, `modified()` false, `turns` empty.
- Missing anchors (fresh run):
  - `act` anchored to `a99:nonexistent…@request` → `redoNext` false, `replayErr`:
    “…was anchored to a99:nonexistent:psp-x.reserve:never#1@request, which the rebuilt run never reached.
    It was not moved elsewhere.”; future cleared.
  - `release` of `a99:submit:…@request` → `redoNext` false, `replayErr`:
    “the recorded wait … never occurred in the rebuilt run, so its release was not applied anywhere else.”

## F. Presenter replays — PASS (6/6)

For each `presenter-<j>-<m>`: `loadReplay` → `state.replay.digest === replay.baked ===
manifest.bakedDigests[key]`; `stepTo` moves the cursor (3 → end).

| key | digest | events | result |
|---|---|---|---|
| presenter-changed-offer-scripted | 0b53135401483a25 | 90 | completed |
| presenter-changed-offer-manual | 0589652e6bdfaf56 | 90 | completed |
| presenter-funding-loss-scripted | 9d9aa0f5b42814de | 34 | failed (expected by fixture) |
| presenter-funding-loss-manual | 33e92d632e077cd1 | 34 | failed (expected by fixture) |
| presenter-auto-pay-scripted | 6c769964af1a12bf | 117 | completed |
| presenter-auto-pay-manual | 3620d8fcd5fa7fab | 117 | completed |

## Node suites (kept separate from browser evidence)

- `pnpm test`: 593/593 pass
- `pnpm scenarios`: exit 0
- `pnpm findings`: exit 0

## Anomalies / notes

- Harness-only false positive: `s.check({w, p: currentP()})` flags S22 `state awaiting_approvals` — S22
  deliberately leaves `purchase-2` unapproved; the explorer's own `runCheck()` uses the manifest `resultPid`
  (`purchase-1`) and passes. Not an explorer defect.
- First `advance` intervention attempt (t=5 at clock 10) was refused `the simulated clock can only advance`;
  retried with `now+30`. The refused act is still recorded as an inserted turn — consistent with design.

**BLOCKED:** none.
