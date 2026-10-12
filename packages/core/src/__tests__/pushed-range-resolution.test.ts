/**
 * The pushed range is RECEIVED, never guessed.
 *
 * ── The defect this exists to keep fixed ───────────────────────────────────────
 * The CR-62 incident-coverage gate used to infer the range it scans, and the inference's
 * fallback was `HEAD~1..HEAD` — the branch taken by every not-yet-pushed branch. That is
 * wrong in both directions and so cannot be repaired by widening it:
 *
 *   TOO NARROW  an 8-commit branch was judged on its last commit, so seven obligated
 *               commits were never examined and the gate reported PASS — a blind gate on
 *               the irreversible half of the commit/push pair.
 *   WRONG       discharge evidence two commits back was invisible, so a fully compliant
 *               branch was REFUSED. A gate that is red on compliant work teaches
 *               `--no-verify`, which switches off the whole battery rather than one check.
 *
 * git already hands the answer to `pre-push` on stdin, one line per ref:
 * `<local ref> <local oid> <remote ref> <remote oid>`, with an all-zero remote oid
 * meaning "this ref is new". So the range was never something to infer.
 *
 * ── Why the assertions are shaped this way ─────────────────────────────────────
 * Asserting the resolver's SOURCE would go green the moment the line is written while
 * the resolution never binds (G2). So the REAL resolver is EXECUTED over a REAL sandbox
 * repository by the shell harness, once per resolution branch, and the REAL gate is
 * attacked in the REAL tree by the live-fire companion. This file asserts both ran a
 * non-vacuous number of checks and returned PASS — and that the refusal branch exists,
 * because the refusal is the half the old code got wrong.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LIB = join(REPO_ROOT, 'scripts/lib/pushed-range.sh');
const SELF_TEST = join(REPO_ROOT, 'scripts/tests/test-pushed-range.sh');
const LIVE_FIRE = join(REPO_ROOT, 'scripts/ops/live-fire-pushed-range.sh');

/** Shrink-only floors. Raise when cases are added; never lower. */
const MIN_SELF_TEST_CHECKS = 11;

function run(script: string) {
  const p = spawnSync('bash', [script], { encoding: 'utf-8', cwd: REPO_ROOT, timeout: 300_000 });
  return { code: p.status, out: `${p.stdout ?? ''}${p.stderr ?? ''}` };
}

/**
 * CAN THE LIVE-FIRE RUN HERE? - measured, never inferred from an environment name.
 *
 * The live-fire attacks the REAL gate, so it needs a real repository: a work tree, a
 * resolvable `origin/main`, and enough ancestry to build a multi-commit baseline. The
 * Sync Check copies this tree into a temp directory and runs the suite there, where none
 * of that holds - so an unconditional run fails for a reason that is about the COPY
 * rather than about the gate.
 *
 * The repo's older harnesses key this decision on the CI environment flag. That flag is a
 * CORRELATE of the property, not the property itself (G28), and it is wrong in exactly
 * this case: the Sync Check runs LOCALLY, with that flag unset, in a directory that has
 * no git history at all. So probe the preconditions themselves and NAME the missing one.
 *
 * This cannot become a silent pass: every missing precondition is listed in the skip
 * reason, and a skip is a visible vitest category. The guard is still proven live where
 * the preconditions DO hold - the registry's reddening proof plants a defect in the real
 * resolver and demands this file go RED.
 */
function livefirePreconditions(): string[] {
  const missing: string[] = [];
  const probe = (args: string[]) =>
    spawnSync('git', args, { encoding: 'utf-8', cwd: REPO_ROOT, timeout: 30_000 });

  if (probe(['rev-parse', '--is-inside-work-tree']).status !== 0) {
    missing.push('not a git work tree');
    return missing; // every later probe would fail for this same reason
  }
  if (probe(['rev-parse', '--verify', '--quiet', 'origin/main']).status !== 0) {
    missing.push('origin/main does not resolve');
  }
  if (probe(['rev-parse', '--verify', '--quiet', 'HEAD~3']).status !== 0) {
    missing.push('HEAD has fewer than 3 ancestors (no multi-commit baseline)');
  }
  return missing;
}

const LIVE_FIRE_BLOCKERS = livefirePreconditions();

/** `passed: N   failed: M` — the runner's OWN tally, never a count I compute here. */
function tally(out: string) {
  const m = out.match(/passed:\s*(\d+)\s+failed:\s*(\d+)/);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
}

