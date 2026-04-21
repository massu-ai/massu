// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Detection Orchestrator (P1-007)
 * ===============================
 *
 * Single entry point: `runDetection(projectRoot, configOverrides?)`.
 *
 * Composes P1-001..P1-006 results into a fully-typed `DetectionResult`.
 * All callers (massu init, config refresh, doctor, drift) should import
 * from here — no direct imports of individual detectors into init/CLI code.
 *
 * Filesystem-only. No DB handles. No network. No child processes.
 *
 * Usage:
 * ```ts
 * import { runDetection } from './detect/index.ts';
 * const result = await runDetection('/repo');
 * result.monorepo.type       // 'turbo' | 'pnpm' | 'single' | ...
 * result.frameworks.python   // { framework: 'fastapi', test_framework: 'pytest', ... }
 * result.verificationCommands.python.test // 'cd apps/ai-service && python3 -m pytest -q'
 * ```
 */

import type { DomainConfig } from '../config.ts';
import {
  detectPackageManifests,
  type PackageManifest,
  type PackageDetectionResult,
  type SupportedLanguage,
  type DetectionWarning,
} from './package-detector.ts';
import {
  detectFrameworks,
  type FrameworkMap,
  type FrameworkInfo,
  type UserDetectionRules,
} from './framework-detector.ts';
import {
  detectSourceDirs,
  type SourceDirMap,
  type SourceDirInfo,
} from './source-dir-detector.ts';
import {
  detectMonorepo,
  type MonorepoInfo,
  type MonorepoKind,
  type WorkspacePackage,
} from './monorepo-detector.ts';
import {
  getVRCommands,
  type VRCommandSet,
  type UserVerificationEntry,
} from './vr-command-map.ts';
import { inferDomains } from './domain-inferrer.ts';

export type {
  PackageManifest,
  PackageDetectionResult,
  SupportedLanguage,
  DetectionWarning,
  FrameworkMap,
  FrameworkInfo,
  UserDetectionRules,
  SourceDirMap,
  SourceDirInfo,
  MonorepoInfo,
  MonorepoKind,
  WorkspacePackage,
  VRCommandSet,
  UserVerificationEntry,
};

/** Shape a caller passes in to plug user overrides. */
export interface DetectionConfigOverrides {
  /** `config.detection` — user additions to the framework detection rule table. */
  detection?: UserDetectionRules;
  /** `config.verification` — per-language VR-* command overrides. */
  verification?: Record<string, UserVerificationEntry>;
}

export interface DetectionResult {
  /** Absolute project root that was scanned. */
  projectRoot: string;
  /** All package manifests discovered (P1-001). */
  manifests: PackageManifest[];
  /** Inferred framework/test/ORM/router/ui per language (P1-002). */
  frameworks: FrameworkMap;
  /** Source + test directories per language (P1-003). */
  sourceDirs: SourceDirMap;
  /** Monorepo layout info (P1-004). */
  monorepo: MonorepoInfo;
  /** Suggested domains (P1-006). */
  domains: DomainConfig[];
  /** VR-* commands per language (P1-005). */
  verificationCommands: Partial<Record<SupportedLanguage, VRCommandSet>>;
  /** Non-fatal warnings collected across all detectors. */
  warnings: DetectionWarning[];
}

function dominantDir(
  lang: SupportedLanguage,
  sourceDirs: SourceDirMap,
  monorepo: MonorepoInfo
): string {
  const info = sourceDirs[lang];
  if (info && info.source_dirs.length > 0) return info.source_dirs[0];
  // Fall back to the first monorepo workspace path if present.
  if (monorepo.packages.length > 0) return monorepo.packages[0].path;
  return '.';
}

/**
 * Run all detectors in order and compose a `DetectionResult`.
 *
 * Order (per plan):
 *   1. packages
 *   2. frameworks (depends on packages)
 *   3. sourceDirs + monorepo (parallel, independent)
 *   4. domains + verificationCommands (depend on 1-3)
 */
export async function runDetection(
  projectRoot: string,
  overrides?: DetectionConfigOverrides
): Promise<DetectionResult> {
  // 1. packages
  const pkg = detectPackageManifests(projectRoot);

  // 2. frameworks (depends on packages)
  const frameworks = detectFrameworks(pkg.manifests, overrides?.detection);

  // 3a. sourceDirs (depends on the language list discovered in packages)
  const languages = Array.from(
    new Set(pkg.manifests.map((m) => m.language))
  ) as SupportedLanguage[];

  // P1-002: when the repo has a `javascript` manifest but NO `typescript`
  // manifest, still glob `.ts`/`.tsx` for the javascript slot. This fixes
  // plain-JS monorepos (e.g. turbo + next in a package.json with no
  // `typescript` dep and no `tsconfig.json`) that contain `.tsx` files
  // under `apps/*/`. Without this, `init --ci` falls back to the nonexistent
  // `src/` and rolls back with a validation error.
  const fallbackTsForJs =
    languages.includes('javascript') && !languages.includes('typescript');

  // 3b. run source-dir + monorepo detection in parallel (both pure fs).
  const [sourceDirs, monorepo] = await Promise.all([
    Promise.resolve(detectSourceDirs(projectRoot, languages, { fallbackTsForJs })),
    Promise.resolve(detectMonorepo(projectRoot)),
  ]);

  // 4a. domains
  const domains = inferDomains(projectRoot, monorepo, sourceDirs);

  // 4b. VR commands per language
  const verificationCommands: Partial<Record<SupportedLanguage, VRCommandSet>> =
    {};
  for (const lang of languages) {
    const fw: FrameworkInfo = frameworks[lang] ?? {
      framework: null,
      version: null,
      test_framework: null,
      orm: null,
      ui_library: null,
      router: null,
    };
    const dir = dominantDir(lang, sourceDirs, monorepo);
    const userOverride = overrides?.verification?.[lang];
    verificationCommands[lang] = getVRCommands(lang, fw, dir, userOverride);
  }

  return {
    projectRoot,
    manifests: pkg.manifests,
    frameworks,
    sourceDirs,
    monorepo,
    domains,
    verificationCommands,
    warnings: pkg.warnings,
  };
}
