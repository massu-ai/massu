// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// Drift-guard: EVERY publishable package must chain npm-publish-guard.sh (P2-3,
// plan-2026-07-24-publication-boundary-hardening).
//
// Measured before the fix: of five package.json files, one is private and four
// publish, and only packages/core chained the guard. The other three -- types,
// adapter-rails, adapter-spring -- published to the registry with no tarball
// scan at all. @massu/types also ships src/**, so the unscanned surface was not
// hypothetical.
//
// The candidate set is DISCOVERED by globbing, never listed here. A test that
// enumerates the packages it checks cannot fail when a fifth package appears,
// which is the exact drift this guard exists to catch.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { globSync } from 'fs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const inInternalRepo = existsSync(join(repoRoot, 'scripts', 'npm-publish-guard.sh'));

const GUARD_REF = 'npm-publish-guard.sh';

/** Discover every package.json in the workspace, root included. */
function discoverPackageJsons(root: string): string[] {
  const found = globSync('packages/*/package.json', { cwd: root });
  return ['package.json', ...found.sort()];
}

interface PkgInfo {
  path: string;
  private: boolean;
  prepublishOnly: string;
}

function readPkg(root: string, rel: string): PkgInfo {
  const d = JSON.parse(readFileSync(join(root, rel), 'utf8'));
  return {
    path: rel,
    private: d.private === true,
    prepublishOnly: d.scripts?.prepublishOnly ?? '',
  };
}

describe('P2-3: every publishable package chains the npm publication gate', () => {
  it.skipIf(!inInternalRepo)('discovers a NON-EMPTY candidate set', () => {
    const pkgs = discoverPackageJsons(repoRoot);
    // Absence is never a pass: a glob that silently matched nothing would make
    // every assertion below vacuously true.
    expect(pkgs.length, 'no package.json discovered — the glob is broken').toBeGreaterThan(1);
    const publishable = pkgs.map((p) => readPkg(repoRoot, p)).filter((p) => !p.private);
    expect(publishable.length, 'no publishable package discovered').toBeGreaterThan(0);
  });

  it.skipIf(!inInternalRepo)('every non-private package.json chains the guard', () => {
    const offenders = discoverPackageJsons(repoRoot)
      .map((p) => readPkg(repoRoot, p))
      .filter((p) => !p.private)
      .filter((p) => !p.prepublishOnly.includes(GUARD_REF))
      .map((p) => `${p.path} (prepublishOnly: ${JSON.stringify(p.prepublishOnly)})`);

    expect(
      offenders,
      `these packages publish to npm WITHOUT the tarball scan:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it.skipIf(!inInternalRepo)('the guard is CHAINED, never replacing an existing prepublishOnly', () => {
    // packages/core's prepublishOnly bundles four public keys, copies the
    // CHANGELOG and builds. A future edit that *replaces* rather than appends
    // would silently drop all of that while looking like hardening.
    const core = readPkg(repoRoot, 'packages/core/package.json');
    expect(core.prepublishOnly).toContain(GUARD_REF);
    expect(core.prepublishOnly).toContain('npm run build');
    expect(core.prepublishOnly.indexOf(GUARD_REF)).toBeGreaterThan(
      core.prepublishOnly.indexOf('npm run build'),
    );
    // types copies the LICENSE in; that must survive too.
    const types = readPkg(repoRoot, 'packages/types/package.json');
    expect(types.prepublishOnly).toContain('LICENSE');
    expect(types.prepublishOnly).toContain(GUARD_REF);
  });

  // ANTI-VACUITY. The plan's stated acceptance: add a fifth publishable package
  // without the guard -> RED. Asserted by running the real detection logic over
  // a scratch workspace, so this proves the CHECK discriminates rather than
  // proving the current tree happens to be clean.
  it.skipIf(!inInternalRepo)('goes RED when a fifth publishable package omits the guard', () => {
    const dir = mkdtempSync(join(repoRoot, '..', 'p23-scratch-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true }, null, 2));
      mkdirSync(join(dir, 'packages', 'newthing'), { recursive: true });
      writeFileSync(
        join(dir, 'packages', 'newthing', 'package.json'),
        JSON.stringify({ name: '@massu/newthing', scripts: { prepublishOnly: 'npm run build' } }, null, 2),
      );

      const offenders = discoverPackageJsons(dir)
        .map((p) => readPkg(dir, p))
        .filter((p) => !p.private)
        .filter((p) => !p.prepublishOnly.includes(GUARD_REF))
        .map((p) => p.path);

      expect(
        offenders,
        'the check did NOT flag an unguarded publishable package — it cannot discriminate',
      ).toContain(join('packages', 'newthing', 'package.json'));

      // And the positive direction: chaining it clears the finding.
      writeFileSync(
        join(dir, 'packages', 'newthing', 'package.json'),
        JSON.stringify(
          { name: '@massu/newthing', scripts: { prepublishOnly: `npm run build && bash ../../scripts/${GUARD_REF} "$PWD"` } },
          null,
          2,
        ),
      );
      const after = discoverPackageJsons(dir)
        .map((p) => readPkg(dir, p))
        .filter((p) => !p.private)
        .filter((p) => !p.prepublishOnly.includes(GUARD_REF));
      expect(after, 'chaining the guard did not clear the finding').toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
