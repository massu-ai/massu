// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard (incident 2026-07-20-generalization-scanner-scripts-scope-hole, CR-62).
 *
 * The generalization scanner's Check 2 ("No hardcoded /Users/ paths") once scanned
 * only `packages/core/src .claude/commands scripts/hooks` — but ALL of `scripts/`
 * syncs public (PUBLIC_MANIFEST). So `scripts/blast-radius.sh`, which hardcodes an
 * operator home path, passed the gate clean and would have leaked on the next sync.
 *
 * This guard fails if the scope-hole ever reopens:
 *   1. Check 2's scan-dir loop MUST include `scripts` (recursive → subsumes hooks).
 *   2. The layer-2 sync guard `scripts/lib/home-path-guard.sh` MUST exist and be
 *      deny-list-independent (refuses any non-placeholder /Users/<name>).
 *   3. `sync-public.sh` (internal repo only) MUST source + invoke that guard on the
 *      staged tree before committing.
 *   4. The guard MUST carry no operator identity of its own (it syncs public).
 *
 * Behavioral parity check: massu-generalization-scanner.sh Check 2 is the
 * pre-commit-time enforcement; this is the npm-test-time enforcement.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../../..');

const SCANNER = resolve(REPO_ROOT, 'scripts/massu-generalization-scanner.sh');
const GUARD = resolve(REPO_ROOT, 'scripts/lib/home-path-guard.sh');
const SYNC = resolve(REPO_ROOT, 'scripts/sync-public.sh');

// G-1 (plan-2026-07-26-anti-vacuity-9-unproven-gates) - ADJUDICATED
// environment-conditional: `scripts/` is not in PUBLIC_DIRS, so neither the guard nor
// sync-public.sh exists in the public mirror. Gated at collection time -> vitest
// reports SKIPPED. These three used to `return`, reporting PASSED in the one tree
// where the guard they assert about is absent.
const HAS_SYNC = existsSync(SYNC);
const HAS_GUARD = existsSync(GUARD);

/** Extract Check 2's `for dir in ...; do` scan-dir list from the scanner source. */
function check2ScanDirs(src: string): string[] {
  // Anchor on the Check 2 echo, then find the next `for dir in ... ; do`.
  const idx = src.indexOf('Check 2: No hardcoded /Users/ paths in source');
  expect(idx, 'Check 2 heading must exist').toBeGreaterThan(-1);
  const after = src.slice(idx);
  const m = after.match(/for dir in ([^;]+); do/);
  expect(m, 'Check 2 must have a `for dir in ...; do` scan loop').not.toBeNull();
  return m![1].trim().split(/\s+/);
}

