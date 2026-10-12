// D-3: THE SILENCE RULE — ONE implementation, and the ONLY place a hang is decided.
//
// ⛔ WHY ONE MODULE. The prior art this plan adopts records the reason from its own second
// caller: "writing it twice would put the number that decides whether a hang is REPORTED into
// two files that drift" (Rule 25 / G32). Every consumer imports `classify` from here; nothing
// re-implements the comparison.
//
// ⛔ THE VERDICT IS THREE-VALUED, NEVER TWO, AND THAT IS THE WHOLE POINT.
//
//   HEALTHY      progress was observed within the bound
//   HUNG         the runner started emitting and then STOPPED
//   CANNOT_LOOK  the watcher could not read a heartbeat at all
//
// Collapsing CANNOT_LOOK into either of the others is the blind-gate defect exactly: a
// misconfigured watcher and a hung suite would become indistinguishable, and a watcher that
// cannot see would report the PASSING value. "No heartbeat file" means the run never reached
// the point of emitting anything — a collection or worker-startup deadlock, the shape that
// produces a 0-byte log and can run for hours. "A heartbeat that went quiet" means it started
// and stopped. Those are different failures with different remedies and they stay separate.
//
// ⛔ THE BOUND IS A MEASUREMENT, NOT A CONSTANT (CR-68). 90 s is derived: 6 runs over
// packages/core on a contended host gave p50 0 ms, p90 6 ms, p99 35 ms, max 6,911 ms, with the
// tail CHARACTERISED — all ten longest silences belonged to three named subprocess-spawning
// tests, so it is stable structure rather than an unbounded variable. One order of magnitude
// above the worst observed (which also covers the 9.5x spread between per-run maxima) gives
// 69.1 s, rounded to 90 s. Re-derive with
// `scripts/ops/measure-vitest-event-gaps.sh --package packages/core --runs 6`.
//
// ⛔ `HANG_SILENCE_S` IS A TESTABILITY OVERRIDE, NOT A TUNING KNOB. D-7's attacker drives seven
// rows; at 90 s each that is over nine minutes per run, and an attacker that expensive gets
// skipped — a skipped attacker is decoration (CR-72). WIDENING THE PRODUCTION BOUND IS
// FORBIDDEN. The remedy for a unit that legitimately blocks longer than the cadence is an
// EXPLICIT BEAT from that unit, never a larger number here (G27: widening a bound to silence
// its own false positives is the move this whole plan exists to undo, and
// `packages/core/vitest.config.ts:25-30` records this repo already doing it once).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERDICT = {
  HEALTHY: 'HEALTHY',
  HUNG: 'HUNG',
  CANNOT_LOOK: 'CANNOT_LOOK',
};

// Derived default, overridable for tests only. See the header.
export const DEFAULT_SILENCE_S = Number(process.env.HANG_SILENCE_S || 90);

export function heartbeatPath(dir) {
  return join(dir, 'heartbeat.json');
}

// classify(beat, nowMs, boundS) -> { verdict, reason, silentForMs, openModules }
//
// A PURE function, so the decision is testable without running a suite — and because the
// runner below calls this same function, a test of `classify` cannot drift from what
// production decides (a test that re-implements its subject drifts into agreeing with its
// subject's bugs).
export function classify(beat, nowMs, boundS = DEFAULT_SILENCE_S) {
  if (beat === null || beat === undefined) {
    return {
      verdict: VERDICT.CANNOT_LOOK,
      reason:
        'no heartbeat could be read — the run may never have reached the point of emitting ' +
        'anything (a collection or worker-startup deadlock), or the watcher is pointed at the ' +
        'wrong directory. This is NOT "healthy" and NOT "hung".',
      silentForMs: null,
      openModules: [],
    };
  }

  if (typeof beat.t_ms !== 'number' || !Number.isFinite(beat.t_ms)) {
    return {
      verdict: VERDICT.CANNOT_LOOK,
      reason: `heartbeat present but its t_ms is unusable (${JSON.stringify(beat.t_ms)}) — ` +
        'refusing to compute a silence from a value that is not a monotonic timestamp',
      silentForMs: null,
      openModules: [],
    };
  }

  const silentForMs = nowMs - beat.t_ms;

  // A NEGATIVE age cannot happen with a monotonic clock. If it does, the two sides are not on
  // the same clock and any comparison is meaningless — say so rather than emit a plausible
  // verdict from an impossible input.
  if (silentForMs < 0) {
    return {
      verdict: VERDICT.CANNOT_LOOK,
      reason:
        `heartbeat is ${-silentForMs}ms in the FUTURE — the watcher and the reporter are not ` +
        'reading the same monotonic clock, so no silence can be computed',
      silentForMs,
      openModules: beat.open_modules || [],
    };
  }

  const openModules = Array.isArray(beat.open_modules) ? beat.open_modules : [];

  if (silentForMs > boundS * 1000) {
    return {
      verdict: VERDICT.HUNG,
      reason:
        `no test event for ${(silentForMs / 1000).toFixed(1)}s (bound ${boundS}s). ` +
        `Last event: ${beat.event} ${beat.subject || ''}`.trim(),
      silentForMs,
      openModules,
    };
  }

  return {
    verdict: VERDICT.HEALTHY,
    reason: `last event ${(silentForMs / 1000).toFixed(1)}s ago (bound ${boundS}s)`,
    silentForMs,
    openModules,
  };
}

// readBeat(dir) -> the parsed beat, or null when it cannot be read.
//
// ⛔ null MEANS "COULD NOT READ", WHICH `classify` TURNS INTO CANNOT_LOOK — never into
// healthy. A missing file, an unreadable file and a half-written file all land here, and the
// heartbeat writer uses temp+rename precisely so a partial read is not a normal occurrence.
export function readBeat(dir) {
  try {
    return JSON.parse(readFileSync(heartbeatPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

// check(dir, boundS) -> the same shape as classify, read from disk.
// Kept to one line of logic so the file/clock plumbing cannot diverge from the rule.
export function check(dir, boundS = DEFAULT_SILENCE_S) {
  return classify(readBeat(dir), Number(process.hrtime.bigint() / 1000000n), boundS);
}
