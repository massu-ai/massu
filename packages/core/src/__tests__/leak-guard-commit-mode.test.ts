// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Vitest drift-guard for plan-leak-guard-range-mode-verify P-B-002.
 *
 * Pins the commit-mode behavior shipped in commit 960219e (2026-05-10):
 * `MASSU_LEAK_GUARD_MODE=commit MASSU_LEAK_GUARD_SHA=<sha>` correctly
 * detects content-trigger violations that the old range-mode silently
 * PASSed (synthetic-PR `massu-ai/massu#2` run 25621197800 false-PASS
 * 2026-05-09; verified live by `massu-ai/massu#3` run 25708648211 FAIL
 * 2026-05-11 per plan-leak-guard-range-mode-verify P-A-002).
 *
 * The test stages 3 fixture files into a temporary git repo, commits
 * each, then invokes `scripts/massu-public-leak-guard.sh` with the
 * commit SHA. Asserts:
 *   - Clean fixture (no trigger): scanner exits 0.
 *   - Leak fixture (generic CONFIDENTIAL catalog pattern): scanner exits 1
 *     with the trigger word visible in the violation output. Uses a generic
 *     pattern (not an operator-only one) so the test verifies the same
 *     mechanism in the public-mirror CI where operator patterns are absent.
 *   - Mixed fixture (trigger embedded in clean prose): scanner exits 1
 *     (regression check for tokenizer correctness across paragraph
 *     boundaries).
 *
 * Bug class this test makes impossible: any future refactor of
 * `massu-public-leak-guard.sh` that re-introduces the old range-mode
 * behavior (silently MISSING the file in `git diff` output) fails
 * loudly in CI before merge.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// G29/CR-92 — `cwd:` does not scope git; GIT_DIR outranks it. See the helper for why.
import { gitSafeEnv } from './helpers/git-safe-env.ts'


const REPO_ROOT = resolve(__dirname, '../../../..')
const LEAK_GUARD_SCRIPT = resolve(REPO_ROOT, 'scripts/massu-public-leak-guard.sh')
const FIXTURES_DIR = resolve(__dirname, 'fixtures/leak-guard-commit-mode')

interface CommitResult {
  sha: string
  exitCode: number
  stdout: string
  stderr: string
}

let tmpRepo: string

function runInTmp(cmd: string, env: Record<string, string> = {}): string {
  return execSync(cmd, {
    cwd: tmpRepo,
    encoding: 'utf-8',
    env: gitSafeEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function commitFixture(fixtureName: string, asPath: string): string {
  const fullDest = join(tmpRepo, asPath)
  // Create parent dirs (e.g., packages/core/) if missing.
  mkdirSync(join(tmpRepo, asPath.split('/').slice(0, -1).join('/')), { recursive: true })
  copyFileSync(join(FIXTURES_DIR, fixtureName), fullDest)
  runInTmp(`git add "${asPath}"`)
  runInTmp(`git commit -m "test commit: ${fixtureName} as ${asPath}" --no-verify`)
  return runInTmp(`git rev-parse HEAD`).trim()
}

function runLeakGuardCommitMode(sha: string): CommitResult {
  try {
    const stdout = execSync(`bash "${LEAK_GUARD_SCRIPT}"`, {
      cwd: tmpRepo,
      encoding: 'utf-8',
      env: gitSafeEnv({
        MASSU_LEAK_GUARD_MODE: 'commit',
        MASSU_LEAK_GUARD_SHA: sha,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { sha, exitCode: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      sha,
      exitCode: e.status ?? 1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    }
  }
}

describe('leak-guard commit-mode (plan-leak-guard-range-mode-verify P-B-002)', () => {
  beforeAll(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'leak-guard-test-'))
    runInTmp('git init -q')
    runInTmp('git config user.email "test@plan-leak-guard.local"')
    runInTmp('git config user.name "test"')
    runInTmp('git commit --allow-empty -m "initial" --no-verify')
  })

  afterAll(() => {
    if (tmpRepo) {
      rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('clean fixture: scanner exits 0 (no triggers, allowed path)', () => {
    // Path `packages/core/some-doc.md` IS in ALLOWED_PATTERNS (^packages/core/);
    // content has no triggers; scanner should PASS.
    const sha = commitFixture('expected-clean.md', 'packages/core/some-clean-doc.md')
    const result = runLeakGuardCommitMode(sha)
    expect(
      result.exitCode,
      `clean fixture should pass scanner; got exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0)
  })

  it('leak fixture: scanner exits 1 with trigger word in violation output', () => {
    // Path `packages/core/...` is allowed; content contains the generic
    // CONFIDENTIAL catalog trigger; scanner should FAIL on content check.
    const sha = commitFixture('expected-leak.md', 'packages/core/some-leak-doc.md')
    const result = runLeakGuardCommitMode(sha)
    expect(
      result.exitCode,
      `leak fixture should FAIL scanner; got exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(1)
    // The trigger word must appear in the violation output (proves content
    // check fired, not some unrelated failure mode).
    const combined = `${result.stdout}\n${result.stderr}`
    expect(
      combined,
      'violation output should reference the content trigger',
    ).toMatch(/confidential|content|trigger|violat/i)
  })

  it('mixed fixture: scanner exits 1 (regression for tokenizer across paragraph boundaries)', () => {
    // Trigger is embedded in the middle of clean prose paragraphs; scanner
    // must NOT short-circuit on the first non-matching paragraph.
    const sha = commitFixture('expected-mixed.md', 'packages/core/some-mixed-doc.md')
    const result = runLeakGuardCommitMode(sha)
    expect(
      result.exitCode,
      `mixed fixture should FAIL scanner; got exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(1)
  })

  it('commit mode requires MASSU_LEAK_GUARD_SHA (regression check)', () => {
    // Sanity: invoking commit-mode without SHA should exit 2 with explicit error.
    try {
      execSync(`bash "${LEAK_GUARD_SCRIPT}"`, {
        cwd: tmpRepo,
        encoding: 'utf-8',
        env: gitSafeEnv({ MASSU_LEAK_GUARD_MODE: 'commit', MASSU_LEAK_GUARD_SHA: '' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      throw new Error('expected scanner to exit non-zero without MASSU_LEAK_GUARD_SHA')
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer | string }
      expect(e.status, 'commit-mode without SHA should exit 2').toBe(2)
      const stderr = e.stderr ? e.stderr.toString() : ''
      expect(stderr, 'error should mention MASSU_LEAK_GUARD_SHA').toMatch(/MASSU_LEAK_GUARD_SHA/)
    }
  })
})
