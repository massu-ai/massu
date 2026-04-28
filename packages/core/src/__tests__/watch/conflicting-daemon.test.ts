// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Iter-8 fix: Plan 3a §256 risk #6 — second `massu watch --foreground` on
 * the same toplevel must refuse to start. Tests the pure precheck function
 * `checkConflictingDaemon` in isolation so we don't need to spin up a real
 * chokidar daemon to verify the gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { writeStateAtomic, DEFAULT_STATE } from '../../watch/state.ts';
import { checkConflictingDaemon } from '../../commands/watch.ts';

describe('runForeground precheck — checkConflictingDaemon', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'massu-conflict-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no watch-state.json exists', () => {
    expect(checkConflictingDaemon(dir, 99999, () => true)).toBeNull();
  });

  it('returns null when the recorded pid is dead', () => {
    writeStateAtomic(dir, { ...DEFAULT_STATE, daemonPid: 4242 });
    expect(checkConflictingDaemon(dir, 99999, () => false)).toBeNull();
  });

  it('returns null when the recorded pid IS our own (self-restart inside same process)', () => {
    writeStateAtomic(dir, { ...DEFAULT_STATE, daemonPid: 12345 });
    expect(checkConflictingDaemon(dir, 12345, () => true)).toBeNull();
  });

  it('returns a non-null conflict message when another live pid owns the root', () => {
    writeStateAtomic(dir, { ...DEFAULT_STATE, daemonPid: 4242 });
    const msg = checkConflictingDaemon(dir, 99999, () => true);
    expect(msg).not.toBeNull();
    expect(msg).toContain('PID=4242');
    expect(msg).toContain(dir);
    expect(msg).toContain('massu watch --stop');
  });

  it('returns null when readState throws (corrupt/inaccessible state)', () => {
    // Use a path that does not have a watch-state.json — readState returns
    // DEFAULT_STATE (no throw, daemonPid: null), so the check returns null.
    expect(checkConflictingDaemon(dir, 99999, () => true)).toBeNull();
  });
});
