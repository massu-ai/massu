// Plan 3c Phase 9b P-A-013: per-adapter project config under root
// vitest.config.ts `test.projects`.
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    pool: 'forks',
  },
});
