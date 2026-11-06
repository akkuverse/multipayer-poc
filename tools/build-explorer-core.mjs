// Generates the committed browser core: every src/**/*.ts module except the
// CLI entry, type-stripped with node:module's stripTypeScriptTypes under the
// pinned generator Node, .ts specifiers rewritten to .js and node:crypto
// redirected to the hand-maintained shim. Generation is staged, the staged
// inventory and imports are validated, then explorer/app/core/ is replaced —
// authored directories are never touched. A deterministic build.json lands
// beside it: content provenance only, no timestamps or checkout SHAs.
// See docs/superpowers/plans/2026-11-06-explorer-colocation.md contract 2.
//
// Usage: node tools/build-explorer-core.mjs        (also: pnpm explorer:build)

import { stripTypeScriptTypes } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, computeInputDigest, requireGeneratorNode, sourceModules, toPosix } from './explorer-inputs.mjs';

const isIdChar = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
const isIdStart = (c) => c !== undefined && /[A-Za-z_$]/.test(c);
const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';
const isQuote = (c) => c === "'" || c === '"';

// Skip whitespace and comments forward from j inside a code region.
const skipTrivia = (code, j) => {
  const n = code.length;
  for (;;) {
    while (j < n && isWs(code[j])) j++;
    if (code[j] === '/' && code[j + 1] === '/') {
      while (j < n && code[j] !== '\n') j++;
      continue;
    }
    if (code[j] === '/' && code[j + 1] === '*') {
      const e = code.indexOf('*/', j + 2);
      j = e < 0 ? n : e + 2;
      continue;
    }
    return j;
  }
};

// Skip a string literal starting at code[i] (a quote); returns the index
// after the closing quote, or end of input if unterminated.
const skipString = (code, i) => {
  const q = code[i];
  let j = i + 1;
  const n = code.length;
  while (j < n) {
    if (code[j] === '\\') j += 2;
    else if (code[j] === q) return j + 1;
    else j++;
  }
  return j;
};

// The token ending at index i (exclusive), walking back over identifier
// characters. Returns '' when the previous character is not an identifier.
const wordBefore = (code, i) => {
  let j = i;
  while (j > 0 && isIdChar(code[j - 1])) j--;
  return code.slice(j, i);
};

