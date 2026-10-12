#!/usr/bin/env node
// massu-plan-gate: plan | citation resolver
// verify-plan-citations — resolve every `path:line` citation in a plan against disk.
//
// WHY THIS EXISTS (G24/CR-87 — fix the INSTRUMENT, not the workaround).
// Measured 2026-09-20 on docs/plans/2026-09-20-stack-conformant-asset-rendering.md:
// audit iteration 1 discovered 26 gaps, iteration 2 discovered 21 — and 17 of those 21
// were defects introduced by iteration 1's own repairs. The single largest category was
// hand-typed file:line citations drifting by 1-4 lines. Iteration 2 caught six of its OWN
// by re-reading all 46 programmatically; that ad-hoc step is this script.
//
// A plan's citations are a hand-maintained list of pointers into a moving tree (G32).
// Reading them cannot converge — opinions don't. A command can.
//
// VERDICT VOCABULARY IS CLOSED (G3): an unrecognised state is an ERROR, never a skipped row.
// REPORTS ITS DENOMINATOR every run (M1). Zero citations scanned is a LOUD ERROR, never a pass.
// FAILS CLOSED (M2): an unreadable plan or source file is exit 2, never an empty "clean".

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A citation: a path containing a dot-extension, followed by :N or :N-M.
// Anchored on a path-ish token so prose like "10:30 PDT" is not a citation.
const CITATION_RE = /((?:\.?[\w.@-]+\/)+)?([\w.@-]+\.(?:ts|tsx|js|mjs|cjs|json|yaml|yml|sh|md|py))[:](\d+)(?:-(\d+))?\b/g;
// A backticked symbol on the same line — the expectation to check the line against.
// A function is most naturally cited as `fn()`. Without the optional parens the regex
// misses it entirely and falls back to some other backticked word on the line — which
// mis-judged a CORRECT citation as SYMBOL_NOT_NEAR (measured 2026-09-20).
const SYMBOL_RE = /`([A-Za-z_$][\w$]*)(?:\(\))?`/g;

const WINDOW = 3; // lines either side; a citation may point at a decl's first or last line

function fail(msg, code = 2) { console.error(`verify-plan-citations: ${msg}`); process.exit(code); }

const planArg = process.argv[2];
if (!planArg) fail('usage: verify-plan-citations.mjs <plan.md> [--quiet]');
const QUIET = process.argv.includes('--quiet');
const planPath = resolve(process.cwd(), planArg);
if (!existsSync(planPath)) fail(`plan not found: ${planPath}`);

let planText;
try { planText = readFileSync(planPath, 'utf-8'); }
catch (e) { fail(`plan unreadable: ${e.message}`); }

// ---------------------------------------------------------------------------
// PATH RESOLUTION — a plan cites SHORTHAND, and that is legitimate prose.
// `install-commands.ts:476` is how a human writes it. Resolving only against the
// repo root reported 51 FILE_MISSING on a plan whose citations were nearly all fine
// (measured 2026-09-20) — the wider net crying wolf (G18). The fix is the RULE.
//
// So: resolve a repo-relative path directly; otherwise resolve a SUFFIX match against
// the tracked file set. A basename matching MORE THAN ONE tracked file is its own
// verdict, AMBIGUOUS_PATH — not a pass. That is a real plan defect: this repo has two
// different `renderTemplate` exports in two files, and a bare citation cannot say which.
// The candidate set is DERIVED from `git ls-files` (G32), never a roster.
// ---------------------------------------------------------------------------
let TRACKED;
try {
  TRACKED = execFileSync('git', ['-C', REPO_ROOT, 'ls-files'], { encoding: 'utf-8' })
    .split('\n').filter(Boolean);
} catch (e) {
  fail(`could not enumerate tracked files (git ls-files): ${e.message}`);
}
if (TRACKED.length === 0) fail('git ls-files returned 0 files — cannot resolve citations');

const resolveCache = new Map();
function resolveRel(rel) {
  if (resolveCache.has(rel)) return resolveCache.get(rel);
  let out;
  if (existsSync(resolve(REPO_ROOT, rel)) && statSync(resolve(REPO_ROOT, rel)).isFile()) {
    out = { kind: 'unique', rel };
  } else {
    const suffix = '/' + rel;
    const hits = TRACKED.filter((f) => f === rel || f.endsWith(suffix));
    if (hits.length === 1) out = { kind: 'unique', rel: hits[0] };
    else if (hits.length > 1) out = { kind: 'ambiguous', hits };
    else out = { kind: 'missing' };
  }
  resolveCache.set(rel, out);
  return out;
}

const srcCache = new Map();
function readSource(rel) {
  if (srcCache.has(rel)) return srcCache.get(rel);
  const abs = resolve(REPO_ROOT, rel);
  let v;
  if (!existsSync(abs) || !statSync(abs).isFile()) v = { ok: false };
  else { try { v = { ok: true, lines: readFileSync(abs, 'utf-8').split('\n') }; }
         catch { v = { ok: false }; } }
  srcCache.set(rel, v);
  return v;
}

