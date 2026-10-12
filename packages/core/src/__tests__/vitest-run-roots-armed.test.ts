import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { report } from './helpers/report.ts';
// The run-root predicate lives in ONE module and this gate ASKS it. It used to carry private
// copies of the comment stripper and the shape classifier; a sibling instrument then re-derived
// the same predicate with grep and got it wrong within the hour. One derivation, many consumers.
import { discoverRunRoots } from '../../../../scripts/lib/vitest-run-roots.mjs';

/* ------------------------------------------------------------------------------------------ */
/*  D-3 — EVERY VITEST RUN ROOT ARMS THE HANG DETECTOR.                                       */
/*                                                                                            */
/*  A hang is the absence of EVENTS. The runner declares its progress through a heartbeat      */
/*  reporter (D-2) and an out-of-process watcher asks (D-3). A run root that does not declare  */
/*  that reporter writes no heartbeat at all — and to a watcher, "no heartbeat" and "a         */
/*  heartbeat that stopped" are the two states the detector exists to tell apart. An unarmed   */
/*  run root is therefore not a missing nicety; it is a run the detector cannot see.           */
/*                                                                                            */
/*  ── THE SCOPE IS RUN ROOTS, DERIVED — NOT "EVERY TRACKED CONFIG" ───────────────────────    */
/*  `reporters` is a member of vitest's `NonProjectOptions`                                    */
/*  (node_modules/vitest/dist/chunks/reporters.d.DtoKVV2s.d.ts:3572) and                       */
/*  `type ProjectConfig = Omit<InlineConfig, NonProjectOptions | "sequencer" | "deps">` (:3597),*/
/*  so a `defineProject` config CANNOT express a reporter. Requiring one of every tracked      */
/*  config would be unsatisfiable — a brick, and a brick gets bypassed (CR-72). A project is   */
/*  always run by a root, and arming the root covers it.                                       */
/*                                                                                            */
/*  This is G28: "every tracked vitest config" is a CORRELATE of the property; "every run      */
/*  root" IS the property. The correlate was the LARGER set, so it read as more thorough while */
/*  being impossible to satisfy.                                                               */
/*                                                                                            */
/*  ── WHY DERIVED AND NOT LISTED (G32/Rule 25) ───────────────────────────────────────────    */
/*  The candidate set comes from `git ls-files`, so a config added tomorrow is in scope         */
/*  tomorrow. A hardcoded roster would also be WRONG IN THE PUBLIC MIRROR, which ships no      */
/*  `website/` — a count-based assertion ("there are 3 run roots") is a fixture asserting a    */
/*  fact true in only one tree. Deriving makes the gate correct in both.                        */
/*                                                                                            */
/*  ── FAIL CLOSED, EVERY WAY IT CAN FAIL TO LOOK (M1/M2) ─────────────────────────────────    */
/*  An empty candidate set, an unreadable config, a config whose shape matches NEITHER          */
/*  `defineConfig` nor `defineProject`, and a config with no recognisable default export are   */
/*  each an ERROR. None of them may resolve to "nothing to check" — that is the value a        */
/*  healthy tree also produces, and it is the passing one.                                     */
/* ------------------------------------------------------------------------------------------ */

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

/** Tracked membership, never a roster. */


