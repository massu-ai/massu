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

// ============================================================
// TEMPLATING — Plan #2 P1-004
// Integration: rendered output replaces {{...}} with substituted values;
// no leftover placeholders; engine errors fail per-file, not the whole run.
// ============================================================

describe('templating integration (Plan #2 P1-004)', () => {
  it('substitutes config values into a templated source file', () => {
    const sourceDir = mkTmp('tpl-source');
    const targetDir = mkTmp('tpl-target');

    const templatedBody =
      '# Scaffold\n' +
      'Path: {{paths.source}}\n' +
      'Auth: {{detected.python.auth_dep | default("get_current_user")}}\n';
    writeFileSync(join(sourceDir, 'massu-scaffold.md'), templatedBody, 'utf-8');

    const manifest = emptyManifest();
    const stats = syncDirectory(
      sourceDir,
      targetDir,
      emptyFramework(),
      manifest,
      'commands',
      true,
      {
        paths: { source: 'apps/api/src' },
        detected: { python: { auth_dep: 'require_tier_or_guardian' } },
      },
    );

    expect(stats.installed).toBe(1);
    const installedContent = readFileSync(join(targetDir, 'massu-scaffold.md'), 'utf-8');
    expect(installedContent).toContain('Path: apps/api/src');
    expect(installedContent).toContain('Auth: require_tier_or_guardian');
    expect(installedContent).not.toContain('{{');
    expect(installedContent).not.toContain('}}');
  });

  it('falls through to default when detected block is empty', () => {
    const sourceDir = mkTmp('tpl-default-source');
    const targetDir = mkTmp('tpl-default-target');

    const templatedBody =
      'auth = {{detected.python.auth_dep | default("get_current_user")}}\n';
    writeFileSync(join(sourceDir, 'massu-scaffold.md'), templatedBody, 'utf-8');

    const manifest = emptyManifest();
    const stats = syncDirectory(
      sourceDir,
      targetDir,
      emptyFramework(),
      manifest,
      'commands',
      true,
      { detected: {} },
    );

    expect(stats.installed).toBe(1);
    const installed = readFileSync(join(targetDir, 'massu-scaffold.md'), 'utf-8');
    expect(installed.trim()).toBe('auth = get_current_user');
  });

  it('skips a single template on missing-var error and continues with others (VR-NO-LEFTOVER-PLACEHOLDERS)', () => {
    const sourceDir = mkTmp('tpl-error-source');
    const targetDir = mkTmp('tpl-error-target');

    // First file: requires a missing var with NO default → engine throws
    writeFileSync(join(sourceDir, 'broken.md'), '{{required.but.missing}}\n', 'utf-8');
    // Second file: clean, should still install
    writeFileSync(join(sourceDir, 'clean.md'), 'plain content\n', 'utf-8');

    const manifest = emptyManifest();
    const stats = syncDirectory(
      sourceDir,
      targetDir,
      emptyFramework(),
      manifest,
      'commands',
      true,
      {},
    );

    // The broken file is skipped; the clean one installs.
    expect(stats.installed).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(existsSync(join(targetDir, 'broken.md'))).toBe(false);
    expect(existsSync(join(targetDir, 'clean.md'))).toBe(true);

    // Manifest only records the file that actually landed.
    expect(Object.keys(manifest.entries)).toEqual(['commands/clean.md']);
  });

  it('no `{{` placeholders remain in installed files (VR-NO-LEFTOVER-PLACEHOLDERS)', () => {
    const sourceDir = mkTmp('tpl-noleak-source');
    const targetDir = mkTmp('tpl-noleak-target');

    writeFileSync(
      join(sourceDir, 'a.md'),
      '{{a}} {{b.c}} {{d | default("D")}}\n',
      'utf-8',
    );
    writeFileSync(join(sourceDir, 'b.md'), 'plain\n', 'utf-8');

    const manifest = emptyManifest();
    syncDirectory(sourceDir, targetDir, emptyFramework(), manifest, 'commands', true, {
      a: 'A',
      b: { c: 'C' },
    });

    for (const file of readdirSync(targetDir)) {
      const content = readFileSync(join(targetDir, file), 'utf-8');
      expect(content).not.toContain('{{');
      expect(content).not.toContain('}}');
    }
  });

  it('records the rendered hash in the manifest (not the raw template hash)', () => {
    const sourceDir = mkTmp('tpl-hash-source');
    const targetDir = mkTmp('tpl-hash-target');

    const raw = 'value: {{x}}\n';
    writeFileSync(join(sourceDir, 'a.md'), raw, 'utf-8');

    const manifest = emptyManifest();
    syncDirectory(sourceDir, targetDir, emptyFramework(), manifest, 'commands', true, {
      x: 'rendered-value',
    });

    const installedContent = readFileSync(join(targetDir, 'a.md'), 'utf-8');
    const expectedHash = hashContent(installedContent);
    expect(manifest.entries['commands/a.md']).toBe(expectedHash);
    expect(manifest.entries['commands/a.md']).not.toBe(hashContent(raw));
  });
});

