import { describe, it, expect } from 'vitest';
import { isTestOrFixturePath, TEST_OR_FIXTURE_PATH_PATTERNS } from '../hooks/fix-detector.ts';
import { readFileSync } from 'fs';
import { join } from 'path';

// plan-stage-d-medium-sweep P-M-003 drift-guard: fix-detector.ts must guard
// against slow git filesystems by (a) caching the work-tree probe with a
// short timeout and (b) auto-disabling git diff invocation per-session when
// previous-call latency exceeds 2000ms. Regression to per-call `git diff`
// without skip would consume the full 5s hook budget on WSL / network drives.

const SRC = readFileSync(
  join(__dirname, '..', 'hooks', 'fix-detector.ts'),
  'utf-8',
);

describe('P-M-003 fix-detector skip-on-slow-git drift-guard', () => {
  it('guarded work-tree probe exists with a budget under 1 second', () => {
    // Helper name documented in the plan; accept either spelling.
    expect(SRC).toMatch(/isGitWorkTree(Fast|Cached|Probe)?/);
    // Probe must specify an explicit timeout ≤500ms.
    const timeoutMatches = Array.from(SRC.matchAll(/timeout:\s*(\d+)/g));
    expect(timeoutMatches.length, 'expected at least one explicit timeout option').toBeGreaterThan(0);
    const probeTimeouts = timeoutMatches.map((m) => parseInt(m[1] ?? '0', 10));
    expect(Math.min(...probeTimeouts)).toBeLessThanOrEqual(500);
  });

  it('per-session auto-disable kicks in when previous-call latency exceeds threshold', () => {
    // Threshold value (>=2000ms) and a session-scoped flag must both exist.
    expect(SRC).toMatch(/2000|2_000/);
    expect(SRC).toMatch(/isSessionAutoDisabled|autoDisable|skipGitDiff/);
  });

  it('cached probe result is persisted to /tmp/massu-fix-detector-state/', () => {
    expect(SRC).toMatch(/massu-fix-detector-state/);
  });
});

/*
 * ROLE-GATE drift-guard (incident 2026-08-13).
 *
 * The heuristics score raw diff CONTENT with no notion of a file's ROLE, so
 * `added_error_handling` (>2 asserts) and `auth_fix` (the word "token") fire on
 * essentially every test. Measured: 464 of 544 massu-internal test files (85%)
 * and 879 of 887 in a sibling private repo (99%) classified as bug fixes. The pipeline
 * then demanded an incident for the very test that closed the PREVIOUS incident
 * — circular, satisfiable only by inventing a defect.
 *
 * This guard EXECUTES the role-gate patterns lifted from the source rather than
 * re-implementing them: a test that re-implements its subject drifts into
 * agreement with its subject's bugs.
 */
describe('fix-detector role-gate (incident 2026-08-13)', () => {
  // Binds to the SOURCE OF TRUTH: the same array the hook itself calls. No text scraping —
  // my first attempt extracted the regex literals with a regex and truncated at the `/` inside
  // `[^/]`, which is the same "a regex cannot parse nested structure" trap as counting parens.
  const skipped = (p: string): boolean => isTestOrFixturePath(p);

  it('the pattern set is non-empty and the hook calls it (M1 — prove it looked)', () => {
    expect(TEST_OR_FIXTURE_PATH_PATTERNS.length).toBeGreaterThan(2);
    expect(SRC, 'the hook no longer calls the exported predicate').toContain('isTestOrFixturePath(filePath)');
  });

  it('SKIPS test and fixture files — the false-positive class', () => {
    for (const p of [
      'packages/core/src/__tests__/foo.test.ts',
      'packages/core/src/__tests__/helpers/code-only.ts',
      'src/__fixtures__/thing.ts',
      'apps/ai-service/tests/test_redact_lib.py',
      'scripts/tests/run.sh',
      'a/b/foo_test.py',
      'web/src/thing.spec.tsx',
    ]) {
      expect(skipped(p), `should be SKIPPED but was scored: ${p}`).toBe(true);
    }
  });

  it('still SCORES product code — a gate that skips everything is dead', () => {
    for (const p of [
      'packages/core/src/hooks/fix-detector.ts',
      'packages/core/src/memory-db.ts',
      'packages/core/src/commands/init.ts',
      'website/src/lib/ip/pepper-guard.ts',
    ]) {
      expect(skipped(p), `should be SCORED but was skipped: ${p}`).toBe(false);
    }
  });

  it('the role-gate runs BEFORE any heuristic scoring', () => {
    // Ordering is the property: gating after scoring would still fire the pipeline.
    expect(SRC.indexOf('// Skip TESTS and FIXTURES')).toBeLessThan(SRC.indexOf('for (const heuristic of FIX_HEURISTICS)'));
  });
});

