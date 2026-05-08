// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Canonical manifest registry — Plan 1.5.1 §3 deliverable.
 *
 * Single source-of-truth for "what manifest files we recognize and how we
 * read them." Both `package-detector.ts` (init's framework-detection layer)
 * and `adapters/runner.ts:buildDetectionSignals` (AST adapter signal layer)
 * consume from THIS registry. Adding a new manifest type = ONE entry; both
 * consumers automatically pick it up.
 *
 * Pre-registry state (1.5.0) had TWO parallel lists that drifted:
 *   - `package-detector.ts:MANIFEST_FILES` — 11 entries (legacy)
 *   - `runner.ts:buildDetectionSignals` — 9 manifest reads (extended Phase 7)
 * Phoenix + ASP.NET were unreachable via `npx massu init` because their
 * manifest files (mix.exs, *.csproj) were in the runner's list but missing
 * from package-detector's list. CR-39 violation; closed by this registry.
 *
 * Per CR-46 Rule 0 self-attest #3 ("does this add an N+1th alias map?"):
 * this REPLACES the duplicated lists with one canonical map. The drift-
 * prevention test `manifest-registry-drift.test.ts` fails the build if a
 * registry entry is consumed by only one of the two layers.
 *
 * Plan 1.5.1 reference:
 * `~/massu-internal/docs/plans/2026-05-08-1.5.1-init-end-to-end.md`.
 */

import type { PackageManifest, DetectionWarning, SupportedLanguage } from './package-detector.ts';
import type { DetectionSignals } from './adapters/types.ts';
import * as parsers from './package-detector.ts';

/**
 * The pattern by which the registry recognizes a manifest file:
 *   - exact filename: `'Gemfile'`, `'mix.exs'`, `'package.json'`
 *   - extension-glob: `'*.csproj'` (matches any file ending in `.csproj`)
 * Only these two shapes are supported; arbitrary glob patterns are
 * intentionally rejected to keep matching cheap and predictable.
 */
export type ManifestPattern = string;

/**
 * Match a candidate filename against a registry pattern.
 * Returns true if `name` matches `pattern`.
 */
export function matchManifestPattern(name: string, pattern: ManifestPattern): boolean {
  if (pattern.startsWith('*')) {
    const suffix = pattern.slice(1);
    if (suffix.includes('*')) {
      throw new Error(
        `[manifest-registry] pattern "${pattern}" has more than one wildcard. ` +
        `Only "*.<ext>" extension-globs are supported.`,
      );
    }
    return name.endsWith(suffix);
  }
  return name === pattern;
}

/**
 * Parser function signature — matches the existing parse* fns in
 * package-detector.ts. Returns null on file-not-found or parse failure
 * (with a warning pushed to `warnings`).
 */
export type ManifestParser = (
  path: string,
  directory: string,
  root: string,
  warnings: DetectionWarning[],
) => PackageManifest | null;

/**
 * Single registry entry. One per manifest type.
 */
export interface ManifestEntry {
  /** Recognition pattern (see `ManifestPattern`). */
  pattern: ManifestPattern;
  /** Canonical manifest-type tag (matches `PackageManifest.manifestType`). */
  manifestType: PackageManifest['manifestType'];
  /** Default language this manifest implies. */
  language: SupportedLanguage;
  /** Runtime family hint. */
  runtime: string;
  /** Function that reads + parses the file into a `PackageManifest`. */
  parse: ManifestParser;
  /**
   * The DetectionSignals key the runner uses to expose this manifest's
   * contents to AST adapters. `null` when this manifest doesn't surface
   * to the AST tier (e.g., requirements.txt is captured via pyprojectToml
   * sibling already; Package.swift has no AST adapter consumer yet).
   */
  signalKey: keyof DetectionSignals | null;
  /**
   * Shape the runner stores under `signalKey`. Drives whether the runner
   * calls `tryReadString` (string) or `tryReadToml` (toml) or
   * `tryReadJson` (json) when populating signals. Ignored when
   * `signalKey === null`.
   */
  signalShape: 'string' | 'toml' | 'json';
}

/**
 * The canonical registry — the SINGLE source-of-truth for "what manifests
 * we recognize."
 *
 * Lazy initializer: package-detector.ts re-exports the parsers we
 * reference here, so eager top-level evaluation would risk an ESM
 * circular-import undefined-symbol. Resolution: build the registry on
 * first call (after both modules' top-level evaluations have completed).
 *
 * Adding a new manifest type:
 *   1. Author a new `parseXxx()` function in `package-detector.ts`.
 *   2. Add an entry to MANIFEST_REGISTRY referencing it.
 *   3. (If needed) extend `SupportedLanguage` and
 *      `PackageManifest.manifestType` unions.
 *   4. Add the new signal field to `DetectionSignals` if the AST adapter
 *      pipeline needs to read it.
 *   5. The drift-prevention test will fail until both consumers see the
 *      new entry.
 */
