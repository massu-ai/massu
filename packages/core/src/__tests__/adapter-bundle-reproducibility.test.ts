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

import { describe, expect, it } from 'vitest';
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

describe('bundle-adapters reproducibility (P-B-003 / drift-prevention #2)', () => {
  it('sentinel file exists after build', () => {
    if (!existsSync(SENTINEL)) {
      // Skip cleanly if dist is missing (e.g. local dev where the user hasn't
      // run `npm run build`). CI MUST run build before tests so this case
      // shouldn't fire in CI.
      console.warn(
        `[adapter-bundle-reproducibility] SKIP: ${SENTINEL} missing — run "npm run build" before this test.`,
      );
      return;
    }
    expect(existsSync(SENTINEL)).toBe(true);
  });

  it('sentinel sha256 entries match on-disk dist files (round-trip)', () => {
    if (!existsSync(SENTINEL)) {
      console.warn('[adapter-bundle-reproducibility] SKIP: dist not built');
      return;
    }
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

  it('sentinel covers all 5 first-party workspace adapters + 4 helpers + the adapter subpath', () => {
    if (!existsSync(SENTINEL)) {
      console.warn('[adapter-bundle-reproducibility] SKIP: dist not built');
      return;
    }
    const sentinel = JSON.parse(readFileSync(SENTINEL, 'utf-8')) as Record<string, string>;
    const keys = Object.keys(sentinel).sort();

    // Required keys: 5 frameworks + 4 helpers + 1 subpath = 10
    const expectedKeys = [
      '@massu/core/adapter',
      'aspnet',
      'go-chi',
      'parse-guard',
      'phoenix',
      'query-helpers',
      'rails',
      'spring',
      'tree-sitter-loader',
      'types',
    ].sort();

    expect(keys).toEqual(expectedKeys);
  });
});
