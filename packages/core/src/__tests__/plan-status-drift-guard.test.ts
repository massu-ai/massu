// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 1.5.8 / Plan 2026-05-09-stale-plan-status-drift-guard P2-002.
 *
 * Drift-guard test for the Plan Status Validator + Commit Drift Scanner.
 *
 * Wraps `bash scripts/massu-plan-status-validator.sh` and
 * `bash scripts/massu-plan-commit-drift.sh` in vitest assertions so any
 * future change that:
 *   - introduces an unknown Status enum value,
 *   - drops the **Plan Token**: field,
 *   - duplicates a Plan Token across two files,
 *   - lands a commit referencing a still-DRAFT plan,
 *   - or breaks the validator/scanner itself,
 * fails CI immediately at `npm test`.
 *
 * Mirrors the pattern of `pattern-scanner-self-test.test.ts` (cited at
 * audit iter 5/6): execSync from node:child_process with cwd: REPO_ROOT,
 * try/catch around the call to capture exit codes for FAIL cases.
 *
 * NOTE on case 8 (live HEAD): re-enabled in Phase 4 (P4-001) of the 1.5.8
 * plan. All 55 plans now carry **Plan Token**: + **Status**: in their
 * frontmatter and the external-tokens allowlist covers cross-repo
 * (sister-repo) tokens, so the validator + drift scanner exit 0 against
 * the live corpus.
 * Case 8 runs unconditionally — it's the structural gate that makes future
 * stale-Status drift visible at `npm test` time.
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// G29/CR-92 — `cwd:`/`-C` do not scope git; GIT_DIR outranks both. See the helper for why.
import { gitSafeEnv } from './helpers/git-safe-env.ts';

// __dirname is packages/core/src/__tests__; repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const VALIDATOR_PATH = resolve(REPO_ROOT, 'scripts', 'massu-plan-status-validator.sh');
const SCANNER_PATH = resolve(REPO_ROOT, 'scripts', 'massu-plan-commit-drift.sh');
const FIXTURE_DIR = resolve(__dirname, 'fixtures', 'plans');

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(scriptPath: string, env: NodeJS.ProcessEnv = {}): ExecResult {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execSync(`bash ${scriptPath}`, {
      cwd: REPO_ROOT,
      env: gitSafeEnv({ ...env }),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    exitCode = e.status ?? -1;
    stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf-8') ?? '');
    stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf-8') ?? '');
  }
  return { exitCode, stdout, stderr };
}

/**
 * Build a temp dir containing only a subset of fixture plans, so the
 * validator/scanner can be invoked against a curated PASS-only set or a
 * single targeted FAIL case.
 */
function makeCuratedFixtureDir(includeBasenames: string[]): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'massu-plan-fix-'));
  for (const base of includeBasenames) {
    const src = join(FIXTURE_DIR, base);
    const content = readFileSync(src, 'utf-8');
    writeFileSync(join(tmpDir, base), content);
  }
  return tmpDir;
}

/**
 * Build a temp git repo with synthetic commit subjects and a curated plan
 * corpus, so the drift scanner can be exercised without polluting the real
 * repo's history.
 */
function makeFakeGitRepo(commitSubjects: string[], planBasenames: string[]): {
  repoDir: string;
  planDir: string;
} {
  const repoDir = mkdtempSync(join(tmpdir(), 'massu-drift-repo-'));
  const planDir = join(repoDir, 'docs', 'plans');
  mkdirSync(planDir, { recursive: true });
  for (const base of planBasenames) {
    const content = readFileSync(join(FIXTURE_DIR, base), 'utf-8');
    writeFileSync(join(planDir, base), content);
  }
  // Initialize git, configure local identity, and create one commit per subject.
  execSync(`git init -q -b main`, { cwd: repoDir, env: gitSafeEnv() });
  execSync(`git config user.email test@massu.test`, { cwd: repoDir, env: gitSafeEnv() });
  execSync(`git config user.name MassuTest`, { cwd: repoDir, env: gitSafeEnv() });
  // Stage fixture files so commits have content
  execSync(`git add -A`, { cwd: repoDir, env: gitSafeEnv() });
  // First commit pinned to a date well after MASSU_DRIFT_SINCE default.
  execSync(`git commit -q --date=2026-04-15T12:00:00 -m "${commitSubjects[0]}"`, {
    cwd: repoDir,
    env: gitSafeEnv({ GIT_AUTHOR_DATE: '2026-04-15T12:00:00', GIT_COMMITTER_DATE: '2026-04-15T12:00:00' }),
  });
  for (let i = 1; i < commitSubjects.length; i++) {
    // Touch a tracked file so each commit has a delta
    const sentinel = join(planDir, '_sentinel.txt');
    writeFileSync(sentinel, `commit ${i}`);
    execSync(`git add -A`, { cwd: repoDir, env: gitSafeEnv() });
    execSync(`git commit -q --date=2026-04-${15 + i}T12:00:00 -m "${commitSubjects[i]}"`, {
      cwd: repoDir,
      env: gitSafeEnv({
        GIT_AUTHOR_DATE: `2026-04-${15 + i}T12:00:00`,
        GIT_COMMITTER_DATE: `2026-04-${15 + i}T12:00:00`,
      }),
    });
  }
  return { repoDir, planDir };
}

