// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/*
 * GATE FAIL-OPEN drift-guard (incident 2026-07-23).
 *
 * THE BUG CLASS: a gate that cannot perform its check prints a WARNing and `exit 0`.
 * It reads as PASS. It is not a pass — it is a gate that has stopped checking.
 *
 * REAL INSTANCE THAT MOTIVATED THIS: `massu-deploy-staleness-check.sh` (the CR-48 gate for
 * "shipped to npm but not deployed to Vercel") contained:
 *
 *     echo "WARN: could not parse Vercel deploy listing — skipping staleness check"
 *     exit 0
 *
 * Vercel CLI >= ~50.x began REJECTING a project-name argument (`vercel ls massu` →
 * "not a valid project name"); `ls` must run from the linked project dir. Every run hit
 * the unparseable branch, printed WARN, exited 0, and pre-push reported
 * "[9/22] Deploy Staleness... WARN (non-fatal)". It was read past ~10 times in a single
 * session while 47 HOURS of unshipped website changes — including 4 HIGH-severity CVE
 * fixes — sat behind it. A second fail-open in the same script resolved `-- website/`
 * relative to CWD, so running from any subdirectory found zero commits and also skipped.
 *
 * THE RULE (operator prime directive, 2026-07-23): every issue is fixed regardless of
 * severity — WARNINGS INCLUDED. A WARN is a failure that has not been triaged yet.
 *
 * WHAT THIS GUARD ENFORCES: a gate script may only `exit 0` on a genuine PASS or an
 * EXPLICIT, logged bypass. Any "cannot determine / could not parse / skipping" branch must
 * `exit 1`. Sanctioned exceptions are listed in FAIL_OPEN_EXEMPT with a stated reason, so
 * each one is a deliberate, reviewed decision rather than an accident.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');

/**
 * Sanctioned fail-open branches. Each entry MUST carry a reason. A gate legitimately
 * skips when the CHECK ITSELF IS NOT APPLICABLE (wrong branch, tool genuinely absent on a
 * contributor machine, explicit operator bypass) — never when it merely FAILED TO DETERMINE
 * an answer it was supposed to determine.
 */
const FAIL_OPEN_EXEMPT: Record<string, string> = {
  // Explicit, audit-logged operator bypasses are the ONE sanctioned escape hatch.
  'MASSU_SKIP_DEPLOY_STALENESS_CHECK': 'explicit operator bypass, logged to stderr for audit (CR-48)',
};

/** Phrases that indicate "I could not determine the answer" — never a legitimate pass. */
const CANNOT_DETERMINE = [
  /could not parse/i,
  /cannot determine/i,
  /unable to (?:parse|determine|verify)/i,
  /failed to (?:parse|determine)/i,
];

function gateScripts(): string[] {
  if (!existsSync(SCRIPTS_DIR)) return [];
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.sh'))
    .map((f) => join(SCRIPTS_DIR, f));
}

describe('gate fail-open drift-guard (incident 2026-07-23 — a WARN is not a PASS)', () => {
  it('discovers a non-trivial corpus of gate scripts (anti-vacuity of THIS guard)', () => {
    expect(
      gateScripts().length,
      'ZERO gate scripts discovered — scripts/ moved or the glob broke; this guard would be vacuous',
    ).toBeGreaterThan(10);
  });

  it('no gate script exits 0 on a "could not determine" branch', () => {
    const violations: string[] = [];

    for (const file of gateScripts()) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      const rel = file.replace(`${REPO_ROOT}/`, '');

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        // Only consider EXECUTABLE lines; a comment describing the old bug is not the bug.
        if (/^\s*#/.test(line)) continue;
        if (!CANNOT_DETERMINE.some((re) => re.test(line))) continue;
        if (Object.keys(FAIL_OPEN_EXEMPT).some((k) => line.includes(k))) continue;

        // Look ahead a few lines for an `exit 0` in the same branch.
        const lookahead = lines.slice(i, i + 6);
        const exitsZero = lookahead.some((l) => /^\s*exit\s+0\s*(?:#.*)?$/.test(l));
        if (exitsZero) {
          violations.push(
            `${rel}:${i + 1}\n    ${line.trim()}\n    -> followed by \`exit 0\` — this gate reports PASS while ` +
              `having failed to perform its check.`,
          );
        }
      }
    }

    expect(
      violations,
      `\n${violations.length} FAIL-OPEN GATE BRANCH(ES) — a gate that cannot perform its check ` +
        `has NOT passed, it has STOPPED CHECKING:\n\n${violations.join('\n\n')}\n\n` +
        `FIX: make the branch \`exit 1\` with a loud message naming what could not be verified. ` +
        `If the skip is genuinely legitimate (the check is NOT APPLICABLE, e.g. an explicit ` +
        `operator bypass), add its sentinel to FAIL_OPEN_EXEMPT with a stated reason so the ` +
        `decision is reviewed rather than accidental.\n` +
        `Prime directive (2026-07-23): every issue is fixed regardless of severity — WARNINGS ` +
        `INCLUDED. A WARN is a failure that has not been triaged yet.\n`,
    ).toEqual([]);
  });
});
