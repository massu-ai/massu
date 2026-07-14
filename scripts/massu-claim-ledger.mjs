#!/usr/bin/env node
// CLAIM LEDGER GATE (CR-63).
//
// An audit that reads a plan can confirm that every file:line it CITES exists. It
// cannot confirm that the plan's claims about the WORLD are TRUE. Universal
// quantifiers ("the only store…", "every module…") and capability assertions ("the
// seeders read the corpus", "run X against Y") are claims about reality: only
// EXECUTING something can validate them.
//
// A plan audited to ZERO gaps across six passes still shipped two false premises, each
// one shell command from being caught. This gate makes that impossible to repeat.
//
// THE RULE: any flagged claim must appear in the plan's `## CLAIM LEDGER` with a
// verification command, its PASTED OUTPUT, and a CONFIRMED/REFUTED verdict. A REFUTED
// claim FAILS — it is not a footnote.
//
// NO EXEMPT ESCAPE HATCH. Existing plans are grandfathered by an explicit baseline that
// may only SHRINK. A per-plan "exempt" flag is how a gate rots, so there isn't one.
//
// Usage:
//   node scripts/massu-claim-ledger.mjs             # gate all plans
//   node scripts/massu-claim-ledger.mjs --self-test # ANTI-VACUITY: prove the detector fires
//   node scripts/massu-claim-ledger.mjs <file.md>   # gate one plan
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import {
  detectClaims,
  parseLedger,
  rowIsSubstantive,
  claimIsCovered,
  refutedRows,
} from './lib/claim-ledger-detect.mjs';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

const ROOT = process.cwd();
const PLANS_DIR = join(ROOT, 'docs', 'plans');
const BASELINE_PATH = join(ROOT, 'scripts', 'lib', 'claim-ledger-baseline.json');

