// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P7-003 (plan-massu-resilience-layer1) — the LYING-DOCTOR regression.
 *
 * Bug #2 (incident 2026-07-12): `massu doctor`'s Native-Modules check merely imported
 * better-sqlite3, which loads only the JS wrapper — the native dlopen is LAZY (fires
 * inside the Database constructor). So `import` succeeded while `new Database()` died,
 * and doctor reported "loads correctly" while `consolidate` was silently dead.
 *
 * This test injects exactly that shape: a loader whose ctor is present (import OK) but
 * whose CONSTRUCTION throws an ABI error. The truthful check MUST report FAIL. Against
 * the OLD code (bare import) this shape would falsely PASS.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { checkNativeModules } from '../commands/doctor.ts';
import { __setSqliteLoaderTestHooks } from '../lib/sqlite-loader.ts';

function makeCtor(behavior: () => void): unknown {
  return class FakeDb {
    constructor(_path: string, _opts?: unknown) {
      behavior();
    }
    prepare(): { get: () => unknown } {
      return { get: () => ({ '1': 1 }) };
    }
    close(): void {}
  };
}

function throwAbi(): never {
  const e = new Error(
    'The module was compiled against a different Node.js version using ' +
      'NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 147.',
  );
  (e as NodeJS.ErrnoException).code = 'ERR_DLOPEN_FAILED';
  throw e;
}

afterEach(() => __setSqliteLoaderTestHooks({ ctor: null, heal: null }));

describe('checkNativeModules — truthful doctor', () => {
  it('FAILs when import succeeds but construction throws an ABI error (the lying-doctor shape)', async () => {
    __setSqliteLoaderTestHooks({ ctor: makeCtor(() => throwAbi()) as never });
    const result = await checkNativeModules();
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/unusable|abi/i);
    expect(result.detail).toMatch(/massu heal/); // carries the remedy
  });

  it('PASSes when a real construct + SELECT 1 succeeds', async () => {
    __setSqliteLoaderTestHooks({ ctor: makeCtor(() => {}) as never });
    const result = await checkNativeModules();
    expect(result.status).toBe('pass');
    expect(result.detail).toMatch(/SELECT 1/);
  });
});
