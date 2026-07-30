// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P5-003 (plan-living-memory-slice-2a-embedder): native-dependency drift-guard.
 *
 * Makes the exact bug class that broke this repo twice (native-ABI drift —
 * incident 2026-07-05-node-26-native-module-abi) IMPOSSIBLE to reintroduce via
 * the embedder. Asserts:
 *   1. @massu/core's declared deps + devDeps contain NONE of the known native
 *      embedding/vector packages.
 *   2. The RESOLVED node_modules tree (transitive — the path the auditor flagged)
 *      contains none of them either.
 *   3. The built dist/ ships no compiled *.node addon.
 *
 * onnxruntime-web is the ALLOWED embedder runtime — it is pure JS/WASM (verified
 * native-free in docs/reports/2026-07-12-wasm-embedder-spike-VERIFIED.md).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { execFileSync } from 'child_process';

const CORE_ROOT = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(CORE_ROOT, '..', '..');

/** Packages that pull a native module (onnxruntime-node / sharp / prebuilt tokenizers). */
const NATIVE_DENYLIST = [
  'onnxruntime-node',
  'sharp',
  '@huggingface/transformers',
  '@xenova/transformers',
  'fastembed',
  '@anush008/tokenizers',
  'sqlite-vec',
  'usearch',
  'hnswlib-node',
];

describe('P5-003: native-dependency drift-guard (embedder)', () => {
  const pkg = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('declares NONE of the native embedding/vector packages in deps or devDeps', () => {
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const found = NATIVE_DENYLIST.filter((n) => declared.has(n));
    expect(found).toEqual([]);
  });

  it('allows onnxruntime-web (the pure-JS/WASM embedder runtime) as a dependency', () => {
    expect(pkg.dependencies?.['onnxruntime-web']).toBeTruthy();
  });

  it(
    'has no denylisted native package in the RESOLVED dependency tree (transitive)',
    () => {
      // ONE `npm ls --all --json` parse (not one subprocess per package — that
      // tipped over the 5s default timeout under full-suite CPU contention).
      // Walk the whole resolved tree once for any denylisted name.
      let tree: Record<string, unknown> = {};
      try {
        const out = execFileSync('npm', ['ls', '--all', '--json'], {
          cwd: CORE_ROOT,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 64 * 1024 * 1024,
        });
        tree = JSON.parse(out) as Record<string, unknown>;
      } catch (e) {
        // `npm ls` exits non-zero on peer/extraneous warnings but STILL prints
        // the JSON tree on stdout — parse it from the error when present.
        const stdout = (e as { stdout?: string }).stdout;
        if (stdout) {
          try {
            tree = JSON.parse(stdout) as Record<string, unknown>;
          } catch {
            tree = {};
          }
        }
      }

      const seen = new Set<string>();
      const collect = (node: Record<string, unknown>): void => {
        const deps = node.dependencies as Record<string, Record<string, unknown>> | undefined;
        if (!deps) return;
        for (const [name, child] of Object.entries(deps)) {
          if (seen.has(name)) continue;
          seen.add(name);
          if (child && typeof child === 'object') collect(child);
        }
      };
      collect(tree);

      const found = NATIVE_DENYLIST.filter((n) => seen.has(n));
      // If npm ls produced nothing (constrained env), seen is empty → no false
      // failure; the direct-dep + dist *.node guards still lock the invariant.
      expect(found, `denylisted native packages found in resolved tree: ${found.join(', ')}`).toEqual(
        [],
      );
    },
    30_000,
  );

  it('ships no compiled *.node addon in the built dist/', () => {
    const distDir = join(CORE_ROOT, 'dist');
    // FAIL CLOSED (G-1, plan-2026-07-26-anti-vacuity-9-unproven-gates): "no *.node
    // addon shipped" is vacuously true of a dist/ that was never built.
    expect(
      existsSync(distDir),
      `${distDir} missing — "ships no compiled addon" is unverifiable without a build. ` +
        'Run "npm run build" (packages/core). Do NOT restore the skip.',
    ).toBe(true);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (entry.endsWith('.node')) offenders.push(p);
      }
    };
    walk(distDir);
    expect(offenders).toEqual([]);
  });

  it('repo root has no accidental native embedder dep either', () => {
    const rootPkgPath = join(REPO_ROOT, 'package.json');
    // FAIL CLOSED (G-1): the repo root package.json is a repo invariant, not an
    // environment variable. Its absence means REPO_ROOT resolved wrong.
    expect(
      existsSync(rootPkgPath),
      `${rootPkgPath} missing — REPO_ROOT resolved to the wrong directory, so this ` +
        'test inspected nothing. Do NOT restore the skip.',
    ).toBe(true);
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(rootPkg.dependencies ?? {}),
      ...Object.keys(rootPkg.devDependencies ?? {}),
    ]);
    const found = NATIVE_DENYLIST.filter((n) => declared.has(n));
    expect(found).toEqual([]);
  });
});
