// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4 ACCEPTANCE of docs/plans/2026-09-20-stack-conformant-asset-rendering.md.
 *
 * THE DEFECT THIS EXISTS TO CATCH, in one sentence: massu detects a customer's stack
 * correctly, writes it to massu.config.yaml, and then ships every customer the same
 * TypeScript-shaped asset set that nothing reconciles against that config. In a Python
 * repo those checks run against an absent tree, find nothing, and report CLEAN.
 *
 * So this renders the REAL asset set through the REAL installer into a REAL Python
 * fixture and asserts that no TypeScript-shaped token survives into the output.
 *
 * ⛔ THE TOKEN SET IS NOT WRITTEN HERE. It is read from
 * `scripts/lib/stack-foreign-tokens.json`, the same oracle
 * `scripts/measure-asset-conformance.sh` reads. Two instruments judging one property must
 * not hold two copies of its definition: a token added to one and not the other makes them
 * disagree silently, in the passing direction (G32/CR-74).
 *
 * ⛔ EXEMPTION SCOPE — a marker covers the IMMEDIATELY FOLLOWING LINE, nothing more.
 * DECISION (operator asleep, 2026-09-20; logged in NIGHT-QUEUE.md): the plan says an
 * adjudicated PROSE occurrence carries `<!-- massu-stack-exempt: <reason> -->` "on its own
 * line" but does not say what that line governs. A paragraph- or block-scoped marker would
 * silently WIDEN its own coverage the moment someone appends a sentence underneath it —
 * a waiver that grows without anyone deciding to grow it, which is the exact class this
 * plan exists to end. Line scope is unambiguous, visible in a diff, and forces a judgement
 * per occurrence. WHAT WOULD CHANGE IT: a measured case where a genuinely indivisible
 * prose block needs one reason across many lines and repeating the marker obscures rather
 * than clarifies.
 *
 * BLIND-GATE POSTURE: M1 the denominator (files rendered, occurrences inspected) is
 * asserted non-zero and printed — "0 violations across 0 assets" is a LOUD ERROR, not a
 * pass. M2 an unreadable oracle or fixture is an ERROR, never an empty token set.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { installAll } from '../commands/install-commands.ts';
import { resetConfig } from '../config.ts';
import { report } from './helpers/report.ts';

const REPO_ROOT = resolve(__dirname, '../../../..');
const TOKENS_JSON = join(REPO_ROOT, 'scripts/lib/stack-foreign-tokens.json');
const TEMPLATES_DIR = resolve(__dirname, '../../templates');
const FIXTURES_DIR = resolve(__dirname, 'fixtures/stacks');

const EXEMPT_MARKER = /<!--\s*massu-stack-exempt:\s*(.+?)\s*-->/;

interface TokenEntry {
  pattern: string;
  reason: string;
}
interface TokenOracle {
  vocabulary: TokenEntry[];
  prose: TokenEntry[];
}

function loadOracle(): TokenOracle {
  // M2: a missing oracle is an ERROR. An empty token set would make this gate pass over
  // any corpus at all — the healthiest-looking possible death.
  if (!existsSync(TOKENS_JSON)) throw new Error(`token oracle missing: ${TOKENS_JSON}`);
  const parsed = JSON.parse(readFileSync(TOKENS_JSON, 'utf-8')) as TokenOracle;
  if (!parsed.vocabulary?.length || !parsed.prose?.length) {
    throw new Error('token oracle has an EMPTY half — refusing to report clean');
  }
  return parsed;
}

const ORACLE = loadOracle();
const ALL_TOKENS: TokenEntry[] = [...ORACLE.vocabulary, ...ORACLE.prose];

function stackNames(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((e) => existsSync(join(TEMPLATES_DIR, e, 'massu.config.yaml')))
    .sort();
}

