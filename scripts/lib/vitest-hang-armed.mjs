// D-3: ARM THE HANG DETECTOR FROM THE CONFIG, IN EXACTLY ONE PLACE.
//
// A vitest run declares its own progress (D-2) and an out-of-process watcher asks (D-3). This
// module is the composition that connects them, and it exists as a FACTORY rather than as a
// recipe repeated in each config for one reason: three configs each setting a variable and
// each appending a reporter is three hand-maintained declarations (G32), and the failure mode
// is silent — a fourth package ships tomorrow with its own config and simply has no heartbeat.
// A derived check over three hand edits makes that DETECTABLE; a factory makes an unarmed run
// root be a config that did not call this function, which is a far smaller thing to assert.
//
// ── THE ARMING POINT IS THE CONFIG MODULE BODY, AND THAT IS MEASURED ────────────────────────
// `globalSetup` is TOO LATE: the reporter is constructed during `Vitest._setServer`, so a
// heartbeat armed from globalSetup threw before globalSetup ever logged. The config module body
// evaluates when the config is LOADED, which is before server setup. Probed 2026-09-24.
//
// ── WHY THE REPORTER IS DECLARED BY PATH AND NEVER BY IMPORT ────────────────────────────────
// `vitest-heartbeat-reporter.mjs` throws at import time when the base is unset — deliberately,
// because beating into a location no watcher reads is worse than not beating at all. So an
// `import` of it at a config's top level would evaluate BEFORE the assignment below and kill
// every run at config load. `test.reporters` accepts paths to custom reporters, which defers
// the import until after this function has run. The reporter's fail-closed design is what makes
// a wrong ordering LOUD rather than silent — the same property that exposed globalSetup.
//
// ── ⛔ PRESERVING THE DEFAULT IS NOT COSMETIC ───────────────────────────────────────────────
// `reporters` defaults to `['default']` — or `['default', 'github-actions']` when
// `GITHUB_ACTIONS === 'true'`. None of this repo's run roots declares `reporters` today, so
// naively writing `['default', <heartbeat>]` would DROP the github-actions reporter in CI and
// lose its inline annotations, while every local run looked identical. A regression visible only
// on the machine nobody watches is the worst shape available, so the default is reconstructed
// with the same conditional rather than assumed to be one element.

import { join, resolve } from 'node:path';
import { ENV_BASE, baseFromEnv, baseFromRepoRoot } from './hang-heartbeat-location.mjs';

// The repo root, derived from THIS module's own location — never from `process.cwd()`, which
// differs between a root run and `cd packages/core && npx vitest`, and never from a literal
// (an absolute path baked into a config would leak into the public mirror).
const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** The reporter's absolute path. Absolute because each run root resolves relative paths
 *  against its OWN `root`, and the three run roots sit at three different depths. */
export const HEARTBEAT_REPORTER = join(REPO_ROOT, 'scripts/lib/vitest-heartbeat-reporter.mjs');

/**
 * Vitest's own default `reporters` value, reconstructed rather than guessed.
 * Kept as a named export so the derived check can assert the CI variant is preserved instead
 * of re-deriving it (one source, so the check and the factory cannot disagree).
 */
export function vitestDefaultReporters(env = process.env) {
  return env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'];
}

/**
 * Arm a run-root vitest config with the hang detector.
 *
 * Sets the heartbeat base for this process (the config module body is the only point early
 * enough) and APPENDS the heartbeat reporter, preserving whatever the config already declared.
 *
 * ⛔ RUN ROOTS ONLY. `reporters` is a member of vitest's `NonProjectOptions`, so a
 * `defineProject` config cannot express it — calling this on one would produce a config field
 * the type system omits and vitest ignores, i.e. a silently unarmed run. A project is always
 * run by a root, and arming the root covers it.
 *
 * @param {object} config a config object (typically the result of `defineConfig({...})`)
 * @returns {object} the same shape, armed
 */
export function withHangDetection(config) {
  if (!config || typeof config !== 'object') {
    throw new TypeError(
      'withHangDetection: expected a vitest config object. Arming is not optional — refusing to ' +
        'return an unarmed config, because a run that silently does not beat reads to the watcher ' +
        'as permanent silence.',
    );
  }

  // ⛔ DEFAULT IT, DO NOT OVERWRITE IT — AND THIS IS THE TESTABILITY DISTINCTION THE PLAN
  // ALREADY DRAWS FOR `HANG_SILENCE_S`, APPLIED TO THE BASE. The first version assigned
  // unconditionally, which made the base UNDIRECTABLE: a launcher could not point a run's
  // heartbeats anywhere, and no harness could isolate its beats from the real
  // `<repo>/.hang-heartbeats`. Measured 2026-09-24 — a probe exporting the variable had its
  // value silently discarded and wrote into the repo base instead, which is also what D-7's
  // attacker would have done to the operator's live tree.
  //
  // Respecting an explicit value does NOT weaken the reporter's M2: the reporter still refuses
  // to start when nothing set the base at all, so "armed into a location no watcher reads"
  // remains impossible. What changes is only WHO may choose the location — and a launcher that
  // sets it is the same process that tells its watcher where to look, so they still agree BY
  // CONSTRUCTION rather than by coincidence.
  //
  // An EMPTY value is NOT an override (G17 — an empty path component widens a path to its
  // parent, and `<base>/<pid>` with an empty base is a directory in the process's cwd). It
  // falls through to the default like any other absent value.
  const explicit = baseFromEnv();
  process.env[ENV_BASE] = explicit || baseFromRepoRoot(REPO_ROOT);

  const test = config.test ?? {};
  const declared = test.reporters;
  const base =
    declared === undefined
      ? vitestDefaultReporters()
      : Array.isArray(declared)
        ? declared
        : [declared];

  // Idempotent: arming an already-armed config is a no-op rather than a second reporter, so a
  // config composed twice (or a factory call added where one already existed) cannot double the
  // beat stream and make the watcher's last-event bookkeeping ambiguous.
  const reporters = base.includes(HEARTBEAT_REPORTER) ? base : [...base, HEARTBEAT_REPORTER];

  return { ...config, test: { ...test, reporters } };
}
