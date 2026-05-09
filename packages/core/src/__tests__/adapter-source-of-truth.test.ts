// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3c Phase 9b P-B-004: drift-prevention #1 — source-of-truth invariant.
 *
 * For each id in `CORE_BUNDLED_IDS`, asserts EXACTLY ONE of:
 *   (a) `packages/core/src/detect/adapters/<id>.ts` is the CANONICAL source
 *       (≥5 lines of substantive code) AND no `packages/adapter-<id>` package
 *       exists.
 *   (b) `packages/adapter-<id>/src/index.ts` is the CANONICAL source AND
 *       `packages/core/src/detect/adapters/<id>.ts` is a thin re-export
 *       (≤5 lines of substantive code, single `export {…} from '@massu/adapter-<id>'`
 *       statement).
 *
 * Mixed/duplicated source FAILs. This is the core CR-46 drift-prevention
 * gate for Phase 9b's workspace-canonical model.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_BUNDLED_IDS } from '../detect/adapters/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_CORE = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(PKG_CORE, '..', '..');

/** Substantive (non-blank, non-comment-only) line count of a TS source file. */
function substantiveLines(source: string): number {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (trimmed.startsWith('//')) return false;
      if (trimmed.startsWith('*')) return false;
      if (trimmed.startsWith('/*')) return false;
      if (trimmed === '*/') return false;
      return true;
    }).length;
}

describe('adapter source-of-truth invariant (P-B-004 / drift-prevention #1)', () => {
  for (const id of CORE_BUNDLED_IDS) {
    it(`${id}: source lives in EXACTLY ONE place (workspace OR core, never both)`, () => {
      const corePath = resolve(PKG_CORE, 'src', 'detect', 'adapters', `${id}.ts`);
      const workspacePath = resolve(REPO_ROOT, 'packages', `adapter-${id}`, 'src', 'index.ts');

      const coreExists = existsSync(corePath);
      const workspaceExists = existsSync(workspacePath);

      if (workspaceExists) {
        // Pattern (b): workspace-canonical. Core file MUST be a thin re-export.
        expect(coreExists, `core re-export shim missing for "${id}" at ${corePath}`).toBe(true);

        const workspaceSrc = readFileSync(workspacePath, 'utf-8');
        const coreSrc = readFileSync(corePath, 'utf-8');

        const workspaceLines = substantiveLines(workspaceSrc);
        const coreLines = substantiveLines(coreSrc);

        // Workspace must be the canonical source: ≥5 substantive lines.
        expect(
          workspaceLines,
          `workspace adapter "${id}" should have substantive source at ${workspacePath}`,
        ).toBeGreaterThanOrEqual(5);

        // Core must be the thin shim: ≤5 substantive lines, contains a
        // `from '@massu/adapter-<id>'` re-export statement.
        expect(
          coreLines,
          `core re-export shim for "${id}" should be ≤5 substantive lines, found ${coreLines} at ${corePath}`,
        ).toBeLessThanOrEqual(5);
        expect(
          coreSrc.includes(`from '@massu/adapter-${id}'`),
          `core re-export shim for "${id}" must import from "@massu/adapter-${id}"`,
        ).toBe(true);
      } else {
        // Pattern (a): core-canonical. Core file MUST be substantive.
        expect(coreExists, `canonical adapter source missing for "${id}" at ${corePath}`).toBe(true);

        const coreSrc = readFileSync(corePath, 'utf-8');
        const coreLines = substantiveLines(coreSrc);

        expect(
          coreLines,
          `core adapter "${id}" should have substantive source at ${corePath}`,
        ).toBeGreaterThan(5);
      }
    });
  }
});
