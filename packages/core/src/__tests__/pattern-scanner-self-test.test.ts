// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 2026-05-07-pattern-scanner-fail-fixes — Layer D drift-guard.
 *
 * Wraps `bash scripts/massu-pattern-scanner.sh` in a vitest assertion so
 * any future commit that:
 *   - introduces a real Check 1 / Check 5 violation (require()/yaml-parse
 *     in source without a `// pattern-scanner-allow: <key>` directive),
 *   - removes a directive without removing the underlying call,
 *   - modifies the scanner in a way that breaks its filter logic,
 *   - or trips any other check (1-12) the scanner enforces,
 * fails CI immediately at `npm test` instead of at a manual scan run.
 *
 * Mirrors the pattern of `core-bundled-ids-drift.test.ts` and
 * `tree-sitter-loader-manifest.test.ts` from the Phase 7 work — the
 * scanner becomes self-asserting via the standard test suite.
 *
 * Why this is the structural answer (CR-46 #2): the scanner exists to
 * enforce coding patterns, but until now it was only invoked
 * out-of-band (pre-push hook + manual). Wiring it into vitest makes
 * the enforcement IMPOSSIBLE to bypass during normal development —
 * `npm test` runs in every PR check and pre-commit hook.
 */

import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// Resolve the repo root deterministically. __dirname is
// `packages/core/src/__tests__`; the repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SCANNER_PATH = resolve(REPO_ROOT, 'scripts', 'massu-pattern-scanner.sh');

describe('pattern-scanner self-test (Plan 2026-05-07 drift-guard)', () => {
  // Timeout bumped 30s post plan-public-content-leak-guard Check 16
  // (scans 129 MDX files in website/content/; adds ~2-13s depending on
  // CI vs local). Default 5s was already tight pre-Check-16; new check
  // pushes it past the default reliably.
  it('massu-pattern-scanner.sh exits 0 against current source tree', { timeout: 30000 }, () => {
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      stdout = execSync(`bash ${SCANNER_PATH}`, {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
      exitCode = e.status ?? -1;
      stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf-8') ?? '');
      stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf-8') ?? '');
    }

    if (exitCode !== 0) {
      // Surface the scanner's own output in the assertion message so a
      // failing CI run shows the same operator-friendly diagnostic the
      // pre-push hook would. Truncate to keep vitest output readable.
      const tailLines = stdout.split('\n').slice(-30).join('\n');
      throw new Error(
        `pattern-scanner.sh exited ${exitCode}.\n\n` +
          `--- scanner stdout (last 30 lines) ---\n${tailLines}\n` +
          (stderr ? `--- scanner stderr ---\n${stderr}\n` : '') +
          `\nFix the violation OR add a // pattern-scanner-allow: <key> directive on the line BEFORE the call (see scripts/massu-pattern-scanner.sh scan_with_directive helper).`,
      );
    }

    expect(stdout).toMatch(/All pattern checks passed/);
  });
});
