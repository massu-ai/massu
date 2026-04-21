// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift detection logic (P7-004).
 *
 * Phase 5 runtime (drift runner / auto-rerun) is NOT in the MVP cut, but the
 * pure detection LOGIC is tested here so the runtime layer lands without bugs.
 *
 * Two primary entry points:
 *
 *   1. `computeFingerprint(detectionResult)` — deterministic SHA-256 of the
 *      normalized JSON form of (languages, frameworks, source_dirs, manifest
 *      paths sorted). Any meaningful change in the detected stack changes the
 *      fingerprint.
 *
 *   2. `detectDrift(currentConfig, actualDetection)` — returns
 *      `{ drifted: boolean, changes: Array<{field, before, after}> }`.
 *
 * No filesystem / network / child_process.
 */

import { createHash } from 'crypto';
import type { AnyConfig } from './migrate.ts';
import type { DetectionResult, SupportedLanguage } from './index.ts';

export interface DriftChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface DriftReport {
  drifted: boolean;
  changes: DriftChange[];
}

/** Stable-sorted, normalized summary of a DetectionResult used for hashing. */
interface DetectionFingerprintData {
  languages: string[];
  frameworks: Record<string, { framework: string | null; test_framework: string | null; orm: string | null }>;
  source_dirs: Record<string, string[]>;
  manifests: string[];
  monorepo: string;
  workspaces: string[];
}

function summarizeDetection(det: DetectionResult): DetectionFingerprintData {
  const languages = Array.from(new Set(det.manifests.map((m) => m.language))).sort();
  const frameworks: DetectionFingerprintData['frameworks'] = {};
  for (const lang of languages) {
    const fw = det.frameworks[lang as SupportedLanguage];
    frameworks[lang] = {
      framework: fw?.framework ?? null,
      test_framework: fw?.test_framework ?? null,
      orm: fw?.orm ?? null,
    };
  }
  const sourceDirs: Record<string, string[]> = {};
  for (const lang of languages) {
    const info = det.sourceDirs[lang as SupportedLanguage];
    sourceDirs[lang] = [...(info?.source_dirs ?? [])].sort();
  }
  const manifests = [...det.manifests.map((m) => m.relativePath)].sort();
  const workspaces = [...det.monorepo.packages.map((p) => p.path)].sort();
  return {
    languages,
    frameworks,
    source_dirs: sourceDirs,
    manifests,
    monorepo: det.monorepo.type,
    workspaces,
  };
}

/** Deterministic SHA-256 of a detection result. Stable across runs for the
 * same inputs. */
export function computeFingerprint(det: DetectionResult): string {
  const data = summarizeDetection(det);
  const stable = JSON.stringify(data, Object.keys(data).sort());
  return createHash('sha256').update(stable).digest('hex');
}

function stringOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * Compute drift between a currently-loaded config and a freshly-run detection.
 *
 * A non-empty `changes[]` means fields in the config no longer agree with
 * what the repository actually contains. Callers decide whether to auto-repair
 * (via `migrateV1ToV2`) or surface to the user.
 */
export function detectDrift(
  currentConfig: AnyConfig,
  actualDetection: DetectionResult
): DriftReport {
  const changes: DriftChange[] = [];

  const configFw = (currentConfig.framework && typeof currentConfig.framework === 'object')
    ? (currentConfig.framework as Record<string, unknown>)
    : {};
  const configLanguages = (configFw.languages && typeof configFw.languages === 'object')
    ? (configFw.languages as Record<string, Record<string, unknown>>)
    : {};

  const detectedLanguages = Array.from(
    new Set(actualDetection.manifests.map((m) => m.language))
  ) as SupportedLanguage[];

  const configLangKeys = Object.keys(configLanguages).sort();
  const detectedLangKeys = [...detectedLanguages].sort();

  // 1. Language set drift.
  if (JSON.stringify(configLangKeys) !== JSON.stringify(detectedLangKeys)) {
    changes.push({
      field: 'framework.languages',
      before: configLangKeys,
      after: detectedLangKeys,
    });
  }

  // 2. Per-language framework/test_framework drift.
  for (const lang of detectedLanguages) {
    const detFw = actualDetection.frameworks[lang];
    const cfgEntry = configLanguages[lang];
    if (!cfgEntry) continue;
    const cfgFramework = stringOf(cfgEntry.framework);
    const detFramework = detFw?.framework ?? null;
    if (cfgFramework !== detFramework && detFramework !== null) {
      changes.push({
        field: `framework.languages.${lang}.framework`,
        before: cfgFramework,
        after: detFramework,
      });
    }
    const cfgTest = stringOf(cfgEntry.test_framework);
    const detTest = detFw?.test_framework ?? null;
    if (cfgTest !== detTest && detTest !== null) {
      changes.push({
        field: `framework.languages.${lang}.test_framework`,
        before: cfgTest,
        after: detTest,
      });
    }
  }

  // 3. Manifest set drift: new/removed manifest files.
  const detectedManifestPaths = new Set(actualDetection.manifests.map((m) => m.relativePath));
  const declaredManifestPaths = new Set<string>();
  // v2 configs don't record manifest paths directly; we look at
  // `canonical_paths.manifest_paths` (string comma-separated) OR a `manifests`
  // top-level array. When neither is present we skip this check.
  const canonical = currentConfig.canonical_paths as Record<string, unknown> | undefined;
  if (canonical && typeof canonical.manifest_paths === 'string') {
    for (const p of (canonical.manifest_paths as string).split(',').map((s) => s.trim())) {
      if (p) declaredManifestPaths.add(p);
    }
  }
  if (Array.isArray(currentConfig.manifests)) {
    for (const p of currentConfig.manifests as unknown[]) {
      if (typeof p === 'string') declaredManifestPaths.add(p);
    }
  }
  if (declaredManifestPaths.size > 0) {
    const added = [...detectedManifestPaths].filter((p) => !declaredManifestPaths.has(p)).sort();
    const removed = [...declaredManifestPaths].filter((p) => !detectedManifestPaths.has(p)).sort();
    if (added.length > 0) {
      changes.push({ field: 'manifests.added', before: [], after: added });
    }
    if (removed.length > 0) {
      changes.push({ field: 'manifests.removed', before: removed, after: [] });
    }
  }

  // 4. Monorepo workspace set drift.
  const configWorkspaces: string[] = [];
  if (Array.isArray((currentConfig.monorepo as Record<string, unknown> | undefined)?.workspaces)) {
    for (const w of ((currentConfig.monorepo as Record<string, unknown>).workspaces as unknown[])) {
      if (typeof w === 'string') configWorkspaces.push(w);
    }
  }
  const detectedWorkspaces = actualDetection.monorepo.packages.map((p) => p.path).sort();
  if (configWorkspaces.length > 0) {
    const cfgSorted = [...configWorkspaces].sort();
    if (JSON.stringify(cfgSorted) !== JSON.stringify(detectedWorkspaces)) {
      changes.push({
        field: 'monorepo.workspaces',
        before: cfgSorted,
        after: detectedWorkspaces,
      });
    }
  }

  return { drifted: changes.length > 0, changes };
}
