// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-001 — Bootstrap drift-guard (Layer 2, CR-70).
 *
 * Locks the self-bootstrapping launcher chokepoint behaviour:
 *   (a) at/above floor  → no-op (no discovery, no re-exec)
 *   (b) below floor + a compatible Node present → re-execs and mirrors its exit code
 *   (c) below floor + none found → exit NON-ZERO with a copy-paste remedy on stderr (never 0)
 *   (d) MASSU_NO_NODE_BOOTSTRAP=1 below floor → NO re-exec but STILL a loud fail
 *   (e) G-6 anti-vacuity: a mutant that skips the re-exec below floor MUST be caught
 *   (f) loop guard (R-1): the re-exec sentinel makes the child a no-op
 *
 * Origin: incident 2026-07-22-native-abi-hooks-bare-node-launch — bare hooks crashed under a
 * sub-floor / mismatched-ABI Node while the server was hand-wrapped to a compatible one.
 */

import { describe, it, expect } from 'vitest';
import {
  bootstrapNodeOrExit,
  REEXEC_SENTINEL_ENV,
  OPT_OUT_ENV,
} from '../lib/node-bootstrap.ts';
import { MIN_NODE_MAJOR, MIN_NODE_MINOR } from '../preflight.ts';

const ABOVE_FLOOR = `v${MIN_NODE_MAJOR + 1}.0.0`;
const BELOW_FLOOR = `v${MIN_NODE_MAJOR - 1}.0.0`; // e.g. v21.x — node:sqlite absent/flagged

interface Spy {
  discoverCalls: number;
  reexecCalls: Array<{ nodePath: string; selfEntry: string; argv: string[] }>;
  exitCode: number | null;
  stderr: string;
}

function run(
  argv: string[],
  env: NodeJS.ProcessEnv,
  o: { nodeVersion: string; discoverResult?: string | null; reexecStatus?: number },
): Spy {
  const spy: Spy = { discoverCalls: 0, reexecCalls: [], exitCode: null, stderr: '' };
  bootstrapNodeOrExit(argv, env, {
    nodeVersion: o.nodeVersion,
    selfEntry: '/fake/cli.js',
    discover: () => {
      spy.discoverCalls += 1;
      return o.discoverResult ?? null;
    },
    reexec: (nodePath, selfEntry, a) => {
      spy.reexecCalls.push({ nodePath, selfEntry, argv: a });
      return o.reexecStatus ?? 0;
    },
    stderr: (m) => {
      spy.stderr += m;
    },
    exit: (c) => {
      spy.exitCode = c;
    },
  });
  return spy;
}

describe('P4-001 node-bootstrap drift-guard (Layer 2, CR-70)', () => {
  it('(a) at/above floor → no-op: no discovery, no re-exec, no exit', () => {
    const spy = run([], {}, { nodeVersion: ABOVE_FLOOR });
    expect(spy.discoverCalls).toBe(0);
    expect(spy.reexecCalls).toHaveLength(0);
    expect(spy.exitCode).toBeNull();
    expect(spy.stderr).toBe('');
  });

  it('(b) below floor + compatible Node present → re-execs and mirrors its exit code', () => {
    const spy = run(['hook-runner', 'session-start'], {}, {
      nodeVersion: BELOW_FLOOR,
      discoverResult: '/opt/homebrew/opt/node@22/bin/node',
      reexecStatus: 0,
    });
    expect(spy.discoverCalls).toBe(1);
    expect(spy.reexecCalls).toHaveLength(1);
    expect(spy.reexecCalls[0].nodePath).toBe('/opt/homebrew/opt/node@22/bin/node');
    expect(spy.reexecCalls[0].argv).toEqual(['hook-runner', 'session-start']);
    expect(spy.exitCode).toBe(0);
  });

  it('(b2) below floor + compatible Node → non-zero child exit is mirrored, not swallowed', () => {
    const spy = run([], {}, { nodeVersion: BELOW_FLOOR, discoverResult: '/n', reexecStatus: 7 });
    expect(spy.exitCode).toBe(7);
  });

  it('(c) below floor + NONE found → non-zero exit + remedy on stderr, NEVER exit 0', () => {
    const spy = run([], {}, { nodeVersion: BELOW_FLOOR, discoverResult: null });
    expect(spy.reexecCalls).toHaveLength(0);
    expect(spy.exitCode).toBe(1);
    expect(spy.exitCode).not.toBe(0);
    // The remedy reuses the preflight requirement statement + a copy-paste install line.
    expect(spy.stderr).toMatch(new RegExp(`${MIN_NODE_MAJOR}\\.${MIN_NODE_MINOR}\\.0`));
    expect(spy.stderr).toMatch(/nvm install|brew install node/);
  });

  it('(d) MASSU_NO_NODE_BOOTSTRAP=1 below floor → NO re-exec but STILL loud-fails', () => {
    const spy = run([], { [OPT_OUT_ENV]: '1' }, { nodeVersion: BELOW_FLOOR, discoverResult: '/n' });
    expect(spy.discoverCalls).toBe(0); // opt-out skips discovery entirely
    expect(spy.reexecCalls).toHaveLength(0);
    expect(spy.exitCode).toBe(1);
    expect(spy.stderr).toMatch(new RegExp(`${MIN_NODE_MAJOR}\\.${MIN_NODE_MINOR}\\.0`));
  });

  it('(f) loop guard: the re-exec sentinel makes a below-floor child fail loud, never re-loop', () => {
    // Sentinel set but child still below floor (should be impossible in practice) → loud fail,
    // never another discovery/re-exec (that is the infinite-loop this guard prevents).
    const spy = run([], { [REEXEC_SENTINEL_ENV]: '1' }, { nodeVersion: BELOW_FLOOR, discoverResult: '/n' });
    expect(spy.discoverCalls).toBe(0);
    expect(spy.reexecCalls).toHaveLength(0);
    expect(spy.exitCode).toBe(1);
  });

  it('(f2) loop guard: sentinel set + at/above floor child → clean no-op', () => {
    const spy = run([], { [REEXEC_SENTINEL_ENV]: '1' }, { nodeVersion: ABOVE_FLOOR });
    expect(spy.exitCode).toBeNull();
    expect(spy.reexecCalls).toHaveLength(0);
  });

  it('(e) G-6 anti-vacuity: the "re-exec happened" assertion has teeth — a mutant that skips it is caught', () => {
    // The REAL implementation re-execs below floor:
    let realReexeced = false;
    bootstrapNodeOrExit([], {}, {
      nodeVersion: BELOW_FLOOR,
      discover: () => '/n',
      reexec: () => {
        realReexeced = true;
        return 0;
      },
      exit: () => {},
      stderr: () => {},
    });
    expect(realReexeced).toBe(true);

    // A MUTANT bootstrap that no-ops below floor (the exact regression this guard exists to
    // catch) never sets the flag. The same assertion MUST fail for it — proving this test is
    // not vacuous. If `expect(mutantReexeced).toBe(true)` did NOT throw, the guard would be
    // decoration (CR-64: a gate that cannot go red).
    const mutantBootstrap = (_deps: { reexec: () => number }) => {
      /* deliberately skips re-exec below floor */
    };
    let mutantReexeced = false;
    mutantBootstrap({
      reexec: () => {
        mutantReexeced = true;
        return 0;
      },
    });
    expect(() => expect(mutantReexeced).toBe(true)).toThrow();
  });
});
