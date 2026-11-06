// The read-only explorer conformance gate (contract 4, "Node conformance").
// Reads the committed generated core, manifest and build metadata and
// requires: exact scenario inventories across src/ and the generated core;
// the manifest's walkthrough ids ∪ deferredScenarioIds equal to the source
// set exactly, with the two lists disjoint; a generated-module inventory
// equal to src/ minus cli.ts;
// exactly the expected baked-digest keys; a passing run()+check() per
// scenario in BOTH implementations with source digest = generated digest =
// baked digest — and the same three-way equality for every journey/mode
// run under the fixed run id 'explorer'; and committed provenance matching
// the live input bytes, toolchain pin and fixture versions.
//
// The checked population derives from src/ and the generated tree — never
// from the manifest — so a deleted manifest entry cannot shrink it. Trace
// digests are computed here with native node:crypto, never through the
// generated core's own helper, so a broken generated hash or crypto shim
// cannot validate itself. Nothing in this file writes or re-baselines.
//
// Runs on the whole compatibility matrix (>= 23.6); only the writers are
// pinned to the generator Node. See
// docs/superpowers/plans/2026-11-06-explorer-colocation.md contract 4.
//
// Usage: node tools/check-explorer.mjs [root]   (also: pnpm explorer:check)
// The optional root is for validating scratch copies; canonical artifacts
// are never modified either way.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, computeInputDigest, listTree, loadToolchain, sourceModules } from './explorer-inputs.mjs';

// The fixed run id every baked journey digest was produced under — the
// same convention tools/ui-data.mjs records in bakedDigestSource.
const JOURNEY_RUN_ID = 'explorer';

// sha256(JSON.stringify(events)).hex.slice(0,16) — the same rule as
// src/evidence/run-record.ts traceDigest, computed locally so this gate
// does not trust either implementation's own digest helper.
const digestEvents = (events) =>
  createHash('sha256').update(JSON.stringify(events)).digest('hex').slice(0, 16);

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const unique = (list) => [...new Set(list)];

// Ids appearing more than once in a list (a Set collapses them, so
// duplicates need their own detection to stay a hard failure).
const duplicatesOf = (ids) => {
  const seen = new Set();
  const dup = new Set();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
};

