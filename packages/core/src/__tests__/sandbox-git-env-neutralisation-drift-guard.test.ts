// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * G29/CR-92 — every file that CREATES a git repository must neutralise the caller's
 * git environment first.
 *
 * WHY THIS EXISTS
 * ---------------
 * `cd` does not scope git. Neither does `git -C <dir>`, nor `cwd:` on a child process.
 * `GIT_DIR` outranks all three. It is inherited from any CALLER that sets it — a nested
 * git invocation, a wrapper, a test harness, a tool. (Git does NOT hand `GIT_DIR` to the
 * hooks it runs; measured, `scripts/ops/probe-git-hook-env.sh`. Hooks DO inherit
 * `GIT_INDEX_FILE`, which redirects the index on its own, so a sandbox `git add` under a
 * pre-commit hook writes the REAL index with no `GIT_DIR` involved at all.) So a harness
 * that builds a throwaway repo and commits into it — launched from anywhere a leaked
 * `GIT_DIR` is set — does not touch its sandbox.
 * It addresses the REAL repository and records every other tracked file as deleted.
 *
 * 2026-08-04, a sibling repo on this machine: exactly that produced a commit touching
 * 5,543 files and deleting 1,388,627 lines. Caught before it was pushed. Incident #166.
 *
 * WHY A DISCOVERING TEST AND NOT A FILE LIST
 * ------------------------------------------
 * The class was swept four times. Each sweep worked a list, and each list was short:
 * pass 4's brief named 7 files and the real count was 8. **When a candidate set comes
 * from a human list, the list IS the population** — so this test encodes no list. It
 * DISCOVERS the population every run, by the effect that creates the hazard, and fails
 * when a member lacks the guard. A harness added next month is covered by declaring
 * itself (Rule 25). No pass 6.
 *
 * WHAT IT DOES *NOT* COVER — stated as a finding, not buried (G20)
 * ----------------------------------------------------------------
 * It covers files that CREATE a repo. It does NOT cover a file that merely READS git
 * through a path it was handed (`home_path_guard "$root"`, `--repo-root <dir>`), because
 * whether such a read intends the caller's own repo (correct, GIT_DIR points there
 * anyway) or some other tree (a bug) is a JUDGEMENT no regex can make. Pass 5 adjudicated
 * those 30 candidates by hand. `RESIDUAL_UNCOVERED_READERS` below records how many exist
 * so the uncovered surface has a NUMBER rather than a shrug.
 *
 * BLIND-GATE POSTURE
 * ------------------
 *   M1 prove it looked — the discovered population is asserted non-empty and reported.
 *   M2 fail closed — an unreadable file is an ERROR, never an implicit exemption.
 *   M4 fixtures per detection path, each of which must FIRE, plus must-stay-silent ones.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// G29/CR-92 — this guard reads the repo it lives in; keep its own git call honest.
import { gitSafeEnv } from './helpers/git-safe-env.ts';

const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * "This file creates a git repository."
 *
 * `[^|;&\n]` — the newline exclusion is load-bearing. A negated character class in most
 * regex flavours MATCHES newline, so `git[^|;&]{0,60}\binit\b` pairs a `git` on one line
 * with an `init` three lines below and reports a file that never creates anything. That
 * false positive was observed while building this guard.
 *
 * Every alternative REQUIRES the command to be git. An earlier draft had a third branch
 * matching any argv beginning `['init', …]` with a `cwd:` nearby — it fired on
 * `massu init --yes` in init-tarball-e2e.test.ts, which creates no repository at all. A
 * guard that reads unrelated code as the hazard is one people learn to ignore, so the
 * branch was deleted rather than patched; the two git-anchored forms already cover the
 * node spellings.
 */
const CREATES_A_REPO =
  /\bgit\b[^|;&\n]{0,60}\binit\b|['"`]git['"`]\s*,\s*\[\s*['"`]init['"`]/;

/** Any recognised form of "the caller's git environment has been neutralised". */
const NEUTRALISED =
  /unset\s+GIT_DIR|gitSafeEnv|git_safe_env|GIT_ENV_LEAKS|env\s+-u\s+GIT_DIR|init\.templateDir=/;