// ---------------------------------------------------------------------------
// ANTI-VACUITY SELF-TEST. If the detector does not fire on the two claims that
// actually shipped, this gate is decoration and must fail loudly.
// ---------------------------------------------------------------------------
function selfTest() {
  const MUST_FLAG = [
    "The knowledge graph is the ONLY store that isn't per-account.",
    'Run the seeder suite against the point-in-time corpus.',
    'The adapter already supports delisted-inclusive prices.',
    'Every module in packages/core/src imports the config helper.',
  ];
  const MUST_NOT_FLAG = [
    'Massu may never overwrite prose a human wrote.',
    'The renderer MUST refuse any row whose origin is not local.',
    'This is the most dangerous slice in the workstream.',
  ];

  let ok = true;
  for (const s of MUST_FLAG) {
    if (detectClaims(s).length === 0) {
      console.error(`${RED}SELF-TEST FAIL${NC}: detector did NOT flag: "${s}"`);
      ok = false;
    }
  }
  for (const s of MUST_NOT_FLAG) {
    if (detectClaims(s).length > 0) {
      console.error(`${RED}SELF-TEST FAIL${NC}: detector wrongly flagged design intent: "${s}"`);
      ok = false;
    }
  }

  // A ledger row with an empty output column is decoration — it must NOT count.
  const decorative = { claim: 'x is the only store', command: 'grep foo', output: '', verdict: 'CONFIRMED' };
  if (rowIsSubstantive(decorative)) {
    console.error(`${RED}SELF-TEST FAIL${NC}: a ledger row with empty output was accepted as evidence`);
    ok = false;
  }
  const noVerdict = { claim: 'x', command: 'grep foo', output: '3 hits', verdict: 'TBD' };
  if (rowIsSubstantive(noVerdict)) {
    console.error(`${RED}SELF-TEST FAIL${NC}: a ledger row without a CONFIRMED/REFUTED verdict was accepted`);
    ok = false;
  }

  if (!ok) {
    console.error(
      `\n${RED}The detector is decoration, not a gate.${NC} It must fire on the two claims that actually shipped.`,
    );
    process.exit(1);
  }
  console.log(`${GREEN}PASS${NC}: claim-ledger self-test (detector fires on the real-world misses; decoration rejected)`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { grandfathered: [], maxSize: 0 };
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
}

function gatePlan(file, baseline) {
  const name = basename(file);
  const text = readFileSync(file, 'utf-8');
  const claims = detectClaims(text);
  const rows = parseLedger(text);

  // A REFUTED claim fails the audit outright, grandfathered or not. A plan built on a
  // premise it has DISPROVEN is the exact failure this gate exists to stop.
  const refuted = refutedRows(rows);
  if (refuted.length > 0) {
    return {
      name,
      status: 'FAIL',
      reason: `REFUTED claim(s) in the ledger — the plan rests on a false premise and must be rewritten:\n` +
        refuted.map((r) => `      - "${r.claim}"`).join('\n'),
    };
  }

  if (claims.length === 0) return { name, status: 'PASS' };

  if (baseline.grandfathered.includes(name)) {
    return { name, status: 'BASELINE', count: claims.length };
  }

  const uncovered = claims.filter((c) => !claimIsCovered(c, rows));
  if (uncovered.length === 0) return { name, status: 'PASS', count: claims.length };

  return {
    name,
    status: 'FAIL',
    reason:
      `${uncovered.length} claim(s) about the world with NO executed evidence.\n` +
      uncovered
        .slice(0, 8)
        .map((c) => `      L${c.line} [${c.ruleId}]\n        ${c.text.slice(0, 110)}\n        -> ${c.why}`)
        .join('\n') +
      (uncovered.length > 8 ? `\n      … and ${uncovered.length - 8} more` : ''),
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) selfTest();

  const baseline = loadBaseline();

  // The RATCHET: the grandfathered list may only shrink. Adding a plan to it is how a
  // gate is neutralised one commit at a time.
  if (baseline.grandfathered.length > baseline.maxSize) {
    console.error(
      `${RED}FAIL${NC}: the claim-ledger baseline GREW (${baseline.grandfathered.length} > max ${baseline.maxSize}).\n` +
        `  The baseline is a ratchet: it may only shrink. A new plan must carry its own CLAIM LEDGER.`,
    );
    process.exit(1);
  }

  // The public mirror has no `docs/plans/` (they are internal). A generic script that
  // no-ops on an absent corpus can be synced as-is — the same posture as
  // massu-plan-status-validator.sh — rather than needing a sync exclusion.
  if (!args.length && !existsSync(PLANS_DIR)) {
    console.log(`${GREEN}PASS${NC}: Claim Ledger (CR-63) — no docs/plans/ in this checkout`);
    process.exit(0);
  }

  const targets = args.length
    ? args.filter((a) => !a.startsWith('--'))
    : readdirSync(PLANS_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => join(PLANS_DIR, f));

  const results = targets.map((f) => gatePlan(f, baseline));
  const failed = results.filter((r) => r.status === 'FAIL');
  const grandfathered = results.filter((r) => r.status === 'BASELINE');

  console.log('=== Claim Ledger (CR-63) ===');
  console.log(
    `Plans scanned: ${results.length} | grandfathered: ${grandfathered.length}/${baseline.maxSize} (shrink-only) | failing: ${failed.length}`,
  );

  if (grandfathered.length > 0) {
    const claims = grandfathered.reduce((n, r) => n + (r.count ?? 0), 0);
    console.log(
      `${YELLOW}NOTE${NC}: ${claims} unverified claim(s) remain in grandfathered plans. The baseline may only shrink.`,
    );
  }

  for (const r of failed) {
    console.log(`\n${RED}FAIL${NC}: ${r.name}`);
    console.log(`    ${r.reason}`);
  }

  if (failed.length > 0) {
    console.log(
      `\n  A universal quantifier ("only", "every", "no other") or a capability assertion\n` +
        `  ("X reads Y", "run X against Y", "X already supports Z") is a CLAIM ABOUT REALITY.\n` +
        `  Reading the plan cannot validate it. Add a '## CLAIM LEDGER' section:\n\n` +
        `    ## CLAIM LEDGER\n` +
        `    | Claim (verbatim) | Verification command | Pasted output | Verdict |\n` +
        `    |---|---|---|---|\n` +
        `    | "X is the only store that…" | <enumerate ALL candidates> | (real output) | CONFIRMED |\n\n` +
        `  A universal claim needs an ENUMERATION over the whole candidate set — not a\n` +
        `  spot-check of the one example the plan mentions. A capability claim needs a PROBE\n` +
        `  that exercises it — a docstring saying so is not evidence it is wired up.\n` +
        `  A REFUTED claim fails the audit; the plan must be rewritten.`,
    );
    process.exit(1);
  }

  console.log(`${GREEN}PASS${NC}: every non-grandfathered plan's claims carry executed evidence`);
  process.exit(0);
}

main();
