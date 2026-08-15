// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * F2 / A-003 — ASSERT THE PROPERTY, NOT THE DECLARATION.
 *
 * `hook-failure-isolation.ts` declares the seam; a static guard can confirm that
 * declaration exists. Neither proves the thing anyone actually cares about:
 *
 *     a test run must not change `.massu/hook-failures.jsonl`.
 *
 * That is the property the plan's own rollback row names ("`wc -l` unchanged by a test
 * run"), and it is checkable directly. This `globalSetup` fingerprints the log before any
 * test runs and re-checks it after the last one, so ANY route into that file fails the
 * run — a hook spawned with a hand-built env, an in-process `recordHookFailure` from
 * `memory-db`, a future test nobody thought about, or the setup file being removed.
 *
 * FAIL CLOSED (M2). Absent-then-absent is fine (a fresh clone or CI runner has no log).
 * Absent-then-present is a FAILURE: a test created it. Present-then-changed is a FAILURE.
 * An unreadable log is an ERROR, never a pass — "I could not look" must not produce the
 * same value as "I looked and nothing changed" (THE BLIND-GATE LAW).
 *
 * REPORT THE DENOMINATOR (M1). The byte and row counts are printed at setup, so
 * "checked nothing and found nothing" is impossible to mistake for a clean run.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

const LOG_RELATIVE = join('.massu', 'hook-failures.jsonl');

/** Walk up for the repo marker, the same way `hook-failure-signal.ts` resolves the log. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'massu.config.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fail closed: without a repo root we cannot name the file we are protecting, and a
  // guard that silently protects nothing is worse than no guard.
  throw new Error(
    '[hook-log-untouched] could not locate the repo root (no massu.config.yaml within 12 '
      + `levels of ${process.cwd()}). Refusing to run: this guard cannot report clean about `
      + 'a file it cannot find.',
  );
}

interface Fingerprint {
  present: boolean;
  bytes: number;
  rows: number;
  sha256: string;
}

function fingerprint(path: string): Fingerprint {
  if (!existsSync(path)) return { present: false, bytes: 0, rows: 0, sha256: 'ABSENT' };
  // NOT wrapped in try/catch on purpose: an EACCES/EIO here must propagate as an ERROR.
  // Swallowing it would return a fingerprint indistinguishable from an untouched file.
  const buf = readFileSync(path);
  return {
    present: true,
    bytes: buf.byteLength,
    rows: buf.length === 0 ? 0 : buf.toString('utf-8').trimEnd().split('\n').length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

let logPath = '';
let before: Fingerprint | null = null;

export function setup(): void {
  logPath = join(findRepoRoot(), LOG_RELATIVE);
  before = fingerprint(logPath);
  process.stdout.write(
    `[hook-log-untouched] watching ${LOG_RELATIVE} — `
      + `${before.present ? `${before.rows} rows, ${before.bytes} bytes, sha256:${before.sha256.slice(0, 12)}` : 'ABSENT'}\n`,
  );
}

/**
 * FAIL THE RUN BY SETTING `process.exitCode`, NOT BY THROWING.
 *
 * MEASURED, and the reason this file does not do the obvious thing: vitest 3 runs
 * `globalSetup` teardown inside `Vitest.close()`, AFTER the exit code has been decided. A
 * throw there is PRINTED — stack and all — and the process still exits **0**:
 *
 *     EXIT_WITH_THROWING_TEARDOWN=0        message appears N times: 1
 *     EXIT_WITH_EXITCODE_SET=1
 *
 * So the first draft of this guard was decoration in the purest form: it observed the
 * change, printed a loud message, and the suite went green. Only the CR-72 live-fire
 * (`scripts/tests/live-fire-hook-failure-log-isolation.sh`, PROOF 2) distinguished those two
 * worlds — a fixture asserting "teardown throws" would have passed against the broken one.
 *
 * `process.exitCode` is therefore the load-bearing line, and the live-fire is what keeps it
 * honest if a future vitest changes this behaviour again.
 */
export function teardown(): void {
  if (before === null) {
    process.exitCode = 1;
    process.stderr.write(
      '[hook-log-untouched] teardown ran without setup — the guard never observed a '
        + 'baseline, so it cannot report clean.\n',
    );
    return;
  }
  const after = fingerprint(logPath);
  if (after.sha256 === before.sha256) return;

  const what = !before.present && after.present
    ? `it did not exist before the run and now has ${after.rows} row(s)`
    : `rows ${before.rows} -> ${after.rows}, bytes ${before.bytes} -> ${after.bytes}`;

  process.exitCode = 1;
  process.stderr.write(
    `\n[hook-log-untouched] A TEST WROTE TO THE OPERATOR'S LIVE HOOK-FAILURE LOG.\n`
      + `  file : ${logPath}\n`
      + `  delta: ${what}\n`
      + `  sha  : ${before.sha256} -> ${after.sha256}\n`
      + '\n'
      + '  That file is incident evidence, not scratch space. Something reached\n'
      + '  recordHookFailure() with MASSU_HOOK_FAILURE_LOG unset or pointed back into the\n'
      + '  repo — most likely a child process given a hand-built `env:` that does not carry\n'
      + '  process.env through. Set the seam for that call rather than relaxing this guard.\n\n',
  );
}
