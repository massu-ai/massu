// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P5-002 (plan-living-memory-slice-2a-embedder): embedder asset-ship drift-guard.
 *
 * Prevents "semantic recall silently degraded to keyword because the bundled
 * model/vocab did not ship in the tarball." Asserts:
 *   1. SOURCE assets exist (assets/embedder/{model_quantized.onnx,vocab.txt,MODEL-LICENSE}).
 *   2. package.json `files` covers dist/ (via the dist/**\/* glob) — so the copied
 *      dist/embedder assets ship in `npm pack` by construction (GAP-005).
 *   3. onnxruntime-web (the WASM runtime) resolves and ships its .wasm.
 *   4. When dist/ is built, dist/embedder/{model_quantized.onnx,vocab.txt} exist.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { createRequire } from 'module';

const CORE_ROOT = resolve(__dirname, '..', '..');
const ASSETS_DIR = join(CORE_ROOT, 'assets', 'embedder');
const DIST_ASSETS_DIR = join(CORE_ROOT, 'dist', 'embedder');

describe('P5-002: embedder asset-ship drift-guard', () => {
  it('ships the SOURCE model + vocab + license under assets/embedder/', () => {
    for (const f of ['model_quantized.onnx', 'vocab.txt', 'MODEL-LICENSE']) {
      const p = join(ASSETS_DIR, f);
      expect(existsSync(p), `${f} must exist in assets/embedder/`).toBe(true);
    }
    // The model must be a real multi-MB artifact, not an LFS pointer / HTML error.
    const onnxSize = statSync(join(ASSETS_DIR, 'model_quantized.onnx')).size;
    expect(onnxSize).toBeGreaterThan(10_000_000); // ~22 MB int8 model
  });

  it('package.json `files` covers dist/ so copied embedder assets ship (GAP-005)', () => {
    const pkg = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf-8')) as {
      files?: string[];
    };
    const files = pkg.files ?? [];
    // dist/**/* (or dist or dist/**) — any glob that ships the dist tree.
    const coversDist = files.some((f) => /^dist(\/\*\*(\/\*)?)?$/.test(f) || f === 'dist/**/*');
    expect(coversDist, `files must cover dist/ — got ${JSON.stringify(files)}`).toBe(true);
  });

  it('onnxruntime-web resolves and ships a .wasm runtime', () => {
    const req = createRequire(import.meta.url);
    const entry = req.resolve('onnxruntime-web');
    const ortDist = dirname(entry);
    const wasmFiles = readdirSync(ortDist).filter((f) => f.endsWith('.wasm'));
    expect(wasmFiles.length, `onnxruntime-web dist (${ortDist}) must contain .wasm`).toBeGreaterThan(
      0,
    );
  });

  it('dist/embedder holds the copied model + vocab after build:assets', () => {
    // FAIL CLOSED (G-1, plan-2026-07-26-anti-vacuity-9-unproven-gates): the previous
    // `return` made "assets were never copied" and "both assets are present" report
    // the same PASS, which is the only state this test exists to tell apart.
    expect(
      existsSync(DIST_ASSETS_DIR),
      `${DIST_ASSETS_DIR} missing — the shipped embedder assets cannot be checked. ` +
        'Run "npm run build:assets" (packages/core). Do NOT restore the skip.',
    ).toBe(true);
    for (const f of ['model_quantized.onnx', 'vocab.txt']) {
      expect(existsSync(join(DIST_ASSETS_DIR, f)), `dist/embedder/${f} must exist post-build`).toBe(
        true,
      );
    }
  });
});
