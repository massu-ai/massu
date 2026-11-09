// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-H002 (plan-stage-c-high-batch) drift-guard DG-2.
 *
 * Closes the bug-class where auto-learning-pipeline.ts ran two unbounded
 * `git diff` reads of the entire working tree on the Stop event, hanging
 * session-end on monorepos with 10MB+ uncommitted diffs.
 *
 * Structural fix: two-stage probe (name-only → shortstat → full-diff IFF
 * estimated_bytes <= MAX_FULL_DIFF_BYTES). This test fabricates a working tree
 * with ~5MB of TRACKED changes and asserts the over-cap diff is SKIPPED, paired
 * with an under-cap diff that is SCANNED.
 *
 * It asserted "completes in <5s" until 2026-07-28. That was wrong twice over:
 * a wall-clock budget measures the machine rather than the code (it flaked the
 * pre-push battery under load), and the fixture's files were never committed,
 * so `git diff` saw nothing and the bounded path was never entered at all.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MAX_FULL_DIFF_BYTES } from '../hooks/auto-learning-pipeline.ts';
// G29/CR-92 — `cwd:` does not scope git; GIT_DIR outranks it. See the helper for why.
import { gitSafeEnv } from './helpers/git-safe-env.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let testRepo = '';

/**
 * Seed the repo with bulk files and COMMIT them, so that the later rewrite in
 * {@link makeLargeDiff} registers as a tracked modification.
 *
 * This step is load-bearing. Until 2026-07-28 the fixture only wrote NEW files
 * and never committed them, and `git diff` reports nothing for untracked paths
 * — so the hook exited at its stage-1 `if (nameOnly.trim())` check and the
 * bounded path was NEVER entered. The test passed in milliseconds and would
 * have passed with the cap deleted outright: a dead gate whose green came from
 * an empty diff, not from bounding.
 */
function seedBulkFiles(repoPath: string, totalBytes: number): void {
  const linesPerFile = Math.floor(totalBytes / 80 / 10);
  for (let i = 0; i < 10; i++) {
    const lines: string[] = [];
    for (let j = 0; j < linesPerFile; j++) {
      lines.push(`// seed ${i}-${j} ` + 'x'.repeat(60));
    }
    writeFileSync(join(repoPath, `bulk-${i}.ts`), lines.join('\n'));
  }
}

/**
 * Rewrite the committed bulk files, producing a genuine multi-megabyte diff.
 *
 * The replacement lines are deliberately FIX PATTERNS (try/catch/throw/assert/
 * null-guards). If the cap were removed the hook would scan this diff, clear
 * its `fixPatterns > 3` threshold and print its banner — which is what makes
 * the "no banner" assertion falsifiable rather than decorative.
 */
function makeLargeDiff(repoPath: string, totalBytes: number): void {
  const linesPerFile = Math.floor(totalBytes / 80 / 10);
  const fixShapes = [
    'try { foo(); } catch (e) { throw e; }',
    'if (x === null) { assert(false); }',
    'if (y === undefined) { validate(y); }',
    'if (z === None) { raise(); }',
  ];
  for (let i = 0; i < 10; i++) {
    const lines: string[] = [];
    for (let j = 0; j < linesPerFile; j++) {
      lines.push(`${fixShapes[j % fixShapes.length]} // ${i}-${j} ` + 'x'.repeat(30));
    }
    writeFileSync(join(repoPath, `bulk-${i}.ts`), lines.join('\n'));
  }
}

beforeAll(() => {
  testRepo = mkdtempSync(join(tmpdir(), 'massu-auto-learning-bound-'));
  execFileSync('git', ['init', '--quiet'], { cwd: testRepo, env: gitSafeEnv() });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testRepo, env: gitSafeEnv() });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testRepo, env: gitSafeEnv() });
  // Initial commit to establish HEAD — and COMMIT the bulk files, so the
  // rewrite below is a tracked modification that `git diff` actually reports.
  writeFileSync(join(testRepo, 'README.md'), '# test\n');
  seedBulkFiles(testRepo, 5 * 1024 * 1024);
  execFileSync('git', ['add', '.'], { cwd: testRepo, env: gitSafeEnv() });
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: testRepo, env: gitSafeEnv() });
  // Fabricate ~5MB of uncommitted changes against those committed files
  makeLargeDiff(testRepo, 5 * 1024 * 1024);
  // Ensure massu.config.yaml exists so getConfig() doesn't blow up
  writeFileSync(
    join(testRepo, 'massu.config.yaml'),
    'project:\n  name: test\nframework:\n  type: typescript\n',
  );
});

afterAll(() => {
  if (testRepo) rmSync(testRepo, { recursive: true, force: true });
});

