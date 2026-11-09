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
import { spawnSync } from 'node:child_process';

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

  /*
   * THE SAME BUG CLASS, IN A GUARD'S ASSERTION RATHER THAN A GATE'S EXIT CODE.
   *
   * A drift-guard that reads a source file and asserts `toContain('<symbol>')` over the RAW
   * text is satisfied by ANY mention — including the comment EXPLAINING why the symbol
   * exists, which is the last thing anyone deletes. Delete the code, keep the comment, and
   * the guard stays green over exactly the edit it exists to catch. That is a gate that has
   * stopped checking while still printing PASS — this file's subject, one layer in.
   *
   * MEASURED 2026-08-12 by scripts/ops/probe-comment-satisfiable-assertions.py, which strips
   * comments from the guarded file and re-evaluates: 1 LIVE (an assertion discharged by
   * documentation alone) and 11 LATENT. The LIVE one was
   * rule-pack-enforcement-bridge.test.ts asserting `toContain('destination')` over
   * installed-rules/index.ts, where all seven occurrences are comments — rebound to the
   * SELECT projection that actually carries the field, and mutation-proven.
   *
   * This is the probe's EXECUTING CALLER (CR-71): a measuring script nothing invokes is a
   * dead feature, and it lives here rather than in a new test file so it needs no new
   * registry candidate.
   */
  // The probe is given 120_000ms below and sweeps the whole tree; vitest's global
  // testTimeout is 20000, so the subprocess budget could never actually be spent.
  /**
   * Assertions whose SUBJECT genuinely IS a comment, so "satisfied by a comment alone" is
   * the intent rather than the defect. Each entry is a decision with a reason, not a mute.
   *
   * Surfaced 2026-08-13 when the probe's path resolver was repaired: its first-argument
   * capture was `[^,)]+`, which stops at the first `,` or `)`, so the commonest shape in
   * this repo — `readFileSync(join(SRC, 'x.ts'), 'utf8')` — yielded `join(SRC` and lost the
   * filename. Ten reads were filed "unresolvable" that the probe had simply never seen,
   * and this LIVE finding was among them. A blind spot reported as a measurement.
   */
  const DOCUMENTATION_BY_DESIGN: readonly string[] = [
    // The test is NAMED 'TOOL_DB_NEEDS comment documents the P-H009 rationale' and carries
    // `// CR-46: the structural fix MUST self-document the bug class it closes`. It asserts
    // the manifest still explains WHY trpc_map needs the Data DB. A comment satisfying it is
    // the whole point; rebinding it to code would destroy what it checks.
    "packages/core/src/__tests__/trpc-map-empty-codegraph-hint.test.ts asserts 'P-H009' over packages/core/src/tool-db-needs.ts",
  ];

  it('no guard assertion is discharged by a COMMENT alone', { timeout: 120_000 }, () => {
    const probe = resolve(REPO_ROOT, 'scripts', 'ops', 'probe-comment-satisfiable-assertions.py');
    const r = spawnSync('python3', [probe, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    // M2 — a probe that could not run is an ERROR, never an empty finding set. This is the
    // whole subject of this file: "could not look" must not read as "looked and found nothing".
    expect(r.status, `probe did not run: ${r.stderr ?? ''}`).toBe(0);
    const report = JSON.parse(r.stdout) as {
      test_files_scanned: number;
      resolved_to_a_real_guarded_file: number;
      unresolvable_path_expression: number;
      LIVE_satisfied_by_a_comment_ALONE: number;
      findings: Array<{ test: string; guarded: string; literal: string }>;
    };
    // M1 — assert the DENOMINATOR, so a probe that scanned nothing cannot report clean.
    expect(report.test_files_scanned, 'probe scanned 0 test files').toBeGreaterThan(100);
    // A COLLAPSE floor, and honestly labelled as one: this number is checkout-dependent
    // (68 here, 37 in the published mirror, which ships a subset of the tree), so it cannot
    // be ratcheted. It catches "the resolver died", nothing subtler.
    expect(
      report.resolved_to_a_real_guarded_file,
      'probe resolved almost no guarded files — its path resolver stopped working and every ' +
        'finding would silently vanish',
    ).toBeGreaterThan(20);

    // THE RATCHET LIVES HERE, on the metric that means the same thing in both checkouts.
    // `unresolvable` now counts only expressions the probe could not PARSE — reads where no
    // string literal survived. A file the checkout does not ship is counted separately as
    // `target_absent_in_this_checkout`, because an unavailable INPUT is not a resolver
    // defect (G26/CR-89). Measured with the split: unresolvable is 5 HERE and 5 IN THE
    // MIRROR, while target_absent absorbs the difference (9 vs 31).
    //
    // Before the split there was no threshold that meant the same thing in both — internally
    // 68/14, in the mirror 37/36 — and a ratchet pinned to either one was guaranteed to be
    // wrong in the other. The regression this guards against (a truncating first-argument
    // capture, 3d959882) drives this number UP, because a truncated expression yields no
    // literal, so it is caught here in either checkout.
    expect(
      report.unresolvable_path_expression,
      'more path expressions are UNPARSEABLE than before — each is an assertion the probe ' +
        'silently cannot judge, which is how ten never-seen paths were once reported as a ' +
        'measurement. Enumerate them with --debug-unresolved and fix the parser, or raise ' +
        'this cap in the same commit with a stated reason.',
    ).toBeLessThanOrEqual(5);
    expect(
      report.findings
        .map((f) => `${f.test} asserts '${f.literal}' over ${f.guarded}`)
        .filter((k) => !DOCUMENTATION_BY_DESIGN.includes(k)),
      'These assertions are satisfied ONLY by a comment in the guarded file. Deleting the code ' +
        'they claim to guard would not turn them red. Rebind each to something the code ' +
        'actually contains — the probe prints the first comment line that discharges it.',
    ).toEqual([]);

    // SHRINK-ONLY, same discipline as every other allowlist here: an entry the probe no
    // longer reports is DELETED, not left to outlive its reason. Without this the list
    // could quietly become a suppression file.
    const stale = DOCUMENTATION_BY_DESIGN.filter(
      (k) => !report.findings.map((f) => `${f.test} asserts '${f.literal}' over ${f.guarded}`).includes(k),
    );
    expect(
      stale,
      'These documentation-by-design entries are no longer reported by the probe — delete them.',
    ).toEqual([]);

    // The COUNT must equal the allowlist exactly. Stronger than the `toBe(0)` this replaced,
    // which could only ever express "none at all": a LIVE finding the list does not name now
    // fails here even if the string-shaping above ever drifted.
    expect(
      report.LIVE_satisfied_by_a_comment_ALONE,
      'LIVE count does not match the documentation-by-design allowlist',
    ).toBe(DOCUMENTATION_BY_DESIGN.length);
  });
});
