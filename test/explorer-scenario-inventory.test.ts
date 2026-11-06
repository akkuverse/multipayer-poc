// Tooling tests for the explorer scenario-inventory contract: authored
// walkthrough ids ∪ deferredScenarioIds must partition the source scenario
// set exactly (unique, disjoint, nothing dropped, nothing invented), and a
// deferred scenario keeps full generated parity — it still runs, check()s
// under both src/ and the generated core, and carries a baked digest. Only
// its interactive walkthrough is deferred. Ids are derived from src/ and
// the tooling artifacts — no second copy of the scenario list lives here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  requireIdSet,
  validateDeferredScenarioIds,
  validateManifestInput,
} from '../tools/explorer-inputs.mjs';
import { checkExplorer } from '../tools/check-explorer.mjs';
import { scenarios } from '../src/scenarios.ts';

const sourceIds = scenarios.map((s) => s.id);

const authoredInput = () =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'tools/explorer/manifest-input.json'), 'utf8'));

const generatedManifest = () =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'explorer/app/manifest.json'), 'utf8'));

test('the committed authored input validates and partitions every source scenario id', () => {
  const input = validateManifestInput(authoredInput());
  const walked = Object.keys(input.scenarios);
  const deferred = input.deferredScenarioIds ?? [];
  assert.ok(deferred.length > 0, 'expected a non-empty deferred inventory');
  // Disjoint was enforced by the validator; the union must equal src ids.
  requireIdSet([...walked, ...deferred], sourceIds, 'walkthroughs ∪ deferred vs src');
  assert.equal(walked.length + deferred.length, sourceIds.length);
});

test('deferredScenarioIds is optional: absent validates as an empty inventory', () => {
  const input = authoredInput();
  delete input.deferredScenarioIds;
  assert.deepEqual(validateDeferredScenarioIds(input.deferredScenarioIds, Object.keys(input.scenarios)), []);
  assert.doesNotThrow(() => validateManifestInput(input));
});

test('a deferred id that is also an authored walkthrough is rejected', () => {
  const input = authoredInput();
  const walkedId = Object.keys(input.scenarios)[0];
  input.deferredScenarioIds = [...(input.deferredScenarioIds ?? []), walkedId];
  assert.throws(() => validateManifestInput(input), /overlap.*walkthroughs/);
});

test('duplicate deferred ids are rejected', () => {
  const input = authoredInput();
  const first = input.deferredScenarioIds[0];
  input.deferredScenarioIds = [first, first];
  assert.throws(() => validateManifestInput(input), /duplicate id/);
});

test('a non-array or empty-string deferred id is rejected', () => {
  const input = authoredInput();
  input.deferredScenarioIds = 'S37';
  assert.throws(() => validateManifestInput(input), /must be an array/);
  input.deferredScenarioIds = [''];
  assert.throws(() => validateManifestInput(input), /non-empty string/);
});

test('the writer partition check rejects a silently dropped id and an unknown id', () => {
  const input = validateManifestInput(authoredInput());
  const walked = Object.keys(input.scenarios);
  const deferred = input.deferredScenarioIds;
  // Missing: remove one deferred id without adding a walkthrough for it.
  assert.throws(
    () => requireIdSet([...walked, ...deferred.slice(1)], sourceIds, 'partition'),
    /missing/,
  );
  // Unknown: a deferred id that names no source scenario.
  assert.throws(
    () => requireIdSet([...walked, ...deferred, 'S00-not-a-scenario'], sourceIds, 'partition'),
    /unexpected/,
  );
});

test('a valid explicit partition passes validator and writer checks', () => {
  const walked = sourceIds.slice(0, 1);
  const deferred = sourceIds.slice(1);
  assert.deepEqual(validateDeferredScenarioIds(deferred, walked), deferred);
  requireIdSet([...walked, ...deferred], sourceIds, 'partition');
});

test('deferred scenarios keep full generated parity: baked digest and src/generated checks', async () => {
  const manifest = generatedManifest();
  const deferred = manifest.deferredScenarioIds ?? [];
  const walked = manifest.scenarios.map((s: { id: string }) => s.id);
  // The generated manifest partitions the source set exactly once.
  assert.deepEqual([...walked, ...deferred].sort(), [...sourceIds].sort());
  assert.equal(new Set([...walked, ...deferred]).size, sourceIds.length);
  // Every deferred id still carries a baked digest.
  for (const id of deferred) {
    assert.equal(typeof manifest.bakedDigests[id], 'string', `${id} has no baked digest`);
    assert.equal(manifest.bakedDigests[id].length, 16);
  }
  // The Node gate ran and checked every source scenario — deferred ids
  // included — in both implementations and compared all three digests.
  const { failures, scenarioRuns, journeyRuns } = await checkExplorer({ root: REPO_ROOT });
  assert.deepEqual(failures, []);
  assert.equal(scenarioRuns, sourceIds.length);
  assert.ok(journeyRuns > 0);
});
