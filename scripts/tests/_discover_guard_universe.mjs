#!/usr/bin/env node
// scripts/tests/_discover_guard_universe.mjs
//
// P4 (plan-2026-07-15-wave-1-g6-anti-vacuity-registry, Wave 1b) — DISCOVER the STRUCTURALLY-
// DERIVED guard universe: every vitest enforcement guard, every scripts/tests/*.sh gate, and
// every eslint-rules/*.js rule. This is the sibling of scripts/tests/_discover_scanner_checks.py
// (the SHELL fail-point discoverer). It mirrors that module's fail-closed + denominator discipline.
//
// ── WHY AN AST CLASSIFIER, NOT A GREP (F3, R3-2) ────────────────────────────────────────────
// G-6's central claim is universal: EVERY enforcement guard ships a proof it can fail. That claim
// is only worth anything if the candidate set is COMPUTED from the tree — so a guard added tomorrow
// is in scope tomorrow, without anyone remembering to list it. A `grep`/substring discoverer is
// FORBIDDEN here: a path named in a `//` comment or a string literal would count, which is the exact
// G-6 vacuity class this plan exists to kill — reintroducing it inside G-6's own discovery is
// self-defeating. So clause (b) parses the TEST's TypeScript AST (comments are not AST nodes;
// identifiers inside string/template text are not code) and qualifies a test iff ANY of the THREE
// EXHAUSTIVE mechanisms fires — the only ways a test can reference committed first-party code:
//
//   M-fs    — a real fs-touch (readFileSync/readdirSync/globSync/existsSync/statSync/cpSync/…)
//             whose argument AST-resolves (literal / const dataflow) to a GIT-TRACKED path
//             (membership by `git ls-files`, NEVER a hardcoded root list — CR-68). Excludes a
//             call on a MOCKED fs binding and an arg whose dataflow originates in tmpdir/mkdtemp.
//   M-exec  — a committed-tree / committed-script shell-out: execSync/execFileSync/spawnSync whose
//             command (i) invokes `git ls-files|grep|diff|show|log` (a read of the COMMITTED TREE),
//             OR (ii) runs bash/sh/node/npx on a script path (in the command string OR an array arg)
//             resolving to a TRACKED file OR a dist/ build-output of tracked source. Keyed on the
//             COMMAND's shape + embedded script path — NOT on the first arg being a file (every exec
//             first-arg is a command string, so that rule would be INERT — CL-28).
//   M-import— a static import / require / dynamic import() of a COMMITTED first-party module (a
//             relative ../ specifier, or a @/ / @massu/ alias) resolving to a tracked module — NOT
//             a vitest/node:/third-party specifier. Fires on the IMPORT itself (R11-2), symmetric
//             with M-fs/M-exec firing on the CALL — never on the binding reaching an expect().
//
// ── FAIL-CLOSED ON UNRESOLVABLE (blind-gate M2 applied to discovery — R11-1) ─────────────────
// "I could not resolve this reference" ≠ "this test references nothing first-party." The former is
// an ERROR that demands a ruling, the latter is the silent drop this plan exists to kill. So a
// *.test.ts that textually contains ANY fs/exec/import reference token whose target the resolver
// CANNOT resolve to a tracked artifact (a `readFileSync(runtimeVar)`, a dynamic `import(var)`, a
// spawn of a runtime-variable script) enters the candidate set FLAGGED `unresolvable-reference` —
// NEVER silently dropped. Under-inclusion is closed by (resolution ∪ fail-closed-flagging).
//
// ── NO-TOKEN SUB-CHANNEL (R11-2) ────────────────────────────────────────────────────────────
// A guard whose first-party touch happens in a vitest setupFiles/globalSetup module carries no
// token in its own body to resolve-or-flag. Today NO vitest.config.* declares either (CL-31), so
// the channel is empty — but the discoverer WATCHES it and FAILs CLOSED if one is ever added.
//
// ── OVER-INCLUSION IS SAFE, UNDER-INCLUSION IS THE DISEASE ───────────────────────────────────
// M-import is deliberately broad (most tests import first-party source). That is HARMLESS: every
// candidate is RULED downstream (a registered can-fail proof if GUARD, or a cited `exempt` entry if
// NON-GUARD). Under-inclusion silently drops a guard — the case-(c) fails-open this wave exists to
// kill. So the broad tracked-membership predicate is the SAFE direction; a narrow root allowlist is
// the dangerous one. This discoverer yields a CANDIDATE set; enforcement-guard membership is decided
// by the per-candidate RULING in gate-registry.json (R6-1), never by this classifier alone.
//
// Emits JSON on stdout:
//   {
//     "denominator": {"test_ts": N, "scripts_tests_sh": M, "eslint_rules": K, "tracked": T},
//     "cr_named":   ["packages/core/src/__tests__/....test.ts", ...],   // clause (a), for invariant (i)
//     "candidates": [
//       {"kind":"vitest-guard","path":"...","mechanisms":["M-fs","M-import",...],
//        "cr_named":bool, "flags":["unresolvable-reference"?], "hits":[{...evidence...}]},
//       {"kind":"shell-gate-script","path":"scripts/tests/....sh"},
//       {"kind":"eslint","path":"eslint-rules/....js"}
//     ]
//   }
//
// Exit 0 with JSON on success. Nonzero (FATAL to stderr) on any unreadable/zero-denominator input.
//
// Usage: node scripts/tests/_discover_guard_universe.mjs [--repo-root PATH]

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function fatal(msg) {
  process.stderr.write(`FATAL: ${msg}\n`);
  process.exit(2);
}

