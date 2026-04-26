// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Codebase Introspector (Plan #2 P3-001)
 * ======================================
 *
 * Walks a small sample of existing source files and extracts repo-local
 * conventions (auth dependency name, API prefix, biometric policy, etc.).
 * The output is consumed by the templating engine via `getConfig().detected`.
 *
 * Design rules (Plan #2 §"Phase 3" + Risk #6):
 *   - Per-field confidence: if 3+ different values are sampled for a field,
 *     return null instead of guessing. Auth deps especially must never be
 *     defaulted silently (R-011 / Hedge auth rule).
 *   - Regex-only — no AST. Every regex MUST avoid ReDoS:
 *       * No nested quantifiers (`(a+)+`).
 *       * No overlapping alternations (`(a|a)*`).
 *       * Non-greedy where possible.
 *   - File size cap: 256KB per file (skip silently if larger).
 *   - Sample cap: at most 3 files per adapter (sorted, deterministic order).
 *   - Total wall-clock budget across all adapters: <2s on a 10K-file repo.
 *   - Filesystem-only. No network, no child processes, no DB.
 *   - Returns `null` for any field it can't confidently extract — the template
 *     engine's `| default("...")` then takes over.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { resolve, join, basename } from 'path';
import type { DetectionResult } from './index.ts';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_SAMPLES_PER_ADAPTER = 3;
const MAX_DIR_DEPTH = 6;

// ============================================================
// Public types
// ============================================================

export interface DetectedPython {
  auth_dep?: string;
  api_prefix_base?: string;
  test_async_pattern?: string;
  _provenance?: Record<string, string>;
}

export interface DetectedSwift {
  api_client_class?: string;
  biometric_policy?: string;
  _provenance?: Record<string, string>;
}

export interface DetectedTypeScript {
  trpc_router_builder?: string;
  procedure_pattern?: string;
  _provenance?: Record<string, string>;
}

export interface DetectedConventions {
  python?: DetectedPython;
  swift?: DetectedSwift;
  typescript?: DetectedTypeScript;
}

// ============================================================
// Public entry point
// ============================================================

/**
 * Introspect the project's source files. Returns per-language conventions or
 * an empty object if nothing was extracted.
 */
export function introspect(
  detection: DetectionResult,
  projectRoot: string,
): DetectedConventions {
  const out: DetectedConventions = {};
  const languages = Array.from(
    new Set(detection.manifests.map(m => m.language)),
  );

  if (languages.includes('python')) {
    const python = introspectPython(detection, projectRoot);
    if (python !== null) out.python = python;
  }

  if (languages.includes('swift')) {
    const swift = introspectSwift(detection, projectRoot);
    if (swift !== null) out.swift = swift;
  }

  if (
    languages.includes('typescript') ||
    languages.includes('javascript')
  ) {
    const ts = introspectTypeScript(detection, projectRoot);
    if (ts !== null) out.typescript = ts;
  }

  return out;
}

// ============================================================
// Python adapter (FastAPI + Django)
// ============================================================

/**
 * Introspect Python sources. Probes both FastAPI router files (`routers/*.py`,
 * `api/*.py`) and Django views (`views.py`). Returns the most-extracted shape.
 */
function introspectPython(
  detection: DetectionResult,
  projectRoot: string,
): DetectedPython | null {
  const sourceDir = resolveSourceDir(detection, 'python', projectRoot);
  if (!sourceDir) return null;

  // Sample router-shaped files first (FastAPI / Flask), then views.py (Django),
  // then any .py file as a last resort.
  const routerFiles = sampleFiles(sourceDir, /\.py$/, name =>
    /(routers?|api|endpoints?)/.test(name),
  );
  const viewFiles = sampleFiles(sourceDir, /^views\.py$/);
  const fallbackFiles = routerFiles.length === 0 && viewFiles.length === 0
    ? sampleFiles(sourceDir, /\.py$/)
    : [];
  const candidates = [...routerFiles, ...viewFiles, ...fallbackFiles].slice(
    0,
    MAX_SAMPLES_PER_ADAPTER,
  );

  if (candidates.length === 0) return null;

  const authDeps = new Map<string, string>(); // value → first source path
  const prefixBases = new Map<string, string>();
  const testAsyncPatterns = new Map<string, string>();

  for (const path of candidates) {
    const body = readSafe(path);
    if (body === null) continue;

    // Auth dependency: `Depends(<name>)` — capture the call's argument.
    // ReDoS-safe: anchored, short window, no nested quantifiers.
    const authRegex = /\bDepends\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/gu;
    forEachMatch(authRegex, body, m => {
      const name = m[1];
      if (!authDeps.has(name)) authDeps.set(name, path);
    });

    // Django: `@login_required` or `@permission_required` decorators.
    const djangoAuthRegex = /^@\s*([a-z_][a-z0-9_]*(?:_required|_login))\b/gmu;
    forEachMatch(djangoAuthRegex, body, m => {
      const name = m[1];
      if (!authDeps.has(name)) authDeps.set(name, path);
    });

    // API prefix base: `APIRouter(prefix="/api/...")` — capture just the BASE
    // (everything up to the second `/` from the start).
    const prefixRegex = /\bAPIRouter\s*\(\s*[^)]*?prefix\s*=\s*["']([^"']+)["']/gu;
    forEachMatch(prefixRegex, body, m => {
      const fullPrefix = m[1];
      const base = extractPrefixBase(fullPrefix);
      if (base && !prefixBases.has(base)) prefixBases.set(base, path);
    });

    // Test async pattern: `@pytest.mark.asyncio` (with possible parens).
    const asyncRegex = /^(@pytest\.mark\.asyncio(?:\s*\([^)]*\))?)/gmu;
    forEachMatch(asyncRegex, body, m => {
      const pat = m[1].trim();
      if (!testAsyncPatterns.has(pat)) testAsyncPatterns.set(pat, path);
    });
  }

  const authDep = pickBestSingleton(authDeps);
  const apiPrefixBase = pickBestSingleton(prefixBases);
  const testAsyncPattern = pickBestSingleton(testAsyncPatterns);

  const result: DetectedPython = {};
  const provenance: Record<string, string> = {};

  if (authDep) {
    result.auth_dep = authDep.value;
    provenance.auth_dep_source = relativeTo(projectRoot, authDep.source);
  }
  if (apiPrefixBase) {
    result.api_prefix_base = apiPrefixBase.value;
    provenance.api_prefix_base_source = relativeTo(projectRoot, apiPrefixBase.source);
  }
  if (testAsyncPattern) {
    result.test_async_pattern = testAsyncPattern.value;
    provenance.test_async_pattern_source = relativeTo(projectRoot, testAsyncPattern.source);
  }

  // Only emit a language block when at least one real field was extracted.
  // An empty result (provenance-only) clutters the YAML for no value.
  if (Object.keys(result).length === 0) return null;
  if (Object.keys(provenance).length > 0) result._provenance = provenance;
  return result;
}