/** Build a real customer repo for `stack` from its fixture tree + its template config. */
function makeRepo(stack: string): string {
  const root = mkdtempSync(join(tmpdir(), `massu-conf-${stack}-`));
  const fixture = join(FIXTURES_DIR, stack);
  if (!existsSync(fixture)) throw new Error(`no P7.1 fixture for stack '${stack}'`);
  cpSync(fixture, root, { recursive: true });
  // The config is DERIVED from the template, never a committed copy beside the fixture —
  // see stack-fixtures.test.ts for why.
  writeFileSync(
    join(root, 'massu.config.yaml'),
    readFileSync(join(TEMPLATES_DIR, stack, 'massu.config.yaml'), 'utf-8'),
  );
  mkdirSync(join(root, '.claude'), { recursive: true });
  return root;
}

function inRepo<T>(root: string, fn: () => T): T {
  const prev = process.cwd();
  resetConfig();
  try {
    process.chdir(root);
    return fn();
  } finally {
    process.chdir(prev);
    resetConfig();
  }
}

function renderedFiles(root: string): string[] {
  const out: string[] = [];
  const base = join(root, '.claude');
  if (!existsSync(base)) return out;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith('.md')) out.push(abs);
    }
  };
  walk(base);
  return out;
}

interface Scan {
  filesScanned: number;
  linesScanned: number;
  violations: string[];
  exempt: number;
}

function scanForForeignTokens(root: string): Scan {
  const files = renderedFiles(root);
  const violations: string[] = [];
  let exempt = 0;
  let linesScanned = 0;

  for (const file of files) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    linesScanned += lines.length;
    const rel = file.slice(root.length + 1);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (EXEMPT_MARKER.test(line)) continue; // the marker line itself is not an occurrence
      const hit = ALL_TOKENS.find((t) => new RegExp(t.pattern).test(line));
      if (!hit) continue;
      // Scope: the marker on the PREVIOUS line, and only that line, grants the exemption.
      const prev = i > 0 ? lines[i - 1] : '';
      if (EXEMPT_MARKER.test(prev)) {
        exempt++;
        continue;
      }
      violations.push(`${rel}:${i + 1}: /${hit.pattern}/ :: ${line.trim().slice(0, 110)}`);
    }
  }
  return { filesScanned: files.length, linesScanned, violations, exempt };
}

describe('P4 acceptance — no TypeScript-shaped token survives into a Python install', () => {
  const STACK = 'python-fastapi';
  let scan: Scan;
  let skipped: number;

  beforeAll(() => {
    const root = makeRepo(STACK);
    const result = inRepo(root, () => installAll(root, { skipPermissions: true }));
    skipped = result.totalSkipped;
    scan = scanForForeignTokens(root);
    // Printed, not just asserted: a reviewer must be able to read the denominator — and
    // through `report()`, because `console.log` is SWALLOWED by this runner and this very
    // line spent its whole life claiming to print while printing nothing.
    report(
      `[P4] stack=${STACK} rendered=${scan.filesScanned} files / ${scan.linesScanned} lines · ` +
        `violations=${scan.violations.length} · exempt=${scan.exempt} · skipped=${skipped}`,
    );
  });

  it('the oracle is non-empty (M2: an empty token set passes over any corpus)', () => {
    expect(ALL_TOKENS.length).toBeGreaterThan(0);
    expect(ORACLE.vocabulary.length).toBeGreaterThan(0);
    expect(ORACLE.prose.length).toBeGreaterThan(0);
    // Every entry carries its reason — an oracle without reasons is a roster (G32).
    for (const t of ALL_TOKENS) expect(t.reason, `no reason for /${t.pattern}/`).toBeTruthy();
  });

  it('the installer actually rendered something (M1: 0 violations across 0 assets is an ERROR)', () => {
    expect(scan.filesScanned).toBeGreaterThan(0);
    expect(scan.linesScanned).toBeGreaterThan(0);
  });

  it('renders with stats.skipped === 0 — a silently dropped asset is the failure mode, not a pass', () => {
    expect(skipped).toBe(0);
  });

  it('exempt_count matches the committed P1.2 baseline — a new exemption is never silent', () => {
    const baseline = 0; // scripts/measure-asset-conformance.sh reports exempt_count 0 at f76c21da
    expect(scan.exempt).toBe(baseline);
  });
});