let ts;
try { ts = require('typescript'); }
catch (e) { fatal(`typescript not resolvable: ${e.message}`); }

// ── args ────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo-root') a.repoRoot = argv[++i];
    else fatal(`unknown arg: ${argv[i]}`);
  }
  if (!a.repoRoot) {
    a.repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  }
  return a;
}

// ── git-tracked membership (the SoT for "committed first-party", never a hardcoded root list) ──
function gitTracked(repoRoot) {
  let out;
  try {
    out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    fatal(`git ls-files failed in ${repoRoot}: ${e.message} — cannot see the committed tree (M2: cannot-look is not nothing-found).`);
  }
  const set = new Set(out.split('\0').filter(Boolean));
  if (set.size === 0) fatal(`git ls-files returned ZERO tracked files — refusing to report an empty tree.`);
  return set;
}

function lsFilesGlob(repoRoot, pattern) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', pattern], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\0').filter(Boolean);
  } catch (e) {
    fatal(`git ls-files '${pattern}' failed: ${e.message}`);
  }
}

// ── path helpers ──────────────────────────────────────────────────────────────────────────────
// Map a resolved absolute path to a repo-relative POSIX path, or null if outside the repo.
function repoRel(repoRoot, abs) {
  const rel = path.relative(repoRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// A dist/build/out artifact whose compiled PRE-IMAGE is tracked source (…/dist/x.js → …/src/x.ts).
function distPreimageTracked(repoRel_, tracked) {
  if (!repoRel_) return false;
  const m = repoRel_.match(/^(.*)\/(dist|build|out)\/(.+)$/);
  if (!m) return false;
  const [, pkg, , rest] = m;
  const restNoExt = rest.replace(/\.(js|mjs|cjs)$/, '');
  // esbuild --outdir=dist/hooks src/hooks/*.ts  →  dist/hooks/X.js  ⇐  src/hooks/X.ts
  // esbuild --outfile=dist/cli.js src/cli.ts     →  dist/cli.js      ⇐  src/cli.ts
  const cands = [`${pkg}/src/${restNoExt}.ts`, `${pkg}/src/${restNoExt}.tsx`];
  return cands.some((c) => tracked.has(c));
}

// ── source-root climb + module resolution for M-import specifiers ─────────────────────────────
const IMPORT_EXT_PROBE = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json'];
function resolveModuleSpecifier(repoRoot, tracked, fileDir, spec) {
  // Returns {resolved:true, repoRel} | {resolved:false, firstParty:bool}
  // firstParty=true means "clearly a first-party specifier we FAILED to resolve" → unresolvable flag.
  if (spec.startsWith('.')) {
    const base = path.resolve(fileDir, spec);
    const cands = [base, ...IMPORT_EXT_PROBE.map((e) => base + e), ...IMPORT_EXT_PROBE.map((e) => path.join(base, 'index' + e))];
    for (const c of cands) {
      const rr = repoRel(repoRoot, c);
      if (rr && tracked.has(rr)) return { resolved: true, repoRel: rr };
    }
    return { resolved: false, firstParty: true };
  }
  if (spec.startsWith('@/')) {
    // website alias @/* → website/src/*
    const base = path.join(repoRoot, 'website', 'src', spec.slice(2));
    const cands = [base, ...IMPORT_EXT_PROBE.map((e) => base + e), ...IMPORT_EXT_PROBE.map((e) => path.join(base, 'index' + e))];
    for (const c of cands) {
      const rr = repoRel(repoRoot, c);
      if (rr && tracked.has(rr)) return { resolved: true, repoRel: rr };
    }
    return { resolved: false, firstParty: true };
  }
  if (spec.startsWith('@massu/')) {
    // First-party workspace package (packages/*). Its source is tracked; treat as first-party.
    // We don't need the exact file — M-import qualifies on importing a committed first-party module.
    return { resolved: true, repoRel: `@massu:${spec}` };
  }
  // vitest / node: / bare third-party → not first-party.
  return { resolved: false, firstParty: false };
}

// ── scratch/tmpdir markers (an fs arg whose dataflow originates here is EXCLUDED, not a guard) ──
const SCRATCH_NAME_RE = /(^|[_.])(tmp|temp|scratch|testdir|test_dir|tmpdir|workdir|fixturedir)($|[_.])/i;
const SCRATCH_CALLEES = new Set(['tmpdir', 'mkdtemp', 'mkdtempSync', 'mkdirtemp']);

// ── the fs-touch verb set (M-fs) and the exec verbs (M-exec) ──────────────────────────────────
const FS_TOUCH = new Set([
  'readFileSync', 'readFile', 'readdirSync', 'readdir', 'globSync', 'glob',
  'existsSync', 'statSync', 'stat', 'lstatSync', 'accessSync', 'access',
  'cpSync', 'cp', 'copyFileSync', 'copyFile', 'createReadStream', 'openSync',
]);
const EXEC_VERBS = new Set(['execSync', 'execFileSync', 'spawnSync', 'exec', 'execFile', 'spawn']);
const GIT_TREE_RE = /\bgit\b[^\n]*\b(ls-files|grep|diff|show|log|cat-file|rev-parse)\b/;
const INTERPRETER_RE = /(^|[\s'"/])(bash|sh|node|npx|tsx|ts-node)(\s|$|['"])/;

// ── resolve a path-ish expression node ────────────────────────────────────────────────────────
//   status: 'abs'   value=absolute path       (from __dirname/join/resolve/fileURLToPath)
//           'lit'   value=raw string literal  (a path segment or a plain string — NOT abs-promoted)
//           'scratch'                          (tmpdir/mkdtemp/named-scratch — EXCLUDED from M-fs)
//           'unresolvable'                     (a runtime variable we cannot trace)
//   `partial:true` on an 'abs' result means we resolved a leading PREFIX (e.g. join(SRC, loopVar)
//   resolved SRC but not loopVar) — the value is the deepest tracked-checkable base. That base is a
//   committed DIR the fs call reads under, so it still qualifies as M-fs (plan CL-23).
function makeResolver(tsMod, fileDir, consts) {
  const t = tsMod;
  function res(node, seen = new Set()) {
    if (!node) return { status: 'unresolvable' };
    if (t.isParenthesizedExpression(node)) return res(node.expression, seen);
    if (t.isAsExpression(node) || t.isTypeAssertionExpression?.(node)) return res(node.expression, seen);
    // string literal / no-substitution template → a RAW segment (never abs-promoted here)
    if (t.isStringLiteral(node) || t.isNoSubstitutionTemplateLiteral(node)) {
      if (SCRATCH_NAME_RE.test(node.text)) return { status: 'scratch' };
      return { status: 'lit', value: node.text };
    }
    if (t.isIdentifier(node)) {
      if (node.text === '__dirname') return { status: 'abs', value: fileDir };
      if (node.text === '__filename') return { status: 'abs', value: path.join(fileDir, '__file__.ts') };
      if (SCRATCH_NAME_RE.test(node.text)) return { status: 'scratch' };
      if (seen.has(node.text)) return { status: 'unresolvable' };
      const init = consts.get(node.text);
      if (init) { const s2 = new Set(seen); s2.add(node.text); return res(init, s2); }
      return { status: 'unresolvable' };
    }
    if (t.isPropertyAccessExpression(node)) {
      const txt = safeText(node);
      if (/import\.meta\.(url|dirname|filename)/.test(txt)) return { status: 'abs', value: fileDir };
      return { status: 'unresolvable' };
    }
    if (t.isCallExpression(node)) {
      const callee = node.expression;
      const name = t.isIdentifier(callee) ? callee.text
        : t.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (SCRATCH_CALLEES.has(name)) return { status: 'scratch' };
      if (name === 'fileURLToPath') return { status: 'abs', value: path.join(fileDir, '__file__.ts') };
      if (name === 'dirname') { const r = res(node.arguments[0], seen); return r.status === 'abs' ? { status: 'abs', value: path.dirname(r.value), partial: r.partial } : r.status === 'scratch' ? r : { status: 'abs', value: fileDir }; }
      if (name === 'cwd') return { status: 'abs', value: fileDir };
      if (name === 'join' || name === 'resolve') {
        // Build an absolute path from the arguments left→right (path.resolve semantics: an
        // absolute arg resets the base). Stop at the first UNRESOLVABLE arg and return the
        // resolved PREFIX as a partial base — that prefix is the committed dir being read under.
        let base = null;
        for (const arg of node.arguments) {
          const r = res(arg, seen);
          if (r.status === 'scratch') return { status: 'scratch' };
          if (r.status === 'unresolvable') {
            return base != null ? { status: 'abs', value: base, partial: true } : { status: 'unresolvable' };
          }
          if (r.status === 'abs') { base = r.value; if (r.partial) return { status: 'abs', value: base, partial: true }; continue; }
          // 'lit' segment
          const seg = r.value;
          if (base == null) base = path.isAbsolute(seg) ? seg : path.resolve(fileDir, seg);
          else base = path.resolve(base, seg);
        }
        return base != null ? { status: 'abs', value: base } : { status: 'unresolvable' };
      }
      return { status: 'unresolvable' };
    }
    if (t.isTemplateExpression(node)) {
      // Only used for M-fs path building; scratch propagates. If a span is unresolvable we cannot
      // form the path → unresolvable (fail-closed). Static-only templates give a raw string.
      let out = node.head.text; let sawAbs = false;
      for (const span of node.templateSpans) {
        const r = res(span.expression, seen);
        if (r.status === 'scratch') return { status: 'scratch' };
        if (r.status === 'unresolvable') return { status: 'unresolvable' };
        if (r.status === 'abs') sawAbs = true;
        out += r.value + span.literal.text;
      }
      if (SCRATCH_NAME_RE.test(out)) return { status: 'scratch' };
      if (sawAbs || path.isAbsolute(out)) return { status: 'abs', value: out };
      return { status: 'lit', value: out };
    }
    if (t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.PlusToken) {
      const l = res(node.left, seen), r = res(node.right, seen);
      if (l.status === 'scratch' || r.status === 'scratch') return { status: 'scratch' };
      if (l.status === 'unresolvable' || r.status === 'unresolvable') return { status: 'unresolvable' };
      const combined = l.value + r.value;
      if (l.status === 'abs' || r.status === 'abs' || path.isAbsolute(combined)) return { status: 'abs', value: combined };
      return { status: 'lit', value: combined };
    }
    return { status: 'unresolvable' };
  }
  return res;
}

function safeText(node) {
  try { return node.getText(); } catch { return ''; }
}

// ── classify one *.test.ts ────────────────────────────────────────────────────────────────────
function classifyTest(repoRoot, tracked, trackedDirs, relPath) {
  // A read/exec target is "committed" iff the resolved repo-relative path is a tracked FILE, a
  // tracked DIRECTORY (some tracked file lives under it — covers join(SRC, loopVar) → CL-23), or
  // a dist/ build-output whose tracked source pre-image exists (CL-30).
  const committedHit = (rr) => !!rr && (tracked.has(rr) || trackedDirs.has(rr) || distPreimageTracked(rr, tracked));
  const abs = path.join(repoRoot, relPath);
  const fileDir = path.dirname(abs);
  let src;
  try { src = readFileSync(abs, 'utf8'); }
  catch (e) { fatal(`cannot read test file ${relPath}: ${e.message}`); }

  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true,
    abs.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  // fs mocked? (vi.mock('fs'|'node:fs') OR readFileSync: vi.fn()) — exclude M-fs entirely.
  const fsMocked = /vi\.mock\(\s*['"](node:)?fs(\/promises)?['"]/.test(src)
    || /\b(readFileSync|readdirSync|existsSync|statSync)\s*:\s*vi\.fn/.test(src);

  // Collect top-level + block const initializers for dataflow resolution.
  const consts = new Map();
  const collectConsts = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (!consts.has(node.name.text)) consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectConsts);
  };
  collectConsts(sf);
  const resolvePath = makeResolver(ts, fileDir, consts);

  const mechanisms = new Set();
  const flags = new Set();
  const hits = [];

  const visit = (node) => {
    // ── M-import: import decl / require() / import() ──
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const r = resolveModuleSpecifier(repoRoot, tracked, fileDir, node.moduleSpecifier.text);
      if (r.resolved) { mechanisms.add('M-import'); hits.push({ m: 'M-import', spec: node.moduleSpecifier.text, target: r.repoRel }); }
      else if (r.firstParty) { flags.add('unresolvable-reference'); hits.push({ m: 'M-import', spec: node.moduleSpecifier.text, unresolvable: true }); }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      // require('x') / import('x')
      if ((calleeName === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword) && node.arguments.length) {
        const a0 = node.arguments[0];
        if (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0)) {
          const r = resolveModuleSpecifier(repoRoot, tracked, fileDir, a0.text);
          if (r.resolved) { mechanisms.add('M-import'); hits.push({ m: 'M-import', spec: a0.text, target: r.repoRel }); }
          else if (r.firstParty) { flags.add('unresolvable-reference'); hits.push({ m: 'M-import', spec: a0.text, unresolvable: true }); }
        } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          // dynamic import(nonLiteral) → unresolvable (fail-closed)
          flags.add('unresolvable-reference'); hits.push({ m: 'M-import', spec: '<dynamic>', unresolvable: true });
        }
      }
      // ── M-fs: fs-touch on a non-mocked fs binding ──
      if (!fsMocked && FS_TOUCH.has(calleeName) && node.arguments.length) {
        const r = resolvePath(node.arguments[0]);
        if (r.status === 'abs') {
          const rr = repoRel(repoRoot, r.value);
          if (committedHit(rr)) { mechanisms.add('M-fs'); hits.push({ m: 'M-fs', verb: calleeName, target: rr, partial: !!r.partial }); }
          // resolved-but-untracked (node_modules, a runtime .tmp file, /etc) → not committed; ignore
        } else if (r.status === 'lit') {
          // a statically-known relative literal — resolve against repoRoot AND fileDir; a hit is
          // committed; a miss is a real path to an untracked artifact, NOT a runtime var → no flag.
          const cands = [repoRel(repoRoot, path.resolve(repoRoot, r.value)), repoRel(repoRoot, path.resolve(fileDir, r.value))];
          const rr = cands.find(committedHit);
          if (rr) { mechanisms.add('M-fs'); hits.push({ m: 'M-fs', verb: calleeName, target: rr }); }
        } else if (r.status === 'unresolvable') {
          // a genuine runtime variable — fail-closed (the R11-1 blind-gate default for discovery).
          flags.add('unresolvable-reference'); hits.push({ m: 'M-fs', verb: calleeName, unresolvable: true });
        }
        // status 'scratch' → EXCLUDED (tmpdir/mkdtemp/named-scratch); no flag
      }
      // ── M-exec: git-tree read OR interpreter+committed-script ──
      if (EXEC_VERBS.has(calleeName) && node.arguments.length) {
        const arg0 = node.arguments[0];
        const arg0Raw = rawArgText(arg0);
        let matched = false;
        // (i) a read of the COMMITTED TREE: git ls-files / grep / diff / show / log
        if (GIT_TREE_RE.test(arg0Raw)) {
          mechanisms.add('M-exec'); hits.push({ m: 'M-exec', kind: 'git-tree', cmd: clip(arg0Raw) }); matched = true;
        }
        // (ii) interpreter + a committed/dist script path — collected from the whole exec call:
        //   • every arg (arg0 command string, args-array elements) resolved to an abs path, AND
        //   • every identifier/join inside arg0's subtree that resolves to an abs path (the
        //     `bash "${LEAK_GUARD_SCRIPT}"` case, CL-28) — keyed on the command's embedded script.
        if (!matched && (INTERPRETER_RE.test(arg0Raw) || EXEC_VERBS.has(calleeName))) {
          const scriptAbs = collectExecPaths(node, resolvePath);
          for (const sa of scriptAbs) {
            const rr = repoRel(repoRoot, sa);
            if (committedHit(rr)) { mechanisms.add('M-exec'); hits.push({ m: 'M-exec', kind: 'script', target: rr }); matched = true; break; }
          }
        }
        // (iii) an exec whose command is a bare runtime variable (no static text at all) → fail-closed
        if (!matched && ts.isIdentifier(arg0) && resolvePath(arg0).status === 'unresolvable') {
          flags.add('unresolvable-reference'); hits.push({ m: 'M-exec', unresolvable: true });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const isCandidate = mechanisms.size > 0 || flags.size > 0;
  return { isCandidate, mechanisms: [...mechanisms].sort(), flags: [...flags].sort(), hits };

  // Collect abs script-path candidates from an exec call: array elements, direct args, and any
  // identifier/join expression appearing anywhere in arg0's subtree that resolves to an abs path.
  function collectExecPaths(callNode, resolvePathFn) {
    const out = [];
    const pushAbs = (n) => { const r = resolvePathFn(n); if (r.status === 'abs') out.push(r.value); };
    callNode.arguments.forEach((arg, i) => {
      if (ts.isArrayLiteralExpression(arg)) arg.elements.forEach(pushAbs);
      else if (i > 0) pushAbs(arg);
    });
    // Walk arg0's subtree: template `${SCRIPT}` spans, concatenations, nested identifiers.
    const arg0 = callNode.arguments[0];
    const walk = (n) => {
      if (ts.isIdentifier(n) || ts.isCallExpression(n) || ts.isTemplateExpression(n) || ts.isBinaryExpression(n)) pushAbs(n);
      ts.forEachChild(n, walk);
    };
    if (arg0) walk(arg0);
    return out;
  }
}

function rawArgText(node) { try { return node.getText(); } catch { return ''; } }
function clip(s) { return s.length > 80 ? s.slice(0, 77) + '...' : s; }

// ── clause (a): parse .claude/CLAUDE.md CR→VR table for named enforcement guards ──────────────
function clauseA(repoRoot, tracked) {
  const claudeMd = path.join(repoRoot, '.claude', 'CLAUDE.md');
  let text;
  try { text = readFileSync(claudeMd, 'utf8'); }
  catch (e) { fatal(`cannot read .claude/CLAUDE.md: ${e.message} (M2: an unreadable authority is FATAL, not empty).`); }

  const names = new Set();
  // direct <name>.test.ts tokens
  for (const m of text.matchAll(/([A-Za-z0-9_.-]+)\.test\.ts/g)) names.add(m[1]);
  // bare `npm test -- <n>` / `npx vitest run <n>` names
  for (const m of text.matchAll(/(?:npm test -- |npx vitest run )([A-Za-z0-9_/-]+)/g)) names.add(m[1]);

  const resolved = new Set();
  const unresolved = [];
  for (const n of names) {
    const base = n.split('/').pop();
    // (1) An exact <base>.test.ts is the specific single-file guard — prefer it.
    const exact = [...tracked].find((f) => f.endsWith(`/${base}.test.ts`) || f === `${base}.test.ts`);
    if (exact) { resolved.add(exact); continue; }
    // (2) Otherwise the token is a `npm test -- <base>` / `npx vitest run <base>` FILTER,
    // which vitest resolves by matching every *.test.ts whose PATH contains <base> (substring,
    // not exact basename). Resolve to that whole set so a legitimate multi-file drift-guard
    // suite (e.g. `shared-memory` → the 12 shared-memory-*.test.ts) is not mis-read as a DROP.
    const filterHits = [...tracked].filter((f) => f.endsWith('.test.ts') && f.includes(base));
    if (filterHits.length) { for (const h of filterHits) resolved.add(h); continue; }
    // (3) A token that matches ZERO tracked test files is still an unresolved DROP — fail-closed (M2).
    unresolved.push(n);
  }
  // A CR-named guard that does not resolve to a file is a DROP — fail-closed (M2).
  if (unresolved.length) {
    fatal(`clause (a): ${unresolved.length} CR-named guard name(s) in .claude/CLAUDE.md did not resolve to a tracked *.test.ts: ${unresolved.join(', ')} — refusing to silently drop a CR-named guard.`);
  }
  return resolved;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repoRoot);
  const tracked = gitTracked(repoRoot);
  // All directory prefixes of tracked files — so a read UNDER a committed dir (join(SRC, loopVar))
  // qualifies as M-fs even when the exact leaf is a runtime variable (CL-23).
  const trackedDirs = new Set();
  for (const f of tracked) {
    let d = f;
    while ((d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') !== '') trackedDirs.add(d);
  }

  // Denominators (M1 — prove it looked; each asserted non-zero below).
  const testTs = lsFilesGlob(repoRoot, '*.test.ts');
  const shellGates = lsFilesGlob(repoRoot, 'scripts/tests/*.sh');
  const eslintRules = lsFilesGlob(repoRoot, 'eslint-rules/*.js');
  if (testTs.length === 0) fatal('discovered ZERO *.test.ts — refusing to report an empty candidate set (M1).');
  if (shellGates.length === 0) fatal('discovered ZERO scripts/tests/*.sh — refusing to report an empty candidate set (M1).');

  // No-token sub-channel watch (R11-2 / CL-31): NO vitest.config.* may declare setupFiles/globalSetup.
  const vitestConfigs = lsFilesGlob(repoRoot, '*vitest.config.*');
  for (const c of vitestConfigs) {
    let t;
    try { t = readFileSync(path.join(repoRoot, c), 'utf8'); }
    catch (e) { fatal(`cannot read ${c}: ${e.message}`); }
    if (/\b(setupFiles|globalSetup)\b\s*:/.test(t)) {
      fatal(`${c} declares setupFiles/globalSetup — the no-token sub-channel is no longer empty (R11-2). A guard whose first-party touch lives in a setup module carries no token in its own body; the discoverer must be extended to enumerate that setup module's reads before this can pass. Refusing to under-count.`);
    }
  }

  const crNamed = clauseA(repoRoot, tracked);

  const candidates = [];
  // vitest-guard candidates: clause (a) ∪ clause (b)
  const seen = new Map(); // path → candidate
  for (const rel of testTs) {
    const cls = classifyTest(repoRoot, tracked, trackedDirs, rel);
    const isCrNamed = crNamed.has(rel);
    if (cls.isCandidate || isCrNamed) {
      candidates.push({
        kind: 'vitest-guard',
        path: rel,
        cr_named: isCrNamed,
        mechanisms: cls.mechanisms,
        flags: cls.flags,
        hits: cls.hits,
      });
      seen.set(rel, true);
    }
  }
  // Every CR-named guard MUST be a candidate (0 dropped — CL-20/CL-24). Enforce.
  for (const rel of crNamed) {
    if (!seen.has(rel)) {
      // A CR-named guard that clause (b) didn't flag is still a candidate by clause (a).
      candidates.push({ kind: 'vitest-guard', path: rel, cr_named: true, mechanisms: [], flags: [], hits: [] });
    }
  }

  // shell-gate-script candidates: EVERY scripts/tests/*.sh (filesystem-derived, never a glob subset).
  for (const rel of shellGates) candidates.push({ kind: 'shell-gate-script', path: rel });
  // eslint candidates: every eslint-rules/*.js
  for (const rel of eslintRules) candidates.push({ kind: 'eslint', path: rel });

  // Deterministic order (kind, then path) so the ruling diff and the mutation tests are stable.
  const KIND_ORDER = { 'vitest-guard': 0, 'shell-gate-script': 1, 'eslint': 2 };
  candidates.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const out = {
    denominator: {
      test_ts: testTs.length,
      scripts_tests_sh: shellGates.length,
      eslint_rules: eslintRules.length,
      tracked: tracked.size,
    },
    cr_named: [...crNamed].sort(),
    candidates,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

main();
