import { defineConfig } from 'vitest/config';

export default defineConfig({
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
    // Timeout calibration for this suite under the `forks` pool on slower/loaded machines
    // (notably macOS-26, where native `better-sqlite3` construction is slow). The vitest
    // defaults (5s test / 10s hook) intermittently time out the heaviest native-DB setups and
    // subprocess-spawning tests under full 16-process parallelism — purely CPU contention, never
    // a deadlock (each passes comfortably in isolation). Raise both so a starved-but-progressing
    // test is not failed for the machine being busy; a genuine hang still trips these ceilings.
    testTimeout: 20000,
    hookTimeout: 30000,
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
});