export async function checkExplorer({ root = REPO_ROOT } = {}) {
  root = resolve(root);
  const failures = [];
  const fail = (m) => failures.push(m);

  const readJson = (rel) => {
    try {
      return JSON.parse(readFileSync(join(root, rel), 'utf8'));
    } catch (e) {
      fail(`cannot read ${rel}: ${e.message}`);
      return undefined;
    }
  };
  const importModule = async (rel) => {
    try {
      return await import(pathToFileURL(join(root, rel)).href);
    } catch (e) {
      fail(`load error ${rel}: ${e.message}`);
      return undefined;
    }
  };

  const manifest = readJson('explorer/app/manifest.json');
  const build = readJson('explorer/app/build.json');

  // --- Inventories ---------------------------------------------------------
  // The source scenario list is the authority; the generated core must hold
  // exactly the same id set, and the manifest's walkthrough entries plus
  // deferred inventory must partition it — all with no duplicates.
  const srcScenariosMod = await importModule('src/scenarios.ts');
  const genScenariosMod = await importModule('explorer/app/core/scenarios.js');
  const srcIds = srcScenariosMod?.scenarios?.map((s) => s.id) ?? [];
  const genIds = genScenariosMod?.scenarios?.map((s) => s.id) ?? [];
  const manIds = Array.isArray(manifest?.scenarios) ? manifest.scenarios.map((s) => s.id) : [];
  const deferredIds = Array.isArray(manifest?.deferredScenarioIds) ? manifest.deferredScenarioIds : [];

  if (manifest !== undefined && !Array.isArray(manifest.scenarios)) {
    fail('manifest.scenarios must be an array of scenario entries');
  }
  if (manifest !== undefined) {
    if (manifest.deferredScenarioIds === undefined) {
      fail('manifest.deferredScenarioIds is missing — an empty array records no deferred walkthroughs');
    } else if (!Array.isArray(manifest.deferredScenarioIds)) {
      fail('manifest.deferredScenarioIds must be an array of scenario ids');
    } else {
      for (const [i, id] of manifest.deferredScenarioIds.entries()) {
        if (typeof id !== 'string' || id === '') {
          fail(`manifest.deferredScenarioIds[${i}] must be a non-empty string`);
        }
      }
    }
  }
  if (srcScenariosMod !== undefined && !Array.isArray(srcScenariosMod.scenarios)) {
    fail('src/scenarios.ts exports no scenarios array');
  }
  if (genScenariosMod !== undefined && !Array.isArray(genScenariosMod.scenarios)) {
    fail('explorer/app/core/scenarios.js exports no scenarios array');
  }
  if (srcScenariosMod && Array.isArray(srcScenariosMod.scenarios) && !srcIds.length) {
    fail('src/scenarios.ts exports an empty scenarios array');
  }

  for (const [where, ids] of [
    ['src/scenarios.ts', srcIds],
    ['explorer/app/core/scenarios.js', genIds],
    ['manifest.scenarios', manIds],
    ['manifest.deferredScenarioIds', deferredIds],
  ]) {
    for (const id of duplicatesOf(ids)) fail(`${where}: duplicate scenario id '${id}'`);
  }
  const missingIn = (have) => unique(srcIds).filter((x) => !have.includes(x));
  const unexpectedIn = (have) => unique(have).filter((x) => !srcIds.includes(x));
  {
    const missing = missingIn(genIds);
    const extra = unexpectedIn(genIds);
    if (missing.length) fail(`explorer/app/core/scenarios.js: missing scenario ids ${missing.join(', ')}`);
    if (extra.length) fail(`explorer/app/core/scenarios.js: unexpected scenario ids ${extra.join(', ')}`);
  }
  // The manifest partitions the source set: walkthrough entries and the
  // deferred inventory must be disjoint, and their union must equal the
  // source ids exactly — no scenario silently dropped or listed twice.
  {
    const overlap = unique(deferredIds).filter((x) => manIds.includes(x));
    if (overlap.length) {
      fail(`manifest: scenario ids in both scenarios and deferredScenarioIds: ${overlap.join(', ')}`);
    }
    const covered = [...unique(manIds), ...unique(deferredIds)];
    const missing = missingIn(covered);
    const extra = unexpectedIn(covered);
    if (missing.length) {
      fail(`manifest.scenarios ∪ deferredScenarioIds: missing scenario ids ${missing.join(', ')}`);
    }
    if (extra.length) {
      fail(`manifest.scenarios ∪ deferredScenarioIds: unexpected scenario ids ${extra.join(', ')}`);
    }
  }

  // The generated-module inventory: every src/**/*.ts except cli.ts as
  // .js, no extras and nothing missing.
  let expectedModules = [];
  try {
    expectedModules = sourceModules(join(root, 'src')).map((p) => `${p.slice(0, -3)}.js`);
  } catch (e) {
    fail(`cannot inventory src/: ${e.message}`);
  }
  let coreFiles = [];
  try {
    coreFiles = listTree(join(root, 'explorer/app/core'));
  } catch (e) {
    fail(`cannot inventory explorer/app/core: ${e.message}`);
  }
  {
    const missing = expectedModules.filter((x) => !coreFiles.includes(x));
    const extra = coreFiles.filter((x) => !expectedModules.includes(x));
    if (missing.length) fail(`explorer/app/core: missing generated modules ${missing.join(', ')}`);
    if (extra.length) fail(`explorer/app/core: unexpected files ${extra.join(', ')}`);
  }

  // --- Baked-digest keys ----------------------------------------------------
  // Expected keys derive from the source contracts — PRESENTER_JOURNEYS,
  // 'auto-pay' and PRESENTER_MODES — never from the manifest itself.
  const srcJourneysMod = await importModule('src/presenter/journeys.ts');
  const genJourneysMod = await importModule('explorer/app/core/presenter/journeys.js');
  const journeyIds = [...(srcJourneysMod?.PRESENTER_JOURNEYS ?? []), 'auto-pay'];
  const modes = srcJourneysMod?.PRESENTER_MODES ?? [];
  if (srcJourneysMod && !Array.isArray(srcJourneysMod.PRESENTER_JOURNEYS)) {
    fail('src/presenter/journeys.ts exports no PRESENTER_JOURNEYS array');
  }
  if (srcJourneysMod && Array.isArray(srcJourneysMod.PRESENTER_MODES) && !modes.length) {
    fail('src/presenter/journeys.ts exports an empty PRESENTER_MODES array');
  }
  if (srcJourneysMod && genJourneysMod) {
    for (const name of ['PRESENTER_JOURNEYS', 'PRESENTER_MODES']) {
      const s = srcJourneysMod[name];
      const g = genJourneysMod[name];
      if (!Array.isArray(g)) fail(`explorer/app/core/presenter/journeys.js exports no ${name} array`);
      else if (JSON.stringify(g) !== JSON.stringify(s)) {
        fail(`generated core ${name} is ${JSON.stringify(g)}, src exports ${JSON.stringify(s)}`);
      }
    }
  }

  // The manifest journey list must cover exactly the same journey set.
  const manJourneyIds = Array.isArray(manifest?.journeys) ? manifest.journeys.map((j) => j.id) : [];
  if (manifest !== undefined && !Array.isArray(manifest.journeys)) {
    fail('manifest.journeys must be an array of journey entries');
  }
  for (const id of duplicatesOf(manJourneyIds)) fail(`manifest.journeys: duplicate journey id '${id}'`);
  {
    const missing = journeyIds.filter((x) => !manJourneyIds.includes(x));
    const extra = unique(manJourneyIds).filter((x) => !journeyIds.includes(x));
    if (missing.length) fail(`manifest.journeys: missing journey ids ${missing.join(', ')}`);
    if (extra.length) fail(`manifest.journeys: unexpected journey ids ${extra.join(', ')}`);
  }

  const expectedKeys = [...unique(srcIds)];
  for (const j of journeyIds) for (const m of modes) expectedKeys.push(`presenter-${j}-${m}`);

  const baked = manifest?.bakedDigests;
  const bakedOk = isPlainObject(baked);
  if (manifest !== undefined && !bakedOk) {
    fail('manifest.bakedDigests must be an object keyed by scenario id / presenter key');
  }
  if (bakedOk) {
    const keys = Object.keys(baked);
    const missing = expectedKeys.filter((x) => !keys.includes(x));
    const extra = keys.filter((x) => !expectedKeys.includes(x));
    if (missing.length) fail(`manifest.bakedDigests: missing keys ${missing.join(', ')}`);
    if (extra.length) fail(`manifest.bakedDigests: unexpected keys ${extra.join(', ')}`);
  }

  // --- Three-way digests -----------------------------------------------------
  // Every scenario runs under src/ and under the generated core; each
  // check() must pass and all three digests must be equal. A missing
  // generated counterpart or a failed load is already a recorded failure.
  let scenarioRuns = 0;
  if (srcScenariosMod && genScenariosMod && bakedOk) {
    const genById = new Map((genScenariosMod.scenarios ?? []).map((s) => [s.id, s]));
    for (const s of srcScenariosMod.scenarios ?? []) {
      let srcDigest;
      try {
        const r = await s.run();
        const problem = s.check(r);
        if (problem !== undefined) fail(`scenario ${s.id}: src check() failed: ${problem}`);
        srcDigest = digestEvents(r.w.trace.events);
      } catch (e) {
        fail(`scenario ${s.id}: src run() threw: ${e.message}`);
      }
      const g = genById.get(s.id);
      let genDigest;
      if (g === undefined) {
        fail(`scenario ${s.id}: no generated-core counterpart to run`);
      } else {
        try {
          const r = await g.run();
          const problem = g.check(r);
          if (problem !== undefined) fail(`scenario ${s.id}: generated check() failed: ${problem}`);
          genDigest = digestEvents(r.w.trace.events);
        } catch (e) {
          fail(`scenario ${s.id}: generated run() threw: ${e.message}`);
        }
      }
      const bakedDigest = baked[s.id];
      if (srcDigest !== undefined && genDigest !== undefined) {
        scenarioRuns++;
        if (typeof bakedDigest !== 'string') {
          // Already reported as a missing key; name the comparison it blocked.
          fail(`scenario ${s.id}: no baked digest to compare against`);
        } else if (!(srcDigest === genDigest && genDigest === bakedDigest)) {
          fail(`scenario ${s.id}: digest mismatch src=${srcDigest} generated=${genDigest} baked=${bakedDigest}`);
        }
      }
    }
  }

  // Every journey/mode in both implementations under run id 'explorer';
  // the record's events are hashed here, not through recordRun's digest.
  let journeyRuns = 0;
  if (srcJourneysMod && genJourneysMod && bakedOk) {
    const runOne = async (mod, j, m) =>
      j === 'auto-pay'
        ? mod.runAutoPayJourney(m, JOURNEY_RUN_ID)
        : mod.runPresenterJourney(j, m, JOURNEY_RUN_ID);
    for (const j of journeyIds) {
      for (const m of modes) {
        const key = `presenter-${j}-${m}`;
        let srcDigest;
        try {
          srcDigest = digestEvents((await runOne(srcJourneysMod, j, m)).run.events);
        } catch (e) {
          fail(`${key}: src journey run threw: ${e.message}`);
        }
        let genDigest;
        try {
          genDigest = digestEvents((await runOne(genJourneysMod, j, m)).run.events);
        } catch (e) {
          fail(`${key}: generated journey run threw: ${e.message}`);
        }
        const bakedDigest = baked[key];
        if (srcDigest !== undefined && genDigest !== undefined) {
          journeyRuns++;
          if (typeof bakedDigest !== 'string') {
            fail(`${key}: no baked digest to compare against`);
          } else if (!(srcDigest === genDigest && genDigest === bakedDigest)) {
            fail(`${key}: digest mismatch src=${srcDigest} generated=${genDigest} baked=${bakedDigest}`);
          }
        }
      }
    }
  }

  // --- Provenance -----------------------------------------------------------
  // The committed provenance must match the live input bytes, the pinned
  // generator version and the live fixture versions — staleness means the
  // artifacts no longer describe the inputs they claim to.
  let inputDigest;
  try {
    inputDigest = computeInputDigest(root);
  } catch (e) {
    fail(`cannot compute input digest: ${e.message}`);
  }
  let pin;
  try {
    pin = loadToolchain(root).nodeVersion;
  } catch (e) {
    fail(`cannot read toolchain pin: ${e.message}`);
  }
  const srcFixturesMod = await importModule('src/presenter/fixtures.ts');

  // Contract 1 fixes the artifact shapes exactly: build.json carries only
  // {generatedFrom:{inputDigest,generatorNodeVersion},fileCount} and
  // manifest.generatedFrom the same two fields plus the fixture versions —
  // no timestamps, checkout SHAs or absolute paths may appear.
  const keySet = (o) => (isPlainObject(o) ? Object.keys(o).sort().join(',') : '');
  if (build !== undefined) {
    if (keySet(build) !== 'fileCount,generatedFrom') {
      fail(`build.json keys are ${keySet(build)}, expected fileCount,generatedFrom`);
    }
    if (keySet(build.generatedFrom) !== 'generatorNodeVersion,inputDigest') {
      fail(`build.json generatedFrom keys are ${keySet(build.generatedFrom)}, expected generatorNodeVersion,inputDigest`);
    }
    if (build.fileCount !== expectedModules.length) {
      fail(`build.json fileCount is ${build.fileCount}, the generated inventory has ${expectedModules.length} modules`);
    }
  }
  if (manifest !== undefined && keySet(manifest.generatedFrom) !== 'fixtureVersion,generatorNodeVersion,inputDigest,presenterFixtureVersion') {
    fail(`manifest generatedFrom keys are ${keySet(manifest.generatedFrom)}, expected fixtureVersion,generatorNodeVersion,inputDigest,presenterFixtureVersion`);
  }

  if (inputDigest !== undefined) {
    if (build?.generatedFrom?.inputDigest !== inputDigest) {
      fail(`build.json generatedFrom.inputDigest is ${build?.generatedFrom?.inputDigest}, live inputs give ${inputDigest}`);
    }
    if (manifest?.generatedFrom?.inputDigest !== inputDigest) {
      fail(`manifest generatedFrom.inputDigest is ${manifest?.generatedFrom?.inputDigest}, live inputs give ${inputDigest}`);
    }
  }
  if (pin !== undefined) {
    if (build?.generatedFrom?.generatorNodeVersion !== pin) {
      fail(`build.json generatedFrom.generatorNodeVersion is ${build?.generatedFrom?.generatorNodeVersion}, pinned ${pin}`);
    }
    if (manifest?.generatedFrom?.generatorNodeVersion !== pin) {
      fail(`manifest generatedFrom.generatorNodeVersion is ${manifest?.generatedFrom?.generatorNodeVersion}, pinned ${pin}`);
    }
  }
  if (manifest !== undefined) {
    const fixture = manifest.generatedFrom?.fixtureVersion;
    const liveFixture = srcScenariosMod?.FIXTURE_VERSION;
    if (srcScenariosMod && liveFixture === undefined) fail('src/scenarios.ts exports no FIXTURE_VERSION');
    else if (liveFixture !== undefined && fixture !== liveFixture) {
      fail(`manifest generatedFrom.fixtureVersion is ${fixture}, live FIXTURE_VERSION is ${liveFixture}`);
    }
    const pfixture = manifest.generatedFrom?.presenterFixtureVersion;
    const livePfixture = srcFixturesMod?.PRESENTER_FIXTURE_VERSION;
    if (srcFixturesMod && livePfixture === undefined) fail('src/presenter/fixtures.ts exports no PRESENTER_FIXTURE_VERSION');
    else if (livePfixture !== undefined && pfixture !== livePfixture) {
      fail(`manifest generatedFrom.presenterFixtureVersion is ${pfixture}, live PRESENTER_FIXTURE_VERSION is ${livePfixture}`);
    }
  }

  return { failures, scenarioRuns, journeyRuns, moduleCount: coreFiles.length, bakedCount: bakedOk ? Object.keys(baked).length : 0, inputDigest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const root = process.argv[2] !== undefined ? { root: process.argv[2] } : {};
    const { failures, scenarioRuns, journeyRuns, moduleCount, bakedCount, inputDigest } = await checkExplorer(root);
    for (const f of failures) console.error(`FAIL ${f}`);
    if (failures.length) {
      console.error(`check-explorer: FAIL — ${failures.length} problem(s)`);
      process.exit(1);
    }
    console.log(
      `check-explorer: PASS — ${scenarioRuns} scenario comparisons, ${journeyRuns} journey/mode comparisons, ` +
        `${moduleCount} generated modules, ${bakedCount} baked digests; inputDigest ${inputDigest}`,
    );
  } catch (e) {
    console.error(`check-explorer: ${e.message}`);
    process.exit(1);
  }
}
