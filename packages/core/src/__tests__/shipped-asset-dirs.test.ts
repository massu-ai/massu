// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Every directory the installer READS at runtime must be a directory npm SHIPS.
 *
 * ⛔ WHY THIS EXISTS. P4.3b added `packages/core/fragments/`, and `package.json`'s `files`
 * array did not list it. Nothing failed: `resolveAssetDir('fragments')` would simply return
 * null in an installed package, every `{{> name}}` would resolve to its "no fragment for
 * this stack" diagnostic, and the customer would receive a comment where their checklist
 * should be. Locally it worked perfectly, because locally the directory is right there.
 *
 * That is the blind-gate shape wearing a packaging manifest: the failure appears only in the
 * published artifact, and it appears as *slightly wrong content* rather than as an error.
 *
 * ⛔ AND THE POPULATION IS DERIVED, NOT LISTED. A hand-maintained roster here would need
 * editing every time an asset directory is added — the same forgetting that caused the
 * defect. The candidate set comes from what the installer actually reads (`ASSET_TYPES`
 * plus `fragments`), so a new asset directory is covered on its first commit (G32).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

const CORE = resolve(__dirname, '../..');
const PKG = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf-8')) as {
  files: string[];
};

/**
 * Directories the installer reads. Derived from the source rather than retyped: ASSET_TYPES
 * is the installer's own roster, and `fragments` is the one directory resolved by name.
 */
function installerDirs(): string[] {
  const src = readFileSync(join(CORE, 'src/commands/install-commands.ts'), 'utf-8');
  const block = src.slice(src.indexOf('const ASSET_TYPES = ['), src.indexOf('] as const;'));
  const names = [...block.matchAll(/name:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  const fragSrc = readFileSync(join(CORE, 'src/commands/fragments.ts'), 'utf-8');
  for (const m of fragSrc.matchAll(/resolveAssetDir\('([a-z-]+)'\)/g)) names.push(m[1]);
  return [...new Set(names)];
}

describe('every asset directory the installer reads is published', () => {
  const dirs = installerDirs();

  it('the derived population is non-empty and includes the known types (M1)', () => {
    // A zero denominator would make the assertion below vacuous, and "0 dirs, 0 missing"
    // is exactly what a broken derivation returns.
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).toContain('commands');
    expect(dirs).toContain('fragments');
  });

  it.each(installerDirs())('%s is listed in package.json files', (dir) => {
    const listed = PKG.files.some(
      (f) => f === dir || f.startsWith(`${dir}/`) || f === `${dir}/**/*`,
    );
    expect(
      listed,
      `packages/core/${dir}/ is read by the installer but npm would not ship it — ` +
        `an installed package resolves it to null and silently degrades`,
    ).toBe(true);
  });

  it.each(installerDirs())('%s exists on disk', (dir) => {
    expect(existsSync(join(CORE, dir)), `packages/core/${dir}/ is declared but absent`).toBe(true);
  });

  it('fragments/ is non-empty — an empty one degrades every include silently', () => {
    const files = readdirSync(join(CORE, 'fragments')).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
  });
});
