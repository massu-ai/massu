import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    globals: true,
    // Iter-6 fix: tests that call `process.chdir` (watch/, run-on-quiescent,
    // real-chokidar, config-paths, etc.) cannot share a process with other
    // tests that read `process.cwd()` — vitest's default thread pool shares
    // cwd across workers, causing knowledge-e2e and other cwd-dependent tests
    // to flake (verified iter-6: knowledge-e2e fails ~1-in-3 runs alongside
    // chdir-using tests). Switching to the `forks` pool gives each file its
    // own process, isolating cwd. Cost: slightly slower startup; benefit:
    // deterministic test runs.
    pool: 'forks',
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
