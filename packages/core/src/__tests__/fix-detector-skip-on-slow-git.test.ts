import { describe, it, expect } from 'vitest';
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
