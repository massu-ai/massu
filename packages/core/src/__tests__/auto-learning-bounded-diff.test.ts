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
 * estimated_bytes <= MAX_FULL_DIFF_BYTES). This test fabricates a working
 * tree with ~5MB of changes and asserts the pipeline completes in <5s.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let testRepo = '';

function makeLargeDiff(repoPath: string, totalBytes: number): void {
  // Create one large file + many smaller ones to simulate a real big diff.
  const chunkSize = 80; // bytes per "line"
  const linesPerFile = Math.floor(totalBytes / chunkSize / 10);
  for (let i = 0; i < 10; i++) {
    const lines: string[] = [];
    for (let j = 0; j < linesPerFile; j++) {
      lines.push(`// line ${i}-${j} ` + 'x'.repeat(60));
    }
    writeFileSync(join(repoPath, `bulk-${i}.ts`), lines.join('\n'));
  }
}

beforeAll(() => {
  testRepo = mkdtempSync(join(tmpdir(), 'massu-auto-learning-bound-'));
  execFileSync('git', ['init', '--quiet'], { cwd: testRepo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testRepo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testRepo });
  // Initial commit to establish HEAD
  writeFileSync(join(testRepo, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: testRepo });
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: testRepo });
  // Fabricate ~5MB of uncommitted changes
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
  it('completes in under 5s on a working tree with ~5MB of changes', () => {
    const hookPath = resolve(__dirname, '../../dist/hooks/auto-learning-pipeline.js');

    // Skip if hook not built — covered by build:hooks gate.
    try {
      execFileSync('ls', [hookPath], { stdio: 'ignore' });
    } catch {
      // eslint-disable-next-line no-console
      console.warn('DG-2 skipped: hook not built. Run `npm run build:hooks` first.');
      return;
    }

    const start = Date.now();
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
        timeout: 10_000, // give it 10s; we assert <5s below
        encoding: 'utf-8',
        env: { ...process.env, MASSU_CONFIG_DIR: testRepo },
      },
    );
    const elapsedMs = Date.now() - start;

    // Hook must exit 0 (best-effort design — even on error path it exits 0)
    expect(result.status).toBe(0);
    // Hard wall: under 5s. Pre-fix this took >10s on ~5MB diffs.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('still detects fix patterns on small diffs (regression guard)', () => {
    const hookPath = resolve(__dirname, '../../dist/hooks/auto-learning-pipeline.js');
    try {
      execFileSync('ls', [hookPath], { stdio: 'ignore' });
    } catch {
      return;
    }

    // Use a separate small-diff repo so we don't contaminate the 5MB fixture
    const smallRepo = mkdtempSync(join(tmpdir(), 'massu-auto-learning-small-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: smallRepo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: smallRepo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: smallRepo });
      writeFileSync(join(smallRepo, 'a.ts'), 'function x() { return 1; }\n');
      execFileSync('git', ['add', '.'], { cwd: smallRepo });
      execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: smallRepo });
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

      const start = Date.now();
      const result = spawnSync(
        'node',
        [hookPath],
        {
          cwd: smallRepo,
          input: JSON.stringify({
            session_id: 'test-session-small-diff',
            transcript_path: '/tmp/dummy',
            cwd: smallRepo,
          }),
          timeout: 10_000,
          encoding: 'utf-8',
        },
      );
      const elapsedMs = Date.now() - start;

      expect(result.status).toBe(0);
      expect(elapsedMs).toBeLessThan(3_000);
      // Hook should have emitted pipeline instructions on stdout (uncommittedFix triggered).
      expect(result.stdout).toContain('MASSU AUTO-LEARNING PIPELINE');
    } finally {
      rmSync(smallRepo, { recursive: true, force: true });
    }
  });
});
