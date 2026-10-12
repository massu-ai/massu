import { defineConfig } from 'vitest/config';
// D-3: arm the hang detector. The factory is the ONLY place that knows how to arm a run
// root (it sets the heartbeat base and appends the reporter BY PATH, preserving vitest's
// own default including the github-actions CI variant). An unarmed run root is therefore a
// config that did not call this, which is one thing to assert rather than three.
// The import needs no type directive: measured 2026-09-24, `tsc --noEmit --listFiles` resolves
// the .mjs sibling cleanly, and a `@ts-expect-error` here was itself an error (TS2578,
// unused directive) in the one config that IS in a tsconfig program.
import { withHangDetection } from '../../scripts/lib/vitest-hang-armed.mjs';

export default withHangDetection(defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    globals: true,
    // F2 (CR-71): the `MASSU_HOOK_FAILURE_LOG` seam had ZERO callers, so every test that
    // reached `recordHookFailure()` appended to the operator's live `.massu/hook-failures.jsonl`
    // — incident evidence, not scratch space. Declared ONCE here rather than exported in each
    // hook-executing test: the per-site scope (`grep -rln 'dist/hooks/'`) returns 9 files of
    // which only 3 execute a hook, and misses `memory-db.ts`'s in-process caller entirely.
    setupFiles: ['src/__tests__/setup/hook-failure-isolation.ts'],
    // …and this asserts the PROPERTY itself — the real log is byte-identical across the whole
    // run — so a route the declaration above does not cover still fails the suite.
    globalSetup: ['src/__tests__/setup/hook-log-untouched.ts'],
    // Iter-6 fix: tests that call `process.chdir` (watch/, run-on-quiescent,
    // real-chokidar, config-paths, etc.) cannot share a process with other
    // tests that read `process.cwd()` — vitest's default thread pool shares
    // cwd across workers, causing knowledge-e2e and other cwd-dependent tests
    // to flake (verified iter-6: knowledge-e2e fails ~1-in-3 runs alongside
    // chdir-using tests). Switching to the `forks` pool gives each file its
    // own process, isolating cwd. Cost: slightly slower startup; benefit:
    // deterministic test runs.
    pool: 'forks',
    // ⛔ D-6 — THE PER-TEST WALL-CLOCK CEILING IS REMOVED, AND `0` IS HOW YOU REMOVE IT.
    // `0` is not "unset" and not "instant": vitest never ARMS the timer for a non-positive
    // value. Verified in the runner, not inferred from docs:
    //     @vitest/runner/dist/chunk-artifact.js:2262
    //       if (timeout <= 0 || timeout === Number.POSITIVE_INFINITY) {
    //     @vitest/runner/dist/chunk-artifact.js:2672
    //       if (timeout > 0 && timeout !== Number.POSITIVE_INFINITY) {
    //
    // ⛔ DO NOT "TIDY" THESE KEYS AWAY. DELETING THEM IS NOT EQUIVALENT — IT IS STRICTER.
    // vitest's declared defaults are testTimeout 5000 / hookTimeout 10000
    // (reporters.d.DtoKVV2s.d.ts:2891-2901), so removing the keys would reinstate a ceiling
    // FOUR AND THREE TIMES TIGHTER than the 20000/30000 they replace. An explicit `0` is a
    // DECLARATION that the bound was removed deliberately; an absent key is indistinguishable
    // from nobody having considered it, and D-5's guard asserts the property by reading this.
    //
    // WHAT THE OLD COMMENT SAID, AND WHY IT WAS THE DEFECT RATHER THAN THE CALIBRATION:
    //   "Raise both so a starved-but-progressing test is not failed for the machine being
    //    busy; a genuine hang still trips these ceilings."
    // The first clause is a wall-clock bound failing in the RED direction — a healthy test
    // killed for host contention — and raising it only moves the machine speed at which that
    // happens. The second clause is the claim a SILENCE bound now makes properly: a hang is the
    // ABSENCE OF EVENTS, which is a property of the run rather than of the host.
    //
    // WHAT REPLACES THEM, so this is a substitution and not a removal:
    //   the detector  scripts/lib/hang_watch.mjs — 90s of SILENCE, measured (D-1), and it names
    //                 the stuck module AND the stuck hook (proven by live-fire-hang-watch.sh,
    //                 16/16 over seven real hang shapes, including `beforeall-hang`)
    //   the backstop  scripts/lib/hang-supervise.mjs — an absolute TOTAL-RUNTIME ceiling for a
    //                 run that progresses forever, which no silence bound can catch; its own
    //                 exit code 143 so it can never be mistaken for a detection
    testTimeout: 0,
    hookTimeout: 0,
    coverage: {
      // Real v8 instrumented line coverage (plan-2026-06-03-website-lib-test-coverage).
      // Only collected when invoked with `--coverage` (massu-test-coverage.sh /
      // ci-coverage.sh) — bare `npm test` does NOT instrument.
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      // Business-logic only. Excludes integration-shaped ENTRYPOINTS that are not
      // meaningfully unit-testable (operator decision 2026-06-03,
      // plan-2026-06-03-website-lib-test-coverage P0-007): the MCP/stdio server
      // entry (server.ts), the CLI entry + its command handlers (cli.ts,
      // commands/**), the standalone runners (backfill-sessions, trpc-index,
      // validate-features-runner), the hook entrypoints (hooks/**), and the
      // Python language-indexer subsystem (python/**, python-tools.ts).
      exclude: [
        '**/__tests__/**',
        '**/*.d.ts',
        'src/hooks/**',
        'src/cli.ts',
        'src/server.ts',
        'src/commands/**',
        'src/python/**',
        'src/python-tools.ts',
        'src/backfill-sessions.ts',
        'src/validate-features-runner.ts',
        'src/trpc-index.ts',
      ],
      thresholds: {
        // Floor sourced from /coverage-floors.json ("packages/core") and pinned
        // by coverage-floor-monotonic.test.ts so config↔SoT cannot diverge.
        lines: 80,
      },
    },
  },
}));
