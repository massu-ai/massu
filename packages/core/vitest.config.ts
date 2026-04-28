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
  },
});
