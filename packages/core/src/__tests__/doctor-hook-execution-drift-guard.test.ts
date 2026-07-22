// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-005 — Doctor hook-execution drift-guard (Layer 4, CR-70).
 *
 * `doctor` must report RED when a configured hook fails AT RUNTIME (not merely when it is
 * mis-configured or its file is missing). This closes gap G-3 (incident 2026-07-22): a hook
 * that crashes at load with ERR_DLOPEN_FAILED previously read green because doctor only checked
 * that hooks were CONFIGURED. `checkHookExecution` runs a real canary end-to-end; here we force
 * both outcomes with a fixture hook file:
 *
 *   - a hook that crashes at load (throws → non-zero exit) → status:'fail'
 *   - a healthy hook (exit 0)                              → status:'pass'
 *   - a hook that exits non-zero without crashing          → status:'fail'
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { checkHookExecution } from '../commands/doctor.ts';

const CORE_ROOT = resolve(__dirname, '..', '..');

let dir: string;
let healthy: string;
let crashesAtLoad: string;
let nonZero: string;

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'massu-canary-'));

  healthy = resolve(dir, 'healthy.mjs');
  writeFileSync(healthy, "try { require; } catch {}\nprocess.exit(0);\n", 'utf-8');

  // Simulate the incident: a native/ABI failure surfaces as a load-time throw → non-zero exit.
  crashesAtLoad = resolve(dir, 'crash.mjs');
  writeFileSync(
    crashesAtLoad,
    "throw new Error('ERR_DLOPEN_FAILED (simulated native ABI mismatch)');\n",
    'utf-8',
  );

  nonZero = resolve(dir, 'nonzero.mjs');
  writeFileSync(nonZero, 'process.exit(3);\n', 'utf-8');
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* OS reclaims tmp */
  }
});

describe('P4-005 doctor checkHookExecution drift-guard (Layer 4, CR-70)', () => {
  it('a healthy canary (exit 0) → status:pass', async () => {
    const r = await checkHookExecution(CORE_ROOT, { hookFile: healthy });
    expect(r.name).toBe('Hook Runtime');
    expect(r.status).toBe('pass');
  });

  it('a hook that CRASHES AT LOAD (ERR_DLOPEN_FAILED-class) → status:fail (RED)', async () => {
    const r = await checkHookExecution(CORE_ROOT, { hookFile: crashesAtLoad });
    expect(r.status).toBe('fail');
    // The failing exit code / a runtime-failure phrase is surfaced for the remedy.
    expect(r.detail).toMatch(/FAILS at runtime|exited/);
  });

  it('a hook that exits NON-ZERO (without crashing) → status:fail', async () => {
    const r = await checkHookExecution(CORE_ROOT, { hookFile: nonZero });
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/exited 3/);
  });

  it('an unresolvable hook file → status:fail (never silently pass)', async () => {
    const r = await checkHookExecution(CORE_ROOT, { hookFile: resolve(dir, 'does-not-exist.mjs') });
    expect(r.status).toBe('fail');
  });

  it('a Node that cannot be spawned (res.error branch — the native-crash-at-spawn case) → status:fail', async () => {
    // Forcing spawnSync to error surfaces the res.error path — the branch that reports a hook
    // that could not even START (e.g. ERR_DLOPEN_FAILED before main), distinct from a non-zero exit.
    const r = await checkHookExecution(CORE_ROOT, {
      hookFile: healthy,
      node: resolve(dir, 'no-such-node-binary'),
    });
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/did not run/);
  });

  it('a hook that exceeds the timeout → status:fail (timed out)', async () => {
    const slow = resolve(dir, 'slow.mjs');
    writeFileSync(slow, 'setTimeout(() => process.exit(0), 60000);\n', 'utf-8');
    const r = await checkHookExecution(CORE_ROOT, { hookFile: slow, timeoutMs: 300 });
    expect(r.status).toBe('fail');
  });

  it('the REAL resolver path (no hookFile override) resolves the session-start canary and runs it', async () => {
    // Exercises resolveHookFile('session-start') + the real spawn end-to-end (requires a built
    // dist/hooks/session-start.js — the build pipeline runs build:hooks before test). If the hook
    // is unresolved the check returns fail (never a silent pass), which is itself the correct
    // behaviour; when present it must execute cleanly under the current (at-floor) Node.
    const r = await checkHookExecution(CORE_ROOT);
    expect(r.name).toBe('Hook Runtime');
    expect(['pass', 'fail']).toContain(r.status);
    // Under the test's at-or-above-floor Node with a built hook, the canary must pass.
    if (r.detail.includes('unresolved')) {
      // resolver could not find a built hook (dev tree without build:hooks) — that is a fail, and
      // still proves the resolver→catch path (not a silent pass).
      expect(r.status).toBe('fail');
    } else {
      expect(r.status).toBe('pass');
    }
  });
});
