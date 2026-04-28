// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import * as lockfile from 'proper-lockfile';
import { withInstallLock, InstallLockBusyError } from '../../lib/installLock.ts';

describe('lib/installLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'massu-installLock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs fn when lock is free, returns its value', () => {
    const out = withInstallLock(dir, () => 42);
    expect(out).toBe(42);
  });

  it('creates .massu/ if missing (fresh repo, iter-3 G3-A11)', () => {
    expect(existsSync(resolve(dir, '.massu'))).toBe(false);
    withInstallLock(dir, () => {
      expect(existsSync(resolve(dir, '.massu'))).toBe(true);
    });
  });

  it('releases the lock so the next call can acquire', () => {
    let count = 0;
    withInstallLock(dir, () => { count++; });
    withInstallLock(dir, () => { count++; });
    expect(count).toBe(2);
  });

  it('bails immediately with retries:0 (legacy bail-now path)', () => {
    // Acquire externally via proper-lockfile.
    const lockPath = resolve(dir, '.massu', 'installAll.lock');
    require('fs').mkdirSync(resolve(dir, '.massu'), { recursive: true });
    const release = lockfile.lockSync(lockPath, { stale: 30_000, retries: 0, realpath: false });
    try {
      expect(() => withInstallLock(dir, () => 1, { retries: 0 })).toThrow(InstallLockBusyError);
    } finally {
      release();
    }
  });

  it('releases even if fn throws', () => {
    expect(() => withInstallLock(dir, () => { throw new Error('boom'); })).toThrow('boom');
    // Should be free now.
    expect(withInstallLock(dir, () => 'ok')).toBe('ok');
  });

  it('error message follows plan §243 format: "installAll already running (PID=X) — try again in <N>s"', () => {
    const lockPath = resolve(dir, '.massu', 'installAll.lock');
    require('fs').mkdirSync(resolve(dir, '.massu'), { recursive: true });
    // Pretend a different PID is the holder so we can grep the error string.
    writeFileSync(`${lockPath}.pid`, '99999', 'utf-8');
    const release = lockfile.lockSync(lockPath, { stale: 30_000, retries: 0, realpath: false });
    try {
      try {
        withInstallLock(dir, () => 1, { retries: 0 });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(InstallLockBusyError);
        expect((err as Error).message).toMatch(/installAll already running \(PID=99999\) — try again in \d+s/);
      }
    } finally {
      release();
    }
  });

  it('blocks up to blockMs (plan §190) and acquires when holder releases', () => {
    // Iter-3 (third pass) G3-iter3-2: plan §190 demands "second caller blocks
    // up to 30s, then bails". proper-lockfile.lockSync rejects retries>0 in
    // the sync API, so we rely on a manual retry loop. This test exercises
    // the loop with a tiny window.
    const lockPath = resolve(dir, '.massu', 'installAll.lock');
    require('fs').mkdirSync(resolve(dir, '.massu'), { recursive: true });
    const release = lockfile.lockSync(lockPath, { stale: 30_000, retries: 0, realpath: false });
    let now = 0;
    const sleeps: number[] = [];
    let released = false;

    // Schedule the external lock to be released after 3 simulated sleeps.
    const sleep = (ms: number): void => {
      sleeps.push(ms);
      now += ms;
      if (sleeps.length === 3 && !released) {
        released = true;
        try { release(); } catch { /* ignore */ }
      }
    };

    const out = withInstallLock(dir, () => 'acquired', {
      retries: undefined,            // use default block path
      blockMs: 5_000,                // give us 5s of virtual time
      pollIntervalMs: 100,
      now: () => now,
      sleep,
    });

    expect(out).toBe('acquired');
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
  });

  it('bails after blockMs deadline if holder never releases', () => {
    const lockPath = resolve(dir, '.massu', 'installAll.lock');
    require('fs').mkdirSync(resolve(dir, '.massu'), { recursive: true });
    const release = lockfile.lockSync(lockPath, { stale: 60_000, retries: 0, realpath: false });
    try {
      let now = 0;
      const sleep = (ms: number): void => { now += ms; };
      expect(() =>
        withInstallLock(dir, () => 1, {
          blockMs: 1_000,
          pollIntervalMs: 100,
          now: () => now,
          sleep,
        }),
      ).toThrow(InstallLockBusyError);
    } finally {
      release();
    }
  });
});
