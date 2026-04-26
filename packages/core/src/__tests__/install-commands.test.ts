// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Phase 1 (variant resolution) + Phase 2 (manifest / local-edit protection)
 * tests for `install-commands.ts`. See plan
 * `/Users/ekoultra/hedge/docs/plans/2026-04-26-massu-stack-aware-command-templates.md`.
 *
 * Test naming: VARIANT-01..10 cover `pickVariant` and `syncDirectory` variant
 * resolution. MANIFEST-01..08 cover the 3-hash compare + first-install
 * heuristic + atomic manifest write + legacy `installCommands` manifest path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import {
  pickVariant,
  syncDirectory,
  loadManifest,
  saveManifest,
  hashContent,
  installCommands,
  type Manifest,
  type PickVariantResult,
} from '../commands/install-commands.ts';
import type { Config } from '../config.ts';
import { resetConfig } from '../config.ts';

// ============================================================
// Helpers
// ============================================================

const createdDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `massu-install-test-${prefix}-`));
  createdDirs.push(d);
  return d;
}

function cleanupAll(): void {
  while (createdDirs.length) {
    const d = createdDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function emptyFramework(overrides: Partial<Config['framework']> = {}): Config['framework'] {
  return {
    type: 'typescript',
    router: 'none',
    orm: 'none',
    ui: 'none',
    ...overrides,
  };
}

function emptyManifest(): Manifest {
  return {
    version: 1,
    generatedBy: '@massu/core@test',
    generatedAt: new Date().toISOString(),
    entries: {},
  };
}

afterEach(cleanupAll);

// ============================================================
// VARIANT-01..10
// ============================================================

describe('pickVariant — VARIANT-01..10', () => {
  it('VARIANT-01: pure-TS project with only `<base>.md` returns hit-empty-suffix', () => {
    const sourceDir = mkTmp('v01');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# router default');

    const fw = emptyFramework({ type: 'typescript' });
    const result: PickVariantResult = pickVariant('massu-scaffold-router', sourceDir, fw);

    expect(result).toEqual({ kind: 'hit', suffix: '' });
  });

  it('VARIANT-02: multi-stack with python declared AND `.python.md` exists → hit suffix `.python`', () => {
    const sourceDir = mkTmp('v02');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python.md'), '# python');

    const fw = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: {
        python: { framework: 'fastapi' },
      },
    });
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);

    expect(result).toEqual({ kind: 'hit', suffix: '.python' });
  });

  it('VARIANT-03: python declared but no `.python.md` on disk → falls back to default', () => {
    const sourceDir = mkTmp('v03');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');

    const fw = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: { python: { framework: 'fastapi' } },
    });
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);

    expect(result).toEqual({ kind: 'hit', suffix: '' });
  });

  it('VARIANT-04: top-level variant with no base sibling → file is filtered out by syncDirectory', () => {
    // The dot-skip filter at top level skips `<base>.<variant>.md`. Without a
    // matching base, the orphan variant is never copied.
    const sourceDir = mkTmp('v04');
    const targetDir = mkTmp('v04-target');
    writeFileSync(resolve(sourceDir, 'massu-orphan.python.md'), '# orphan python');

    const fw = emptyFramework({ type: 'typescript' });
    const stats = syncDirectory(sourceDir, targetDir, fw, emptyManifest(), '', true);

    expect(stats.installed).toBe(0);
    expect(existsSync(resolve(targetDir, 'massu-orphan.md'))).toBe(false);
    expect(existsSync(resolve(targetDir, 'massu-orphan.python.md'))).toBe(false);
  });

  it('VARIANT-05: two competing variants → first declared in framework.languages wins', () => {
    const sourceDir = mkTmp('v05');
    writeFileSync(resolve(sourceDir, 'massu-foo.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-foo.python.md'), '# python');
    writeFileSync(resolve(sourceDir, 'massu-foo.swift.md'), '# swift');

    // Hedge-shaped: python declared BEFORE swift in the languages block.
    const fw = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: {
        python: { framework: 'fastapi' },
        swift: { framework: 'swiftui' },
      },
    });
    const result = pickVariant('massu-foo', sourceDir, fw);

    // typescript primary is probed first but no `.typescript.md` exists →
    // python (first declared secondary) wins.
    expect(result).toEqual({ kind: 'hit', suffix: '.python' });
  });

  it('VARIANT-06: framework.primary === python with only `.md` → returns empty-suffix hit', () => {
    const sourceDir = mkTmp('v06');
    writeFileSync(resolve(sourceDir, 'massu-foo.md'), '# default');

    const fw = emptyFramework({ type: 'python', primary: 'python' });
    const result = pickVariant('massu-foo', sourceDir, fw);

    expect(result).toEqual({ kind: 'hit', suffix: '' });
  });

  it('VARIANT-07: special filename `_shared-preamble.md` survives both filters', () => {
    const sourceDir = mkTmp('v07');
    const targetDir = mkTmp('v07-target');
    writeFileSync(resolve(sourceDir, '_shared-preamble.md'), '# preamble');

    const fw = emptyFramework({ type: 'typescript' });
    const stats = syncDirectory(sourceDir, targetDir, fw, emptyManifest(), '', true);

    expect(stats.installed).toBe(1);
    expect(existsSync(resolve(targetDir, '_shared-preamble.md'))).toBe(true);
    expect(readFileSync(resolve(targetDir, '_shared-preamble.md'), 'utf-8'))
      .toBe('# preamble');
  });

  it('VARIANT-08: subdirectory recursion preserves all files, including dotted ones', () => {
    const sourceDir = mkTmp('v08');
    const subDir = resolve(sourceDir, 'sub');
    mkdirSync(subDir);
    writeFileSync(resolve(sourceDir, 'top.md'), '# top default');
    writeFileSync(resolve(subDir, 'foo.bar.md'), '# nested dotted');
    writeFileSync(resolve(subDir, 'plain.md'), '# nested plain');

    const targetDir = mkTmp('v08-target');
    const fw = emptyFramework({ type: 'typescript' });
    const stats = syncDirectory(sourceDir, targetDir, fw, emptyManifest(), '', true);

    expect(stats.installed).toBe(3);
    // Nested dotted file MUST survive — no variant filter at depth ≥ 1.
    expect(existsSync(resolve(targetDir, 'sub', 'foo.bar.md'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'sub', 'plain.md'))).toBe(true);
    expect(existsSync(resolve(targetDir, 'top.md'))).toBe(true);
  });

  it('VARIANT-09: framework.type=multi with primary undefined → fallback + stderr warning', () => {
    const sourceDir = mkTmp('v09');
    const targetDir = mkTmp('v09-target');
    writeFileSync(resolve(sourceDir, 'massu-foo.md'), '# default');

    const fw = emptyFramework({ type: 'multi', primary: undefined });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = pickVariant('massu-foo', sourceDir, fw);
      // pickVariant returns 'hit' here because the unsuffixed default DOES exist.
      // The fallback branch fires only when no candidate hits AND no default exists.
      expect(result).toEqual({ kind: 'hit', suffix: '' });

      // Now exercise the actual fallback case: no candidates AND no default file.
      const emptySource = mkTmp('v09-empty');
      stderrSpy.mockClear();
      const fallbackResult = pickVariant('massu-foo', emptySource, fw);
      expect(fallbackResult.kind).toBe('fallback');
      if (fallbackResult.kind === 'fallback') {
        expect(fallbackResult.reason).toBe('multi-without-primary');
      }
      // The stderr warning fires.
      expect(stderrSpy).toHaveBeenCalled();
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrText).toMatch(/framework\.primary is undefined/);

      // syncDirectory uses the fallback to copy the unsuffixed default IF it exists.
      // Here we DO have `<sourceDir>/massu-foo.md`, so the file IS copied.
      stderrSpy.mockClear();
      const stats = syncDirectory(sourceDir, targetDir, fw, emptyManifest(), '', true);
      expect(stats.installed).toBe(1);
      expect(existsSync(resolve(targetDir, 'massu-foo.md'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('VARIANT-10: passthrough-only language (framework.swift) participates in resolution', () => {
    const sourceDir = mkTmp('v10');
    // Only a `.swift.md` shipped — no `.typescript.md`, no default for this base.
    writeFileSync(resolve(sourceDir, 'massu-scaffold-page.swift.md'), '# swift');

    // Hedge-shaped: typescript primary; languages contains [typescript]; NO swift in languages.
    // Top-level passthrough `framework.swift = { framework: 'swiftui' }`.
    const fw = {
      type: 'multi',
      primary: 'typescript',
      router: 'none',
      orm: 'none',
      ui: 'none',
      languages: {
        typescript: { framework: 'next' },
      },
      // top-level passthrough block — preserved at runtime by zod .passthrough()
      swift: { framework: 'swiftui' },
    } as unknown as Config['framework'];

    const result = pickVariant('massu-scaffold-page', sourceDir, fw);
    // Probe order: .typescript (miss) → .swift (HIT via passthrough fallback).
    expect(result).toEqual({ kind: 'hit', suffix: '.swift' });
  });
});

// ============================================================
// MANIFEST-01..08
// ============================================================

describe('manifest — MANIFEST-01..08', () => {
  it('MANIFEST-01: first install on empty dir creates manifest with one entry', () => {
    const sourceDir = mkTmp('m01-src');
    const targetDir = mkTmp('m01-tgt');
    writeFileSync(resolve(sourceDir, 'cmd.md'), 'hello');

    const claudeDir = mkTmp('m01-claude');
    const fw = emptyFramework({ type: 'typescript' });

    const manifest = emptyManifest();
    const stats = syncDirectory(sourceDir, targetDir, fw, manifest, 'commands', true);
    saveManifest(claudeDir, manifest);

    expect(stats.installed).toBe(1);
    expect(stats.kept).toBe(0);

    const reloaded = loadManifest(claudeDir);
    expect(reloaded.entries['commands/cmd.md']).toBe(hashContent('hello'));
    expect(existsSync(resolve(claudeDir, '.massu', 'install-manifest.json'))).toBe(true);
  });

  it('MANIFEST-02: reinstall with no upstream change → skipped++, manifest unchanged', () => {
    const sourceDir = mkTmp('m02-src');
    const targetDir = mkTmp('m02-tgt');
    writeFileSync(resolve(sourceDir, 'cmd.md'), 'hello');

    const fw = emptyFramework({ type: 'typescript' });

    // First install
    const m1 = emptyManifest();
    syncDirectory(sourceDir, targetDir, fw, m1, 'commands', true);
    const before = m1.entries['commands/cmd.md'];

    // Second install (same source content)
    const m2: Manifest = {
      ...m1,
      entries: { ...m1.entries },
    };
    const stats = syncDirectory(sourceDir, targetDir, fw, m2, 'commands', true);

    expect(stats.skipped).toBe(1);
    expect(stats.installed).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.kept).toBe(0);
    expect(m2.entries['commands/cmd.md']).toBe(before);
  });

  it('MANIFEST-03: user edit preserved across reinstall, kept++, stderr warns', () => {
    const sourceDir = mkTmp('m03-src');
    const targetDir = mkTmp('m03-tgt');
    writeFileSync(resolve(sourceDir, 'cmd.md'), 'upstream-original');

    const fw = emptyFramework({ type: 'typescript' });

    // First install
    const manifest = emptyManifest();
    syncDirectory(sourceDir, targetDir, fw, manifest, 'commands', true);

    // User edits the file
    writeFileSync(resolve(targetDir, 'cmd.md'), 'user-edited');

    // Upstream changes too (so it isn't a no-op skip)
    writeFileSync(resolve(sourceDir, 'cmd.md'), 'upstream-v2');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const stats = syncDirectory(sourceDir, targetDir, fw, manifest, 'commands', true);
      expect(stats.kept).toBe(1);
      expect(stats.updated).toBe(0);

      // File on disk is the user's version, NOT upstream-v2
      expect(readFileSync(resolve(targetDir, 'cmd.md'), 'utf-8')).toBe('user-edited');

      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrText).toMatch(/kept your version/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('MANIFEST-04: user deleted file → reinstall recreates it, manifest hash = sourceHash', () => {
    const sourceDir = mkTmp('m04-src');
    const targetDir = mkTmp('m04-tgt');
    writeFileSync(resolve(sourceDir, 'cmd.md'), 'v1');

    const fw = emptyFramework({ type: 'typescript' });
    const manifest = emptyManifest();

    // Initial install
    syncDirectory(sourceDir, targetDir, fw, manifest, 'commands', true);
    const v1Hash = manifest.entries['commands/cmd.md'];
    expect(v1Hash).toBeDefined();

    // Upstream bumps
    writeFileSync(resolve(sourceDir, 'cmd.md'), 'v2');

    // User deletes target file
    rmSync(resolve(targetDir, 'cmd.md'));

    const stats = syncDirectory(sourceDir, targetDir, fw, manifest, 'commands', true);

    expect(stats.installed).toBe(1);
    expect(stats.kept).toBe(0);
    expect(readFileSync(resolve(targetDir, 'cmd.md'), 'utf-8')).toBe('v2');
    expect(manifest.entries['commands/cmd.md']).toBe(hashContent('v2'));
  });

  it('MANIFEST-05: upstream changes a non-edited file → updated++, manifest updated', () => {
    const sourceDir = mkTmp('m05-src');
    const targetDir = mkTmp('m05-tgt');
    writeFileSync(resolve(sourceDir, 'cmd.md'), 'v1');

    const fw = emptyFramework({ type: 'typescript' });
    const manifest = emptyManifest();

    syncDirectory(sourceDir, targetDir, fw, manifest, 'commands', true);

    // Upstream bump; user has not touched the file.
    writeFileSync(resolve(sourceDir, 'cmd.md'), 'v2');

    const stats = syncDirectory(sourceDir, targetDir, fw, manifest, 'commands', true);
    expect(stats.updated).toBe(1);
    expect(readFileSync(resolve(targetDir, 'cmd.md'), 'utf-8')).toBe('v2');
    expect(manifest.entries['commands/cmd.md']).toBe(hashContent('v2'));
  });

  it('MANIFEST-06: first install with pre-existing files and NO manifest → keep edits, skip identical', () => {
    const sourceDir = mkTmp('m06-src');
    const targetDir = mkTmp('m06-tgt');
    writeFileSync(resolve(sourceDir, 'edited.md'), 'upstream-edited');
    writeFileSync(resolve(sourceDir, 'identical.md'), 'same');

    // Consumer already has files from a pre-manifest install.
    writeFileSync(resolve(targetDir, 'edited.md'), 'user-edited-v0');
    writeFileSync(resolve(targetDir, 'identical.md'), 'same');

    const fw = emptyFramework({ type: 'typescript' });
    const manifest = emptyManifest(); // empty == "no prior manifest"

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const stats = syncDirectory(sourceDir, targetDir, fw, manifest, 'commands', true);

      expect(stats.kept).toBe(1); // edited file kept
      expect(stats.skipped).toBe(1); // identical file recorded
      expect(stats.updated).toBe(0);
      expect(stats.installed).toBe(0);

      // Edited file content preserved.
      expect(readFileSync(resolve(targetDir, 'edited.md'), 'utf-8')).toBe('user-edited-v0');
      // Manifest seeded with EXISTING hash for kept and source hash for skipped.
      expect(manifest.entries['commands/edited.md']).toBe(hashContent('user-edited-v0'));
      expect(manifest.entries['commands/identical.md']).toBe(hashContent('same'));

      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrText).toMatch(/First-install heuristic/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('MANIFEST-07: atomic write — saveManifest never leaves partial JSON at the final path', () => {
    const claudeDir = mkTmp('m07-claude');
    const manifest: Manifest = emptyManifest();
    manifest.entries['commands/x.md'] = hashContent('x');

    saveManifest(claudeDir, manifest);

    const finalPath = resolve(claudeDir, '.massu', 'install-manifest.json');
    expect(existsSync(finalPath)).toBe(true);

    // No `.tmp` should remain on disk after a successful write.
    const tmpPath = finalPath + '.tmp';
    expect(existsSync(tmpPath)).toBe(false);

    // File must parse as JSON cleanly (no half-write garbage).
    expect(() => JSON.parse(readFileSync(finalPath, 'utf-8'))).not.toThrow();
    const reloaded = loadManifest(claudeDir);
    expect(reloaded.entries['commands/x.md']).toBe(hashContent('x'));
  });

  it('MANIFEST-08: legacy installCommands writes the manifest under <claudeDirName>/.massu/', () => {
    // Simulate a fresh consumer dir with a massu.config.yaml so getConfig
    // resolves cleanly inside installCommands.
    const projectRoot = mkTmp('m08-root');
    writeFileSync(
      resolve(projectRoot, 'massu.config.yaml'),
      [
        'schema_version: 2',
        'project:',
        '  name: m08',
        '  root: auto',
        'framework:',
        '  type: typescript',
        '  primary: typescript',
        '  router: none',
        '  orm: none',
        '  ui: none',
      ].join('\n'),
    );
    // Empty .claude/commands so installCommands doesn't see anything yet.
    mkdirSync(resolve(projectRoot, '.claude', 'commands'), { recursive: true });

    // Reset the module-level config cache so installCommands picks up the fixture.
    resetConfig();

    const prevCwd = process.cwd();
    try {
      process.chdir(projectRoot);
      const result = installCommands(projectRoot);
      // The bundled commands dir resolves to the live package, so we expect
      // SOME files to have been installed. Manifest existence is what we
      // care about for this test.
      expect(result.commandsDir).toBe(resolve(projectRoot, '.claude', 'commands'));

      const manifestPath = resolve(projectRoot, '.claude', '.massu', 'install-manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
      expect(parsed.version).toBe(1);
      expect(parsed.entries).toBeTypeOf('object');

      // Every entry MUST be keyed under `commands/...`
      for (const key of Object.keys(parsed.entries)) {
        expect(key.startsWith('commands/')).toBe(true);
        expect(parsed.entries[key]).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      try { process.chdir(prevCwd); } catch { /* ignore */ }
      resetConfig();
    }
  });
});
