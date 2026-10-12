// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * The one way a test reports a DENOMINATOR, a metric, or a skip.
 *
 * ⛔ WHY THIS EXISTS — MEASURED 2026-09-21, AND IT IS THE BLIND-GATE LAW AIMED AT OUR OWN
 * TEST OUTPUT.
 *
 * `console.log` inside a test is SWALLOWED by this suite's runner. Direct stream writes are
 * not. Probed on the real config, one file, three channels:
 *
 *     console.log('PROBE_CONSOLE_LOG')          -> absent from the run output
 *     process.stdout.write('PROBE_STDOUT\n')    -> present
 *     process.stderr.write('PROBE_STDERR\n')    -> present
 *
 * Seven sites across five files were reporting denominators through the swallowed one, each
 * with a comment explaining that it was printed so a reviewer could read it. It was not.
 * `stack-asset-conformance.test.ts:178` said so in as many words — *"Printed, not just
 * asserted: a reviewer must be able to read the denominator"* — and printed nothing.
 *
 * ⛔ FIVE MORE SITES WERE WORSE THAN A LOST NUMBER. `validate-features-runner.test.ts`
 * announces `"No data DB found - skipping feature validation"` and then PASSES. A test that
 * skips itself into an invisible channel is indistinguishable from a test that ran and found
 * nothing — which is the exact failure mode this codebase exists to hunt.
 *
 * ⛔ AND THE FIX IS NOT TWELVE EDITS. That repairs today's sites and says nothing about the
 * thirteenth; the next author reaches for `console.log` because that is what reporting looks
 * like everywhere else. One helper, plus a drift guard that refuses `console.log` in the test
 * tree and names this file in its message, makes the wrong channel unreachable by accident
 * (`no-console-log-in-tests.test.ts`).
 *
 * THE CHANNEL IS PROVEN BY EXECUTION, NEVER BY THIS COMMENT:
 * `scripts/ops/live-fire-report-channel.sh` runs the real suite, asserts a real reported line
 * is in the captured output, then PLANTS `console.log` in its place and asserts the line
 * VANISHES — the only evidence that can tell "it printed" from "it was swallowed".
 */

/** Marker every reported line carries, so the live-fire can find them without guessing. */
export const REPORT_PREFIX = '[report]';

/**
 * Report a measurement to the operator.
 *
 * Use it for the numbers that make a green meaningful: files scanned, rows read, candidates
 * considered, precision/recall. A count nobody can read is decoration (M1).
 */
export function report(message: string): void {
  // stdout, deliberately: proven to surface, and a measurement is not a diagnostic.
  process.stdout.write(`${REPORT_PREFIX} ${message}\n`);
}

/**
 * Report that a test could not do its work and is passing anyway.
 *
 * ⛔ STDERR, AND THE WORD "SKIPPED" IS MANDATORY. This is the case where silence is actively
 * dangerous: the suite is green and one of its assertions never ran. Routing it to stderr
 * keeps it visible even where stdout is captured for a report, and the fixed word makes the
 * whole class greppable across a CI log:
 *
 *     grep 'SKIPPED' <ci.log>      # every test that gave up, in one command
 */
export function reportSkip(message: string): void {
  process.stderr.write(`${REPORT_PREFIX} SKIPPED — ${message}\n`);
}
