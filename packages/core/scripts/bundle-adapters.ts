#!/usr/bin/env tsx
/**
 * Plan 3c Phase 9b P-B-001 + P-B-008: bundle workspace-canonical adapters
 * into `@massu/core/dist/detect/adapters/<id>.js` so the published @massu/core
 * tarball ships CORE-BUNDLED versions of each first-party adapter.
 *
 * Source-of-truth: each `packages/adapter-<id>/dist/index.js` (built by the
 * adapter package's own `tsc -p .`). The bundler:
 *   1. esbuilds the workspace adapter dist into core's dist/detect/adapters/.
 *   2. esbuilds `packages/core/src/adapter.ts` into `dist/adapter.js` so the
 *      `@massu/core/adapter` subpath resolves at downstream runtime (P-B-008).
 *   3. esbuilds the 3 helper modules (query-helpers, parse-guard,
 *      tree-sitter-loader) into dist/detect/adapters/ so the runtime helpers
 *      re-exported from `@massu/core/adapter` resolve correctly.
 *   4. Computes sha256 per output file → writes
 *      `dist/detect/adapters/.bundle-shasums.json` (sentinel for the
 *      reproducibility test in P-B-003).
 *
 * Externals match `build:cli` so adapters don't try to inline web-tree-sitter,
 * tweetnacl, etc. into core's bundled dist (those are already runtime deps of
 * @massu/core itself).
 *
 * Build ordering (root package.json scripts.build):
 *   1. `npm run build:adapters` — produces packages/adapter-<id>/dist/index.js
 *   2. `npm run build --workspace=packages/core` — runs build:bundle-adapters
 *      LAST in core's pipeline so it reads freshly-built adapter dist files.
 */

import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// repo-relative path resolution: scripts/ lives under packages/core/
const PKG_CORE = resolve(__dirname, '..');
const PKG_ROOT = resolve(PKG_CORE, '..', '..');

// P-M-032 (plan-stage-d-medium-sweep, commit 6944c11): goChi, phoenix, and
// aspnet adapters were REMOVED from the source tree (see
// packages/core/src/detect/codebase-introspector.ts:61). Their npm packages
// are deprecated. The two remaining first-party framework adapters are
// `rails` and `spring`. This list MUST stay in lockstep with the
// `packages/adapter-*` workspaces and the `src/detect/adapters/*.ts`
// source files — drift here causes prepublishOnly to fail with
// "missing entry for adapter" (real drift surfaced by ef9a763 ceremony).
const ADAPTERS = ['rails', 'spring'] as const;

const HELPERS = [
  // module name (no extension) → src path (relative to PKG_CORE)
  ['query-helpers', 'src/detect/adapters/query-helpers.ts'],
  ['parse-guard', 'src/detect/adapters/parse-guard.ts'],
  ['tree-sitter-loader', 'src/detect/adapters/tree-sitter-loader.ts'],
  ['types', 'src/detect/adapters/types.ts'],
] as const;

// External dependencies — keep in lockstep with build:cli externals so the
// bundled output references runtime npm deps instead of inlining them.
const EXTERNALS = [
  'better-sqlite3',
  'yaml',
  'zod',
  'chokidar',
  'proper-lockfile',
  'fsevents',
  'web-tree-sitter',
  'tweetnacl',
  'tar',
  'smol-toml',
  'vscode-languageserver-protocol',
];

