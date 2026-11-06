// Shared inputs for the explorer generators: the source-module inventory,
// the content-provenance input digest, the exact generator-Node pin and the
// authored manifest-input validation. Node builtins only; nothing here
// writes. See docs/superpowers/plans/2026-11-06-explorer-colocation.md
// contract 1 (provenance) and contract 3 (manifest generation).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(TOOLS_DIR);

export const toPosix = (p) => p.split(sep).join('/');

// Every file under dir, sorted, as POSIX paths relative to dir.
export function listTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

// The browser-core module inventory: all src/**/*.ts except the top-level
// CLI entry, sorted, as POSIX paths relative to srcDir.
export function sourceModules(srcDir) {
  return listTree(srcDir)
    .filter((p) => p.endsWith('.ts') && p !== 'cli.ts')
    .sort();
}

// The sorted set of repo-relative input paths the digest covers: the source
// modules, the generator scripts and this helper, the toolchain pin, the
// authored manifest input, and the hand-maintained shim and vendor trees.
// Generated outputs (app/core, manifest.json, build.json), git metadata and
// documentation are deliberately excluded.
export function inputPaths(root = REPO_ROOT) {
  const srcModules = sourceModules(join(root, 'src')).map((p) => `src/${p}`);
  const fixed = [
    'tools/explorer/toolchain.json',
    'tools/explorer/manifest-input.json',
    'tools/explorer-inputs.mjs',
    'tools/build-explorer-core.mjs',
    'tools/ui-data.mjs',
  ];
  const appInputs = ['explorer/app/shims', 'explorer/app/vendor'].flatMap((d) =>
    listTree(join(root, d)).map((p) => `${d}/${p}`),
  );
  return [...srcModules, ...fixed, ...appInputs].sort();
}

// SHA-256 over the sorted, length-framed sequence of repo-relative POSIX
// paths and raw file bytes. Identical inputs give the same digest in a dirty
// checkout, after a commit and on a PR merge checkout — the digest never
// names a checkout, a timestamp or an absolute path.
export function computeInputDigest(root = REPO_ROOT) {
  const h = createHash('sha256');
  for (const rel of inputPaths(root)) {
    const pathBytes = Buffer.from(rel, 'utf8');
    const bytes = readFileSync(join(root, rel));
    h.update(String(pathBytes.length));
    h.update(':');
    h.update(pathBytes);
    h.update(String(bytes.length));
    h.update(':');
    h.update(bytes);
  }
  return h.digest('hex');
}

// The exact generator pin in tools/explorer/toolchain.json
// ({ "nodeVersion": "24.6.0" }). Anything else is a malformed pin.
export function loadToolchain(root = REPO_ROOT) {
  const raw = JSON.parse(readFileSync(join(root, 'tools/explorer/toolchain.json'), 'utf8'));
  const keys = Object.keys(raw);
  if (keys.length !== 1 || typeof raw.nodeVersion !== 'string' || raw.nodeVersion === '') {
    throw new Error('tools/explorer/toolchain.json must be exactly {"nodeVersion":"<version>"}');
  }
  return raw;
}

// Both writers require exactly the pinned Node before making any writes;
// stripTypeScriptTypes output can vary between versions. A mismatch fails
// naming the required and actual versions. The package runtime floor
// (>= 23.6) is unchanged — this restricts generation only.
export function requireGeneratorNode(root = REPO_ROOT) {
  const required = loadToolchain(root).nodeVersion;
  const actual = process.versions.node;
  if (actual !== required) {
    throw new Error(`explorer generation requires Node ${required} (tools/explorer/toolchain.json), running ${actual}`);
  }
  return required;
}

// --- Authored manifest-input validation -----------------------------------
// Field sets follow the manifest reads in explorer/multipayer-explorer.dc.html:
// components {id,name,actor,src,url,modal,resp}; journeys {id,title,question,
// responsibility}; scenario setup read by buildWorld()/prologue(); steps
// {label,node,op,args,expect}; resultPid picks the result purchase; build
// {coreHash,version} is optional display metadata. Unknown authored fields
// are rejected rather than silently dropped.

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const kindOf = (v) => (Array.isArray(v) ? 'array' : typeof v);

const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.has(k));

// Diagram node ids the explorer renders (its NODE_ORDER) plus the synthetic
// 'clock' step node.
const STEP_NODES = new Set([
  'employer', 'employee', 'colleagues', 'agent', 'merchants', 'registries',
  'coordinator', 'orchestrator', 'ledger', 'policy', 'views', 'store', 'psps',
  'backend', 'interbank', 'clock',
]);

