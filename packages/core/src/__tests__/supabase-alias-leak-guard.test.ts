// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Vitest drift-guard for the Supabase MCP-alias leak-guard hardening
 * (incident docs/incidents/2026-05-27-supabase-projectid-public-leak.md).
 *
 * Closes the bug class where a public-synced command file references a
 * concrete operator Supabase MCP server alias (e.g. `mcp__supabase__<env>__`)
 * or embeds a project-ref host (`<ref>.supabase.co`). Public files MUST use
 * generic placeholders (`mcp__supabase__<your-env-alias>__` / `mcp__supabase__*`).
 *
 * Asserts:
 *   1. The GENERIC alias signal `mcp__supabase__[A-Za-z0-9_]+__` is present in
 *      the PUBLIC pattern catalog (scripts/lib/leak-patterns.sh) — NOT in the
 *      sync-excluded operator file. (If someone removes it, this fails.)
 *   2. The `.supabase.co` host signal is present in the public catalog.
 *   3. A FAKE fixture (fake id `zzzzzzzzzzzzzzzzzzzz` + `mcp__supabase__FAKEENV__`)
 *      is CAUGHT by the guard (exit 1). Proves the pattern actually fires.
 *      NEVER uses a real operator id/alias.
 *
 * The fixture leak is matched by the GENERIC public pattern, so this test
 * verifies the same mechanism the public-mirror CI relies on (where the
 * operator-only pattern file is absent).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../../..')
const LEAK_GUARD_SCRIPT = resolve(REPO_ROOT, 'scripts/massu-public-leak-guard.sh')
const PUBLIC_PATTERNS_FILE = resolve(REPO_ROOT, 'scripts/lib/leak-patterns.sh')
const OPERATOR_PATTERNS_FILE = resolve(REPO_ROOT, 'scripts/lib/leak-patterns-operator.sh')
const FIXTURES_DIR = resolve(__dirname, 'fixtures/leak-guard-commit-mode')

const GENERIC_ALIAS_PATTERN = 'mcp__supabase__[A-Za-z0-9_]+__'
const SUPABASE_HOST_PATTERN = '[a-z0-9]{20}\\.supabase\\.co'

let tmpRepo: string

function runInTmp(cmd: string): string {
  return execSync(cmd, {
    cwd: tmpRepo,
    encoding: 'utf-8',
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function commitFixture(fixtureName: string, asPath: string): string {
  const fullDest = join(tmpRepo, asPath)
  mkdirSync(join(tmpRepo, asPath.split('/').slice(0, -1).join('/')), { recursive: true })
  copyFileSync(join(FIXTURES_DIR, fixtureName), fullDest)
  runInTmp(`git add "${asPath}"`)
  runInTmp(`git commit -m "test commit: ${fixtureName} as ${asPath}" --no-verify`)
  return runInTmp(`git rev-parse HEAD`).trim()
}

function runLeakGuardCommitMode(sha: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`bash "${LEAK_GUARD_SCRIPT}"`, {
      cwd: tmpRepo,
      encoding: 'utf-8',
      env: { ...process.env, MASSU_LEAK_GUARD_MODE: 'commit', MASSU_LEAK_GUARD_SHA: sha },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { exitCode: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    }
  }
}

describe('supabase-alias leak-guard (incident 2026-05-27)', () => {
  it('PUBLIC leak-patterns.sh contains the generic Supabase alias signal', () => {
    const content = readFileSync(PUBLIC_PATTERNS_FILE, 'utf-8')
    expect(content).toContain(GENERIC_ALIAS_PATTERN)
  })

  it('PUBLIC leak-patterns.sh contains the .supabase.co host signal', () => {
    const content = readFileSync(PUBLIC_PATTERNS_FILE, 'utf-8')
    expect(content).toContain(SUPABASE_HOST_PATTERN)
  })

  it('PUBLIC catalog carries the GENERIC signal (operator file carries only exact ids)', () => {
    // The operator-only file MUST NOT be the carrier of the generic pattern;
    // it carries the exact ref-ids. The generic signal must be public so the
    // public-mirror CI (where the operator file is absent) still catches aliases.
    const opContent = readFileSync(OPERATOR_PATTERNS_FILE, 'utf-8')
    expect(opContent).not.toContain(GENERIC_ALIAS_PATTERN)
  })

  beforeAll(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'supabase-alias-leak-test-'))
    runInTmp('git init -q')
    runInTmp('git config user.email "test@supabase-alias-leak.local"')
    runInTmp('git config user.name "test"')
    runInTmp('git commit --allow-empty -m "initial" --no-verify')
  })

  afterAll(() => {
    if (tmpRepo) rmSync(tmpRepo, { recursive: true, force: true })
  })

  it('FAILs on a planted FAKE Supabase alias fixture (exit 1)', () => {
    // Path `packages/core/...` is in ALLOWED_PATTERNS; the FAKE alias content
    // (mcp__supabase__FAKEENV__ + fake id zzzz...) must trip the generic pattern.
    const sha = commitFixture('expected-supabase-alias-leak.md', 'packages/core/some-alias-doc.md')
    const result = runLeakGuardCommitMode(sha)
    expect(
      result.exitCode,
      `fake-alias fixture should FAIL scanner; got exit ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(1)
  })
})
