// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard (plan-2026-06-01-claude-md-size-compliance, B-003): asserts the
 * CLAUDE.md size gate (scripts/check-claude-md-size.sh) is wired into ALL THREE
 * enforcement layers, so the gate itself cannot be silently removed — the
 * meta-failure that let CLAUDE.md drift to ~2x its budget unobserved.
 *
 *   (a) scripts/pre-push-light.sh        invokes check-claude-md-size.sh
 *   (b) .github/workflows/ci.yml         invokes check-claude-md-size.sh
 *   (c) scripts/hooks/pre-commit-gate.sh invokes check-claude-md-size.sh
 *
 * Mirrors the read-the-source-files approach of ci-prepush-parity.test.ts
 * (same dir, same REPO_ROOT pattern). The skipIf(!IS_INTERNAL_REPO) guard
 * matches that file's precedent: all three scripts DO sync to the public
 * mirror, but the guard is defensive against a future sync-exclusion change.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../../..');

const SIZE_SCRIPT = 'check-claude-md-size.sh';

/**
 * Internal repo carries website/ + docs/; the public mirror does not. Used to
 * gate asserts that read internal-tree script layout (same precedent as
 * ci-prepush-parity.test.ts:IS_INTERNAL_REPO).
 */
const IS_INTERNAL_REPO =
  existsSync(resolve(REPO_ROOT, 'website')) && existsSync(resolve(REPO_ROOT, 'docs'));

function readIfExists(rel: string): string | null {
  const p = resolve(REPO_ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}

describe('claude-md-size-gate (B-003 drift-guard — size gate wired three-layer)', () => {
  it.skipIf(!IS_INTERNAL_REPO)('pre-push-light.sh invokes check-claude-md-size.sh', () => {
    const content = readIfExists('scripts/pre-push-light.sh');
    expect(content, 'scripts/pre-push-light.sh must exist in the internal repo').not.toBeNull();
    expect(
      content!.includes(SIZE_SCRIPT),
      'scripts/pre-push-light.sh must invoke check-claude-md-size.sh (size gate layer 1)',
    ).toBe(true);
  });

  it.skipIf(!IS_INTERNAL_REPO)('ci.yml has a step that invokes check-claude-md-size.sh', () => {
    const content = readIfExists('.github/workflows/ci.yml');
    expect(content, '.github/workflows/ci.yml must exist in the internal repo').not.toBeNull();
    const doc = parseYaml(content!) as {
      jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
    };
    const runs: string[] = [];
    for (const job of Object.values(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run === 'string') runs.push(step.run);
      }
    }
    expect(
      runs.some((r) => r.includes(SIZE_SCRIPT)),
      'ci.yml must have a step whose run invokes check-claude-md-size.sh (size gate layer 2)',
    ).toBe(true);
  });

  it.skipIf(!IS_INTERNAL_REPO)('pre-commit-gate.sh invokes check-claude-md-size.sh', () => {
    const content = readIfExists('scripts/hooks/pre-commit-gate.sh');
    expect(content, 'scripts/hooks/pre-commit-gate.sh must exist in the internal repo').not.toBeNull();
    expect(
      content!.includes(SIZE_SCRIPT),
      'scripts/hooks/pre-commit-gate.sh must invoke check-claude-md-size.sh (size gate layer 3)',
    ).toBe(true);
  });

  it.skipIf(!IS_INTERNAL_REPO)('the autosplit remedy tool exists and is referenced by the size script', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'scripts/claude-md-autosplit.sh')),
      'scripts/claude-md-autosplit.sh (the auto-adjust remedy tool) must exist',
    ).toBe(true);
    const sizeScript = readIfExists(`scripts/${SIZE_SCRIPT}`);
    expect(sizeScript).not.toBeNull();
    expect(
      sizeScript!.includes('claude-md-autosplit.sh'),
      'check-claude-md-size.sh REMEDY message must point at claude-md-autosplit.sh',
    ).toBe(true);
  });
});
