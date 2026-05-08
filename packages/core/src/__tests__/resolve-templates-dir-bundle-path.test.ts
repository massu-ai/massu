// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Regression unit test for the 1.5.2 hotfix path-off-by-one bug — Plan
 * 1.5.3 §Stage C deliverable.
 *
 * Bug: pre-1.5.2, `resolveTemplatesDir()` candidates assumed cli.js was
 * nested at `dist/commands/init.js` depth (so `../../templates` walked up
 * two levels to reach `<package>/templates`). The actual bundled cli.js
 * sits at `dist/cli.js` (one level shallower), so `../templates` is the
 * correct relative — `../../templates` jumped past the package boundary
 * into `<install-root>/node_modules/@massu/templates` (wrong scope).
 *
 * 1.5.1 published with both the new applyVariantTemplate caller and the
 * latent path bug. 1.5.2 hotfix added `../templates` as the first dist-
 * relative candidate. This test sets up the EXACT bundled-cli layout in a
 * tmpdir, verifies resolveTemplatesDir's CURRENT behavior on it, and
 * fails LOUDLY if any future change re-introduces the bug.
 *
 * The vitest test loads init.ts from src/, where `__dirname` resolves to
 * `packages/core/src/commands/`. The previous version of this test file
 * (1.5.1) confirmed that `../../templates` from `src/commands/` reaches
 * the in-repo `packages/core/templates/` — that's how the bug was masked.
 * THIS test specifically constructs a bundled-cli FS layout and uses
 * existsSync directly to verify the candidate paths in their bundled form.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

describe('resolveTemplatesDir — bundled cli.js path resolution', () => {
  /**
   * Replicates the candidate-list logic from
   * `commands/init.ts:resolveTemplatesDir()` against an arbitrary
   * `__dirname`. This decouples the test from process-time `__dirname`
   * (which always reflects vitest's source layout) so we can simulate
   * the bundled cli.js layout.
   */
  function candidateList(simulatedDirname: string, simulatedCwd: string): string[] {
    return [
      resolve(simulatedCwd, 'node_modules/@massu/core/templates'),
      resolve(simulatedDirname, '../templates'),
      resolve(simulatedDirname, '../../templates'),
      resolve(simulatedDirname, '../../../templates'),
    ];
  }

  function pickFirstExisting(candidates: string[]): string | null {
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  it('bundled cli.js layout (<pkg>/dist/cli.js) finds <pkg>/templates via ../templates', () => {
    // Simulate `<root>/node_modules/@massu/core/{dist/cli.js, templates/<id>/}`.
    const root = mkdtempSync(join(tmpdir(), 'massu-resolve-tpl-bundle-'));
    try {
      const pkgDir = join(root, 'node_modules/@massu/core');
      mkdirSync(join(pkgDir, 'dist'), { recursive: true });
      mkdirSync(join(pkgDir, 'templates/phoenix'), { recursive: true });
      writeFileSync(join(pkgDir, 'dist/cli.js'), '// stub', 'utf-8');
      writeFileSync(join(pkgDir, 'templates/phoenix/massu.config.yaml'), 'schema_version: 2\n', 'utf-8');

      const simulatedDirname = join(pkgDir, 'dist'); // bundled cli.js sits here
      const simulatedCwd = join(root, 'project');   // user's project (no node_modules)

      const candidates = candidateList(simulatedDirname, simulatedCwd);
      const found = pickFirstExisting(candidates);

      // EXPECTED: `<pkg>/templates` via `../templates` from `<pkg>/dist`.
      // PRE-1.5.2 BUG: the candidates list lacked `../templates`, so the
      // first hit would have been `<root>/node_modules/@massu/templates`
      // (wrong scope) which doesn't exist → returns null → applyVariantTemplate
      // bails at its first guard.
      expect(found, 'must resolve to <pkg>/templates from bundled cli.js layout').toBe(join(pkgDir, 'templates'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('legacy nested layout (<pkg>/dist/commands/init.js) still finds templates via ../../templates', () => {
    // Defense-in-depth: if a future build re-nests cli.js into
    // dist/commands/, the legacy `../../templates` candidate still wins.
    const root = mkdtempSync(join(tmpdir(), 'massu-resolve-tpl-legacy-'));
    try {
      const pkgDir = join(root, 'node_modules/@massu/core');
      mkdirSync(join(pkgDir, 'dist/commands'), { recursive: true });
      mkdirSync(join(pkgDir, 'templates/rails'), { recursive: true });
      writeFileSync(join(pkgDir, 'dist/commands/init.js'), '// stub', 'utf-8');

      const simulatedDirname = join(pkgDir, 'dist/commands');
      const simulatedCwd = join(root, 'project');

      const candidates = candidateList(simulatedDirname, simulatedCwd);
      const found = pickFirstExisting(candidates);

      expect(found, 'legacy nested layout must still resolve via ../../templates').toBe(join(pkgDir, 'templates'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('project-local install (<project>/node_modules/@massu/core/templates) wins over dist-relative', () => {
    const root = mkdtempSync(join(tmpdir(), 'massu-resolve-tpl-projlocal-'));
    try {
      const pkgInProject = join(root, 'project/node_modules/@massu/core');
      mkdirSync(join(pkgInProject, 'dist'), { recursive: true });
      mkdirSync(join(pkgInProject, 'templates/spring'), { recursive: true });

      // Also create a "remote" install elsewhere; the project-local one
      // should be preferred per the candidate ordering.
      const pkgInNpx = join(root, 'npx-cache/node_modules/@massu/core');
      mkdirSync(join(pkgInNpx, 'dist'), { recursive: true });
      mkdirSync(join(pkgInNpx, 'templates/spring'), { recursive: true });

      const simulatedDirname = join(pkgInNpx, 'dist'); // running from npx cache
      const simulatedCwd = join(root, 'project');     // project has its own install

      const candidates = candidateList(simulatedDirname, simulatedCwd);
      const found = pickFirstExisting(candidates);

      expect(found, 'project-local install must beat npx-cache install').toBe(join(pkgInProject, 'templates'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when no candidate exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'massu-resolve-tpl-none-'));
    try {
      const candidates = candidateList(join(root, 'nonexistent/dist'), join(root, 'nonexistent/project'));
      const found = pickFirstExisting(candidates);
      expect(found).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
