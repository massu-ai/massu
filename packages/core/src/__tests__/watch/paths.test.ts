// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { deriveWatchGlobs, ALWAYS_WATCH_FILES, FALLBACK_SOURCE_GLOBS, DEFAULT_EXCLUSIONS } from '../../watch/paths.ts';
import type { Config } from '../../config.ts';

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    schema_version: 2,
    project: { name: 't', root: '/tmp/t' },
    framework: { type: 'typescript', router: 'none', orm: 'none', ui: 'none' },
    paths: { source: 'src', aliases: { '@': 'src' } },
    toolPrefix: 'massu',
    domains: [],
    rules: [],
    ...over,
  } as Config;
}

describe('watch/paths', () => {
  it('always includes manifest files', () => {
    const out = deriveWatchGlobs(makeConfig());
    for (const f of ALWAYS_WATCH_FILES) {
      expect(out.watch).toContain(f);
    }
  });

  it('uses fallback globs when paths.source is "src" only', () => {
    const out = deriveWatchGlobs(makeConfig({ paths: { source: 'src', aliases: {} } } as Partial<Config>));
    expect(out.watch).toContain('src/**');
    expect(out.usedFallback).toBe(false);
  });

  it('falls back to safe-default globs when no source dirs declared', () => {
    const cfg = makeConfig();
    cfg.paths = { source: '', aliases: {} } as unknown as Config['paths'];
    const out = deriveWatchGlobs(cfg);
    expect(out.usedFallback).toBe(true);
    for (const g of FALLBACK_SOURCE_GLOBS) expect(out.watch).toContain(g);
  });

  it('honors framework.languages.*.source_dirs', () => {
    const cfg = makeConfig({
      framework: {
        type: 'multi',
        primary: 'python',
        router: 'fastapi',
        orm: 'sqlmodel',
        ui: 'none',
        languages: {
          python: { source_dirs: ['app', 'services/api'] } as unknown as Config['framework']['languages'][string],
          typescript: { source_dirs: ['web'] } as unknown as Config['framework']['languages'][string],
        },
      } as Config['framework'],
    });
    const out = deriveWatchGlobs(cfg);
    expect(out.watch).toContain('app/**');
    expect(out.watch).toContain('services/api/**');
    expect(out.watch).toContain('web/**');
  });

  it('honors paths.source already declared as a glob (iter-5 coverage gap)', () => {
    // Iter-5 audit found `toGlob` is a non-trivial helper (early-returns
    // when input already contains a glob) but no test exercised the
    // already-globbed input shape. If a refactor accidentally double-
    // appended `/**` to `src/**` -> `src/**/**`, chokidar would still
    // technically resolve it, but per chokidar v3 docs `**/**` is
    // pathologically slow on Linux/macOS. Lock the invariant.
    const cfg = makeConfig({ paths: { source: 'src/**', aliases: {} } } as Partial<Config>);
    const out = deriveWatchGlobs(cfg);
    expect(out.watch).toContain('src/**');
    expect(out.watch).not.toContain('src/**/**');
    expect(out.usedFallback).toBe(false);
  });

  it('exclusion globs include node_modules, .git, .massu, .claude', () => {
    const out = deriveWatchGlobs(makeConfig());
    expect(out.ignore).toContain('**/node_modules/**');
    expect(out.ignore).toContain('**/.git/**');
    expect(out.ignore).toContain('**/.massu/**');
    expect(out.ignore).toContain('**/.claude/**');
  });

  it('iter-7 editor-temp exclusions cover vim/emacs/macOS noise files (iter-8 coverage gap)', () => {
    // Iter-7 added editor-temp globs to DEFAULT_EXCLUSIONS but no test
    // verified the patterns ship as expected. If a future refactor
    // accidentally drops one (e.g., regex typo, list reorder), the storm
    // counter would silently inflate on every vim save — exactly the kind
    // of regression we want a test to catch.
    const out = deriveWatchGlobs(makeConfig());
    expect(out.ignore).toContain('**/*.swp'); // vim swap (active edit)
    expect(out.ignore).toContain('**/*.swo'); // vim swap (recovery)
    expect(out.ignore).toContain('**/4913');  // vim atomic-write probe
    expect(out.ignore).toContain('**/.#*');    // emacs lockfiles
    expect(out.ignore).toContain('**/*~');     // gedit/many-editors backup
    expect(out.ignore).toContain('**/.DS_Store'); // macOS Finder
    // Sanity: DEFAULT_EXCLUSIONS export is what deriveWatchGlobs returns.
    for (const pat of DEFAULT_EXCLUSIONS) {
      expect(out.ignore).toContain(pat);
    }
  });

  it('watch.scope=full opts into whole-repo watch with same exclusions (iter-8)', () => {
    // Plan 3a §167 + §251 risk #1: scope=full is the opt-in for users on
    // small/medium repos who want every file under toplevel to count.
    // Iter-7 left the schema field defined but unwired — iter-8 implements
    // the path so `scope: full` actually changes deriveWatchGlobs' output.
    const cfg = makeConfig({
      watch: { scope: 'full', debounce_ms: 3000, storm_threshold: 50, deep_storm_threshold: 500, hard_timeout_ms: 300_000 },
    } as unknown as Partial<Config>);
    const out = deriveWatchGlobs(cfg);
    expect(out.watch).toContain('**');
    // Manifest files always present even in full mode.
    expect(out.watch).toContain('package.json');
    // Exclusions still apply (otherwise full mode would scan node_modules).
    expect(out.ignore).toContain('**/node_modules/**');
    expect(out.ignore).toContain('**/.git/**');
    expect(out.usedFallback).toBe(false);
  });

  it('watch.scope=paths is the default (back-compat with iter-7 behavior)', () => {
    // No watch.scope set → behaves identically to iter-7 / pre-iter-8 paths-mode.
    const cfg = makeConfig();
    const out = deriveWatchGlobs(cfg);
    expect(out.watch).not.toContain('**');
    expect(out.watch).toContain('src/**');
  });
});
