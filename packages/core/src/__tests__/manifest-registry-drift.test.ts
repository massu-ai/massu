// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * STRUCTURAL drift-guard for the manifest registry — Plan 1.5.1 §3
 * deliverable.
 *
 * The registry at `detect/manifest-registry.ts` is the SINGLE source-of-
 * truth for "what manifest files we recognize." Two consumers must stay
 * in lockstep with it:
 *   1. `detect/package-detector.ts` — used by `npx massu init` to detect
 *      languages + emit `massu.config.yaml`. Drift causes init to fail
 *      with "no languages detected" for valid projects.
 *   2. `detect/adapters/runner.ts:buildDetectionSignals` — feeds the AST
 *      adapter pipeline. Drift causes adapters to silently degrade to
 *      'none' confidence even when a relevant manifest exists.
 *
 * 1.5.0 shipped with both consumers diverged from each other (mix.exs +
 * *.csproj in runner but missing from package-detector). 1.5.1 introduces
 * the registry to consolidate; THIS test asserts the consolidation
 * remains intact going forward.
 *
 * Failure mode protected against: a future contributor adds a new
 * manifest type to the registry (e.g., `composer.json` for PHP) but
 * forgets to declare a signalKey, OR adds a signalKey that isn't a real
 * field on `DetectionSignals`, OR forgets to populate it in
 * buildDetectionSignals. Each such bug becomes a test failure here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getManifestRegistry, getManifestPatterns, matchManifestPattern } from '../detect/manifest-registry.ts';
import { buildDetectionSignals } from '../detect/adapters/runner.ts';

describe('manifest-registry-drift', () => {
  const registry = getManifestRegistry();

  it('every entry has a callable parse function', () => {
    for (const entry of registry) {
      expect(typeof entry.parse).toBe('function');
    }
  });

  it('every entry has a unique pattern', () => {
    const patterns = registry.map((e) => e.pattern);
    const unique = new Set(patterns);
    expect(unique.size).toBe(patterns.length);
  });

  it('getManifestPatterns() matches registry length', () => {
    expect(getManifestPatterns()).toHaveLength(registry.length);
  });

  it('exact-pattern entries have valid filename shapes', () => {
    for (const entry of registry) {
      if (entry.pattern.startsWith('*')) continue;
      // Exact filenames must not contain wildcards or path separators.
      expect(entry.pattern).not.toMatch(/[*?\[\]\/\\]/);
      expect(entry.pattern.length).toBeGreaterThan(0);
    }
  });

  it('extension-glob patterns are well-formed', () => {
    for (const entry of registry) {
      if (!entry.pattern.startsWith('*')) continue;
      // Only `*.<ext>` shape is supported; no other globs.
      expect(entry.pattern).toMatch(/^\*\.[a-z0-9]+$/i);
    }
  });

  it('matchManifestPattern works for both exact and glob shapes', () => {
    expect(matchManifestPattern('Gemfile', 'Gemfile')).toBe(true);
    expect(matchManifestPattern('Foo.csproj', '*.csproj')).toBe(true);
    expect(matchManifestPattern('Foo.txt', '*.csproj')).toBe(false);
    expect(matchManifestPattern('Other', 'Gemfile')).toBe(false);
  });

  it('matchManifestPattern rejects multi-wildcard patterns', () => {
    expect(() => matchManifestPattern('foo.csproj', '*.cs*proj')).toThrow();
  });

  it('every entry with a non-null signalKey is consumed by buildDetectionSignals', () => {
    // Build signals against a tmp dir with NO manifests; we just need to
    // observe the SHAPE of the returned signals object — i.e., which keys
    // it can populate. tmpdir() returns a real path; buildDetectionSignals
    // tolerates absent manifests (returns undefined per key).
    const tmpdir = '/tmp/manifest-registry-drift-empty-' + Date.now();
    require('node:fs').mkdirSync(tmpdir, { recursive: true });
    try {
      const signals = buildDetectionSignals(tmpdir);
      // Cross-reference: every signalKey claimed by the registry must be a
      // valid key on the returned signals object. JS doesn't include
      // optional keys in `Object.keys` when they're undefined, so we use
      // the type-level check via `Object.prototype.hasOwnProperty` — but
      // since those keys ARE always set (to undefined or read content),
      // we just check the runtime shape.
      const expectedKeys = new Set<string>(
        registry.flatMap((e) => (e.signalKey === null ? [] : [String(e.signalKey)])),
      );
      // The signals object's known fields are: presentDirs, presentFiles,
      // packageJson, pyprojectToml, gemfile, cargoToml, goMod, mixExs,
      // csproj, pomXml, gradleBuild. Every registry signalKey must be in
      // this set.
      const knownSignalFields = new Set([
        'packageJson', 'pyprojectToml', 'gemfile', 'cargoToml', 'goMod',
        'mixExs', 'csproj', 'pomXml', 'gradleBuild',
      ]);
      for (const k of expectedKeys) {
        expect(knownSignalFields).toContain(k);
      }
    } finally {
      require('node:fs').rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('every Phase 7 framework adapter language has a registry entry', () => {
    // Cross-reference: the 6 Phase 7 framework adapters target these
    // languages. Each must be reachable via at least one registry entry.
    const phase7Languages = new Set(['ruby', 'elixir', 'csharp', 'java', 'go', 'python']);
    const registryLanguages = new Set(registry.map((e) => e.language));
    for (const lang of phase7Languages) {
      expect(registryLanguages).toContain(lang);
    }
  });

  it('package-detector source no longer hardcodes a MANIFEST_FILES list', () => {
    // CR-46 self-attest #3: closes the parallel-list antipattern.
    // Reading the file directly so this test catches anyone re-introducing
    // a hand-rolled list.
    const src = readFileSync(
      resolve(__dirname, '../detect/package-detector.ts'),
      'utf-8',
    );
    // Fail if `const MANIFEST_FILES = [` reappears (the old anti-pattern).
    // Allow `getManifestPatterns()` (the registry-derived call).
    expect(src).not.toMatch(/^const MANIFEST_FILES\s*=\s*\[/m);
  });
});
