// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 9b P-B-006: R6 mitigation — every CORE_BUNDLED_IDS entry
 * MUST have a corresponding `dist/detect/adapters/<id>.js` after
 * `npm run build`. Catches typos in `bundle-adapters.ts` config (e.g.
 * adding a new adapter to CORE_BUNDLED_IDS without listing its id in
 * the bundler's ADAPTERS array).
 *
 * Skipped (not failed) when dist is missing — local dev convenience.
 * CI MUST run `npm run build` before tests.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_BUNDLED_IDS } from '../detect/adapters/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_CORE = resolve(__dirname, '..', '..');
const DIST_ADAPTERS = resolve(PKG_CORE, 'dist', 'detect', 'adapters');
const REPO_ROOT = resolve(PKG_CORE, '..', '..');

describe('core-bundled adapter dist files presence (P-B-006)', () => {
  for (const id of CORE_BUNDLED_IDS) {
    const workspaceSrc = resolve(REPO_ROOT, 'packages', `adapter-${id}`, 'src', 'index.ts');
    if (!existsSync(workspaceSrc)) {
      // Adapter is core-canonical (Pattern (a) per P-B-004) — not bundled
      // by the workspace bundler. Skip; covered by tarball-e2e tests.
      continue;
    }

    it(`${id}: has dist/detect/adapters/${id}.js after build (workspace-canonical)`, () => {
      const distFile = resolve(DIST_ADAPTERS, `${id}.js`);
      if (!existsSync(resolve(DIST_ADAPTERS, '.bundle-shasums.json'))) {
        console.warn(`[core-bundled-files-presence] SKIP ${id}: dist not built (run "npm run build" first)`);
        return;
      }
      expect(existsSync(distFile), `${distFile} missing — bundle-adapters.ts didn't emit ${id}.js`).toBe(true);
    });
  }
});