const VERDICTS = ['OK', 'FILE_MISSING', 'AMBIGUOUS_PATH', 'EXTERNAL_REPO', 'LINE_OUT_OF_RANGE', 'SYMBOL_NOT_NEAR', 'UNCHECKED_NO_SYMBOL'];
// A citation into a DIFFERENT repo on this machine cannot be resolved from here and is not a
// defect. It is reported so it is never silently counted as verified (G20).
//
// ⛔ THE SET IS DERIVED, AND THE HAND-MAINTAINED VERSION WAS A PRIVATE-CONTENT LEAK.
//
// This was a literal array holding the sibling repo NAMES, one string each. This
// file SYNCS TO THE PUBLIC MIRROR, so that list published the names of private repositories,
// and the publication leak-guard refused a sync over exactly it (2026-09-21). A hand-
// maintained list is a bug waiting for its turn (G32); this one was a disclosure waiting for
// a sync.
//
// The predicate it was reaching for needs no names at all: a citation is EXTERNAL when its
// leading path segment is not a top-level directory OF THIS REPO. Derived from `git ls-files`,
// so a new sibling repo is handled on its first citation and nobody maintains anything.
const TOP_LEVEL_DIRS = new Set(
  execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter((f) => f.includes('/'))
    .map((f) => f.slice(0, f.indexOf('/'))),
);
if (TOP_LEVEL_DIRS.size === 0) {
  // M2 — an empty set would classify EVERY citation as external and report a clean run over
  // a corpus it never resolved. Unreadable input is an error, never an empty one.
  process.stderr.write('verify-plan-citations: git ls-files returned no directories — refusing to run.\n');
  process.exit(2);
}
/** A citation that cannot be resolved from this repo because it names another one. */
function isExternalCitation(rel) {
  const i = rel.indexOf('/');
  return i > 0 && !TOP_LEVEL_DIRS.has(rel.slice(0, i));
}
const rows = [];
const planLines = planText.split('\n');

