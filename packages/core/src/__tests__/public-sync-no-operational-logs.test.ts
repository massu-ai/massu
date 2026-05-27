// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// Drift-guard: internal operational logs MUST never be git-tracked (and thus
// never reach the public-sync mirror at github.com/massu-ai/massu).
//
// Incident 2026-05-27: `scripts/hooks/secret-detections.log` (secret-detection
// telemetry — timestamps, tool, secret-TYPE names, session IDs) and
// `scripts/hooks/mcp-usage.log` were tracked in the internal repo AND copied to
// the public repo by sync-public.sh (which copies scripts/ wholesale). No secret
// VALUES leaked, but operational telemetry did. Root cause: runtime logs were
// committed instead of gitignored, and the leak-guard content scan targets
// secret values, not log files.
//
// Three-layer structural enforcement (this test is layer 3):
//   1. .gitignore: `scripts/hooks/*.log` — git refuses to stage them.
//   2. sync-public.sh: `--exclude='hooks/*.log'` — rsync refuses to copy them.
//   3. this drift-guard: CI fails if either invariant regresses.

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// `scripts/sync-public.sh` is excluded from the public-sync mirror (it's the
// sync engine itself), so its presence marks the internal repo. The .gitignore
// rule + sync-exclude assertions verify internal-repo prevention config; in the
// public mirror they're vacuous and skip. The "no tracked logs" invariant holds
// in BOTH repos and runs unconditionally. (Same graceful-absence pattern as
// auto-learning-mirror-drift-guard.test.ts.)
const inInternalRepo = existsSync(join(repoRoot, 'scripts', 'sync-public.sh'));

describe('public-sync: no internal operational logs (incident 2026-05-27)', () => {
  it('no *.log file under scripts/ is git-tracked', () => {
    const tracked = execSync('git ls-files "scripts/**/*.log" "scripts/*.log"', {
      cwd: repoRoot,
      encoding: 'utf-8',
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(tracked, `Operational logs must be gitignored, not tracked: ${tracked.join(', ')}`).toEqual([]);
  });

  it.skipIf(!inInternalRepo)('.gitignore excludes scripts/hooks/*.log', () => {
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toMatch(/^scripts\/hooks\/\*\.log\s*$/m);
  });

  it.skipIf(!inInternalRepo)('sync-public.sh excludes hooks/*.log from the public scripts copy', () => {
    const sync = readFileSync(join(repoRoot, 'scripts', 'sync-public.sh'), 'utf-8');
    expect(sync).toContain("--exclude='hooks/*.log'");
  });
});
