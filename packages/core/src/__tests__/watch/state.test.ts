// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import {
  readState,
  updateState,
  writeStateAtomic,
  watchStatePath,
  backupStatePath,
  WatchStateNewerError,
  MAX_SUPPORTED_SCHEMA_VERSION,
  DEFAULT_STATE,
} from '../../watch/state.ts';

describe('watch/state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'massu-state-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns DEFAULT_STATE when state file is missing', () => {
    const s = readState(dir);
    expect(s).toEqual(DEFAULT_STATE);
  });

  it('writeStateAtomic + readState round-trip', () => {
    writeStateAtomic(dir, {
      ...DEFAULT_STATE,
      lastFingerprint: 'abc123',
      lastRefreshAt: '2026-04-27T00:00:00Z',
      daemonPid: 4242,
    });
    const s = readState(dir);
    expect(s.lastFingerprint).toBe('abc123');
    expect(s.lastRefreshAt).toBe('2026-04-27T00:00:00Z');
    expect(s.daemonPid).toBe(4242);
    expect(s.schema_version).toBe(MAX_SUPPORTED_SCHEMA_VERSION);
  });

  it('updateState merges patches and bumps schema_version', () => {
    updateState(dir, { lastFingerprint: 'first' });
    updateState(dir, { lastRefreshAt: '2026-04-27T01:00:00Z' });
    const s = readState(dir);
    expect(s.lastFingerprint).toBe('first');
    expect(s.lastRefreshAt).toBe('2026-04-27T01:00:00Z');
  });

  it('archives a state file with missing schema_version field', () => {
    const path = watchStatePath(dir);
    require('fs').mkdirSync(resolve(dir, '.massu'), { recursive: true });
    writeFileSync(path, JSON.stringify({ daemonPid: 1, lastFingerprint: 'x' }), 'utf-8');
    const s = readState(dir);
    expect(s).toEqual(DEFAULT_STATE);
    expect(existsSync(backupStatePath(dir))).toBe(true);
    const archived = JSON.parse(readFileSync(backupStatePath(dir), 'utf-8'));
    expect(archived.lastFingerprint).toBe('x');
  });

  it('throws WatchStateNewerError when schema_version > daemon max', () => {
    const path = watchStatePath(dir);
    require('fs').mkdirSync(resolve(dir, '.massu'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ schema_version: MAX_SUPPORTED_SCHEMA_VERSION + 1, daemonPid: 1 }),
      'utf-8',
    );
    expect(() => readState(dir)).toThrow(WatchStateNewerError);
  });

  it('archives and rebuilds when state file is corrupt JSON', () => {
    const path = watchStatePath(dir);
    require('fs').mkdirSync(resolve(dir, '.massu'), { recursive: true });
    writeFileSync(path, 'not-json {{{', 'utf-8');
    const s = readState(dir);
    expect(s).toEqual(DEFAULT_STATE);
    expect(existsSync(backupStatePath(dir))).toBe(true);
  });

  it('writeStateAtomic creates .massu/ when missing (fresh repo case)', () => {
    expect(existsSync(resolve(dir, '.massu'))).toBe(false);
    writeStateAtomic(dir, { ...DEFAULT_STATE, daemonPid: 5 });
    expect(existsSync(watchStatePath(dir))).toBe(true);
  });

  it('archives binary garbage as corrupt (iter-5 coverage gap)', () => {
    // Iter-5 audit found state.test.ts only covered string-corrupt JSON
    // (`'not-json {{{' utf-8`). A real-world torn write or filesystem-level
    // corruption can produce arbitrary binary content; the read path must
    // still archive + rebuild, never propagate a parse exception out.
    const path = watchStatePath(dir);
    require('fs').mkdirSync(resolve(dir, '.massu'), { recursive: true });
    // 16 bytes of pseudo-binary garbage incl. NUL and high bytes.
    const garbage = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01, 0x02, 0xab, 0xcd,
                                 0xef, 0x00, 0x10, 0x20, 0x30, 0xfe, 0xfd, 0xfc]);
    require('fs').writeFileSync(path, garbage);
    const s = readState(dir);
    expect(s).toEqual(DEFAULT_STATE);
    expect(existsSync(backupStatePath(dir))).toBe(true);
  });

  it('back-to-back writeStateAtomic calls do not collide on temp filename (iter-1 per-pid+counter fix)', () => {
    // Iter-1's writeStateAtomic uses `${path}.${pid}.${counter}.tmp` so
    // multiple sequential writes never share a temp filename, and any
    // concurrent renamer that happens to interleave (test simulates by
    // writing 50 times in a tight loop) lands at the final path with
    // exactly the last successful payload — never a torn / partial write.
    for (let i = 0; i < 50; i++) {
      writeStateAtomic(dir, { ...DEFAULT_STATE, lastFingerprint: `fp-${i}` });
    }
    const final = readState(dir);
    expect(final.lastFingerprint).toBe('fp-49');
    // No leftover .tmp files in .massu/ — every rename succeeded.
    const fs = require('fs');
    const entries: string[] = fs.readdirSync(resolve(dir, '.massu'));
    const stragglers = entries.filter((n) => n.endsWith('.tmp'));
    expect(stragglers).toEqual([]);
  });
});
