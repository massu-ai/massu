// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * A package that copies the root CHANGELOG.md into itself at publish time must already
 * carry an identical, committed copy.
 *
 * Why: `prepublishOnly` runs `cp ../../CHANGELOG.md ./CHANGELOG.md`, and the copy is a
 * TRACKED file. When a release commit updates the root changelog but not the copy, the
 * publish rewrites the tracked file, so the tree is dirty after the tag. The fix then
 * has to land AFTER the tag, the public sync runs from that later commit, and the
 * public mirror gets no release tag (the tagger only tags an exact release sync).
 * This happened at 2.5.8 and again at 2.5.9. Failing here puts the copy back in the
 * release commit, before the tag.
 *
 * The candidate set is DERIVED from the producers: every workspace package.json script
 * containing a `cp <…>/CHANGELOG.md <target>` that resolves to the root changelog.
 * A package that adds that copy step is covered the first time it does.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const ROOT_CHANGELOG = resolve(REPO_ROOT, 'CHANGELOG.md');

interface CopySite {
  pkgJson: string;
  script: string;
  target: string;
}

/** Every `cp <src> <dst>` in a package's scripts whose src is the root CHANGELOG.md. */
function findChangelogCopies(repoRoot: string): { scanned: number; sites: CopySite[] } {
  const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as {
    workspaces?: string[];
  };
  const patterns = (rootPkg.workspaces ?? []).map((w) => `${w}/package.json`);
  const pkgFiles = patterns.flatMap((p) => globSync(p, { cwd: repoRoot })).sort();
  const rootChangelog = resolve(repoRoot, 'CHANGELOG.md');
  const sites: CopySite[] = [];
  const cpRe = /\bcp\s+(?:-[a-zA-Z]+\s+)*(\S+)\s+(\S+)/g;
  for (const rel of pkgFiles) {
    const abs = resolve(repoRoot, rel);
    const pkg = JSON.parse(readFileSync(abs, 'utf-8')) as { scripts?: Record<string, string> };
    for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
      for (const m of body.matchAll(cpRe)) {
        const src = resolve(dirname(abs), m[1]);
        if (src !== rootChangelog) continue;
        let dst = resolve(dirname(abs), m[2]);
        if (!dst.endsWith('CHANGELOG.md')) dst = resolve(dst, 'CHANGELOG.md');
        sites.push({ pkgJson: rel, script: name, target: dst });
      }
    }
  }
  return { scanned: pkgFiles.length, sites };
}

describe('a package changelog copied in at publish time is committed identical to the root', () => {
  const { scanned, sites } = findChangelogCopies(REPO_ROOT);

  it('looked: workspace package.json files were read and the core copy step was found', () => {
    expect(scanned, 'read 0 workspace package.json files — cannot judge').toBeGreaterThan(0);
    // packages/core is the published package that copies the changelog; if the step
    // disappears or the parser stops seeing it, this guard would pass on nothing.
    expect(
      sites.map((s) => s.pkgJson),
      'no `cp …/CHANGELOG.md` step found in packages/core/package.json',
    ).toContain('packages/core/package.json');
  });

  it('every copy target exists and is byte-identical to the root CHANGELOG.md', () => {
    const root = readFileSync(ROOT_CHANGELOG, 'utf-8');
    for (const s of sites) {
      expect(existsSync(s.target), `${s.pkgJson} "${s.script}" copies to ${s.target}, which is not committed`).toBe(true);
      expect(
        readFileSync(s.target, 'utf-8') === root,
        `${s.target} differs from CHANGELOG.md. ${s.pkgJson} "${s.script}" will rewrite it at publish ` +
          'and leave the tree dirty after the tag. Run: cp CHANGELOG.md ' +
          `${s.target.slice(REPO_ROOT.length + 1)} and commit it with the release.`,
      ).toBe(true);
    }
  });
});