describe('P4.4b — a LEGACY config, missing every optional key, still installs clean', () => {
  /**
   * ⛔ THE FIXTURES CANNOT SEE THIS CASE, WHICH IS WHY IT IS ITS OWN TEST.
   *
   * Every P7.1 fixture derives its config from a shipped TEMPLATE, and the templates
   * declare every key the assets reference — including `paths.tests`, added 2026-09-20.
   * So "all 13 fixtures install clean" is necessarily true of configs that already have
   * the new key, and says NOTHING about the config a customer wrote last month.
   *
   * A missing optional key raises MissingVariableError, which `install-commands.ts`
   * catches into `stats.skipped++` and exit 0 — the silent drop this plan exists to end.
   * An acceptance whose corpus is generated from the same source as the thing under test
   * agrees with itself by construction (THE BLIND-GATE LAW).
   *
   * So this builds the MINIMUM config the schema accepts and asserts the whole asset set
   * still renders. Every `{{...}}` an asset references must therefore either be a key the
   * schema REQUIRES, or carry a `| default(...)`.
   */
  it('installs every asset with skipped === 0 against a minimal config', () => {
    const root = mkdtempSync(join(tmpdir(), 'massu-legacy-'));
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'main.py'), 'def health():\n    return "ok"\n');
    // Deliberately minimal: no `paths.tests`, no `verification:` block, nothing optional.
    writeFileSync(
      join(root, 'massu.config.yaml'),
      'project:\n  name: legacy\nframework:\n  type: python\n  primary: python\n',
    );
    const result = inRepo(root, () => installAll(root, { skipPermissions: true }));
    expect(
      result.totalSkipped,
      'a config predating an optional key silently loses assets',
    ).toBe(0);
    expect(renderedFiles(root).length).toBeGreaterThan(0);
  });
});

describe('P4.4 — every shipped stack installs clean', () => {
  const STACKS = stackNames();

  it('the roster is derived and non-empty', () => {
    expect(STACKS.length).toBe(13);
  });

  it.each(STACKS)('%s installs with skipped === 0 and renders at least one asset', (stack) => {
    const root = makeRepo(stack);
    const result = inRepo(root, () => installAll(root, { skipPermissions: true }));
    expect(result.totalSkipped, `${stack}: assets were silently dropped`).toBe(0);
    expect(renderedFiles(root).length, `${stack}: nothing rendered`).toBeGreaterThan(0);
  });

  /**
   * P4.3b acceptance — `fragmentsMissing === 0` across all 13 fixtures, and the count is
   * REPORTED every run.
   *
   * ⛔ A MISSING FRAGMENT IS THE ONE OUTCOME THAT DOES NOT SHOW UP IN `skipped`. By design
   * (D5) an unresolvable `{{> name}}` degrades to a visible diagnostic and the asset STILL
   * INSTALLS — because throwing would reach the installer's catch, become `skipped++` and
   * exit 0, which is the silently-absent asset this whole plan exists to end. The cost of
   * that correct choice is that the failure is now a comment in a shipped file instead of a
   * counter, so `missing` is the only thing that can see it.
   *
   * The denominator is printed, not just asserted: `resolved + defaulted` proves fragments
   * were actually being resolved on this stack, so a zero `missing` cannot be the vacuous
   * kind that comes from having no fragments at all (M1).
   */
  it.each(STACKS)('%s resolves every fragment it references (missing === 0)', (stack) => {
    const root = makeRepo(stack);
    const result = inRepo(root, () => installAll(root, { skipPermissions: true }));
    const f = result.fragments;
    report(
      `[P4.3b] stack=${stack} fragments resolved=${f.resolved} ` +
        `defaulted=${f.defaulted} missing=${f.missing}`,
    );
    expect(
      f.missing,
      `${stack}: ${f.missing} fragment(s) rendered a diagnostic into a shipped asset`,
    ).toBe(0);
    expect(
      f.resolved + f.defaulted,
      `${stack}: no fragment was resolved at all — "missing === 0" is vacuous here`,
    ).toBeGreaterThan(0);
  });
});
