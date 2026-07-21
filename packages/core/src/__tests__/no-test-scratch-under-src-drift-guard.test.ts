// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.
//
// DRIFT-GUARD: no test may create scratch (a dir/DB/file it writes) UNDER packages/core/src.
//
// THE BUG CLASS THIS CLOSES
// -------------------------
// A test that does `resolve(__dirname, '../<scratch>')` lands in packages/core/src and then
// mkdirs/writes/opens a DB there. Meanwhile OTHER tests recursively `readdirSync` + `statSync`
// + `readFileSync` all of src (the memory-dir single-resolver drift-guard walker; the v8
// coverage scan). When the two run in parallel — which vitest does by default — the walker
// collects a path the scratch test then deletes, and the later `readFileSync` throws ENOENT.
// The suite fails INTERMITTENTLY, and only under --coverage (more files, slower, wider race).
//
// This exact flake shipped on 2026-07-14 as "SUITE-FLAKE" and was reported CLOSED, but the fix
// only hardened the walker for ONE case; fourteen other tests still wrote scratch into src and
// resurfaced the flake on 2026-07-15 (this guard's origin). Memory:
// feedback_dashboard_key_ux_and_src_scratch_race. Fix: scratch lives under os.tmpdir(), and
// THIS GUARD makes the anti-pattern impossible to reintroduce.
//
// PRECISION (not a blind gate)
// ----------------------------
// The allowed set of one-level-up segments is DERIVED FROM THE FILESYSTEM: the real, committed
// entries directly under packages/core/src (feedback_drift_guard_filesystem_derived_over_static).
// A reference like `resolve(__dirname, '../detect/package-detector.ts')` points at a REAL source
// dir (`detect`) and is allowed; a reference like `resolve(__dirname, '../test-foo-tmp')` points
// at a segment that is NOT a real source entry — it can only be a runtime scratch target — and
// FAILS. `../../<x>` (climbing above src, into packages/core) is not this class and is ignored.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/core/src/__tests__
const SRC = join(HERE, '..'); // packages/core/src

// One-level-up ref: resolve(__dirname, '../SEG...') or join(__dirname, '../SEG...').
const ONE_UP = /(?:resolve|join)\(\s*__dirname\s*,\s*['"`]\.\.\/([^'"`]+)['"`]/g;

function realSrcEntries(): Set<string> {
  // FAIL CLOSED (M2): an unreadable src is an ERROR, never an empty allow-set that would let
  // every scratch ref through as "not-a-real-entry"... wait — an empty set makes EVERYTHING a
  // violation, which is loud, not silent. The real blind-gate risk is the DENOMINATOR: if we
  // scan zero test files we must not report "clean". That is asserted below.
  const entries = readdirSync(SRC);
  if (entries.length === 0) throw new Error(`blind-gate: packages/core/src looks empty (${SRC})`);
  return new Set(entries);
}

// This guard's OWN source necessarily contains the pattern it forbids — in its regex, its
// comments, and its failure message. It only READS files; it never writes scratch. Excluding
// it is the same self-reference carve-out the leak-guard uses (CONTENT_SCAN_SELF_REFERENCE_FILES).
// The mutation test plants its offender in a DIFFERENT file, so this exclusion does not blunt it.
const SELF = 'no-test-scratch-under-src-drift-guard.test.ts';

function scanForScratchRefs() {
  const real = realSrcEntries();
  const testDir = HERE;
  const files = readdirSync(testDir).filter((f) => f.endsWith('.ts') && f !== SELF);
  const violations: string[] = [];
  let scanned = 0;

  for (const f of files) {
    const full = join(testDir, f);
    // A file vanishing mid-scan is itself the race we forbid; treat an unreadable member as a
    // hard error (fail closed), never a silent skip.
    statSync(full);
    const txt = readFileSync(full, 'utf-8');
    scanned++;
    let m: RegExpExecArray | null;
    ONE_UP.lastIndex = 0;
    while ((m = ONE_UP.exec(txt)) !== null) {
      const seg = m[1].split('/')[0];
      if (seg === '..' || seg === '.') continue; // climbs above src — different class
      if (!real.has(seg)) {
        violations.push(`${f}: resolve(__dirname, '../${m[1]}') → packages/core/src/${seg} is NOT a real source entry (scratch under src)`);
      }
    }
  }
  return { scanned, fileCount: files.length, violations, realCount: real.size };
}

describe('no test writes scratch UNDER packages/core/src (flake drift-guard)', () => {
  const result = scanForScratchRefs();

  it('actually looked — non-zero denominator (blind-gate M1)', () => {
    // "Scanned 0, found 0" must be a LOUD FAILURE, never a pass.
    expect(result.fileCount).toBeGreaterThan(50);
    expect(result.scanned).toBe(result.fileCount);
    expect(result.realCount).toBeGreaterThan(20);
  });

  it('no test resolves a scratch target one level up into src/', () => {
    expect(
      result.violations,
      `Test scratch must live under os.tmpdir(), never packages/core/src (it races the src walker + coverage scan → intermittent ENOENT).\n` +
        `Change resolve(__dirname, '../<name>') to resolve(tmpdir(), \`massu-<name>-\${process.pid}\`).\n` +
        `Violations:\n  ${result.violations.join('\n  ')}`,
    ).toEqual([]);
  });
});
