// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * THE FAIL-OPEN: two consecutive installs destroy a customized command file.
 *
 * The operator's binding rule (2026-07-13 / 2026-07-14):
 *   "never delete YOUR customizations; upstream may change its own content"
 *
 * THE BUG
 * -------
 * When the installer meets a command file that exists on disk but has NO manifest entry, it
 * cannot know whether massu wrote it or a human did. It correctly KEEPS the file — and then
 * records THE FILE'S OWN HASH into the manifest:
 *
 *     manifest.entries[manifestKey] = existingHash;   // the hash of a file it did NOT write
 *
 * The manifest is supposed to mean "this is the hash of what massu installed". That line writes a
 * LIE into it. On the NEXT run the safe-upgrade branch reads the lie back:
 *
 *     existingHash === lastInstalledHash  &&  sourceHash differs   ->   overwrite
 *
 * ...concludes the file is untouched since massu wrote it, and DESTROYS the customization.
 *
 * RUN 1 ARMS IT. RUN 2 DETONATES IT. Measured with the real installer on a scratch copy of a real
 * repo: run 1 reported "36 kept (local edits)", run 2 reported "36 updated" — 36 files of local
 * work gone. One real repo's manifest was ALREADY in the armed state.
 *
 * It is a FAIL-OPEN in a branch whose own comment says it is handling AMBIGUITY. Facing "I don't
 * know who wrote this", the installer chose the destructive answer. The correct response to not
 * knowing is to record NOTHING — so the ambiguity is re-detected on every run and the file is kept
 * on every run, forever, idempotently.
 *
 * The consequence is deliberate: a customized file with no provenance FREEZES. Safe, but stale.
 * Upstream changes reach it only via an explicit merge (a separate feature) or an explicit
 * `rm <file> && massu install-commands`. Between "stale" and "your work is silently deleted", the
 * operator's rule chooses stale.
 *
 * WHY syncDirectory AND NOT installCommands: `installCommands` locates its own source tree via
 * `resolveAssetDir`, which — running from source rather than dist — resolves `__dirname/../commands`
 * back onto `src/commands` (the TypeScript dir, zero .md files) and installs nothing. A test built
 * on it goes red for the wrong reason, which proves nothing. `syncDirectory` is the exported unit
 * that actually contains the fail-open, and it takes an explicit sourceDir, so the fixture is real.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { syncDirectory, hashContent, type Manifest } from '../commands/install-commands.ts';
import type { Config } from '../config.ts';

const createdDirs: string[] = [];
afterEach(() => {
  while (createdDirs.length) {
    const d = createdDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `massu-failopen-${prefix}-`));
  createdDirs.push(d);
  return d;
}

const FRAMEWORK: Config['framework'] = {
  type: 'typescript', router: 'none', orm: 'none', ui: 'none',
};

function emptyManifest(): Manifest {
  return { version: 1, generatedBy: '@massu/core@test', generatedAt: '2026-07-14T00:00:00Z', entries: {} };
}

const UPSTREAM_V1 = '# Commit\n\nStep one.\n';
const UPSTREAM_V2 = '# Commit\n\nStep one.\nStep two (an upstream improvement).\n';
const CUSTOM_LINE = '## REPO-LOCAL: a customization the operator added.';

/** One install run: sourceDir -> targetDir, mutating the manifest exactly as production does. */
function install(sourceDir: string, targetDir: string, manifest: Manifest) {
  return syncDirectory(sourceDir, targetDir, FRAMEWORK, manifest, 'commands');
}