for (let i = 0; i < planLines.length; i++) {
  const line = planLines[i];
  // ⛔ SYMBOLS ARE ASSOCIATED BY PROXIMITY, NOT BY LINE. A plan's table rows run to
  // 1,500+ characters and carry many backticked tokens; collecting ALL of them and
  // testing a citation against any one is an association the text does not support.
  // Measured 2026-09-20: a CORRECT citation to `install-commands.ts:549-556` (the
  // MissingVariableError swallow site) was judged SYMBOL_NOT_NEAR against `build` and
  // `yaml` — tokens from a sentence about a measurement ~900 characters earlier in the
  // same row. The citation was right and the instrument was wrong, which is the failure
  // that teaches people to ignore a gate (CR-72/G24).
  const symbolHits = [...line.matchAll(SYMBOL_RE)].map((m) => ({ name: m[1], at: m.index ?? 0 }));
  const SYMBOL_WINDOW = 120; // characters either side of the citation
  const symbolsNear = (at) =>
    symbolHits.filter((h) => Math.abs(h.at - at) <= SYMBOL_WINDOW).map((h) => h.name);
  // A line carrying SEVERAL citations and one backticked symbol cannot tell us which
  // citation the symbol belongs to. Applying it to all of them manufactures false
  // positives (measured: 5 of 11 flags on the first real run). Only a line with EXACTLY
  // ONE citation licenses a symbol check.
  const citesOnLine = [...line.matchAll(CITATION_RE)].length;
  for (const m of line.matchAll(CITATION_RE)) {
    const [, dirPart, basePart, startS, endS] = m;
    const rel = ((dirPart || '') + basePart).replace(/^\.\//, '');
    const start = Number(startS);
    const end = endS ? Number(endS) : start;
    const res = resolveRel(rel);
    let verdict, detail = '', src = { ok: false };
    // ⛔ RESOLUTION IS ATTEMPTED BEFORE THE EXTERNAL TEST, AND THE ORDER IS THE WHOLE
    // CORRECTNESS ARGUMENT. Plans cite local files by PARTIAL path — `hooks/user-prompt.ts`,
    // `detect/adapters/python-flask.ts` — whose leading segment is not top-level but which
    // resolve here by basename. Asking "is it foreign?" first sent 5 resolvable local
    // citations to EXTERNAL_REPO (OK 31 -> 30, EXTERNAL 4 -> 9): the gate reported PASS
    // while verifying LESS than before, which is the blind-gate shape in a verdict column.
    // Foreign is therefore the residue: unresolvable here AND not one of our own roots.
    if (res.kind === 'missing' && isExternalCitation(rel)) { verdict = 'EXTERNAL_REPO'; }
    else if (res.kind === 'missing') { verdict = 'FILE_MISSING'; }
    else if (res.kind === 'ambiguous') {
      verdict = 'AMBIGUOUS_PATH';
      detail = `matches ${res.hits.length}: ${res.hits.slice(0, 3).join(', ')}${res.hits.length > 3 ? ', ...' : ''}`;
    }
    else if (!(src = readSource(res.rel)).ok) { verdict = 'FILE_MISSING'; }
    else if (start < 1 || end > src.lines.length) {
      verdict = 'LINE_OUT_OF_RANGE'; detail = `file has ${src.lines.length} lines`;
    } else {
      const lo = Math.max(1, start - WINDOW), hi = Math.min(src.lines.length, end + WINDOW);
      const window = src.lines.slice(lo - 1, hi).join('\n');
      // A symbol the plan mentions that does NOT occur anywhere in the cited file is
      // describing FUTURE state ("extend buildTemplateVars to expose `verify`") — correct
      // prose, not a stale citation. Only a symbol that EXISTS in the file can testify to
      // whether the LINE NUMBER drifted, which is the defect class this gate exists for.
      const whole = src.lines.join('\n');
      // A symbol that occurs MANY times in the file cannot localize a line, so its absence
      // from a +/-3 window is not evidence of anything. Reporting SYMBOL_NOT_NEAR for
      // `raw`, `name` or `projectRoot` is a FALSE FINDING — measured 2026-09-20 against a
      // real plan, where generic tokens produced most of the flags. Only a symbol that is
      // rare enough to point at one place may testify about a line number.
      const MAX_OCCURRENCES_TO_LOCALIZE = 5;
      const occurrences = (needle) => {
        let n = 0, from = 0;
        for (;;) {
          const at = whole.indexOf(needle, from);
          if (at === -1) return n;
          n++;
          if (n > MAX_OCCURRENCES_TO_LOCALIZE) return n;
          from = at + needle.length;
        }
      };
      const symbols = symbolsNear(m.index ?? 0);
      const candidates = symbols.filter(
        (s) => s.length > 2 && whole.includes(s) && occurrences(s) <= MAX_OCCURRENCES_TO_LOCALIZE,
      );
      if (citesOnLine !== 1 || candidates.length === 0) { verdict = 'UNCHECKED_NO_SYMBOL'; }
      else if (candidates.some((s) => window.includes(s))) { verdict = 'OK'; }
      else { verdict = 'SYMBOL_NOT_NEAR'; detail = `none of [${candidates.join(', ')}] within +/-${WINDOW}`; }
    }
    if (!VERDICTS.includes(verdict)) fail(`internal: unrecognised verdict "${verdict}"`);
    rows.push({ planLine: i + 1, rel, start, end, verdict, detail });
  }
}

const total = rows.length;
// DENOMINATOR 0 is "could not look", never "looked and found nothing" (M1). It exits 3 —
// distinct from 1 (citations failed) and 2 (unreadable input) — so a CORPUS sweep can count
// no-citation plans separately instead of tallying them as failures. Collapsing the two is
// the blind-gate shape: a plan with nothing to check and a plan that is broken must not
// produce the same value.
if (total === 0) {
  console.error(`verify-plan-citations: NO CITATIONS in ${planArg} — nothing was checked.`);
  console.log(`PLAN:                 ${planArg}`);
  console.log(`CITATIONS SCANNED:    0   (denominator)`);
  console.log(`RESULT: NO-CITATIONS (nothing verified; this is not a pass)`);
  process.exit(3);
}

const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
for (const r of rows) counts[r.verdict]++;

const bad = rows.filter((r) => !['OK', 'UNCHECKED_NO_SYMBOL', 'EXTERNAL_REPO'].includes(r.verdict));
if (!QUIET) {
  for (const r of rows.filter((r) => r.verdict === 'EXTERNAL_REPO')) {
    console.log(`${r.verdict.padEnd(18)} plan:${String(r.planLine).padEnd(5)} ${r.rel}:${r.start}  (another repo — not verified here)`);
  }
  for (const r of bad) {
    console.log(`${r.verdict.padEnd(18)} plan:${String(r.planLine).padEnd(5)} ${r.rel}:${r.start}${r.end !== r.start ? '-' + r.end : ''}  ${r.detail}`);
  }
}
console.log('----');
console.log(`PLAN:                 ${planArg}`);
console.log(`CITATIONS SCANNED:    ${total}   (denominator)`);
console.log(`DISTINCT FILES:       ${srcCache.size}`);
for (const v of VERDICTS) console.log(`  ${v.padEnd(20)}${counts[v]}`);
console.log(`RESULT: ${bad.length === 0 ? 'PASS' : 'FAIL'} (${bad.length} citation(s) do not resolve)`);
process.exit(bad.length === 0 ? 0 : 1);