describe('the pushed range is received from git, not inferred', () => {
  it('the resolver and both of its harnesses are present', () => {
    expect(existsSync(LIB), `resolver MISSING at ${LIB}`).toBe(true);
    expect(existsSync(SELF_TEST), `self-test MISSING at ${SELF_TEST}`).toBe(true);
    expect(existsSync(LIVE_FIRE), `live-fire companion MISSING at ${LIVE_FIRE}`).toBe(true);
  });

  it('there is NO branch that invents a range, and the refusal is reachable', () => {
    const src = readFileSync(LIB, 'utf-8');

    /**
     * CODE, NOT PROSE. The first draft of this assertion matched the whole file and went
     * RED on the resolver's own header, which QUOTES the old `HEAD~1..HEAD` fallback in
     * order to explain why it was removed. A guard that punishes documenting the defect
     * teaches people to stop documenting it — and the repo has paid for this exact
     * confusion before, in a sweep where half its "writers" turned out to be comments.
     * So: drop full-line comments first, then match.
     */
    const code = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

    // The exact substitution that caused the defect must not come back.
    expect(code, 'the HEAD~1 fallback is back in live code')
      .not.toMatch(/HEAD~1\.\.HEAD/);

    // The refusal must exist by name. If it is deleted the resolver silently reverts to
    // a shape where "could not determine" can be mistaken for an answer.
    expect(src, 'the refusal branch is gone').toContain('cannot determine what this push delivers');

    // The authoritative source must be consulted. Losing this line does not break
    // anything visibly — it just quietly demotes every run to a derivation.
    expect(src, 'the ref-line branch is gone').toContain('MASSU_PUSH_REFS');
  });

  it('the CR-62 gate consumes the resolver and fails closed without it', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts/massu-incident-coverage.sh'), 'utf-8');
    expect(src, 'the gate no longer calls the resolver').toContain('massu_pushed_range');
    expect(src, 'a missing resolver must exit 2, not fall back')
      .toContain('cannot source scripts/lib/pushed-range.sh');
  });

  it('the battery captures the ref lines git handed the hook', () => {
    // The capture is the only thing that makes the authoritative branch REACHABLE in
    // production. Without it the resolver silently falls through to a derivation, which
    // looks identical in the log — so this asserts the export exists at the boundary.
    const src = readFileSync(join(REPO_ROOT, 'scripts/hooks/pre-push-release-battery.sh'), 'utf-8');
    expect(src, 'the battery no longer exports the captured refs').toContain('export MASSU_PUSH_REFS');
  });

  it('the self-test EXECUTES every resolution branch and returns PASS', () => {
    const { code, out } = run(SELF_TEST);
    const t = tally(out);
    expect(t, `no tally line in self-test output:\n${out.slice(-800)}`).not.toBeNull();
    expect(t!.failed, `self-test reported failures:\n${out.slice(-1200)}`).toBe(0);
    expect(t!.passed, 'self-test check count shrank — a silently narrowed harness')
      .toBeGreaterThanOrEqual(MIN_SELF_TEST_CHECKS);
    expect(code, `self-test exit ${code}`).toBe(0);
  });

  /**
   * THE LIVE-FIRE IS NOT RUN FROM HERE, AND THAT IS THE FIX FOR A REAL FAILURE.
   *
   * It plants defects into `scripts/lib/pushed-range.sh` and the CR-62 gate IN THE REAL
   * TREE — which is what CR-72 requires of an attack. But vitest runs test FILES in
   * parallel forks, so while the plant was applied another harness
   * (`live-fire-incident-coverage-linkage.sh`) read the gate mid-mutation and reported
   * 7 failing checks. Measured 2026-09-22: the linkage harness passes standalone (9/0)
   * and passes as a single vitest file, and fails ONLY in the full suite — the signature
   * of shared-state contention, not of a defect in either harness.
   *
   * So a tree-planting attack belongs to the serial ops tier, which is the convention
   * every other planting harness here already follows. Its CALLER is the gate registry:
   * `shell-gate-script::scripts/tests/test-pushed-range.sh` declares `recipe=companion`
   * naming `scripts/ops/live-fire-pushed-range.sh`, and the anti-vacuity machinery
   * refuses any registered gate whose companion is missing or dangling — asserted below,
   * so deleting the companion breaks this test rather than going quiet (CR-71).
   */
  /**
   * THIS ASSERTION IS PRIVATE-TREE ONLY, AND THE DISCRIMINATOR IS NOT THE ARTIFACT.
   *
   * The gate registry is private governance; the published tree excludes it by design, so
   * opening it there raises ENOENT. Keying the skip on "the registry is missing" would be
   * the blind-gate shape — removing the registry in the private tree would then silently
   * skip the check that notices it.
   *
   * So the discriminator is a DIFFERENT private-only marker, one the publication guard
   * refuses outright. Where that marker exists this is the private tree and a missing
   * registry is a hard FAILURE; where it does not, there is no registry to assert about
   * and the skip is named.
   *
   * The marker, the incident and the plan behind this guard are cited from the incident
   * record, NOT from here: a private doc path written inside publishable code is exactly
   * what the publication guard exists to catch, and it caught this comment's first draft.
   */
  const IS_INTERNAL = existsSync(join(REPO_ROOT, 'docs/incidents'));
  const registryIt = IS_INTERNAL ? it : it.skip;
  registryIt('the live-fire companion is REGISTERED, so something serial invokes it', async () => {
    const { readFileSync } = await import('fs');
    const registryPath = join(REPO_ROOT, 'scripts/lib/gate-registry.json');
    expect(
      existsSync(registryPath),
      'the private-tree marker is present but the gate registry is GONE',
    ).toBe(true);
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8')) as {
      gates: Array<Record<string, unknown>>;
    };

    const row = registry.gates.find(
      (g) => g.id === 'shell-gate-script::scripts/tests/test-pushed-range.sh',
    );
    expect(row, 'the self-test is not registered, so nothing adjudicates it').toBeTruthy();
    expect(row!.recipe, 'a companion recipe is what names a DISTINCT prover').toBe('companion');
    expect(row!.companion_script, 'the registered companion is not the live-fire')
      .toBe('scripts/ops/live-fire-pushed-range.sh');
    expect(existsSync(LIVE_FIRE), `the registered companion is dangling: ${LIVE_FIRE}`).toBe(true);
  });
});