let _registryCache: ManifestEntry[] | null = null;

export function getManifestRegistry(): ManifestEntry[] {
  if (_registryCache !== null) return _registryCache;
  _registryCache = [
    {
      pattern: 'package.json',
      manifestType: 'package.json',
      language: 'typescript',
      runtime: 'node',
      parse: parsers.parsePackageJson,
      signalKey: 'packageJson',
      signalShape: 'json',
    },
    {
      pattern: 'pyproject.toml',
      manifestType: 'pyproject.toml',
      language: 'python',
      runtime: 'python3',
      parse: parsers.parsePyproject,
      signalKey: 'pyprojectToml',
      signalShape: 'toml',
    },
    {
      pattern: 'requirements.txt',
      manifestType: 'requirements.txt',
      language: 'python',
      runtime: 'python3',
      parse: parsers.parseRequirementsTxt,
      // Captured via pyprojectToml sibling already; no separate signal.
      signalKey: null,
      signalShape: 'string',
    },
    {
      pattern: 'Pipfile',
      manifestType: 'Pipfile',
      language: 'python',
      runtime: 'python3',
      parse: parsers.parsePipfile,
      // Captured via pyprojectToml sibling already; no separate signal.
      signalKey: null,
      signalShape: 'string',
    },
    {
      pattern: 'Cargo.toml',
      manifestType: 'Cargo.toml',
      language: 'rust',
      runtime: 'cargo',
      parse: parsers.parseCargoToml,
      signalKey: 'cargoToml',
      signalShape: 'toml',
    },
    {
      pattern: 'Package.swift',
      manifestType: 'Package.swift',
      language: 'swift',
      runtime: 'xcode',
      parse: parsers.parsePackageSwift,
      // No AST adapter consumer yet (swift-swiftui doesn't need it).
      signalKey: null,
      signalShape: 'string',
    },
    {
      pattern: 'go.mod',
      manifestType: 'go.mod',
      language: 'go',
      runtime: 'go',
      parse: parsers.parseGoMod,
      signalKey: 'goMod',
      signalShape: 'string',
    },
    {
      pattern: 'pom.xml',
      manifestType: 'pom.xml',
      language: 'java',
      runtime: 'jvm',
      parse: parsers.parsePomXml,
      signalKey: 'pomXml',
      signalShape: 'string',
    },
    {
      pattern: 'build.gradle',
      manifestType: 'build.gradle',
      language: 'java',
      runtime: 'jvm',
      parse: parsers.parseBuildGradle,
      signalKey: 'gradleBuild',
      signalShape: 'string',
    },
    {
      pattern: 'build.gradle.kts',
      manifestType: 'build.gradle',
      language: 'java',
      runtime: 'jvm',
      parse: parsers.parseBuildGradle,
      signalKey: 'gradleBuild',
      signalShape: 'string',
    },
    {
      pattern: 'Gemfile',
      manifestType: 'Gemfile',
      language: 'ruby',
      runtime: 'ruby',
      parse: parsers.parseGemfile,
      signalKey: 'gemfile',
      signalShape: 'string',
    },
    // Plan 1.5.1 — closes CR-39 violation (1.5.0 init failed for Phoenix
    // + ASP.NET fixtures). Both rely on AST adapters that already work
    // in introspect; the gap was solely package-detector unaware of the
    // manifest filenames.
    {
      pattern: 'mix.exs',
      manifestType: 'mix.exs',
      language: 'elixir',
      runtime: 'beam',
      parse: parsers.parseMixExs,
      signalKey: 'mixExs',
      signalShape: 'string',
    },
    {
      pattern: '*.csproj',
      manifestType: '*.csproj',
      language: 'csharp',
      runtime: 'dotnet',
      parse: parsers.parseCsproj,
      signalKey: 'csproj',
      signalShape: 'string',
    },
  ];
  return _registryCache;
}

/**
 * Filename list for direct iteration callers (e.g., the existing
 * package-detector.ts `MANIFEST_FILES` const). Derived from the registry
 * so it stays in lockstep automatically.
 */
export function getManifestPatterns(): ManifestPattern[] {
  return getManifestRegistry().map((e) => e.pattern);
}