describe('plan-status-drift-guard (Plan 1.5.8 P2-002)', () => {
  // ----- Validator cases (fixture-driven) -----

  it('case 1: validator passes against fresh + shipped + superseded + historical fixtures', () => {
    const tmp = makeCuratedFixtureDir([
      'fresh-draft.md',
      'shipped.md',
      'superseded.md',
      'historical.md',
    ]);
    try {
      const r = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
      if (r.exitCode !== 0) {
        throw new Error(
          `Expected validator exit 0; got ${r.exitCode}.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
        );
      }
      expect(r.stdout).toMatch(/PASS/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 2: validator fails on unknown Status enum value', () => {
    const tmp = makeCuratedFixtureDir(['unknown-status.md']);
    try {
      const r = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/unknown Status enum value/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 3: validator fails on missing Plan Token field', () => {
    const tmp = makeCuratedFixtureDir(['missing-token.md']);
    try {
      const r = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/missing \*\*Plan Token\*\*: field/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 4: validator fails on duplicate Plan Tokens across two fixtures', () => {
    const tmp = makeCuratedFixtureDir(['duplicate-token-a.md', 'duplicate-token-b.md']);
    try {
      const r = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/duplicate Plan Token 'plan-test-dup'/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ----- Drift scanner cases (synthetic git repo) -----

  it('case 5: commit-drift scanner fails when commit references stale-draft fixture', () => {
    const { repoDir, planDir } = makeFakeGitRepo(
      ['feat(plan-test-stale): add stale-draft work'],
      ['stale-draft.md'],
    );
    try {
      const r = runScript(SCANNER_PATH, {
        MASSU_DRIFT_REPO: repoDir,
        MASSU_PLAN_DIR: planDir,
        MASSU_DRIFT_ALLOWLIST: '/nonexistent-allowlist',
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/Status=DRAFT/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('case 6: commit-drift scanner passes when commit references shipped fixture', () => {
    const { repoDir, planDir } = makeFakeGitRepo(
      ['feat(plan-test-shipped): cite shipped plan'],
      ['shipped.md'],
    );
    try {
      const r = runScript(SCANNER_PATH, {
        MASSU_DRIFT_REPO: repoDir,
        MASSU_PLAN_DIR: planDir,
        MASSU_DRIFT_ALLOWLIST: '/nonexistent-allowlist',
      });
      if (r.exitCode !== 0) {
        throw new Error(
          `Expected drift exit 0 against shipped fixture; got ${r.exitCode}.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
        );
      }
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('case 7: commit-drift scanner passes when commit references historical fixture (escape hatch)', () => {
    const { repoDir, planDir } = makeFakeGitRepo(
      ['fix(plan-test-historical): cite historical plan'],
      ['historical.md'],
    );
    try {
      const r = runScript(SCANNER_PATH, {
        MASSU_DRIFT_REPO: repoDir,
        MASSU_PLAN_DIR: planDir,
        MASSU_DRIFT_ALLOWLIST: '/nonexistent-allowlist',
      });
      if (r.exitCode !== 0) {
        throw new Error(
          `Expected drift exit 0 against historical fixture; got ${r.exitCode}.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
        );
      }
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // ----- Live HEAD assertion (unconditional after Phase 4 backfill) -----

  it('case 8: live HEAD — validator + scanner exit 0 against real docs/plans/*.md', { timeout: 180_000 }, () => {
    // BUDGET, MEASURED 2026-07-27 — re-derive it, do not trust this number (CR-68).
    //
    //   bash scripts/massu-plan-status-validator.sh   ->  6s   (115 plans)
    //   bash scripts/massu-plan-commit-drift.sh       ->  4s   (645 commits)
    //   combined, idle machine                        -> 10s
    //
    // The previous budget was 30s, written 2026-05-11 against "~60 plans". There are now
    // 115, and the scanners grow with BOTH plan count and commit count. 10s idle looked
    // like 3x headroom — and this test TIMED OUT in the pre-push battery on 2026-07-27,
    // blocking a push, because it does not run idle: it runs inside `npm test`, which
    // fans 342 test files across parallel workers. The observed slowdown was therefore
    // at least 3x. Sizing a budget on an idle measurement while the thing runs under the
    // load the suite itself creates is M3 — test the gate the way production runs it.
    //
    // 180s is ~18x today's idle cost, which absorbs both contention and continued growth.
    // It is NOT a licence to let these scripts get slow: if the idle figure above passes
    // ~30s, the right fix is to make the scanners incremental, not to raise this again.
    // Re-derive with:
    //   S=$(date +%s); bash scripts/massu-plan-status-validator.sh >/dev/null 2>&1; \
    //   bash scripts/massu-plan-commit-drift.sh >/dev/null 2>&1; echo $(( $(date +%s) - S ))s
    const v = runScript(VALIDATOR_PATH);
    if (v.exitCode !== 0) {
      throw new Error(
        `Live HEAD validator failed (exit ${v.exitCode}). A new plan likely landed without **Plan Token**: + **Status**: frontmatter, OR an existing plan's Status drifted out of the canonical enum.\nLast 30 lines of stdout:\n${v.stdout.split('\n').slice(-30).join('\n')}`,
      );
    }
    const s = runScript(SCANNER_PATH);
    if (s.exitCode !== 0) {
      throw new Error(
        `Live HEAD drift scanner failed (exit ${s.exitCode}). Likely cause: a recent commit references a plan whose Status is still DRAFT or IN PROGRESS.\nLast 30 lines of stdout:\n${s.stdout.split('\n').slice(-30).join('\n')}`,
      );
    }
    expect(v.exitCode).toBe(0);
    expect(s.exitCode).toBe(0);
  });

  // ----- Phase -> rollback coverage (2026-08-12) -----
  //
  // `2026-07-23-hook-latency-and-silent-loss-fixes.md` silently shipped a phase with no
  // rollback TWICE — P7 (found by an audit) and P6 (found 2026-08-12). Each landed in the
  // implementation section hundreds of lines from a rollback section that was written once
  // and never revisited. These cases are the gate for that class; case 22 plants the ORIGINAL
  // defect back into a copy of the REAL corpus and demands RED (CR-72 — a fixture-only
  // mutation test is a regression test in disguise).

  it('case 14: validator passes when every declared phase is named in the rollback section', () => {
    const tmp = makeCuratedFixtureDir(['phase-rollback-covered.md']);
    try {
      const r = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
      if (r.exitCode !== 0) {
        throw new Error(`Expected exit 0; got ${r.exitCode}.\nstdout:\n${r.stdout}`);
      }
      // M1 — the check must report what it looked at, not merely stay quiet.
      expect(r.stdout).toMatch(/Phase-rollback coverage: 3 phase\(s\) across 1 plan\(s\)/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 15: validator FAILS on a phase declared after the rollback section was written', () => {
    const tmp = makeCuratedFixtureDir(['phase-rollback-missing.md']);
    try {
      const r = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/Phase 6 has no rollback/);
      // P1 and P2 ARE covered by that fixture's rollback section: a gate that flagged them
      // too would be reporting the whole plan, not the phase that actually drifted.
      expect(r.stdout).not.toMatch(/Phase 1 has no rollback/);
      expect(r.stdout).not.toMatch(/Phase 2 has no rollback/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 16: a co-located **Rollback**: line inside the phase block discharges the phase', () => {
    const tmp = makeCuratedFixtureDir(['phase-rollback-own-block.md']);
    try {
      const r = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
      if (r.exitCode !== 0) {
        throw new Error(`Expected exit 0; got ${r.exitCode}.\nstdout:\n${r.stdout}`);
      }
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 17: a plan with phases but NO rollback section is out of scope', () => {
    const tmp = makeCuratedFixtureDir(['phase-rollback-no-section.md']);
    try {
      const r = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
      if (r.exitCode !== 0) {
        throw new Error(`Expected exit 0; got ${r.exitCode}.\nstdout:\n${r.stdout}`);
      }
      expect(r.stdout).toMatch(/Phase-rollback coverage: 0 phase\(s\) across 0 plan\(s\)/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 18: headings that only LOOK like phase declarations are not phases', () => {
    // "Phase Shippability" parsed as phase "S" and "(Phase 4.8)" as a declaration in the
    // first draft of this parser — both measured against the real corpus. A gate that reads
    // prose as code is one people learn to ignore.
    const tmp = makeCuratedFixtureDir(['phase-rollback-not-a-phase.md']);
    try {
      const r = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
      if (r.exitCode !== 0) {
        throw new Error(`Expected exit 0; got ${r.exitCode}.\nstdout:\n${r.stdout}`);
      }
      expect(r.stdout).toMatch(/Phase-rollback coverage: 1 phase\(s\)/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 18b: version strings and item ids in rollback prose create NO coverage', () => {
    // The first range expander accepted a bare `<a>-<b>`, so "1.1.0 - 1.2.0" and "P5-007"
    // in prose invented phase ranges — and invented DIFFERENT ones under mawk than under
    // BWK awk (macOS {5,6,7,103,104} vs Linux {1,2,3,5,6,7,103,104} on one real plan).
    // A gate whose verdict depends on which awk ran it is not a gate. Both endpoints of a
    // range must now be explicit (`P1-P5`, or a "Phase(s)" prefix on the pair).
    const tmp = makeCuratedFixtureDir(['phase-rollback-prose-ranges.md']);
    try {
      const r = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/Phase 2 has no rollback/);
      expect(r.stdout).toMatch(/Phase 3 has no rollback/);
      // P1 IS named explicitly in that fixture's rollback section.
      expect(r.stdout).not.toMatch(/Phase 1 has no rollback/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 19: an unreadable parser FAILS the validator — it never reports coverage clean', () => {
    // M2 — the dependency is injectable precisely so this failure can be forced. A guard you
    // cannot inject a failure into is decoration.
    const tmp = makeCuratedFixtureDir(['phase-rollback-covered.md']);
    try {
      const r = runScript(VALIDATOR_PATH, {
        MASSU_PLAN_DIR: tmp,
        MASSU_PHASE_ROLLBACK_AWK: join(tmpdir(), 'massu-no-such-parser.awk'),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/refusing to report coverage/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 20: the baseline is a ratchet — exceeding its own MAX fails', () => {
    const tmp = makeCuratedFixtureDir(['phase-rollback-missing.md']);
    const baseline = join(tmp, 'baseline.txt');
    writeFileSync(baseline, '# MAX: 0\nphase-rollback-missing.md::6\n');
    try {
      const r = runScript(VALIDATOR_PATH, {
        MASSU_PLAN_DIR: tmp,
        MASSU_PHASE_ROLLBACK_BASELINE: baseline,
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/baseline GREW \(1 > max 0\)/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('case 21: a STALE baseline line fails — that is how a ratchet stops ratcheting', () => {
    const tmp = makeCuratedFixtureDir(['phase-rollback-covered.md']);
    const baseline = join(tmp, 'baseline.txt');
    // Phase 1 of that fixture IS covered, so grandfathering it is stale.
    writeFileSync(baseline, '# MAX: 5\nphase-rollback-covered.md::1\n');
    try {
      const r = runScript(VALIDATOR_PATH, {
        MASSU_PLAN_DIR: tmp,
        MASSU_PHASE_ROLLBACK_BASELINE: baseline,
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/is STALE/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The public mirror carries this validator but NOT the private plan corpus, so the
  // condition is known at collection time and `skipIf` reports it as SKIPPED. Never a bare
  // `return` inside the body — a silently skipped it() is reported as PASSED.
  const REAL_PLANS = resolve(REPO_ROOT, 'docs', 'plans');
  const SUBJECT_PLAN = '2026-07-23-hook-latency-and-silent-loss-fixes.md';

  it.skipIf(!existsSync(join(REAL_PLANS, SUBJECT_PLAN)))(
    'case 22: REAL corpus — re-planting the P6 rollback omission makes the validator RED',
    { timeout: 180_000 },
    () => {
      const SUBJECT = SUBJECT_PLAN;
      const tmp = mkdtempSync(join(tmpdir(), 'massu-plan-real-'));
      try {
        for (const base of readdirSync(REAL_PLANS)) {
          if (base.endsWith('.md')) copyFileSync(join(REAL_PLANS, base), join(tmp, base));
        }
        // NEGATIVE CONTROL. Without it, "the gate went red" and "the copy was broken" are
        // the same observation.
        const before = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
        if (before.exitCode !== 0) {
          throw new Error(
            `The unplanted copy of the real corpus must PASS; got ${before.exitCode}.\n${before.stdout.split('\n').slice(-20).join('\n')}`,
          );
        }

        // Plant the ORIGINAL defect: delete the P6 rollback paragraph that b7cd39bd added.
        const subject = join(tmp, SUBJECT);
        const text = readFileSync(subject, 'utf-8');
        const start = text.indexOf('**P6 (added 2026-08-12');
        expect(start).toBeGreaterThan(-1);
        const end = text.indexOf('**P7 (added by audit-2', start);
        expect(end).toBeGreaterThan(start);
        writeFileSync(subject, text.slice(0, start) + text.slice(end));
        expect(readFileSync(subject, 'utf-8')).not.toMatch(/\*\*P6 \(added 2026-08-12/);

        const after = runScript(VALIDATOR_PATH, { MASSU_PLAN_DIR: tmp });
        expect(after.exitCode).toBe(1);
        expect(after.stdout).toMatch(/Phase 6 has no rollback/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