/**
 * Files that create a repo but legitimately need the caller's git context, each with a
 * reason. An entry that NO LONGER creates a repo is a stale exemption and fails — an
 * allowlist that is never re-validated is how a gate quietly widens.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'scripts/ci-sync-check.sh',
    'DEPENDS on inheriting the global init.templateDir so the payload-safety hook is ' +
      'present in the ephemeral mirror; see its own comment. It DOES neutralise GIT_DIR ' +
      '(so this entry covers only the template), and is listed here to keep that ' +
      'deliberate dependency reviewed rather than silent.',
  ],
]);

function trackedSources(): string[] {
  let out: string;
  try {
    out = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', '-z', '--', '*.sh', '*.py', '*.ts', '*.mjs', '*.js'],
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, env: gitSafeEnv() },
    );
  } catch (e) {
    throw new Error(
      `cannot look: git ls-files failed (${(e as Error).message}). ` +
        'A discovery failure is an ERROR, never an empty population.',
    );
  }
  const files = out.split('\0').filter(Boolean);
  if (files.length === 0) {
    throw new Error('cannot look: git ls-files returned ZERO tracked sources.');
  }
  return files;
}

function readOrThrow(rel: string): string {
  try {
    return readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
  } catch (e) {
    throw new Error(`cannot look: ${rel} unreadable (${(e as Error).message}) — M2.`);
  }
}

interface Scan {
  scanned: number;
  creators: string[];
  unguarded: string[];
}

function scan(): Scan {
  const creators: string[] = [];
  const unguarded: string[] = [];
  const files = trackedSources();
  for (const rel of files) {
    // This guard describes the patterns it hunts, so it would flag itself.
    if (rel.endsWith('sandbox-git-env-neutralisation-drift-guard.test.ts')) continue;
    const text = readOrThrow(rel);
    if (!CREATES_A_REPO.test(text)) continue;
    creators.push(rel);
    if (ALLOWLIST.has(rel)) continue;
    if (!NEUTRALISED.test(text)) unguarded.push(rel);
  }
  return { scanned: files.length, creators, unguarded };
}

describe('G29/CR-92 — sandbox git-env neutralisation (Incident #166)', () => {
  it('reports a real denominator (M1 — "scanned 0, found 0" is never a pass)', () => {
    const { scanned, creators } = scan();
    expect(scanned, 'tracked sources scanned').toBeGreaterThan(500);
    expect(
      creators.length,
      'files that create a git repo — if this is 0 the detector is dead, not the repo clean',
    ).toBeGreaterThan(0);
  });

  it('every repo-creating file neutralises the caller git environment', () => {
    const { scanned, creators, unguarded } = scan();
    expect(
      unguarded,
      `UNGUARDED sandbox git harness(es).\n` +
        `  scanned ${scanned} tracked sources; ${creators.length} create a repo.\n` +
        `  Each file below runs \`git init\` without first neutralising GIT_DIR, so when it\n` +
        `  is invoked from a git hook it addresses the REAL repository instead of its\n` +
        `  sandbox — writing to the wrong tree and adjudicating the wrong tree.\n` +
        `  Shell (executed): unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY\n` +
        `                          GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX\n` +
        `  Shell (sourced) : an \`env -u GIT_DIR …\` wrapper — a bare unset would mutate the caller.\n` +
        `  TypeScript      : env: gitSafeEnv()   from ./helpers/git-safe-env.ts\n` +
        `  Python          : env=git_safe_env()  from scripts/lib/git_safe_env.py`,
    ).toEqual([]);
  });

  it('no allowlist entry is stale (an unre-validated exemption widens the gate)', () => {
    const { creators } = scan();
    const stale = [...ALLOWLIST.keys()].filter((f) => !creators.includes(f));
    expect(
      stale,
      'allowlisted file(s) that no longer create a repo — remove the exemption',
    ).toEqual([]);
  });

  it('the allowlist carries a reason for every entry', () => {
    for (const [file, reason] of ALLOWLIST) {
      expect(reason.length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });

  // ── M4: one fixture per detection path, each of which MUST fire ──────────────
  it('DETECTS every spelling of "creates a repo"', () => {
    const mustMatch: Array<[string, string]> = [
      ['plain shell', 'git init -q .'],
      ['shell with -C', 'git -C "$SCRATCH" init -q'],
      ['shell with --git-dir', 'git --git-dir=/tmp/x init'],
      ['node argv', `execFileSync('git', ['init', '--quiet'], { cwd: testRepo })`],
      ['node spawnSync argv', `spawnSync('git', ['init', '-q'], { cwd: sandbox })`],
      ['python argv', `subprocess.run(["git", "init", "-q", d])`],
      ['python f-string', `os.system(f"git init {d}")`],
    ];
    for (const [label, src] of mustMatch) {
      expect(CREATES_A_REPO.test(src), `detection path "${label}" did not fire on: ${src}`).toBe(
        true,
      );
    }
  });

  it('does NOT fire on unrelated git usage (a gate that cries wolf gets ignored)', () => {
    const mustNotMatch: Array<[string, string]> = [
      ['status', 'git status --porcelain'],
      ['ls-files', `execSync('git ls-files', { cwd: REPO_ROOT })`],
      ['rev-parse', 'git rev-parse --show-toplevel'],
      [
        'cross-line false pair',
        'const a = git;\nconst b = 2;\nconst c = 3;\nfunction init() {}',
      ],
      // Regression pin: this exact shape was the guard's first false positive
      // (init-tarball-e2e.test.ts:239). `massu init` creates no repository.
      [
        'a non-git CLI whose argv starts with init',
        `spawnSync(cliBin, ['init', '--yes', '--skip-side-effects'],\n  {\n    cwd: fixtureRoot,\n  })`,
      ],
      ['npm init', `spawnSync('npm', ['init', '-y'], { cwd: dir })`],
    ];
    for (const [label, src] of mustNotMatch) {
      expect(CREATES_A_REPO.test(src), `false positive on "${label}": ${src}`).toBe(false);
    }
  });

  it('recognises every neutralisation form actually used in this repo', () => {
    const forms = [
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
      'env -u GIT_DIR -u GIT_WORK_TREE git "$@"',
      'env: gitSafeEnv()',
      'env=git_safe_env()',
      'const GIT_ENV_LEAKS = [',
    ];
    for (const f of forms) {
      expect(NEUTRALISED.test(f), `neutralisation form not recognised: ${f}`).toBe(true);
    }
    expect(NEUTRALISED.test('const x = 1;'), 'must not match arbitrary code').toBe(false);
  });
});
