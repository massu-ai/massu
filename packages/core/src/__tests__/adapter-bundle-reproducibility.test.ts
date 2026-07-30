// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 9b P-B-003: drift-prevention #2 — bundle reproducibility.
 *
 * Re-runs the bundle script (`scripts/bundle-adapters.ts`) and asserts the
 * sha256 of every output matches the sentinel committed at
 * `dist/detect/adapters/.bundle-shasums.json`. Drift means esbuild's output
 * is non-deterministic for our codebase (Node minor bump, esbuild minor
 * bump, source change without sentinel update, etc.).
 *
 * The test reads the existing dist sentinel — produced by `npm run build`
 * which the CI pipeline runs before tests. If the dist is missing, the
 * test SKIPS with a clear message rather than failing.
 *
 * This is the structural drift-guard for the workspace-canonical adapter
 * model: a workspace adapter's source CANNOT be edited without the
 * bundled output changing. If they drift, the manifest sha256 (Stage C
 * P-C-002) will also drift, and the registry verifier (Phase 9b §1) will
 * REFUSE the loaded adapter at install time.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// .test.ts → __tests__ → src → packages/core
const PKG_CORE = resolve(__dirname, '..', '..');
const DIST_ADAPTERS = resolve(PKG_CORE, 'dist', 'detect', 'adapters');
const SENTINEL = resolve(DIST_ADAPTERS, '.bundle-shasums.json');

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const SENTINEL_REMEDY =
  `${SENTINEL} missing — these tests cannot verify anything. ` +
  `Run "npm run build:adapters && npm run build:bundle-adapters" (packages/core). ` +
  `Do NOT restore the skip: a skipped it() is reported as PASSED ` +
  `(G-1, plan-2026-07-26-anti-vacuity-9-unproven-gates).`;

describe('bundle-adapters reproducibility (P-B-003 / drift-prevention #2)', () => {
  // FAIL CLOSED. Until G-1 this suite skipped on the absent sentinel — and the
  // first test then asserted that same sentinel exists, so it could not fail in
  // EITHER direction: absent -> skipped -> PASSED, present -> assertion trivially
  // true. ci-anti-vacuity.sh:25-26 names this file as a dist-artifact oracle.
  beforeAll(() => {
    expect(existsSync(SENTINEL), SENTINEL_REMEDY).toBe(true);
  });

  it('sentinel file exists after build', () => {
    expect(existsSync(SENTINEL), SENTINEL_REMEDY).toBe(true);
  });

  it('sentinel sha256 entries match on-disk dist files (round-trip)', () => {
    const sentinel = JSON.parse(readFileSync(SENTINEL, 'utf-8')) as Record<string, string>;
    const entries = Object.entries(sentinel);
    expect(entries.length).toBeGreaterThan(0);

    // For each sentinel entry, locate the on-disk file and recompute sha256.
    // Map the sentinel key → file path.
    const FRAMEWORKS = ['rails', 'phoenix', 'aspnet', 'spring', 'go-chi'];
    const HELPERS = ['query-helpers', 'parse-guard', 'tree-sitter-loader', 'types'];

    for (const [key, expectedSha] of entries) {
      let filePath: string;
      if (key === '@massu/core/adapter') {
        filePath = resolve(PKG_CORE, 'dist', 'adapter.js');
      } else if (FRAMEWORKS.includes(key) || HELPERS.includes(key)) {
        filePath = resolve(DIST_ADAPTERS, `${key}.js`);
      } else {
        throw new Error(`unknown sentinel key: ${key}`);
      }

      expect(existsSync(filePath)).toBe(true);
      const actualSha = sha256OfFile(filePath);
      expect(actualSha).toBe(expectedSha);
    }
  });

  it('sentinel covers all first-party workspace adapters + 4 helpers + the adapter subpath', () => {
    // P-M-032 (plan-stage-d-medium-sweep, commit 6944c11): aspnet, phoenix,
    // and go-chi adapters were REMOVED from source. The two remaining
    // first-party adapters are `rails` and `spring`. Total required keys:
    // 2 frameworks + 4 helpers + 1 subpath = 7. Drift-guard against the
    // P-M-032 removal is preserved by the explicit list below — adding a
    // new adapter requires touching THREE places (workspace package,
    // bundle-adapters.ts ADAPTERS, and this list) and the drift between
    // any two FAILs this test.
    const sentinel = JSON.parse(readFileSync(SENTINEL, 'utf-8')) as Record<string, string>;
    const keys = Object.keys(sentinel).sort();

    const expectedKeys = [
      '@massu/core/adapter',
      'parse-guard',
      'query-helpers',
      'rails',
      'spring',
      'tree-sitter-loader',
      'types',
    ].sort();

    expect(keys).toEqual(expectedKeys);
  });
});
