// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * scripts/hooks/pre-commit-gate.sh (the agent's PreToolUse commit gate) must decide what to
 * check from what the commit CAN include, not from what happens to be staged before the
 * command runs.
 *
 * The hook runs BEFORE the Bash command, so in a one-line `git add X && git commit` nothing is
 * staged yet. The gate read `git diff --cached`, found 0 packages/ paths, skipped tsc and npm
 * test, and passed a commit whose suite was red (516010ce, 2026-11-09). It also read the index
 * of the hook's cwd rather than of the repository the command named.
 *
 * Driven through the gate's MASSU_PRECOMMIT_SCOPE_ONLY seam against a throwaway repo, so no
 * case runs the real suite. Every git call uses gitSafeEnvForNewRepo (G29): a leaked GIT_DIR
 * would otherwise point these commands at the real repository.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gitSafeEnvForNewRepo } from './helpers/git-safe-env.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GATE = join(REPO_ROOT, 'scripts', 'hooks', 'pre-commit-gate.sh');

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env: gitSafeEnvForNewRepo(), stdio: 'pipe' });

function scope(command: string): string {
  const r = spawnSync('bash', [GATE], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf-8',
    // Run from an UNRELATED directory: the gate must read the repo the command names.
    cwd: tmpdir(),
    env: { ...gitSafeEnvForNewRepo(), MASSU_PRECOMMIT_SCOPE_ONLY: '1', CLAUDE_PROJECT_DIR: '' },
  });
  return `${r.stdout}${r.stderr}`;
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'precommit-scope-')));
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  mkdirSync(join(repo, 'packages', 'core'), { recursive: true });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('pre-commit-gate scope', () => {
  it('a one-line `git add && git commit` of an UNSTAGED packages/ change is in scope', () => {
    writeFileSync(join(repo, 'packages', 'core', 'x.ts'), 'export const x = 1;\n');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add x');
    writeFileSync(join(repo, 'packages', 'core', 'x.ts'), 'export const x = 2;\n'); // modified, not staged
    expect(scope(`cd ${repo} && git add -A && git commit -m y`)).toContain('scope core=1 website=0');
  });

  it('an UNTRACKED packages/ file is in scope', () => {
    writeFileSync(join(repo, 'packages', 'core', 'new.ts'), 'export {};\n');
    expect(scope(`cd ${repo} && git add -A && git commit -m y`)).toContain('scope core=1');
  });

  it('a staged change is still in scope', () => {
    writeFileSync(join(repo, 'packages', 'core', 's.ts'), 'export {};\n');
    git('add', '-A');
    expect(scope(`cd ${repo} && git commit -m y`)).toContain('scope core=1');
  });

  it('control: a commit with no packages/ or website/ change is out of scope', () => {
    writeFileSync(join(repo, 'README.md'), 'hi\n');
    expect(scope(`cd ${repo} && git add -A && git commit -m y`)).toContain('scope core=0 website=0');
  });
});

/**
 * The checks themselves, with `npx` replaced by a stub so no real tool runs. A PreToolUse hook
 * that Claude Code cancels at its timeout takes NO decision and the command proceeds, so the
 * gate's own deadline must BLOCK rather than let the hook time out (2026-11-09: 1f693059 landed
 * with a stale proof that way). The stub's sleep is the stimulus; every assertion is on the
 * exit code and the message, never on how long anything took.
 */
describe('pre-commit-gate checks fail closed', () => {
  function gate(stubBody: string, budgetSecs: string) {
    const bin = join(repo, '.stub-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\n${stubBody}\n`);
    chmodSync(join(bin, 'npx'), 0o755);
    writeFileSync(join(repo, 'packages', 'core', 'x.ts'), 'export const x = 1;\n');
    return spawnSync('bash', [GATE], {
      input: JSON.stringify({ tool_input: { command: `cd ${repo} && git add -A && git commit -m y` } }),
      encoding: 'utf-8',
      cwd: tmpdir(),
      env: { ...gitSafeEnvForNewRepo(), PATH: `${bin}:${process.env.PATH ?? ''}`, CLAUDE_PROJECT_DIR: '', MASSU_PRECOMMIT_BUDGET_SECS: budgetSecs },
    });
  }

  it('control: checks that pass allow the commit', () => {
    const r = gate('exit 0', '60');
    expect(r.status, r.stderr).toBe(0);
  });

  it('a check that fails blocks the commit', () => {
    const r = gate('exit 1', '60');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('failed. Fix before committing');
  });

  it('a check that cannot finish within the budget BLOCKS instead of timing out open', () => {
    const r = gate('sleep 30', '6');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('did not finish within');
  });
});
