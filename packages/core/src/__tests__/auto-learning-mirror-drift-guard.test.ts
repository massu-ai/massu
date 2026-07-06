// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-E-008: byte-equivalence drift
// guard between the canonical auto-learning.md (under `.claude/...`) and
// its public-sync mirror (under `packages/core/commands/...`).
//
// Pre-fix cleanup: the sibling `loop-controller.md` has a 78-line
// preexisting drift that does NOT belong to this plan. This test is
// scoped to `auto-learning.md` ONLY; closing the loop-controller drift
// is filed as a separate follow-up plan per CR-46 #4 (close via
// follow-up plan, NOT sibling-defer release valve).

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveRepoRoot(): string {
  // Anchor on this test file's own location: packages/core/src/__tests__/ →
  // four levels up is the repo root. Independent of process.cwd() — works
  // both in `cd packages/core && npm test` AND in the pre-commit gate's
  // scratch-dir scenario where cwd differs.
  return join(__dirname, '..', '..', '..', '..');
}

function fileExistsRelative(relPath: string): boolean {
  return existsSync(join(resolveRepoRoot(), relPath));
}

const canonical = '.claude/commands/massu-loop/references/auto-learning.md';
const mirror = 'packages/core/commands/massu-loop/references/auto-learning.md';

// In the public-sync mirror repo, the `.claude/` canonical is legitimately
// absent — sync-public.sh / the leak-guard sandbox excludes internal `.claude/`
// infrastructure from the published package. This byte-equivalence drift-guard
// only has meaning where BOTH the canonical and its mirror coexist (the internal
// repo); in the public mirror there is no canonical to drift from, so the suite
// is vacuous and skips. Mirrors the graceful-absence pattern in
// loop-multi-perspective-enforcement.test.ts (readScoreEntries).
const canonicalExists = fileExistsRelative(canonical);

describe.skipIf(!canonicalExists)('auto-learning.md mirror byte-equivalence (P-E-008)', () => {
  it('canonical file exists', () => {
    expect(fileExistsRelative(canonical)).toBe(true);
  });

  it('mirror file exists', () => {
    expect(fileExistsRelative(mirror)).toBe(true);
  });

  it('canonical and mirror are byte-equivalent', () => {
    const repoRoot = resolveRepoRoot();
    const canonicalBytes = readFileSync(join(repoRoot, canonical), 'utf-8');
    const mirrorBytes = readFileSync(join(repoRoot, mirror), 'utf-8');

    if (canonicalBytes !== mirrorBytes) {
      const aLines = canonicalBytes.split('\n');
      const bLines = mirrorBytes.split('\n');
      const firstMismatch = aLines.findIndex((line, idx) => line !== bLines[idx]);
      // eslint-disable-next-line no-console
      console.error(`auto-learning.md drift at line ${firstMismatch + 1}:`);
      // eslint-disable-next-line no-console
      console.error(`  canonical: ${aLines[firstMismatch] ?? '(EOF)'}`);
      // eslint-disable-next-line no-console
      console.error(`  mirror:    ${bLines[firstMismatch] ?? '(EOF)'}`);
    }
    expect(mirrorBytes).toBe(canonicalBytes);
  });

  it('canonical file contains the v0.2 idempotency amendment marker', () => {
    const repoRoot = resolveRepoRoot();
    const text = readFileSync(join(repoRoot, canonical), 'utf-8');
    expect(text).toContain('encodeMemoryDirName');
    expect(text).toContain('prompt_hash:');
  });
});

// plan-loop-controller-mirror-drift-closure (P-A-003): the sibling
// loop-controller.md pair had a 78-line preexisting drift, reconciled here. This
// block extends the same byte-equivalence guard to that pair so the drift class
// is structurally impossible for BOTH command-reference mirrors. Same
// graceful-absence skip as above (canonical absent in the public mirror).
const loopControllerCanonical = '.claude/commands/massu-loop/references/loop-controller.md';
const loopControllerMirror = 'packages/core/commands/massu-loop/references/loop-controller.md';

describe.skipIf(!fileExistsRelative(loopControllerCanonical))('loop-controller.md mirror byte-equivalence (plan-loop-controller-mirror-drift-closure)', () => {
  it('canonical file exists', () => {
    expect(fileExistsRelative(loopControllerCanonical)).toBe(true);
  });

  it('mirror file exists', () => {
    expect(fileExistsRelative(loopControllerMirror)).toBe(true);
  });

  it('canonical and mirror are byte-equivalent', () => {
    const repoRoot = resolveRepoRoot();
    const canonicalBytes = readFileSync(join(repoRoot, loopControllerCanonical), 'utf-8');
    const mirrorBytes = readFileSync(join(repoRoot, loopControllerMirror), 'utf-8');

    if (canonicalBytes !== mirrorBytes) {
      const aLines = canonicalBytes.split('\n');
      const bLines = mirrorBytes.split('\n');
      const firstMismatch = aLines.findIndex((line, idx) => line !== bLines[idx]);
      // eslint-disable-next-line no-console
      console.error(`loop-controller.md drift at line ${firstMismatch + 1}:`);
      // eslint-disable-next-line no-console
      console.error(`  canonical: ${aLines[firstMismatch] ?? '(EOF)'}`);
      // eslint-disable-next-line no-console
      console.error(`  mirror:    ${bLines[firstMismatch] ?? '(EOF)'}`);
    }
    expect(mirrorBytes).toBe(canonicalBytes);
  });
});