// Rewrite module specifiers in code regions only — comments, string literals
// and template text pass through byte-identical. Recognised forms:
//   import ... from 'x' / export ... from 'x' / import 'x' / import('x')
// 'node:crypto' is replaced by shimSpec; relative .ts specifiers gain a .js
// suffix. Any other specifier fails naming the source file. Returns the
// rewritten code and the rewritten specifier list for import validation.
function rewriteSpecifiers(code, shimSpec, sourceName) {
  const specs = [];
  let out = '';
  const n = code.length;
  let i = 0;
  // State stack: a 'code' region or a template literal. `}` at brace depth 0
  // inside a nested code region returns to the surrounding template.
  const stack = [{ t: 'code', braces: 0 }];
  const top = () => stack[stack.length - 1];

  // A 'from' keyword only starts a specifier in import/export position:
  // preceded by an identifier (import x from), '}' (import {x} from /
  // export {x} from) or '*' (export * from). A property key like
  // { from: 'x' } is preceded by '{' or ',' and is left alone.
  const fromIsSpecifier = (at) => {
    let j = at;
    for (;;) {
      while (j > 0 && isWs(code[j - 1])) j--;
      if (code[j - 2] === '/' && code[j - 1] === '/') {
        // Start of a line comment — the token before it is the context.
        j -= 2;
        continue;
      }
      if (j >= 2 && code[j - 2] === '*' && code[j - 1] === '/') {
        const open = code.lastIndexOf('/*', j - 2);
        j = open < 0 ? 0 : open;
        continue;
      }
      break;
    }
    const c = code[j - 1];
    if (c === '}') return true;
    if (c === '*') {
      // '*' only when the '*' itself follows export: `export * from`.
      let k = j - 1;
      while (k > 0 && isWs(code[k - 1])) k--;
      return wordBefore(code, k) === 'export';
    }
    // An identifier is the binding clause's tail: `import x from`,
    // `import * as ns from` — in both cases `from` is specifier position.
    return isIdChar(c);
  };

  // Read the specifier following a matched keyword at index i. Returns the
  // index after the closing quote, or -1 when none follows.
  const readSpecifier = (at, word) => {
    let j = skipTrivia(code, at + word.length);
    if (word === 'import' && code[j] === '(') {
      j = skipTrivia(code, j + 1);
    }
    if (!isQuote(code[j])) return -1;
    const start = j;
    const end = skipString(code, j);
    specs.push({ from: code.slice(start + 1, end - 1), start, end });
    return end;
  };

  const rewrite = (spec) => {
    if (spec === 'node:crypto') return shimSpec;
    if (spec.endsWith('.ts') && spec.startsWith('.')) return `${spec.slice(0, -3)}.js`;
    throw new Error(`${sourceName}: unresolved module specifier '${spec}'`);
  };

  while (i < n) {
    const st = top();
    const c = code[i];
    if (st.t === 'tmpl') {
      if (c === '\\') {
        out += code.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        out += c;
        i++;
        stack.pop();
      } else if (c === '$' && code[i + 1] === '{') {
        out += '${';
        i += 2;
        stack.push({ t: 'code', braces: 0 });
      } else {
        out += c;
        i++;
      }
      continue;
    }
    // code region
    if (c === '/' && code[i + 1] === '/') {
      const e = code.indexOf('\n', i);
      const end = e < 0 ? n : e;
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const e = code.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (isQuote(c)) {
      const end = skipString(code, i);
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (c === '`') {
      out += c;
      i++;
      stack.push({ t: 'tmpl' });
      continue;
    }
    if (c === '{') {
      st.braces++;
      out += c;
      i++;
      continue;
    }
    if (c === '}') {
      if (st.braces === 0 && stack.length > 1) stack.pop();
      else st.braces = Math.max(0, st.braces - 1);
      out += c;
      i++;
      continue;
    }
    if (isIdStart(c) && !isIdChar(code[i - 1])) {
      let j = i;
      while (j < n && isIdChar(code[j])) j++;
      const word = code.slice(i, j);
      if ((word === 'from' && fromIsSpecifier(i)) || word === 'import') {
        const end = readSpecifier(i, word);
        if (end > 0) {
          const s = specs[specs.length - 1];
          const to = rewrite(s.from);
          s.to = to;
          // Keep the surrounding quotes verbatim; replace only the text.
          out += code.slice(i, s.start + 1) + to + code[end - 1];
          i = end;
          continue;
        }
      }
      out += word;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return { code: out, specs };
}

// Backstop: the scanner does not model regex literals, so a specifier in a
// mis-scanned region could survive unrewritten. Fail loudly if the emitted
// code still holds a specifier-shaped '.ts' string.
const STALE_TS_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)['"][^'"]*\.ts['"]/;
const requireNoStaleTsSpecifiers = (code, sourceName) => {
  const m = STALE_TS_SPECIFIER.exec(code);
  if (m) throw new Error(`${sourceName}: unrewritten .ts specifier survived: ${m[0]}`);
};

// POSIX relative specifier from a generated file's directory to shimPath.
const shimSpecifier = (outFileDir, shimPath) => {
  const rel = toPosix(relative(outFileDir, shimPath));
  return rel.startsWith('.') ? rel : `./${rel}`;
};

const headerFor = (rel) =>
  `// GENERATED from src/${toPosix(rel)} — type-stripped build artifact; never hand-edit.\n`;

// Build the browser core. All paths default to the repository layout via
// import.meta.url — never the caller's cwd — and root may point at a scratch
// copy for validation runs.
export function buildExplorerCore({ root = REPO_ROOT, srcDir = join(root, 'src'), outDir = join(root, 'explorer/app/core'), shimPath = join(root, 'explorer/app/shims/node-crypto.js') } = {}) {
  // Normalize every path to absolute: defaults are repo-relative via
  // import.meta.url, never the caller's cwd; explicit paths resolve there.
  root = resolve(root);
  srcDir = resolve(srcDir);
  outDir = resolve(outDir);
  shimPath = resolve(shimPath);
  // The pin is required before any writes, staging included.
  const generatorNodeVersion = requireGeneratorNode(root);

  const modules = sourceModules(srcDir);
  if (modules.length === 0) throw new Error(`no source modules under ${srcDir}`);
  const parent = dirname(outDir);
  mkdirSync(parent, { recursive: true });
  // Sweep staging leftovers from a killed earlier run before staging anew.
  for (const entry of readdirSync(parent)) {
    if (entry.startsWith(`.${basename(outDir)}-staging-`)) rmSync(join(parent, entry), { recursive: true, force: true });
  }
  const staging = mkdtempSync(join(parent, `.${basename(outDir)}-staging-`));

  try {
    const emitted = [];
    for (const rel of modules) {
      const sourceName = `src/${toPosix(rel)}`;
      let stripped;
      try {
        stripped = stripTypeScriptTypes(readFileSync(join(srcDir, rel), 'utf8'), { mode: 'strip' });
      } catch (e) {
        throw new Error(`${sourceName}: type stripping failed — ${e.message}`);
      }
      const outRel = `${rel.slice(0, -3)}.js`;
      const outAbs = join(staging, outRel);
      const { code, specs } = rewriteSpecifiers(stripped, shimSpecifier(dirname(outAbs), shimPath), sourceName);
      requireNoStaleTsSpecifiers(code, sourceName);
      mkdirSync(dirname(outAbs), { recursive: true });
      writeFileSync(outAbs, headerFor(rel) + code);
      emitted.push({ rel, outRel, outAbs, specs });
    }

    // Validate the staged inventory and imports before replacing anything:
    // every emitted .js specifier resolves inside the staging tree, and every
    // shim specifier resolves to the hand-maintained shim itself.
    const shimAbs = resolve(shimPath);
    for (const f of emitted) {
      for (const s of f.specs) {
        const target = resolve(dirname(f.outAbs), s.to);
        if (target === shimAbs) continue;
        if (!target.startsWith(staging + sep)) {
          throw new Error(`${f.rel}: specifier '${s.to}' escapes the generated core`);
        }
        if (!existsSync(target)) {
          throw new Error(`${f.rel}: specifier '${s.to}' does not resolve to a generated module`);
        }
      }
    }
    if (!existsSync(shimAbs)) throw new Error(`crypto shim missing: ${shimPath}`);

    rmSync(outDir, { recursive: true, force: true });
    renameSync(staging, outDir);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }

  const buildPath = join(parent, 'build.json');
  const build = {
    generatedFrom: { inputDigest: computeInputDigest(root), generatorNodeVersion },
    fileCount: modules.length,
  };
  writeFileSync(buildPath, `${JSON.stringify(build, null, 2)}\n`);
  return { fileCount: modules.length, outDir, buildPath };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const { fileCount, outDir, buildPath } = buildExplorerCore();
    console.log(`explorer core: ${fileCount} modules → ${relative(REPO_ROOT, outDir)}; ${relative(REPO_ROOT, buildPath)}`);
  } catch (e) {
    console.error(`build-explorer-core: ${e.message}`);
    process.exit(1);
  }
}
