// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.
//
// build:assets (plan-living-memory-slice-2a-embedder, P1-003): copy the bundled
// embedder assets (int8 ONNX model + vocab + model license) from the SOURCE
// assets/embedder/ into dist/embedder/ so the `files` "dist/**/*" glob ships
// them in the @massu/core tarball (GAP-005). Invoked by `npm run build`.

import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(pkgRoot, 'assets', 'embedder');
const destDir = join(pkgRoot, 'dist', 'embedder');

if (!existsSync(srcDir)) {
  console.error(`build:assets FAILED — source asset dir missing: ${srcDir}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
let copied = 0;
for (const name of readdirSync(srcDir)) {
  copyFileSync(join(srcDir, name), join(destDir, name));
  copied++;
}

// Fail loud if the two load-bearing runtime assets did not land.
for (const required of ['model_quantized.onnx', 'vocab.txt']) {
  if (!existsSync(join(destDir, required))) {
    console.error(`build:assets FAILED — required asset missing after copy: ${required}`);
    process.exit(1);
  }
}
console.log(`build:assets — copied ${copied} embedder asset(s) to dist/embedder/`);
