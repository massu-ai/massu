// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// Drift-guard: CR-62's incident-coverage gate must treat the ENFORCEMENT LAYER as code.
//
// Incident 2026-07-24 — the incident pipeline was blind to the gate layer:
// eight real defects were found and fixed in one session -- a pre-push gate whose predicate
// could never be true, a sync script that exited 1 after succeeding, an installer that wired
// the PUBLIC leak guard into the private repo, a scanner that reported CLEAN when git failed --
// and this gate printed PASS on all six pushes. Not because coverage existed: 0 of the 33
// changed files matched its trigger regex, because every one of them lived in scripts/.
//
// The rule's own text is "a bug the MACHINE finds must produce the same artifacts as a bug the
// HUMAN reports". It cannot exclude the machinery from being code -- gate bugs are precisely
// the ones that make every OTHER gate untrustworthy.
//
// These cases run the REAL script against scratch repositories. Asserting on the regex alone
// would pass against a script whose surrounding logic had changed, which is the class of
// false-green this whole plan is about.

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const gatePath = join(repoRoot, 'scripts', 'massu-incident-coverage.sh');
const inInternalRepo = existsSync(gatePath);

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !args.includes('rev-list')) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

/** A scratch repo carrying the gate script (optionally mutated). */
function makeRepo(gateBody?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cr62-scope-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  if (gateBody === undefined) {
    copyFileSync(gatePath, join(dir, 'scripts', 'massu-incident-coverage.sh'));
  } else {
    writeFileSync(join(dir, 'scripts', 'massu-incident-coverage.sh'), gateBody);
  }
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

/** Commit a set of files under one subject. */
function commit(dir: string, subject: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', subject);
}

/** Run the gate over the last commit. Returns its exit status. */
function runGate(dir: string): { status: number; out: string } {
  const r = spawnSync('bash', ['scripts/massu-incident-coverage.sh', 'HEAD~1..HEAD'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe('CR-62 incident coverage covers the enforcement layer (incident 2026-07-24)', () => {
  let gateSrc = '';
  beforeAll(() => {
    if (inInternalRepo) gateSrc = readFileSync(gatePath, 'utf8');
  });

  it.skipIf(!inInternalRepo)('a fix touching scripts/ with NO incident doc is REJECTED', () => {
    const dir = makeRepo();
    try {
      commit(dir, 'fix(sync): a gate-layer bug', {
        'scripts/sync-public.sh': '#!/usr/bin/env bash\necho patched\n',
      });
      const { status, out } = runGate(dir);
      expect(status, `gate accepted an unrecorded scripts/ fix:\n${out}`).not.toBe(0);
      expect(out).toMatch(/Incident coverage/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!inInternalRepo)('the same fix WITH an incident doc is accepted', () => {
    const dir = makeRepo();
    try {
      commit(dir, 'fix(sync): a gate-layer bug', {
        'scripts/sync-public.sh': '#!/usr/bin/env bash\necho patched\n',
        // Assembled at runtime so this path never sits in the repo as a contiguous
        // literal — the prefix is private to this repo, and this file IS part of the
        // publication set, so a literal here blocks the public sync. Same technique as
        // scripts/tests/test_leak_guard_ci_redaction.sh. The gate under test matches on
        // the assembled value, so the fixture is unchanged in behaviour.
        [`${['docs', 'incidents'].join('/')}/2026-07-24-example.md`]:
          '# incident\n\nroot cause, evidence, prevention\n',
      });
      const { status, out } = runGate(dir);
      expect(status, `gate rejected a properly recorded fix:\n${out}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!inInternalRepo)('.claude/hooks/ is in scope too', () => {
    const dir = makeRepo();
    try {
      commit(dir, 'fix(hooks): a hook bug', {
        '.claude/hooks/some-hook.js': 'module.exports = {};\n',
      });
      const { status } = runGate(dir);
      expect(status, 'a hook fix with no incident doc was accepted').not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!inInternalRepo)('test files are still EXCLUDED — a test-only fix needs no incident', () => {
    // Widening scope must not make every test tweak demand an incident doc; a gate
    // that is heavy on correct work gets switched off, which is how the enforcement
    // layer went unguarded in the first place.
    const dir = makeRepo();
    try {
      commit(dir, 'fix(tests): correct an assertion', {
        'scripts/tests/test_something.sh': '#!/usr/bin/env bash\nexit 0\n',
      });
      const { status, out } = runGate(dir);
      expect(status, `a test-only fix was rejected:\n${out}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!inInternalRepo)('product source remains in scope (no regression)', () => {
    const dir = makeRepo();
    try {
      commit(dir, 'fix(core): a product bug', {
        'packages/core/src/thing.ts': 'export const x = 1;\n',
      });
      const { status } = runGate(dir);
      expect(status, 'a product-source fix with no incident doc was accepted').not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!inInternalRepo)('non-fix commits are untouched (feat/chore/docs)', () => {
    const dir = makeRepo();
    try {
      commit(dir, 'feat(sync): add a capability', {
        'scripts/sync-public.sh': '#!/usr/bin/env bash\necho feature\n',
      });
      const { status } = runGate(dir);
      expect(status, 'a feat commit was treated as a bug fix').toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ANTI-VACUITY. Narrow the scope back to product-only and the first case must
  // PASS — proving the widening is what does the work, not something incidental.
  it.skipIf(!inInternalRepo)('REINTRODUCTION: product-only scope accepts the scripts/ fix', () => {
    const narrowed = gateSrc.replace(
      "| grep -E '^(packages/[^/]+/src/|website/src/|scripts/|\\.claude/hooks/)' \\",
      "| grep -E '^(packages/[^/]+/src/|website/src/)' \\",
    );
    expect(narrowed, 'the scope regex was not found — this test no longer binds to the gate')
      .not.toBe(gateSrc);

    const dir = makeRepo(narrowed);
    try {
      commit(dir, 'fix(sync): a gate-layer bug', {
        'scripts/sync-public.sh': '#!/usr/bin/env bash\necho patched\n',
      });
      const { status } = runGate(dir);
      expect(
        status,
        'the pre-fix gate REJECTED the scripts/ fix — the widening is not what makes case 1 pass',
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
