// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * A deciding hook that crashes must DENY, never allow.
 *
 * Claude Code reads a PreToolUse hook's exit code: 0 allows, 2 denies, and anything else is a
 * "non-blocking error" — the call RUNS. A gate bundle that cannot load a dependency exits 1
 * (measured 2026-11-09: ERR_MODULE_NOT_FOUND, exit 1), so a broken install would open every
 * gate. hook-runner maps every non-verdict exit of a DECISION hook to 2.
 *
 * The deciding set is DERIVED here from the hook sources (entries that call the shared
 * decision) and compared with the registry, so a new deciding entry cannot be missed.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { decisionExitCode } from '../commands/hook-runner.ts';
import { DECISION_HOOKS, REGISTERED_HOOKS } from '../lib/hook-registry.ts';
import { massuShimBody, buildHooksConfig } from '../commands/init.ts';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

function derivedDecisionHooks(): string[] {
  return readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .filter((f) => /runPreToolUseDecision\(/.test(readFileSync(join(HOOKS_DIR, f), 'utf-8')))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

describe('hook-runner: a deciding hook without a verdict denies', () => {
  it('the deciding set in the registry equals the entries that call the shared decision', () => {
    const derived = derivedDecisionHooks();
    expect(derived.length, 'derived zero deciding hooks — the scan saw nothing').toBeGreaterThan(0);
    expect([...DECISION_HOOKS].sort()).toEqual(derived);
  });

  it.each([1, 128, 3, 137])('a decision hook exiting %i is turned into a DENY (2)', (code) => {
    for (const hook of DECISION_HOOKS) expect(decisionExitCode(hook, code), hook).toBe(2);
  });

  it('a decision hook keeps its verdict: 0 stays allow, 2 stays deny', () => {
    for (const hook of DECISION_HOOKS) {
      expect(decisionExitCode(hook, 0)).toBe(0);
      expect(decisionExitCode(hook, 2)).toBe(2);
    }
  });

  it('a non-deciding hook keeps its own exit code (its failure must not block a session)', () => {
    const others = REGISTERED_HOOKS.filter((h) => !(DECISION_HOOKS as readonly string[]).includes(h));
    expect(others.length).toBeGreaterThan(0);
    for (const hook of others) expect(decisionExitCode(hook, 1), hook).toBe(1);
  });
});

/**
 * One layer out: the shim launches cli.js, and a runtime that cannot load exits 1 before
 * hook-runner exists to map it. Run the REAL shim body against a throwaway HOME whose
 * runtime "cli.js" just exits 1.
 */
describe('massu-hook shim: a launch that fails without a verdict denies a deciding hook', () => {
  function runShim(hook: string): number | null {
    const home = mkdtempSync(join(tmpdir(), 'shim-decision-'));
    try {
      const shim = join(home, 'massu-hook');
      writeFileSync(shim, massuShimBody());
      chmodSync(shim, 0o755);
      const dist = join(home, '.massu', 'runtime', '9.9.9', 'node_modules', '@massu', 'core', 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'cli.js'), 'process.exit(1);\n');
      return spawnSync(shim, ['9.9.9', 'hook-runner', hook], { env: { ...process.env, HOME: home }, input: '{}' }).status;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it.each([...DECISION_HOOKS])('%s: a crashed launch becomes exit 2', (hook) => {
    expect(runShim(hook)).toBe(2);
  });

  it('control: a non-deciding hook keeps the crash code (exec path, never blocks a session)', () => {
    expect(runShim('session-end')).toBe(1);
  });
});

/**
 * The host-level half: Claude Code's own `onFailure: "block"` (v2.1.295+) turns a hook that
 * cannot start, exits other than 0/2, TIMES OUT or prints invalid JSON into a block. Only the
 * host can see a timeout, so the installer must set it on every deciding hook — and on no
 * other hook, whose failure must never block a session.
 */
describe('massu init: deciding hooks carry onFailure "block", and only they do', () => {
  it('every emitted entry is checked, deciding ones block on failure', () => {
    const config = buildHooksConfig('', null) as Record<string, Array<{ hooks: Array<{ command: string; onFailure?: string }> }>>;
    let deciding = 0;
    let others = 0;
    for (const groups of Object.values(config)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          const name = DECISION_HOOKS.find((d) => new RegExp(`\\b${d}\\b`).test(h.command));
          if (name) { deciding += 1; expect(h.onFailure, h.command).toBe('block'); }
          else { others += 1; expect(h.onFailure, h.command).toBeUndefined(); }
        }
      }
    }
    expect(deciding, 'no deciding hook was emitted — the check saw nothing').toBeGreaterThan(0);
    expect(others).toBeGreaterThan(0);
  });
});