// ============================================================
// P2-003: Two-axis variant resolution — Plan #2
// Exercises the (lang, sub-framework) probe order shipped in
// pickVariant for Phase 2.
// ============================================================

describe('two-axis variant resolution — Plan #2 P2-003', () => {
  // ----------------------------------------------------------------
  // P2-003-01: python+fastapi → .python-fastapi variant if file exists
  // ----------------------------------------------------------------
  it('P2-003-01: python+fastapi hits .python-fastapi when the file exists', () => {
    const sourceDir = mkTmp('p2-01');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python.md'), '# python');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python-fastapi.md'), '# python-fastapi');

    const fw = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: { python: { framework: 'fastapi' } },
    });
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);
    expect(result).toEqual({ kind: 'hit', suffix: '.python-fastapi' });
  });

  // ----------------------------------------------------------------
  // P2-003-02: python+fastapi without .python-fastapi falls back to .python
  // ----------------------------------------------------------------
  it('P2-003-02: python+fastapi falls back to .python when .python-fastapi absent', () => {
    const sourceDir = mkTmp('p2-02');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python.md'), '# python');
    // .python-fastapi intentionally absent

    const fw = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: { python: { framework: 'fastapi' } },
    });
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);
    expect(result).toEqual({ kind: 'hit', suffix: '.python' });
  });

  // ----------------------------------------------------------------
  // P2-003-03: python+django hits .python-django
  // ----------------------------------------------------------------
  it('P2-003-03: python+django hits .python-django when the file exists', () => {
    const sourceDir = mkTmp('p2-03');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python.md'), '# python');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python-django.md'), '# python-django');

    const fw = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: { python: { framework: 'django' } },
    });
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);
    expect(result).toEqual({ kind: 'hit', suffix: '.python-django' });
  });

  // ----------------------------------------------------------------
  // P2-003-04: python+flask (no .python-flask file) falls back to .python
  // ----------------------------------------------------------------
  it('P2-003-04: python+flask falls back to .python when no .python-flask file exists', () => {
    const sourceDir = mkTmp('p2-04');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python.md'), '# python');
    // .python-flask intentionally absent

    const fw = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: { python: { framework: 'flask' } },
    });
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);
    expect(result).toEqual({ kind: 'hit', suffix: '.python' });
  });

  // ----------------------------------------------------------------
  // P2-003-05: python declared in languages with no sub-framework — not pushed
  // as a candidate (framework key absent / empty), falls to unsuffixed default
  // ----------------------------------------------------------------
  it('P2-003-05: python with no framework key in languages entry falls to unsuffixed default', () => {
    const sourceDir = mkTmp('p2-05');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python.md'), '# python');

    // framework.languages.python has NO framework field → pushCandidate is never
    // called for python (the implementation requires entry.framework to be a
    // non-empty string). Primary is typescript, no .typescript.md → falls to ''.
    const fw = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: {
        python: {} as { framework: string },
      },
    });
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);
    // No candidate for python → typescript probe misses → default ('') HIT
    expect(result).toEqual({ kind: 'hit', suffix: '' });
  });

  // ----------------------------------------------------------------
  // P2-003-06: swift+swiftui has no .swift-swiftui file → falls back to .swift
  // ----------------------------------------------------------------
  it('P2-003-06: swift+swiftui falls back to .swift when no .swift-swiftui file exists', () => {
    const sourceDir = mkTmp('p2-06');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-page.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-page.swift.md'), '# swift');
    // .swift-swiftui intentionally absent

    const fw = {
      type: 'multi',
      primary: 'typescript',
      router: 'none',
      orm: 'none',
      ui: 'none',
      swift: { framework: 'swiftui' },
    } as unknown as Config['framework'];
    const result = pickVariant('massu-scaffold-page', sourceDir, fw);
    expect(result).toEqual({ kind: 'hit', suffix: '.swift' });
  });

  // ----------------------------------------------------------------
  // P2-003-07: typescript+nextjs falls back to .typescript when no .typescript-nextjs
  // ----------------------------------------------------------------
  it('P2-003-07: typescript+nextjs falls back to .typescript when no .typescript-nextjs exists', () => {
    const sourceDir = mkTmp('p2-07');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.typescript.md'), '# typescript');
    // .typescript-nextjs intentionally absent

    const fw = emptyFramework({
      type: 'typescript',
      primary: 'typescript',
      languages: { typescript: { framework: 'nextjs' } },
    });
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);
    expect(result).toEqual({ kind: 'hit', suffix: '.typescript' });
  });

  // ----------------------------------------------------------------
  // P2-003-08: rust+axum with no rust files at all → kind: 'miss'
  // ----------------------------------------------------------------
  it('P2-003-08: rust+axum with no rust files returns miss', () => {
    const sourceDir = mkTmp('p2-08');
    // Only a generic default — no .rust or .rust-axum variants
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');

    const fw = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: { rust: { framework: 'axum' } },
    });
    // pickVariant probes .typescript (hit='' unsuffixed default exists)
    // Actually: no .typescript.md → falls through to unsuffixed → hit suffix=''
    // The miss case only fires when NO file (including default) exists.
    // Re-test: no default either
    const emptySource = mkTmp('p2-08-empty');
    writeFileSync(resolve(emptySource, 'massu-scaffold-router.rust-axum.md'), '# rust-axum');
    // Only rust-axum exists; primary is typescript → .typescript miss, .rust-axum exists
    const fw2 = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: { rust: { framework: 'axum' } },
    });
    const result2 = pickVariant('massu-scaffold-router', emptySource, fw2);
    // rust is NOT primary but it is declared in languages — probe order:
    //   .typescript-<sub> (no) → .typescript (no) → .rust-axum (YES) → hit
    expect(result2).toEqual({ kind: 'hit', suffix: '.rust-axum' });

    // True miss: no matching files at all
    const noFiles = mkTmp('p2-08-nomatch');
    writeFileSync(resolve(noFiles, 'massu-scaffold-router.python.md'), '# python');
    const fwRustOnly = emptyFramework({
      type: 'multi',
      primary: 'typescript',
      languages: { rust: { framework: 'axum' } },
    });
    const missResult = pickVariant('massu-scaffold-router', noFiles, fwRustOnly);
    // .typescript (no), .typescript-<sub> (no), .rust-axum (no), .rust (no), default (no) → miss
    expect(missResult).toEqual({ kind: 'miss' });
  });

  // ----------------------------------------------------------------
  // P2-003-09: multi-lang primary=python+fastapi wins over secondary swift
  // ----------------------------------------------------------------
  it('P2-003-09: multi-lang primary=python+fastapi takes precedence over swift', () => {
    const sourceDir = mkTmp('p2-09');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python-fastapi.md'), '# python-fastapi');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.swift.md'), '# swift');

    const fw = emptyFramework({
      type: 'multi',
      primary: 'python',
      languages: {
        python: { framework: 'fastapi' },
        swift: { framework: 'swiftui' },
      },
    });
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);
    // primary=python → probe .python-fastapi first → HIT
    expect(result).toEqual({ kind: 'hit', suffix: '.python-fastapi' });
  });

  // ----------------------------------------------------------------
  // P2-003-10: sub-framework via top-level passthrough framework.python.framework
  // ----------------------------------------------------------------
  it('P2-003-10: sub-framework from top-level passthrough block is respected', () => {
    const sourceDir = mkTmp('p2-10');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python-fastapi.md'), '# python-fastapi (passthrough)');

    // top-level passthrough: no framework.languages, but framework.python.framework exists
    const fw = {
      type: 'multi',
      primary: 'typescript',
      router: 'none',
      orm: 'none',
      ui: 'none',
      python: { framework: 'fastapi' },
    } as unknown as Config['framework'];
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);
    // .typescript (no) → passthrough python.framework=fastapi → .python-fastapi HIT
    expect(result).toEqual({ kind: 'hit', suffix: '.python-fastapi' });
  });

  // ----------------------------------------------------------------
  // P2-003-11: sub-framework via framework.languages.python.framework (not passthrough)
  // ----------------------------------------------------------------
  it('P2-003-11: sub-framework from framework.languages wins over passthrough', () => {
    const sourceDir = mkTmp('p2-11');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.md'), '# default');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python-django.md'), '# python-django (languages)');
    writeFileSync(resolve(sourceDir, 'massu-scaffold-router.python-fastapi.md'), '# python-fastapi (passthrough)');

    // languages.python.framework = 'django'; passthrough python.framework = 'fastapi'
    const fw = {
      type: 'multi',
      primary: 'typescript',
      router: 'none',
      orm: 'none',
      ui: 'none',
      languages: { python: { framework: 'django' } },
      python: { framework: 'fastapi' },  // passthrough — should NOT win
    } as unknown as Config['framework'];
    const result = pickVariant('massu-scaffold-router', sourceDir, fw);
    // .typescript (no) → languages.python.framework=django → .python-django HIT
    // (passthrough is only consulted for langs NOT already in languages block)
    expect(result).toEqual({ kind: 'hit', suffix: '.python-django' });
  });

  // ----------------------------------------------------------------
  // P2-003-12: framework.type=multi without primary → kind 'fallback'
  // when no default file exists
  // ----------------------------------------------------------------
  it('P2-003-12: multi without primary and no default file → fallback reason multi-without-primary', () => {
    const sourceDir = mkTmp('p2-12');
    // No files at all in sourceDir

    const fw = emptyFramework({ type: 'multi', primary: undefined });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = pickVariant('massu-scaffold-router', sourceDir, fw);
      expect(result.kind).toBe('fallback');
      if (result.kind === 'fallback') {
        expect(result.reason).toBe('multi-without-primary');
      }
      expect(stderrSpy).toHaveBeenCalled();
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrText).toMatch(/framework\.primary is undefined/);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