/**
 * Reduce `/api/foo/bar` to `/api`. Returns null if the path doesn't have at
 * least one slash-segment.
 */
function extractPrefixBase(prefix: string): string | null {
  if (!prefix.startsWith('/')) return null;
  const stripped = prefix.replace(/^\/+/, '');
  const firstSeg = stripped.split('/')[0];
  if (!firstSeg) return null;
  return '/' + firstSeg;
}

// ============================================================
// Swift adapter
// ============================================================

function introspectSwift(
  detection: DetectionResult,
  projectRoot: string,
): DetectedSwift | null {
  const sourceDir = resolveSourceDir(detection, 'swift', projectRoot);
  if (!sourceDir) return null;

  // Prefer View files first, then any .swift.
  const viewFiles = sampleFiles(sourceDir, /\.swift$/, name =>
    /View\.swift$/.test(name),
  );
  const fallbackFiles = viewFiles.length === 0
    ? sampleFiles(sourceDir, /\.swift$/)
    : [];
  const candidates = [...viewFiles, ...fallbackFiles].slice(
    0,
    MAX_SAMPLES_PER_ADAPTER,
  );

  if (candidates.length === 0) return null;

  const apiClasses = new Map<string, string>();
  const biometricPolicies = new Map<string, string>();

  for (const path of candidates) {
    const body = readSafe(path);
    if (body === null) continue;

    // API client class: looks like `let api = SomeAPI()` or
    // `@StateObject var api: SomeAPI = .shared` etc.
    // Extract `SomeAPI` from `SomeAPI(`/`SomeAPI.shared`/`: SomeAPI`.
    const apiRegex = /\b([A-Z][A-Za-z0-9_]*API)\s*(?:\(|\.shared|\b)/gu;
    forEachMatch(apiRegex, body, m => {
      const name = m[1];
      if (!apiClasses.has(name)) apiClasses.set(name, path);
    });

    // LocalAuthentication policy: `LAPolicy.<name>` or `.<name>` after
    // `evaluatePolicy(`. Whitelist known good values to avoid false positives.
    const policyRegex = /\.(deviceOwnerAuthentication(?:WithBiometrics)?)\b/gu;
    forEachMatch(policyRegex, body, m => {
      const name = m[1];
      if (!biometricPolicies.has(name)) biometricPolicies.set(name, path);
    });
  }

  const apiClass = pickBestSingleton(apiClasses);
  const biometricPolicy = pickBestSingleton(biometricPolicies);

  const result: DetectedSwift = {};
  const provenance: Record<string, string> = {};

  if (apiClass) {
    result.api_client_class = apiClass.value;
    provenance.api_client_class_source = relativeTo(projectRoot, apiClass.source);
  }
  if (biometricPolicy) {
    result.biometric_policy = biometricPolicy.value;
    provenance.biometric_policy_source = relativeTo(projectRoot, biometricPolicy.source);
  }

  if (Object.keys(result).length === 0) return null;
  if (Object.keys(provenance).length > 0) result._provenance = provenance;
  return result;
}

// ============================================================
// TypeScript / Next.js + tRPC adapter
// ============================================================

function introspectTypeScript(
  detection: DetectionResult,
  projectRoot: string,
): DetectedTypeScript | null {
  const sourceDir = resolveSourceDir(detection, 'typescript', projectRoot)
    ?? resolveSourceDir(detection, 'javascript', projectRoot);
  if (!sourceDir) return null;

  // Look for tRPC router files first.
  const routerFiles = sampleFiles(sourceDir, /\.tsx?$/, name =>
    /(router|trpc)/i.test(name),
  );
  const candidates = routerFiles.slice(0, MAX_SAMPLES_PER_ADAPTER);

  if (candidates.length === 0) return null;

  const builders = new Map<string, string>();
  const procedurePatterns = new Map<string, string>();

  for (const path of candidates) {
    const body = readSafe(path);
    if (body === null) continue;

    // tRPC router builder: `createTRPCRouter({ ... })`. Whitelist known names
    // (createTRPCRouter, router, t.router) — never grep for arbitrary identifiers.
    const builderRegex = /\b(createTRPCRouter|router|t\.router)\s*\(/gu;
    forEachMatch(builderRegex, body, m => {
      const name = m[1];
      if (!builders.has(name)) builders.set(name, path);
    });

    // Procedure pattern: `publicProcedure.input(...).query(...)` →
    // capture just the procedure name (`publicProcedure`/`protectedProcedure`).
    const procRegex = /\b([a-z]+Procedure)\b/gu;
    forEachMatch(procRegex, body, m => {
      const name = m[1];
      if (!procedurePatterns.has(name)) procedurePatterns.set(name, path);
    });
  }

  const builder = pickBestSingleton(builders);
  const proc = pickBestSingleton(procedurePatterns);

  const result: DetectedTypeScript = {};
  const provenance: Record<string, string> = {};

  if (builder) {
    result.trpc_router_builder = builder.value;
    provenance.trpc_router_builder_source = relativeTo(projectRoot, builder.source);
  }
  if (proc) {
    result.procedure_pattern = proc.value;
    provenance.procedure_pattern_source = relativeTo(projectRoot, proc.source);
  }

  if (Object.keys(result).length === 0) return null;
  if (Object.keys(provenance).length > 0) result._provenance = provenance;
  return result;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Resolve the dominant source directory for a language, falling back to the
 * project root if detection didn't surface anything specific.
 */
function resolveSourceDir(
  detection: DetectionResult,
  lang: string,
  projectRoot: string,
): string | null {
  // sourceDirs has language → SourceDirInfo. Type system uses SupportedLanguage,
  // but introspect() is called with arbitrary language strings; widen via Record.
  const dirs = (detection.sourceDirs as unknown as Record<string, { source_dirs?: string[] }>);
  const info = dirs[lang];
  const list = info?.source_dirs ?? [];
  if (list.length > 0) {
    const first = list[0];
    const abs = resolve(projectRoot, first);
    return existsSync(abs) ? abs : null;
  }
  // Fall back to the project root itself for tiny projects with no sub-dirs.
  return existsSync(projectRoot) ? projectRoot : null;
}

/**
 * Walk `dir` and return up to MAX_SAMPLES_PER_ADAPTER files matching `nameRegex`,
 * filtered further by `nameFilter`. Skips dot-dirs, node_modules, .venv, etc.
 * Bounded depth.
 */
function sampleFiles(
  dir: string,
  nameRegex: RegExp,
  nameFilter?: (name: string) => boolean,
): string[] {
  const out: string[] = [];
  const stack: { path: string; depth: number }[] = [{ path: dir, depth: 0 }];

  while (stack.length > 0 && out.length < MAX_SAMPLES_PER_ADAPTER * 4) {
    const { path, depth } = stack.pop()!;
    if (depth > MAX_DIR_DEPTH) continue;

    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (entry === 'node_modules') continue;
      if (entry === '__pycache__') continue;
      if (entry === 'venv' || entry === '.venv') continue;
      if (entry === 'dist' || entry === 'build') continue;

      const child = join(path, entry);
      let st;
      try {
        st = statSync(child);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        stack.push({ path: child, depth: depth + 1 });
        continue;
      }

      if (!nameRegex.test(entry)) continue;
      if (nameFilter && !nameFilter(entry)) continue;
      if (st.size > MAX_FILE_BYTES) continue;
      out.push(child);
      if (out.length >= MAX_SAMPLES_PER_ADAPTER * 4) break;
    }
  }

  // Stable ordering — deterministic test fixtures.
  out.sort();
  return out.slice(0, MAX_SAMPLES_PER_ADAPTER * 2);
}

/** Read a file as UTF-8. Returns null on any error or if too large. */
function readSafe(path: string): string | null {
  try {
    const st = statSync(path);
    if (st.size > MAX_FILE_BYTES) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Run a global regex over `body` and call `cb` for each match. Caps iteration
 * at 1000 matches per regex to defend against pathological inputs.
 */
function forEachMatch(
  re: RegExp,
  body: string,
  cb: (m: RegExpExecArray) => void,
): void {
  if (!re.global) return;
  re.lastIndex = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    cb(m);
    count++;
    if (count > 1000) break;
    // Defensive: zero-width match → bump lastIndex to avoid infinite loop.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

/**
 * If `samples` has exactly one distinct value, return it.
 * If it has 2 values, return the first-seen (stable, deterministic order from
 * file walk).
 * If it has 3+ distinct values, return null — Risk #6 (auth-dep ambiguity).
 */
function pickBestSingleton(
  samples: Map<string, string>,
): { value: string; source: string } | null {
  if (samples.size === 0) return null;
  if (samples.size >= 3) return null;
  const [firstKey, firstSource] = samples.entries().next().value as [string, string];
  return { value: firstKey, source: firstSource };
}

/** Make a file path relative to the project root. */
function relativeTo(projectRoot: string, absPath: string): string {
  if (absPath.startsWith(projectRoot + '/')) {
    return absPath.slice(projectRoot.length + 1);
  }
  return basename(absPath);
}
