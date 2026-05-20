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

describe('auto-learning.md mirror byte-equivalence (P-E-008)', () => {
  const canonical = '.claude/commands/massu-loop/references/auto-learning.md';
  const mirror = 'packages/core/commands/massu-loop/references/auto-learning.md';

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
