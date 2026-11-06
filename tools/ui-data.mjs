// Writes the complete explorer manifest: authored display input from
// tools/explorer/manifest-input.json plus everything derived live from src/
// — scenario ids/titles/questions/responsibilities, the fixture versions,
// the input digest and every baked trace digest. The writer runs each
// source scenario and every journey/mode before writing anything, so a
// failed check or an id mismatch leaves the committed manifest untouched.
// See docs/superpowers/plans/2026-11-06-explorer-colocation.md contract 3.
//
// Usage: node tools/ui-data.mjs        (also: pnpm ui-data)

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  REPO_ROOT,
  computeInputDigest,
  requireGeneratorNode,
  requireIdSet,
  requireUniqueIds,
  validateManifestInput,
} from './explorer-inputs.mjs';

// The fixed run id every journey bake uses: one deterministic convention,
// named in bakedDigestSource so a reader can reproduce each digest.
const JOURNEY_RUN_ID = 'explorer';

export async function writeManifest({
  root = REPO_ROOT,
  srcDir = join(root, 'src'),
  inputPath = join(root, 'tools/explorer/manifest-input.json'),
  outPath = join(root, 'explorer/app/manifest.json'),
} = {}) {
  // Normalize every path to absolute: defaults are repo-relative via
  // import.meta.url, never the caller's cwd; explicit paths resolve there.
  root = resolve(root);
  srcDir = resolve(srcDir);
  inputPath = resolve(inputPath);
  outPath = resolve(outPath);
  // The pin is required before any writes, staging included.
  const generatorNodeVersion = requireGeneratorNode(root);

  const authored = validateManifestInput(JSON.parse(readFileSync(inputPath, 'utf8')));

  const { scenarios, FIXTURE_VERSION } = await import(pathToFileURL(join(srcDir, 'scenarios.ts')).href);
  const { PRESENTER_FIXTURE_VERSION } = await import(pathToFileURL(join(srcDir, 'presenter/fixtures.ts')).href);
  const { PRESENTER_JOURNEYS, PRESENTER_MODES, runPresenterJourney, runAutoPayJourney } = await import(
    pathToFileURL(join(srcDir, 'presenter/journeys.ts')).href,
  );
  const { traceDigest } = await import(pathToFileURL(join(srcDir, 'evidence/run-record.ts')).href);

  // Exact id-set equality between authored input and source, on both the
  // scenario map (keyed ids — a repeated key collapses to a count mismatch)
  // and the journeys array (duplicate ids rejected above).
  const sourceIds = scenarios.map((s) => s.id);
  requireUniqueIds(sourceIds, 'src scenarios');
  requireIdSet(Object.keys(authored.scenarios), sourceIds, 'manifest scenarios vs src/scenarios.ts');
  const journeyIds = [...PRESENTER_JOURNEYS, 'auto-pay'];
  requireIdSet(
    authored.journeys.map((j) => j.id),
    journeyIds,
    'manifest journeys vs PRESENTER_JOURNEYS ∪ {auto-pay}',
  );

  // Every run and check happens before the output is replaced.
  const bakedDigests = {};
  const scenarioEntries = [];
  for (const s of scenarios) {
    const { w, p } = await s.run();
    const problem = s.check({ w, p });
    if (problem !== undefined) throw new Error(`scenario ${s.id} check() failed: ${problem}`);
    const a = authored.scenarios[s.id];
    const entry = {
      id: s.id,
      title: s.title,
      question: s.question,
      responsibility: s.responsibility,
      setup: a.setup,
      steps: a.steps,
    };
    if (a.resultPid !== undefined) entry.resultPid = a.resultPid;
    scenarioEntries.push(entry);
    bakedDigests[s.id] = traceDigest(w.trace.events);
  }
  for (const journey of PRESENTER_JOURNEYS) {
    for (const mode of PRESENTER_MODES) {
      const rec = await runPresenterJourney(journey, mode, JOURNEY_RUN_ID);
      bakedDigests[`presenter-${journey}-${mode}`] = rec.run.traceDigest;
    }
  }
  for (const mode of PRESENTER_MODES) {
    const rec = await runAutoPayJourney(mode, JOURNEY_RUN_ID);
    bakedDigests[`presenter-auto-pay-${mode}`] = rec.run.traceDigest;
  }

  const manifest = {
    manifestVersion: authored.manifestVersion,
    generatedFrom: {
      inputDigest: computeInputDigest(root),
      generatorNodeVersion,
      fixtureVersion: FIXTURE_VERSION,
      presenterFixtureVersion: PRESENTER_FIXTURE_VERSION,
    },
    components: authored.components,
    scenarios: scenarioEntries,
    journeys: authored.journeys,
    bakedDigests,
    bakedDigestSource: {
      command: 'pnpm explorer:build',
      scenarios: 'each scenario id maps to the trace digest of its run() in src/scenarios.ts',
      journeys: `each presenter-<journey>-<mode> maps to the trace digest of runPresenterJourney / runAutoPayJourney with run id '${JOURNEY_RUN_ID}'`,
    },
  };
  if (authored.build !== undefined) manifest.build = authored.build;

  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, outPath);
  return { outPath, scenarioCount: scenarioEntries.length, digestCount: Object.keys(bakedDigests).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const { outPath, scenarioCount, digestCount } = await writeManifest();
    console.log(
      `explorer manifest: ${scenarioCount} scenarios, ${digestCount} baked digests → ${relative(REPO_ROOT, outPath)}`,
    );
  } catch (e) {
    console.error(`ui-data: ${e.message}`);
    process.exit(1);
  }
}