function sha256OfFile(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function bundleAdapter(id: string): Promise<{ id: string; outPath: string; sha256: string }> {
  const adapterDir = join(PKG_ROOT, 'packages', `adapter-${id}`);
  const entry = join(adapterDir, 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(
      `bundle-adapters: missing entry for adapter "${id}" at ${entry}\n` +
        `Run "npm run build:adapters" at repo root first (root package.json scripts.build does this in order).`,
    );
  }
  const outPath = join(PKG_CORE, 'dist', 'detect', 'adapters', `${id}.js`);
  mkdirSync(dirname(outPath), { recursive: true });

  await build({
    entryPoints: [entry],
    outfile: outPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: EXTERNALS,
    // Adapters consume `@massu/core/adapter` — at bundle time, the alias should
    // resolve to the SAME-package `dist/adapter.js` we emit below. Mark as
    // external so esbuild doesn't try to inline it (would create a circular
    // bundle). The runtime resolver will pick up dist/adapter.js via the
    // package.json exports map.
    alias: {
      '@massu/core/adapter': join(PKG_CORE, 'src', 'adapter.ts'),
    },
    logLevel: 'warning',
  });

  return { id, outPath, sha256: sha256OfFile(outPath) };
}

async function bundleAdapterSubpath(): Promise<{ id: string; outPath: string; sha256: string }> {
  const entry = join(PKG_CORE, 'src', 'adapter.ts');
  const outPath = join(PKG_CORE, 'dist', 'adapter.js');
  mkdirSync(dirname(outPath), { recursive: true });
  await build({
    entryPoints: [entry],
    outfile: outPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: EXTERNALS,
    logLevel: 'warning',
  });
  return { id: '@massu/core/adapter', outPath, sha256: sha256OfFile(outPath) };
}

async function bundleHelper(modName: string, srcRel: string): Promise<{ id: string; outPath: string; sha256: string }> {
  const entry = join(PKG_CORE, srcRel);
  const outPath = join(PKG_CORE, 'dist', 'detect', 'adapters', `${modName}.js`);
  mkdirSync(dirname(outPath), { recursive: true });
  await build({
    entryPoints: [entry],
    outfile: outPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: EXTERNALS,
    logLevel: 'warning',
  });
  return { id: modName, outPath, sha256: sha256OfFile(outPath) };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subpathOnly = args.includes('--subpath-only');

  const results: Array<{ id: string; outPath: string; sha256: string }> = [];

  // 1. Bundle adapter subpath FIRST. In `--subpath-only` mode, this runs
  //    before adapters are built so they can resolve `@massu/core/adapter`
  //    against the freshly-emitted dist/adapter.js + dist/adapter.d.ts.
  console.log('[bundle-adapters] Bundling @massu/core/adapter subpath…');
  const subpathResult = await bundleAdapterSubpath();
  results.push(subpathResult);
  console.log(`  ✓ ${subpathResult.id}: ${subpathResult.outPath} (sha256=${subpathResult.sha256.slice(0, 12)}…)`);

  // 2. Bundle the helper modules (also needed by `@massu/core/adapter`
  //    runtime resolution since adapter.ts re-exports from these).
  console.log('[bundle-adapters] Bundling adapter helper modules…');
  for (const [name, src] of HELPERS) {
    const r = await bundleHelper(name, src);
    results.push(r);
    console.log(`  ✓ ${r.id}: ${r.outPath} (sha256=${r.sha256.slice(0, 12)}…)`);
  }

  if (subpathOnly) {
    console.log('[bundle-adapters] --subpath-only: stopping before workspace adapter bundling.');
    return;
  }

  // 3. Bundle each workspace adapter into core's dist/detect/adapters/.
  console.log(`[bundle-adapters] Bundling ${ADAPTERS.length} workspace adapters into @massu/core/dist…`);
  for (const id of ADAPTERS) {
    const r = await bundleAdapter(id);
    results.push(r);
    console.log(`  ✓ ${r.id}: ${r.outPath} (sha256=${r.sha256.slice(0, 12)}…)`);
  }

  // 4. Write the sentinel manifest (only on full bundle so the sentinel
  //    captures the complete set).
  const sentinel: Record<string, string> = {};
  for (const r of results) {
    sentinel[r.id] = r.sha256;
  }
  const sentinelPath = join(PKG_CORE, 'dist', 'detect', 'adapters', '.bundle-shasums.json');
  writeFileSync(sentinelPath, JSON.stringify(sentinel, null, 2) + '\n', 'utf-8');
  console.log(`[bundle-adapters] Wrote sentinel: ${sentinelPath}`);
  console.log(`[bundle-adapters] Done. Bundled ${results.length} files.`);
}

main().catch((err) => {
  console.error('[bundle-adapters] FAILED:', err);
  process.exit(1);
});
