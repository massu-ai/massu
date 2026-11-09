// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Unit tests for the watcher-liveness canary
 * (plan-2026-08-12-watch-daemon-silent-dead-watcher, D-2).
 *
 * These cover the canary's DECISION LOGIC in isolation. The end-to-end
 * behaviour against a real chokidar instance lives in real-chokidar.test.ts,
 * and the CR-72 proof that the canary can actually go RED on a genuinely dead
 * watcher lives in scripts/tests/live-fire-watch-canary.sh.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import {
  CANARY_DIR_REL,
  CANARY_FILE_REL,
  CANARY_MIN_GRACE_MS,
  canaryAwareIgnore,
  createWatcherCanary,
  isCanaryPath,
} from '../../watch/canary.ts';

describe('watch/canary', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'massu-canary-unit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('isCanaryPath', () => {
    it('matches the canary dir and its contents, relative or absolute', () => {
      expect(isCanaryPath(dir, CANARY_DIR_REL)).toBe(true);
      expect(isCanaryPath(dir, CANARY_FILE_REL)).toBe(true);
      expect(isCanaryPath(dir, resolve(dir, CANARY_FILE_REL))).toBe(true);
    });

    it('does not match ordinary source paths or other .massu entries', () => {
      expect(isCanaryPath(dir, 'src/index.ts')).toBe(false);
      expect(isCanaryPath(dir, '.massu/watch-state.json')).toBe(false);
      expect(isCanaryPath(dir, resolve(dir, '.massu/massu.db'))).toBe(false);
    });

    it('is anchored to the project root, not matched anywhere in the string', () => {
      // A project that itself lives under a directory named `.massu` must not
      // have every one of its files treated as the canary — that would
      // un-ignore the entire tree.
      const nested = resolve(dir, '.massu', 'checkout');
      expect(isCanaryPath(nested, resolve(nested, 'src/index.ts'))).toBe(false);
      expect(isCanaryPath(nested, resolve(nested, CANARY_FILE_REL))).toBe(true);
    });
  });

  describe('canaryAwareIgnore', () => {
    const IGNORE = ['**/node_modules/**', '**/.massu/**', '**/.git/**'];

    function ignores(matchers: (string | ((p: string) => boolean))[], p: string): boolean {
      return matchers.some((m) => (typeof m === 'function' ? m(p) : false));
    }

    it('drops the blanket .massu glob and keeps every other exclusion verbatim', () => {
      const out = canaryAwareIgnore(IGNORE, dir);
      const strings = out.filter((m): m is string => typeof m === 'string');
      expect(strings).toEqual(['**/node_modules/**', '**/.git/**']);
      expect(out.filter((m) => typeof m === 'function')).toHaveLength(1);
    });

    it('still ignores .massu internals but NOT the canary', () => {
      const out = canaryAwareIgnore(IGNORE, dir);
      expect(ignores(out, resolve(dir, '.massu/watch-state.json'))).toBe(true);
      expect(ignores(out, resolve(dir, '.massu/massu.db'))).toBe(true);
      expect(ignores(out, resolve(dir, CANARY_FILE_REL))).toBe(false);
      expect(ignores(out, resolve(dir, 'src/index.ts'))).toBe(false);
    });
  });

  describe('arm / observe / evaluate', () => {
    // A controllable clock, so the grace period is exercised deterministically
    // instead of by sleeping for real (G27/CR-90).
    let clock: number;
    const tick = (ms = CANARY_MIN_GRACE_MS): void => {
      clock += ms;
    };
    const makeCanary = (): ReturnType<typeof createWatcherCanary> => {
      clock = 1_000_000;
      return createWatcherCanary({ projectRoot: dir, now: () => clock });
    };

    it('reports idle before the first arm — never alive', () => {
      // "I could not look" must not collapse into "I looked and saw delivery".
      const c = makeCanary();
      expect(c.evaluate()).toBe('idle');
      expect(c.consecutiveDead).toBe(0);
    });

    it('writes the sentinel on arm', () => {
      const c = makeCanary();
      expect(c.arm()).toBe('armed');
      expect(existsSync(c.filePath)).toBe(true);
      expect(readFileSync(c.filePath, 'utf-8').trim()).not.toBe('');
    });

    it('is alive when the armed write is echoed back', () => {
      const c = makeCanary();
      c.arm();
      expect(c.observe(CANARY_FILE_REL)).toBe(true);
      tick();
      expect(c.evaluate()).toBe('alive');
      expect(c.consecutiveDead).toBe(0);
    });

    it('is dead when the armed write is never echoed, and counts the streak', () => {
      const c = makeCanary();
      c.arm();
      tick();
      expect(c.evaluate()).toBe('dead');
      expect(c.consecutiveDead).toBe(1);
      c.arm();
      tick();
      expect(c.evaluate()).toBe('dead');
      expect(c.consecutiveDead).toBe(2);
    });

    it('resets the streak on recovery', () => {
      const c = makeCanary();
      c.arm();
      tick();
      c.evaluate();
      c.arm();
      tick();
      c.evaluate();
      expect(c.consecutiveDead).toBe(2);
      c.arm();
      c.observe(CANARY_FILE_REL);
      tick();
      expect(c.evaluate()).toBe('alive');
      expect(c.consecutiveDead).toBe(0);
    });

    it('will not convict an arm younger than the grace period', () => {
      // Measured echo latency tails to ~941ms under load. Convicting on that
      // tail would reconcile a perfectly healthy project on the daemon's own
      // heartbeat — the permanent-reconcile failure this must never become.
      const c = makeCanary();
      c.arm();
      tick(CANARY_MIN_GRACE_MS - 1);
      expect(c.evaluate()).toBe('idle');
      expect(c.consecutiveDead).toBe(0);
      // …and the verdict still lands once it is old enough.
      tick(2);
      expect(c.evaluate()).toBe('dead');
    });

    it('does not restart an in-flight arm, so a short tick still reaches a verdict', () => {
      // If arm() rewrote the sentinel every tick, an arm would never age past
      // the grace period under a tick shorter than it, and the canary would sit
      // permanently idle — a dead control emitting exactly the silence a
      // healthy one emits.
      const c = makeCanary();
      c.arm();
      for (let i = 0; i < 20; i++) {
        tick(150);
        c.arm();
      }
      expect(c.evaluate()).toBe('dead');
      expect(c.consecutiveDead).toBe(1);
    });

    it('does NOT count an echo that arrived before the arm', () => {
      // chokidar emits addDir/add for the canary directory from its initial
      // synchronous readdir walk. That is a directory SCAN, not an event
      // delivery, and counting it would make a dead watcher look alive —
      // the canary would be decoration.
      const c = makeCanary();
      expect(c.observe(CANARY_DIR_REL)).toBe(true);
      expect(c.observe(CANARY_FILE_REL)).toBe(true);
      c.arm();
      tick();
      expect(c.evaluate()).toBe('dead');
    });

    it('claims non-canary paths are not its own', () => {
      const c = makeCanary();
      c.arm();
      expect(c.observe('src/index.ts')).toBe(false);
      tick();
      // A source event is NOT evidence the canary was delivered.
      expect(c.evaluate()).toBe('dead');
    });

    it('reports unwritable — and then idle, never dead — when the sentinel cannot be placed', () => {
      // An unwritable .massu/ is a different (and louder) failure than a dead
      // watcher. Reporting it as DEAD would reconcile forever against a
      // watcher that is working fine.
      const asFile = resolve(dir, 'not-a-dir');
      writeFileSync(asFile, 'x', 'utf-8');
      const c = createWatcherCanary({ projectRoot: asFile });
      expect(c.arm()).toBe('unwritable');
      expect(c.evaluate()).toBe('idle');
      expect(c.consecutiveDead).toBe(0);
    });

    it('cleanup removes the sentinel and tolerates a missing one', () => {
      const c = createWatcherCanary({ projectRoot: dir });
      c.arm();
      expect(existsSync(c.filePath)).toBe(true);
      c.cleanup();
      expect(existsSync(c.filePath)).toBe(false);
      expect(() => c.cleanup()).not.toThrow();
    });

    it('uses the injected clock for the sentinel token', () => {
      const c = createWatcherCanary({ projectRoot: dir, now: () => 424242 });
      c.arm();
      expect(readFileSync(c.filePath, 'utf-8').trim()).toBe('424242');
    });

    it('writes a DISTINCT token per arm so a coalesced repeat cannot pose as fresh', () => {
      let t = 1_000_000;
      const c = createWatcherCanary({ projectRoot: dir, now: () => t });
      c.arm();
      const first = readFileSync(c.filePath, 'utf-8');
      // A fresh arm only happens once the previous one has been adjudicated.
      t += CANARY_MIN_GRACE_MS;
      expect(c.evaluate()).toBe('dead');
      t += 7;
      c.arm();
      expect(readFileSync(c.filePath, 'utf-8')).not.toBe(first);
    });
  });

  describe('the canary directory is real', () => {
    it('arm creates the directory when it does not exist', () => {
      const c = createWatcherCanary({ projectRoot: dir });
      rmSync(resolve(dir, '.massu'), { recursive: true, force: true });
      expect(c.arm()).toBe('armed');
      expect(existsSync(resolve(dir, CANARY_DIR_REL))).toBe(true);
    });

    it('survives a pre-existing canary directory', () => {
      mkdirSync(resolve(dir, CANARY_DIR_REL), { recursive: true });
      const c = createWatcherCanary({ projectRoot: dir });
      expect(c.arm()).toBe('armed');
    });
  });
});