describe('generalization scanner scripts/ scope (CR-62 drift-guard)', () => {
  it('scanner file exists', () => {
    expect(existsSync(SCANNER)).toBe(true);
  });

  it('Check 2 scans all of scripts/ (recursive), not just scripts/hooks', () => {
    const src = readFileSync(SCANNER, 'utf-8');
    const dirs = check2ScanDirs(src);
    // `scripts` (top-level, recursive) must be present — this is the fix.
    expect(dirs).toContain('scripts');
    // The narrow `scripts/hooks` must NOT be the only scripts coverage: if it
    // appears, `scripts` must too (recursive subsumes it). Assert the hole is closed.
    expect(dirs.includes('scripts')).toBe(true);
  });

  it('layer-2 home-path guard exists and is deny-list-independent', () => {
    expect(existsSync(GUARD)).toBe(true);
    const g = readFileSync(GUARD, 'utf-8');
    expect(g).toMatch(/home_path_guard\s*\(\)/);
    // Inverted-allowlist design: it enumerates placeholders, not private names.
    expect(g).toMatch(/HOME_PATH_PLACEHOLDERS_DEFAULT/);
    expect(g).toMatch(/\/Users\/\[A-Za-z0-9_\]/); // the /Users/<name> detection regex
  });

  it('the guard carries no operator identity (it syncs public)', () => {
    const g = readFileSync(GUARD, 'utf-8');
    // Generic assertion: no `/Users/<concrete-name>` except angle-bracket
    // placeholders and the regex char-class. Any `/Users/<name>` that is not
    // `<...>` or a bracket class is a real name and must not be here.
    const bad = [...g.matchAll(/\/Users\/([A-Za-z0-9_][A-Za-z0-9._-]*)/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'A-Za-z0-9_'); // the regex class fragment
    expect(bad, `guard must not embed concrete usernames: ${bad.join(', ')}`).toHaveLength(0);
  });

  it.skipIf(!HAS_SYNC)('sync-public.sh sources and invokes the guard before committing (internal repo)', () => {
    const s = readFileSync(SYNC, 'utf-8');
    expect(s).toMatch(/home-path-guard\.sh/);
    expect(s).toMatch(/home_path_guard\s+"\$PUBLIC_REPO"/);
    // Must run AFTER staging (git add -A) so it scans the exact publication set.
    const addIdx = s.indexOf('git add -A');
    const guardIdx = s.indexOf('home_path_guard "$PUBLIC_REPO"');
    expect(addIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(addIdx);
  });

  it.skipIf(!HAS_GUARD)('guard behaviorally refuses a real home path but passes placeholders', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'hpg-drift-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      writeFileSync(resolve(dir, 'clean.txt'), 'ex: /Users/foo/p and /Users/<user>/x\n');
      git(['add', '-A']);
      git(['commit', '-qm', 'init']);

      // Placeholder-only tree passes.
      const pass = execFileSync('bash', [GUARD, dir], { stdio: 'pipe' });
      expect(pass).toBeDefined();

      // A second operator identity (not in any $HOME-derived deny-list) is refused.
      // Path built by concatenation so THIS test file (which syncs public) carries no
      // literal `/Users/<name>`; `zeta9` is a synthetic non-placeholder, non-operator name.
      writeFileSync(resolve(dir, 'bad.txt'), 'leak: ' + '/Users/' + 'zeta9' + '/secret\n');
      git(['add', '-A']);
      let refused = false;
      try {
        execFileSync('bash', [GUARD, dir], { stdio: 'pipe' });
      } catch {
        refused = true;
      }
      expect(refused, 'guard must exit non-zero on a real /Users/<name>').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!HAS_GUARD)('guard refuses when SOURCED under a hostile IFS (sync-public.sh call path)', () => {
    // Regression lock: sync-public.sh SOURCES the guard. If the placeholder
    // alternation were built with unquoted word-splitting, a non-default IFS in
    // the sourcing shell would collapse it to one literal and every real home
    // path would pass — a vacuous guard that is green in standalone tests.
    const dir = mkdtempSync(resolve(tmpdir(), 'hpg-ifs-'));
    try {
      const git = (args: string[]) =>
        execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
      git(['init', '-q']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      writeFileSync(resolve(dir, 'clean.txt'), 'ok: /Users/foo/x and /Users/dev/y\n');
      git(['add', '-A']);
      git(['commit', '-qm', 'init']);

      // Source under a hostile IFS, then assert placeholders still PASS.
      const sourcedClean = `IFS=':'; . '${GUARD}'; home_path_guard '${dir}'`;
      expect(() => execFileSync('bash', ['-c', sourcedClean], { stdio: 'pipe' })).not.toThrow();

      // And a real second-identity path still REFUSES under the same hostile IFS.
      // Path built by concatenation so THIS test file (which syncs public) carries no
      // literal `/Users/<name>`; `zeta9` is a synthetic non-placeholder, non-operator name.
      writeFileSync(resolve(dir, 'bad.txt'), 'leak: ' + '/Users/' + 'zeta9' + '/secret\n');
      git(['add', '-A']);
      let refused = false;
      try {
        execFileSync('bash', ['-c', sourcedClean], { stdio: 'pipe' });
      } catch {
        refused = true;
      }
      expect(refused, 'sourced guard must refuse a real home path regardless of IFS').toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
