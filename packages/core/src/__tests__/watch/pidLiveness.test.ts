// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { isPidAlive } from '../../lib/pidLiveness.ts';

describe('lib/pidLiveness', () => {
  it('returns true for the current process pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for an obviously-dead pid', () => {
    // PID 1 always exists on POSIX, but on Windows we treat as best-effort.
    // Pick a sufficiently absurd pid that is virtually guaranteed dead.
    expect(isPidAlive(2_000_000_000)).toBe(false);
  });

  it('returns false for non-positive / non-finite input', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('treats EPERM as alive (POSIX)', () => {
    const out = isPidAlive(12345, {
      platformOverride: 'darwin',
      killOverride: () => {
        const e = new Error('eperm') as NodeJS.ErrnoException;
        e.code = 'EPERM';
        throw e;
      },
    });
    expect(out).toBe(true);
  });

  it('treats ESRCH as dead (POSIX)', () => {
    const out = isPidAlive(12345, {
      platformOverride: 'linux',
      killOverride: () => {
        const e = new Error('esrch') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      },
    });
    expect(out).toBe(false);
  });

  it('windows path: uses tasklist (best-effort)', () => {
    // We can't really exercise tasklist in this test runner. Just smoke that
    // it doesn't throw and returns a boolean.
    const out = isPidAlive(process.pid, { platformOverride: 'win32' });
    expect(typeof out).toBe('boolean');
  });
});