const SETUP_FIELDS = new Map([
  ['employee', 'object'],
  ['mandate', 'object'],
  ['initiation', 'string'],
  ['faults', 'object'],
  ['pspOffline', 'array'],
  ['refundsSupported', 'boolean'],
  ['startT', 'number'],
  ['autopay', 'boolean'],
  ['session', 'string'],
  ['terms', 'string'],
  ['mandateRoute', 'boolean'],
  ['termsOverride', 'object'],
  ['submitPolicy', 'string'],
  ['settlementMode', 'string'],
]);

const SCENARIO_INPUT_FIELDS = new Set(['setup', 'steps', 'resultPid']);
const STEP_REQUIRED = ['label', 'node', 'op'];
const STEP_FIELDS = new Set(['label', 'node', 'op', 'args', 'expect']);
const COMPONENT_FIELDS = ['id', 'name', 'actor', 'src', 'url', 'modal', 'resp'];
const JOURNEY_FIELDS = ['id', 'title', 'question', 'responsibility'];
const TOP_FIELDS = new Set([
  'manifestVersion',
  'components',
  'scenarios',
  'journeys',
  'build',
  'deferredScenarioIds',
]);
const BUILD_FIELDS = new Set(['coreHash', 'version']);

export function validateSetup(setup, where) {
  if (!isPlainObject(setup)) throw new Error(`${where}: 'setup' must be an object`);
  for (const [k, v] of Object.entries(setup)) {
    const t = SETUP_FIELDS.get(k);
    if (t === undefined) throw new Error(`${where}: unknown setup field '${k}'`);
    if (kindOf(v) !== t) {
      throw new Error(`${where}: setup.${k} must be ${t === 'array' ? 'an array' : `a ${t}`}, got ${kindOf(v)}`);
    }
  }
}