/*
 * SECOND SITE (incident 2026-08-13, found 2026-08-14).
 *
 * The role-gate above shipped into `fix-detector.ts` only. `classify-failure.ts` is the
 * SAME decision — "does this edit look like a bug fix, so must the author file an
 * incident?" — over the same `old_string`/`new_string`, with the same incident/memory
 * skip-list, and it had NO role-gate. So the class stayed live at half its sites while
 * the guard above reported green (CR-74: a fix is a set of SITES, not an edit).
 *
 * It was not theoretical: writing the guard above tripped `classify-failure` on the very
 * test file being written, and again on `helpers/scaling.ts`, each time demanding an
 * incident for an artifact that closes a previous incident.
 *
 * WHY THIS IS A SOURCE ASSERTION AND NOT AN END-TO-END ONE, STATED PLAINLY: a standalone
 * invocation of the compiled hook could not be made to fire even for product code — its
 * POSITIVE CONTROL stayed silent — so a "the hook was quiet" result out of that harness
 * would have been unfalsifiable, which is the blind-gate law aimed at the probe itself.
 * These assertions therefore bind to the SoT the hook actually calls, plus ORDERING.
 */
describe('classify-failure role-gate — the second site of the same class', () => {
  const CF_SRC = readFileSync(join(__dirname, '..', 'hooks', 'classify-failure.ts'), 'utf-8');

  it('calls the shared predicate rather than re-listing the patterns', () => {
    // Two copies of a path predicate is how the two sites drifted apart to begin with.
    expect(CF_SRC, 'classify-failure no longer imports the shared role-gate')
      .toMatch(/import\s*\{[^}]*isTestOrFixturePath[^}]*\}\s*from\s*'\.\/fix-detector\.ts'/);
    expect(CF_SRC, 'classify-failure no longer calls the shared role-gate')
      .toContain('isTestOrFixturePath(');
    // A second literal pattern list here would be the drift this binding exists to stop.
    expect(CF_SRC).not.toContain('__fixtures__|tests?|fixtures?');
  });

  it('gates BEFORE the bug-fix heuristics run', () => {
    const gate = CF_SRC.indexOf('isTestOrFixturePath(');
    const scoring = CF_SRC.indexOf('for (const pattern of BUG_FIX_INDICATORS)');
    expect(gate, 'role-gate call not found').toBeGreaterThan(-1);
    expect(scoring, 'BUG_FIX_INDICATORS loop not found — this guard has gone vacuous').toBeGreaterThan(-1);
    expect(gate, 'the role-gate must run before content scoring, not after').toBeLessThan(scoring);
  });

  it('the shared predicate classifies the paths that actually tripped this hook', () => {
    // The three real files whose edits fired classify-failure on 2026-08-13/14.
    for (const p of [
      'packages/core/src/__tests__/fix-detector-skip-on-slow-git.test.ts',
      'packages/core/src/__tests__/helpers/scaling.ts',
      'packages/core/src/__tests__/knowledge-tools.test.ts',
    ]) {
      expect(isTestOrFixturePath(p), `should be SKIPPED but was scored: ${p}`).toBe(true);
    }
    // …and the hook must still classify the product code it exists for.
    expect(isTestOrFixturePath('packages/core/src/hooks/classify-failure.ts')).toBe(false);
  });
});
