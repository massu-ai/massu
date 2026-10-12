#!/usr/bin/env node
// NOT a `massu-plan-gate:` — this REPORTS a census, it does not adjudicate a plan.
//
// orphaned-test-subjects — which test files are NAMED for a source module they never import?
//
// WHY THIS IS A COMMAND AND NOT A PARAGRAPH (G1). A per-repo census pasted into a plan is a
// snapshot that will be read as current. This one is derived from `git ls-files` every run,
// so the number in the plan can always be re-checked against the tree.
//
// ⛔ IT REPORTS THREE FACTS PER MEMBER, AND THE THIRD IS WHAT STOPS THE WRONG CONCLUSION.
// The first framing of this finding was "N untested modules". Measuring refuted it twice:
// several subjects are covered by DIFFERENTLY-NAMED suites (a naming defect, not a hole),
// and several are deliberately EXCLUDED from the coverage denominator by an operator
// decision recorded in plan-2026-06-03-website-lib-test-coverage. So each row carries
// whether the subject is in the coverage denominator and, when a coverage report exists,
// its measured line %. "Named for a module it does not import" and "that module is
// untested" are different claims and only the first is derivable from the import graph.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE = resolve(REPO, 'packages/core');
const JSON_OUT = process.argv.includes('--json');

/** Where the installer of coverage would have put the summary, if it has been run. */
function coverageSummary() {
  const p = resolve(CORE, 'coverage/coverage-summary.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null; // a malformed report is reported as absent, and said so below.
  }
}

/** Patterns vitest excludes from the coverage denominator — read, never retyped. */
function coverageExcludes() {
  const cfg = readFileSync(resolve(CORE, 'vitest.config.ts'), 'utf-8');
  const block = cfg.slice(cfg.indexOf('exclude: ['), cfg.indexOf('],', cfg.indexOf('exclude: [')));
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function isExcluded(rel, pats) {
  return pats.some((p) =>
    p.endsWith('/**') ? rel.startsWith(p.slice(0, -2)) : p.replace('**/', '') === rel || p === rel,
  );
}

const tests = execFileSync('git', ['ls-files', 'packages/core/src/__tests__'], {
  cwd: REPO,
  encoding: 'utf-8',
})
  .split('\n')
  .filter((f) => f.endsWith('.test.ts'));

if (tests.length === 0) {
  // M2 — a census over zero files would report "0 orphaned" and read as healthy.
  process.stderr.write('orphaned-test-subjects: git ls-files returned no test files — refusing.\n');
  process.exit(2);
}

const excludes = coverageExcludes();
const cov = coverageSummary();
const rows = [];
let considered = 0;

for (const rel of tests) {
  const stem = basename(rel).replace(/\.test\.ts$/, '');
  const cands = [`src/${stem}.ts`, `src/commands/${stem}.ts`, `src/hooks/${stem}.ts`, `src/lib/${stem}.ts`];
  const subject = cands.find((c) => existsSync(resolve(CORE, c)));
  if (!subject) continue; // no same-stem subject: this test claims nothing by its name.
  considered++;
  const src = readFileSync(resolve(REPO, rel), 'utf-8');
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const imports = new RegExp(`from\\s+['"][^'"]*${esc}\\.ts['"]|import\\(['"][^'"]*${esc}\\.ts['"]\\)`).test(src);
  if (imports) continue;
  const key = Object.keys(cov ?? {}).find((k) => k.endsWith('/' + subject));
  rows.push({
    test: rel.replace('packages/core/', ''),
    subject,
    itBlocks: (src.match(/\n\s*it\(/g) || []).length,
    coverageExcluded: isExcluded(subject, excludes),
    linePct: key ? cov[key].lines.pct : null,
  });
}

rows.sort((a, b) => b.itBlocks - a.itBlocks);

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ considered, orphaned: rows.length, coverageReport: cov ? 'present' : 'absent', rows }, null, 1) + '\n');
} else {
  process.stdout.write(`test files with a same-stem subject (denominator): ${considered}\n`);
  process.stdout.write(`of those, NEVER importing that subject:            ${rows.length}\n`);
  process.stdout.write(`coverage report: ${cov ? 'present' : 'ABSENT — run vitest --coverage for the line % column'}\n\n`);
  for (const r of rows) {
    const cvg = r.coverageExcluded ? 'EXCLUDED from coverage' : r.linePct === null ? 'in denominator, % unknown' : `in denominator, ${r.linePct}% lines`;
    process.stdout.write(`${String(r.itBlocks).padStart(3)} it()  ${r.test.padEnd(52)} -/-> ${r.subject.padEnd(36)} ${cvg}\n`);
  }
}