describe('THE FAIL-OPEN — an install must never destroy a local customization', () => {
  it('FAILOPEN-01: run 1 must NOT record a hash for a file massu did not write', () => {
    const src = mkTmp('src');
    const tgt = mkTmp('tgt');
    writeFileSync(resolve(src, 'massu-commit.md'), UPSTREAM_V2);

    // The operator's customized file is already on disk, with NO manifest entry.
    // This is the exact state of every repo that has commands but no manifest entry for them.
    const mine = `${UPSTREAM_V1}${CUSTOM_LINE}\n`;
    writeFileSync(resolve(tgt, 'massu-commit.md'), mine);

    const manifest = emptyManifest();
    const stats = install(src, tgt, manifest);

    // It keeps the file — that half was always correct.
    expect(stats.kept).toBe(1);
    expect(readFileSync(resolve(tgt, 'massu-commit.md'), 'utf-8')).toBe(mine);

    // THE BUG: it records the file's own hash, claiming massu authored it.
    expect(
      manifest.entries['commands/massu-commit.md'],
      'FAIL-OPEN: the installer recorded a hash for a file it did NOT write. On the next run it ' +
        'will read that back, believe the file is untouched, and overwrite it.',
    ).toBeUndefined();
  });

  it('FAILOPEN-02: TWO consecutive installs must not destroy the customization (run 1 arms, run 2 detonates)', () => {
    const src = mkTmp('src');
    const tgt = mkTmp('tgt');
    writeFileSync(resolve(src, 'massu-commit.md'), UPSTREAM_V2);

    const mine = `${UPSTREAM_V1}${CUSTOM_LINE}\n`;
    writeFileSync(resolve(tgt, 'massu-commit.md'), mine);

    const manifest = emptyManifest();
    install(src, tgt, manifest);                       // run 1 — arms it
    const afterRun1 = readFileSync(resolve(tgt, 'massu-commit.md'), 'utf-8');
    expect(afterRun1).toBe(mine);                      // still fine here

    install(src, tgt, manifest);                       // run 2 — detonates it

    expect(
      readFileSync(resolve(tgt, 'massu-commit.md'), 'utf-8'),
      'DESTRUCTION: the second install deleted the operator\'s customization.',
    ).toBe(mine);
  });

  it('FAILOPEN-03: the customization survives an UNBOUNDED number of installs (idempotent)', () => {
    const src = mkTmp('src');
    const tgt = mkTmp('tgt');
    writeFileSync(resolve(src, 'massu-commit.md'), UPSTREAM_V2);

    const mine = `${UPSTREAM_V1}${CUSTOM_LINE}\n`;
    writeFileSync(resolve(tgt, 'massu-commit.md'), mine);

    const manifest = emptyManifest();
    for (let i = 1; i <= 5; i++) {
      install(src, tgt, manifest);
      expect(
        readFileSync(resolve(tgt, 'massu-commit.md'), 'utf-8'),
        `customization destroyed on install #${i}`,
      ).toBe(mine);
    }
  });

  it('FAILOPEN-04: a file massu DID write is STILL upgraded — the fix must not freeze everything', () => {
    // The fix must not degenerate into "never update anything". Where the manifest is TRUTHFUL
    // (massu wrote the file, nobody touched it since), upstream's change must still land —
    // otherwise we have traded silent destruction for silent staleness, which is the mirror bug.
    const src = mkTmp('src');
    const tgt = mkTmp('tgt');
    writeFileSync(resolve(src, 'massu-commit.md'), UPSTREAM_V2);

    // massu installed V1 and nobody has touched it: the manifest entry is the truth.
    writeFileSync(resolve(tgt, 'massu-commit.md'), UPSTREAM_V1);
    const manifest = emptyManifest();
    manifest.entries['commands/massu-commit.md'] = hashContent(UPSTREAM_V1);

    const stats = install(src, tgt, manifest);

    expect(stats.updated).toBe(1);
    expect(
      readFileSync(resolve(tgt, 'massu-commit.md'), 'utf-8'),
      'the safe-upgrade path is DEAD: a file massu owns and nobody touched was not updated',
    ).toBe(UPSTREAM_V2);
    expect(manifest.entries['commands/massu-commit.md']).toBe(hashContent(UPSTREAM_V2));
  });

  it('FAILOPEN-05: a brand-new file is installed and honestly recorded', () => {
    // The happy path must survive the fix.
    const src = mkTmp('src');
    const tgt = mkTmp('tgt');
    writeFileSync(resolve(src, 'massu-commit.md'), UPSTREAM_V2);

    const manifest = emptyManifest();
    const stats = install(src, tgt, manifest);

    expect(stats.installed).toBe(1);
    expect(readFileSync(resolve(tgt, 'massu-commit.md'), 'utf-8')).toBe(UPSTREAM_V2);
    // Recording IS correct here — massu really did write these bytes.
    expect(manifest.entries['commands/massu-commit.md']).toBe(hashContent(UPSTREAM_V2));
  });

  it('FAILOPEN-06: a file already byte-identical to upstream is recorded (massu owns it)', () => {
    // Distinct from the ambiguity branch: if the file EQUALS upstream, massu can honestly claim
    // authorship — the bytes are its own. This branch must keep working.
    const src = mkTmp('src');
    const tgt = mkTmp('tgt');
    writeFileSync(resolve(src, 'massu-commit.md'), UPSTREAM_V2);
    writeFileSync(resolve(tgt, 'massu-commit.md'), UPSTREAM_V2);

    const manifest = emptyManifest();
    const stats = install(src, tgt, manifest);

    expect(stats.skipped).toBe(1);
    expect(manifest.entries['commands/massu-commit.md']).toBe(hashContent(UPSTREAM_V2));
  });

  it('FAILOPEN-07: subsequent installs never resurrect the lie (nested/subdir files too)', () => {
    // The fail-open lives in the shared file loop, so it applies to subdirectory files as well
    // (massu-golden-path/references/*.md — where consumers often hold much of their customization).
    const src = mkTmp('src');
    const tgt = mkTmp('tgt');
    mkdirSync(resolve(src, 'refs'), { recursive: true });
    mkdirSync(resolve(tgt, 'refs'), { recursive: true });
    writeFileSync(resolve(src, 'refs', 'phase-2.md'), UPSTREAM_V2);

    const mine = `${UPSTREAM_V1}${CUSTOM_LINE}\n`;
    writeFileSync(resolve(tgt, 'refs', 'phase-2.md'), mine);

    const manifest = emptyManifest();
    install(src, tgt, manifest);
    install(src, tgt, manifest);

    expect(
      readFileSync(resolve(tgt, 'refs', 'phase-2.md'), 'utf-8'),
      'a customized file in a SUBDIRECTORY was destroyed',
    ).toBe(mine);
  });
});
