// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// Drift-guard: sync-public.sh MUST self-exempt its bulk-delete git commands from
// the root deletion-circuit-breaker (DEFECT 1, incident 2026-07-24).
//
// `git rm -rf .` + `git clean -fd` unlink hundreds of files under $HOME to clean
// the public mirror. The root breaker watches all of $HOME and SIGSTOPs a
// bulk-delete signature, which froze the git child mid-sync every run. The fix
// runs each bulk-delete git command through a `cb_exempt_git` helper that
// registers the git child pid ($!) in ~/.claude/cb-exempt-pids.txt for the
// duration, plus a cleanup trap that removes every pid this script added even on
// interrupt. If either the helper or the trap is edited out, the breaker freezes
// the sync again — this guard fails first.
//
// sync-public.sh is excluded from the public mirror (it is the sync engine
// itself), so this assertion is vacuous there and skips gracefully — same
// graceful-absence pattern as public-sync-no-operational-logs.test.ts.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const syncPublicPath = join(repoRoot, 'scripts', 'sync-public.sh');
const inInternalRepo = existsSync(syncPublicPath);

describe('sync-public: bulk-delete git commands self-exempt the breaker (DEFECT 1, incident 2026-07-24)', () => {
  it.skipIf(!inInternalRepo)('defines the cb_exempt_git helper and routes BOTH bulk deletes through it', () => {
    const sync = readFileSync(syncPublicPath, 'utf-8');
    expect(sync).toMatch(/cb_exempt_git\s*\(\)\s*\{/);
    expect(sync).toContain('cb_exempt_git git rm -rf --quiet .');
    expect(sync).toContain('cb_exempt_git git clean -fd --quiet');
    // The bare unwrapped forms must be gone — a wrapped-and-unwrapped mix would
    // still trip the breaker.
    expect(sync).not.toMatch(/^\s*git rm -rf --quiet \. /m);
    expect(sync).not.toMatch(/^\s*git clean -fd --quiet /m);
  });

  it.skipIf(!inInternalRepo)('registers the git child pid ($!) in the exempt file', () => {
    const sync = readFileSync(syncPublicPath, 'utf-8');
    expect(sync).toContain('cb-exempt-pids.txt');
    expect(sync).toMatch(/local pid=\$!/);
  });

  it.skipIf(!inInternalRepo)('installs a cleanup trap that de-registers this script\'s pids on exit/interrupt', () => {
    const sync = readFileSync(syncPublicPath, 'utf-8');
    expect(sync).toMatch(/trap\s+_cb_exempt_cleanup\s+EXIT\s+INT\s+TERM/);
  });
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL guard (incident 2026-07-24, second defect).
//
// Every assertion above is a grep over the source text, and all of them stayed
// green while sync-public.sh exited 1 on every CI runner: the cleanup function
// ran, its loop body's last command was a failing `[ -n "" ]` because no pid had
// been registered, and under `set -e` a failing command in an EXIT trap sets the
// SCRIPT's exit status. The sync had fully succeeded — publication gate included
// — and then reported failure. Invisible locally, where ~/.claude exists and the
// array is non-empty.
//
// So this case EXECUTES the real function rather than describing it. A static
// pattern check cannot catch a defect whose signature is an exit code.
describe('sync-public: the breaker cleanup trap never sets the exit status', () => {
  it.skipIf(!inInternalRepo)('exits 0 under set -e when NO pid was registered (the CI case)', () => {
    const src = readFileSync(syncPublicPath, 'utf8');

    // Bind to the REAL function body, so editing sync-public.sh moves this test.
    const fn = src.match(/^_cb_exempt_cleanup\(\) \{[\s\S]*?^\}/m);
    expect(fn, '_cb_exempt_cleanup not found in sync-public.sh').not.toBeNull();

    const harness = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'CB_EXEMPT_ADDED=()', // exactly the CI state: registration failed, nothing added
      '_cb_exempt_remove() { return 0; }',
      fn![0],
      'trap _cb_exempt_cleanup EXIT',
      'echo "Sync complete."',
    ].join('\n');

    const dir = mkdtempSync(join(tmpdir(), 'cb-exempt-trap-'));
    try {
      const script = join(dir, 'harness.sh');
      writeFileSync(script, harness, { mode: 0o755 });
      const r = spawnSync('bash', [script], { encoding: 'utf8' });
      expect(r.stdout).toContain('Sync complete.');
      expect(
        r.status,
        'cleanup trap set a non-zero exit status with an empty CB_EXEMPT_ADDED — ' +
          'sync-public.sh will report failure after a fully successful sync on every CI runner',
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