describe('auto-learning pipeline bounded-diff (DG-2)', () => {
  // The spawned hook is given 30_000ms below; vitest's global testTimeout is 20000, so
  // without this the smaller bound silently won and the declared budget was unreachable.
  it('SKIPS the full-diff scan when the working tree exceeds the cap', { timeout: 30_000 }, () => {
    const hookPath = resolve(__dirname, '../../dist/hooks/auto-learning-pipeline.js');

    // FAIL CLOSED (G-1, plan-2026-07-26-anti-vacuity-9-unproven-gates): the hook not
    // being built is exactly the state in which the bounding behaviour is unproven,
    // and a `return` here reported that state as PASSED.
    expect(
      existsSync(hookPath),
      `${hookPath} missing — the bounded-diff behaviour cannot be observed. ` +
        'Run "npm run build:hooks" (packages/core). Do NOT restore the skip.',
    ).toBe(true);

    // POSITIVE CONTROL — the fixture must present a REAL diff that EXCEEDS the
    // cap. "No banner on stdout" is produced by two different states: the diff
    // was over-cap and correctly skipped (the property), or there was no diff
    // at all (the defect this test carried until 2026-07-28). Only these two
    // assertions tell them apart.
    const changed = execFileSync('git', ['diff', '--name-only'], {
      cwd: testRepo, encoding: 'utf-8', env: gitSafeEnv(),
    }).trim().split('\n').filter(Boolean);
    expect(changed.length).toBeGreaterThan(0);

    const shortstat = execFileSync('git', ['diff', '--shortstat'], {
      cwd: testRepo, encoding: 'utf-8', env: gitSafeEnv(),
    });
    const insertions = parseInt(shortstat.match(/(\d+) insertion/)?.[1] ?? '0', 10);
    const deletions = parseInt(shortstat.match(/(\d+) deletion/)?.[1] ?? '0', 10);
    // Same estimator the hook uses (~80 bytes/line), bound to the exported cap
    // rather than to a restated literal.
    expect((insertions + deletions) * 80).toBeGreaterThan(MAX_FULL_DIFF_BYTES);

    const result = spawnSync(
      'node',
      [hookPath],
      {
        cwd: testRepo,
        input: JSON.stringify({
          session_id: 'test-session-bounded-diff',
          transcript_path: '/tmp/dummy',
          cwd: testRepo,
        }),
        timeout: 30_000,
        encoding: 'utf-8',
        env: gitSafeEnv({ MASSU_CONFIG_DIR: testRepo }),
      },
    );

    // Hook must exit 0 (best-effort design — even on error path it exits 0)
    expect(result.status).toBe(0);
    // THE PROPERTY, stated directly instead of inferred from a stopwatch: an
    // over-cap diff is SKIPPED rather than scanned. The rewritten lines are all
    // fix patterns, so a hook that read this diff would clear its
    // `fixPatterns > 3` threshold and print the banner.
    expect(result.stdout).not.toContain('MASSU AUTO-LEARNING PIPELINE');
  });

  // Same 30_000ms subprocess budget as above — matched here so one authority governs.
  it('still detects fix patterns on small diffs (regression guard)', { timeout: 30_000 }, () => {
    const hookPath = resolve(__dirname, '../../dist/hooks/auto-learning-pipeline.js');
    expect(
      existsSync(hookPath),
      `${hookPath} missing — fix-pattern detection cannot be exercised. ` +
        'Run "npm run build:hooks" (packages/core). Do NOT restore the skip.',
    ).toBe(true);

    // Use a separate small-diff repo so we don't contaminate the 5MB fixture
    const smallRepo = mkdtempSync(join(tmpdir(), 'massu-auto-learning-small-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: smallRepo, env: gitSafeEnv() });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: smallRepo, env: gitSafeEnv() });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: smallRepo, env: gitSafeEnv() });
      writeFileSync(join(smallRepo, 'a.ts'), 'function x() { return 1; }\n');
      execFileSync('git', ['add', '.'], { cwd: smallRepo, env: gitSafeEnv() });
      execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: smallRepo, env: gitSafeEnv() });
      // Many fix-pattern lines so threshold triggers
      writeFileSync(
        join(smallRepo, 'a.ts'),
        [
          'function x() { return 1; }',
          'try { foo(); } catch (e) { throw e; }',
          'if (x === null) { assert(false); }',
          'if (y === undefined) { validate(y); }',
          'if (z === None) { raise(); }',
          'try { bar(); } catch (e) { throw e; }',
        ].join('\n'),
      );
      writeFileSync(
        join(smallRepo, 'massu.config.yaml'),
        'project:\n  name: test\nframework:\n  type: typescript\n',
      );

      // The scan is SESSION-SCOPED: a diff this session cannot be shown to have made
      // raises no demand on it, because a demand nobody can discharge gets routed around.
      // This fixture therefore has to supply the actor it is asserting about. Before that
      // scoping existed, `transcript_path: '/tmp/dummy'` was enough — the hook banner-ed on
      // any uncommitted diff, whoever wrote it.
      const transcript = join(smallRepo, 'transcript.jsonl');
      writeFileSync(
        transcript,
        JSON.stringify({
          message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(smallRepo, 'a.ts') } }] },
        }) + '\n',
      );

      const result = spawnSync(
        'node',
        [hookPath],
        {
          cwd: smallRepo,
          input: JSON.stringify({
            session_id: 'test-session-small-diff',
            transcript_path: transcript,
            cwd: smallRepo,
          }),
          timeout: 30_000,
          encoding: 'utf-8',
          // G29/CR-92 — this call carried NO `env:` at all, so it inherited the
          // whole environment implicitly. That is the silent shape: nothing to
          // grep for, and `cwd:` does not scope git.
          env: gitSafeEnv(),
        },
      );

      expect(result.status).toBe(0);
      // The UNDER-cap twin of the test above: this diff IS scanned, so the
      // banner must appear. The pair is what makes either half meaningful —
      // "no banner" only means "skipped" if a comparable diff does produce one.
      expect(result.stdout).toContain('MASSU AUTO-LEARNING PIPELINE');
    } finally {
      rmSync(smallRepo, { recursive: true, force: true });
    }
  });
});