/* ────────────────────────────────────────────────────────────────────────────────────────
 * The comment stripper, the tracked-config discovery and the run-root/project classification all
 * moved to `scripts/lib/vitest-run-roots.mjs`. They are NOT duplicated here, because a second
 * derivation is how the two drift — and this gate's own history is the evidence: a shell
 * instrument written the same hour re-derived the predicate with `grep -q defineProject` and
 * silently dropped the root config, whose line 6 is a COMMENT mentioning `defineProject`.
 *
 * ⛔ WHAT DID *NOT* MOVE, DELIBERATELY: `corrections-md-drift-guard.test.ts` keeps its own
 * stripper. It takes a PATH, strips FULL-LINE `//` only, and is blind to string literals — which
 * it must be, since its predicates key on literals like '## Archived'. This one takes SOURCE,
 * is quote-aware, and strips `//` anywhere outside a string. Each has a failure mode the other
 * lacks, so merging them on textual similarity would drop behaviour one depends on. Group
 * duplicated code by CONTRACT, never by text.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

describe('D-3: every vitest RUN ROOT arms the hang detector', () => {
  // ONE derivation, asked for. `discoverRunRoots` returns EVERY tracked config classified, so
  // the denominator this gate prints and the rows it judges come from the same call — they cannot
  // disagree, which a second private lister would eventually let them do.
  const classified = discoverRunRoots(REPO_ROOT);
  const configs = classified;
  const runRoots = classified.filter((c) => c.shape === 'run-root');
  const projects = classified.filter((c) => c.shape === 'project');

  it('M1: reports its denominator, and an empty candidate set is an ERROR', () => {
    // ⛔ report(), NEVER console.log — console.log is SWALLOWED by this suite's runner, so an
    // M1 denominator sent through it is a number nobody can read. This gate's first draft used
    // console.log and the `no-console-log-in-tests` guard caught it in the full battery while an
    // ISOLATED run of this file printed it perfectly: the channel only disappears under the
    // real runner, which is why reading it once locally proves nothing about it.
    report(
      `[D-3 arming] tracked vitest configs: ${configs.length}  ` +
        `run roots: ${runRoots.length}  projects (cannot carry a reporter): ${projects.length}\n` +
        classified
          .map((c) => `    ${c.shape === 'run-root' ? (c.armed ? 'ARMED  ' : 'UNARMED') : 'project'}  ${c.path}`)
          .join('\n'),
    );
    // "Scanned 0, found 0" must never read as a pass.
    expect(configs.length).toBeGreaterThan(0);
    // Every repo that runs vitest has at least one run root; zero means the classifier broke,
    // not that the tree is clean.
    expect(runRoots.length).toBeGreaterThan(0);
  });

  it('every run root composes withHangDetection', () => {
    const unarmed = runRoots.filter((c) => !c.armed).map((c) => c.path);
    expect(
      unarmed,
      unarmed.length === 0
        ? ''
        : `These vitest RUN ROOTS do not arm the hang detector, so a run started from any of ` +
            `them writes no heartbeat and the watcher cannot distinguish it from a wedged run:\n` +
            unarmed.map((p) => `  - ${p}`).join('\n') +
            `\nFix by composing the factory:\n` +
            `  import { withHangDetection } from '<relative>/scripts/lib/vitest-hang-armed.mjs';\n` +
            `  export default withHangDetection(defineConfig({ ... }));\n` +
            `Do NOT instead set the env var and reporter by hand — the factory exists so that ` +
            `the arming recipe lives in one place (G32), and it reproduces vitest's own ` +
            `\`reporters\` default including the github-actions CI variant, which a hand-written ` +
            `\`['default', <heartbeat>]\` silently drops.`,
    ).toEqual([]);
  });

  it('the arming factory it points at is TRACKED (so the mirror ships it too)', () => {
    // CR-71 applied to this guard's own premise: a gate asserting configs compose a factory is
    // worthless if the factory is not in the tree that ships.
    expect(trackedFiles()).toContain('scripts/lib/vitest-hang-armed.mjs');
  });

  /* ────────────────────────────────────────────────────────────────────────────────────────
   * ⛔ TWO PROPERTIES ARE DELIBERATELY *NOT* ASSERTED HERE, AND THE REASON IS MEASURED — NOT
   * A JUDGEMENT THAT THEY DO NOT MATTER.
   *
   * An earlier draft of this file asserted that the factory (a) exports `withHangDetection`
   * and (b) never imports the heartbeat reporter at top level. Both assertions were
   * DECORATION: neither can ever be observed to fail, because every run root's config imports
   * the factory, so violating either kills the config load and this suite never runs at all.
   * Measured 2026-09-24 by planting each defect into the real factory:
   *
   *     export removed      -> "failed to load config from …/packages/core/vitest.config.ts"
   *                            "Error: Build failed with 1 error"      gate NEVER EXECUTED
   *     reporter imported   -> "failed to load config" / "Startup Error" (x2)
   *                            gate NEVER EXECUTED
   *
   * Reality enforces both far more strongly than an assertion could: the failure is immediate,
   * total and loud, on every invocation, before any test is collected. An assertion that cannot
   * speak is worse than no assertion, because it reads as coverage — which is the blind-gate
   * law aimed at a test file (ask of any check: if the thing were broken, would THIS code
   * produce a different value? here it produces nothing, because it does not run).
   *
   * The live-fire (`scripts/ops/live-fire-run-roots-armed.sh`) still ATTACKS both, and asserts
   * the correct consequence — that the run dies at CONFIG LOAD — rather than pretending the
   * gate caught it. That is what turns "we do not check this" into a proven invariant.
   * ──────────────────────────────────────────────────────────────────────────────────────── */
});

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean);
}
