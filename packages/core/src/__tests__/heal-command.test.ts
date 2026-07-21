// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P7 (plan-massu-resilience-layer1) — `massu heal` command contract.
 *
 * Covers the NON-mutating `--check` exit-code contract (0 when the binary matches the
 * running Node, 1 on ABI mismatch) and asserts, at the source level, that the heal
 * spawns its rebuild with `process.execPath` + an ARGV ARRAY — never a shell string
 * (CR-63 / S5). The `--check` and already-healthy paths never trigger a real rebuild,
 * so this test has no filesystem side effects.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { runHeal } from '../commands/heal.ts';
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
    'compiled against a different Node.js version using NODE_MODULE_VERSION 127. ' +
      'This version of Node.js requires NODE_MODULE_VERSION 147.',
  );
  (e as NodeJS.ErrnoException).code = 'ERR_DLOPEN_FAILED';
  throw e;
}

afterEach(() => {
  __setSqliteLoaderTestHooks({ ctor: null, heal: null });
  vi.restoreAllMocks();
});

describe('massu heal --check (non-mutating)', () => {
  it('exit 0 when the binary matches the running Node', async () => {
    __setSqliteLoaderTestHooks({ ctor: makeCtor(() => {}) as never });
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { exitCode } = await runHeal(['--check']);
    expect(exitCode).toBe(0);
    expect(out.mock.calls.flat().join('')).toMatch(/OK/);
  });

  it('exit 1 on an ABI mismatch, printing the running ABI and the remedy', async () => {
    __setSqliteLoaderTestHooks({ ctor: makeCtor(() => throwAbi()) as never });
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { exitCode } = await runHeal(['--check']);
    expect(exitCode).toBe(1);
    const text = out.mock.calls.flat().join('');
    expect(text).toMatch(/ABI MISMATCH/);
    expect(text).toMatch(/massu heal/);
  });
});

describe('massu heal (already-healthy path, no rebuild)', () => {
  it('exit 0 and reports nothing to do when the engine is healthy', async () => {
    __setSqliteLoaderTestHooks({ ctor: makeCtor(() => {}) as never });
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { exitCode } = await runHeal([]);
    expect(exitCode).toBe(0);
    expect(out.mock.calls.flat().join('')).toMatch(/nothing to do/);
  });
});

describe('security — rebuild spawns with an argv array, never a shell', () => {
  it('the loader drives every child with process.execPath and never shell:true', () => {
    const loaderPath = fileURLToPath(new URL('../lib/sqlite-loader.ts', import.meta.url));
    const src = readFileSync(loaderPath, 'utf-8');
    // Every spawnSync targeting a build tool uses process.execPath as argv[0].
    expect(src).toMatch(/spawnSync\(process\.execPath,\s*\[/);
    // No shell string construction anywhere.
    expect(/shell:\s*true/.test(src)).toBe(false);
  });
});