export function validateSteps(steps, where) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${where}: 'steps' must be a non-empty array`);
  }
  steps.forEach((s, i) => {
    const w = `${where} step ${i}`;
    if (!isPlainObject(s)) throw new Error(`${w}: must be an object`);
    const extra = unknownKeys(s, STEP_FIELDS);
    if (extra.length) throw new Error(`${w}: unknown field(s) ${extra.join(', ')}`);
    for (const f of STEP_REQUIRED) {
      if (typeof s[f] !== 'string' || s[f] === '') throw new Error(`${w}: '${f}' must be a non-empty string`);
    }
    if (!STEP_NODES.has(s.node)) throw new Error(`${w}: unknown node '${s.node}'`);
    if (s.args !== undefined && !isPlainObject(s.args)) throw new Error(`${w}: 'args' must be an object`);
    if (s.expect !== undefined && typeof s.expect !== 'string') throw new Error(`${w}: 'expect' must be a string`);
  });
}

// One authored scenario entry keyed by scenario id: the walkthrough script
// the explorer drives (setup/steps) plus the optional result-purchase pin.
export function validateScenarioEntry(entry, id) {
  const where = `scenarios['${id}']`;
  if (!isPlainObject(entry)) throw new Error(`${where}: must be an object`);
  const extra = unknownKeys(entry, SCENARIO_INPUT_FIELDS);
  if (extra.length) throw new Error(`${where}: unknown field(s) ${extra.join(', ')}`);
  for (const f of ['setup', 'steps']) {
    if (entry[f] === undefined) throw new Error(`${where}: missing '${f}'`);
  }
  if (entry.resultPid !== undefined && typeof entry.resultPid !== 'string') {
    throw new Error(`${where}: 'resultPid' must be a string`);
  }
  validateSetup(entry.setup, where);
  validateSteps(entry.steps, where);
}

const validateRecordArray = (list, fields, what) => {
  if (!Array.isArray(list) || list.length === 0) throw new Error(`'${what}' must be a non-empty array`);
  const allowed = new Set(fields);
  list.forEach((o, i) => {
    const where = `${what}[${i}]`;
    if (!isPlainObject(o)) throw new Error(`${where}: must be an object`);
    const extra = unknownKeys(o, allowed);
    if (extra.length) throw new Error(`${where}: unknown field(s) ${extra.join(', ')}`);
    for (const f of fields) {
      if (o[f] === undefined) throw new Error(`${where}: missing '${f}'`);
    }
  });
  return list;
};

export function validateComponents(components) {
  validateRecordArray(components, COMPONENT_FIELDS, 'components');
  components.forEach((c, i) => {
    const where = `components[${i}]`;
    for (const f of ['id', 'name', 'actor', 'url', 'modal', 'resp']) {
      if (typeof c[f] !== 'string' || c[f] === '') throw new Error(`${where}: '${f}' must be a non-empty string`);
    }
    if (!Array.isArray(c.src) || c.src.length === 0 || c.src.some((x) => typeof x !== 'string')) {
      throw new Error(`${where}: 'src' must be a non-empty string array`);
    }
  });
  requireUniqueIds(components.map((c) => c.id), 'components');
}

export function validateJourneys(journeys) {
  validateRecordArray(journeys, JOURNEY_FIELDS, 'journeys');
  journeys.forEach((j, i) => {
    for (const f of JOURNEY_FIELDS) {
      if (typeof j[f] !== 'string' || j[f] === '') throw new Error(`journeys[${i}]: '${f}' must be a non-empty string`);
    }
  });
  requireUniqueIds(journeys.map((j) => j.id), 'journeys');
}

// The optional authored 'deferredScenarioIds' inventory: source scenario ids
// that deliberately get NO authored walkthrough — they still run, check()
// and bake a digest in both implementations; only the interactive
// walkthrough is deferred. Validation: an array of unique non-empty id
// strings, disjoint from the authored walkthrough keys. Exact coverage of
// the source id set is checked by the writer, which owns the source list.
// Returns the validated list ([] when absent).
export function validateDeferredScenarioIds(ids, walkthroughIds) {
  if (ids === undefined) return [];
  if (!Array.isArray(ids)) {
    throw new Error("manifest input: 'deferredScenarioIds' must be an array of scenario ids");
  }
  ids.forEach((id, i) => {
    if (typeof id !== 'string' || id === '') {
      throw new Error(`manifest input: deferredScenarioIds[${i}] must be a non-empty string`);
    }
  });
  requireUniqueIds(ids, 'manifest input: deferredScenarioIds');
  const walked = new Set(walkthroughIds);
  const overlap = ids.filter((id) => walked.has(id));
  if (overlap.length) {
    throw new Error(
      `manifest input: deferredScenarioIds overlap authored walkthroughs: ${overlap.join(', ')}`,
    );
  }
  return ids;
}

// Validate the whole authored manifest input; returns it unchanged. Throws
// before the writer touches the generated manifest on any structural fault.
export function validateManifestInput(input) {
  if (!isPlainObject(input)) throw new Error('manifest input must be an object');
  const extra = unknownKeys(input, TOP_FIELDS);
  if (extra.length) throw new Error(`manifest input: unknown field(s) ${extra.join(', ')}`);
  for (const f of ['manifestVersion', 'components', 'scenarios', 'journeys']) {
    if (input[f] === undefined) throw new Error(`manifest input: missing '${f}'`);
  }
  if (typeof input.manifestVersion !== 'string' || input.manifestVersion === '') {
    throw new Error("manifest input: 'manifestVersion' must be a non-empty string");
  }
  validateComponents(input.components);
  // Scenario entries are keyed by scenario id; exact set equality of
  // walkthrough keys ∪ deferred ids with the source scenario ids is checked
  // by the writer, which owns the source list.
  if (!isPlainObject(input.scenarios)) throw new Error("manifest input: 'scenarios' must be an object keyed by scenario id");
  for (const [id, entry] of Object.entries(input.scenarios)) {
    validateScenarioEntry(entry, id);
  }
  validateDeferredScenarioIds(input.deferredScenarioIds, Object.keys(input.scenarios));
  validateJourneys(input.journeys);
  if (input.build !== undefined) {
    if (!isPlainObject(input.build)) throw new Error("manifest input: 'build' must be an object");
    const bx = unknownKeys(input.build, BUILD_FIELDS);
    if (bx.length) throw new Error(`manifest input: unknown build field(s) ${bx.join(', ')}`);
    for (const [k, v] of Object.entries(input.build)) {
      if (typeof v !== 'string') throw new Error(`manifest input: build.${k} must be a string`);
    }
  }
  return input;
}

// Exact set equality between authored and expected ids — missing and
// unexpected ids are both reported. Array-order differences are ignored.
export function requireIdSet(actual, expected, what) {
  const a = new Set(actual);
  const e = new Set(expected);
  const missing = [...e].filter((x) => !a.has(x));
  const unexpected = [...a].filter((x) => !e.has(x));
  if (missing.length || unexpected.length) {
    throw new Error(
      `${what}: id set mismatch` +
        (missing.length ? ` — missing: ${missing.join(', ')}` : '') +
        (unexpected.length ? ` — unexpected: ${unexpected.join(', ')}` : ''),
    );
  }
}

export function requireUniqueIds(ids, what) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${what}: duplicate id '${id}'`);
    seen.add(id);
  }
}
