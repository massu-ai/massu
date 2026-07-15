// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { assertMemoryEngineHealthy, FatalStartupError } from '../startup-health.ts';

describe('assertMemoryEngineHealthy (SF-1 — the engine must not report "connected but broken")', () => {
  it('THROWS FatalStartupError when the memory DB engine cannot be opened', () => {
    // Simulate the native-binding / ABI failure (the Node-26 dlopen break).
    const brokenOpener = () => {
      throw new Error(
        "The module was compiled against a different Node.js version using " +
        "NODE_MODULE_VERSION 127. This version requires NODE_MODULE_VERSION 147."
      );
    };
    expect(() => assertMemoryEngineHealthy(brokenOpener)).toThrow(FatalStartupError);
    // The remedy must be actionable — a bare rethrow is not fail-closed enough.
    expect(() => assertMemoryEngineHealthy(brokenOpener)).toThrow(/rebuild|reinstall/i);
  });

  it('does NOT throw when the engine opens, and releases the probe handle', () => {
    let closed = false;
    const healthyOpener = () => ({ close: () => { closed = true; } });
    expect(() => assertMemoryEngineHealthy(healthyOpener)).not.toThrow();
    // Anti-vacuity: prove the probe actually opened AND closed a handle,
    // rather than being a no-op that would pass even if it looked at nothing.
    expect(closed).toBe(true);
  });

  it('propagates the underlying open error message into the fatal error', () => {
    const opener = () => { throw new Error('ERR_DLOPEN_FAILED: cannot open shared object'); };
    expect(() => assertMemoryEngineHealthy(opener)).toThrow(/ERR_DLOPEN_FAILED/);
  });
});
