// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P7-002 (plan-massu-resilience-layer1): the SSOT loader's heal + probe + telemetry
 * behavior, exercised with an INJECTED failing/healing binding (no real ABI break).
 *
 * The invariant under test: a native-ABI failure is NEVER swallowed and NEVER exit 0 —
 * it either self-heals + retries once, or throws a LOUD, structured
 * MemoryEngineUnusableError carrying the remedy. Telemetry records on success AND on
 * terminal failure (dual-safe), to a 0600 file under `credentialsDir()`.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  openDatabase,
  probeMemoryDbUsable,
  recordHealEvent,
  isNativeAbiError,
  MemoryEngineUnusableError,
  NATIVE_DB_REMEDY,
  __setSqliteLoaderTestHooks,
  type HealResult,
} from '../lib/sqlite-loader.ts';
import { credentialsDir } from '../credentials.ts';

/** A fake better-sqlite3 ctor whose construction runs `behavior()` (may throw). */
function makeCtor(behavior: () => void): unknown {
  return class FakeDb {
    constructor(_path: string, _opts?: unknown) {
      behavior();
    }
    prepare(): { get: () => unknown; all: () => unknown[]; run: () => unknown } {
      return { get: () => ({ '1': 1 }), all: () => [], run: () => ({}) };
    }
    close(): void {}
    pragma(): void {}
  };
}

/** Throw the exact ABI-mismatch shape better-sqlite3 raises. */
function throwAbi(): never {
  const e = new Error(
    'The module was compiled against a different Node.js version using ' +
      'NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 147.',
  );
  (e as NodeJS.ErrnoException).code = 'ERR_DLOPEN_FAILED';
  throw e;
}

const HEALED: HealResult = { healed: true, method: 'prebuild-install', abiFrom: '127', abiTo: '147', durationMs: 5 };

afterEach(() => __setSqliteLoaderTestHooks({ ctor: null, heal: null }));

describe('isNativeAbiError classifier', () => {
  it('flags NODE_MODULE_VERSION / ERR_DLOPEN_FAILED but not real DB errors', () => {
    expect(isNativeAbiError(new Error('using NODE_MODULE_VERSION 127'))).toBe(true);
    const dl = new Error('dlopen failed'); (dl as NodeJS.ErrnoException).code = 'ERR_DLOPEN_FAILED';
    expect(isNativeAbiError(dl)).toBe(true);
    expect(isNativeAbiError(new Error('SQLITE_CORRUPT: database disk image is malformed'))).toBe(false);
    expect(isNativeAbiError(new Error('no such table: foo'))).toBe(false);
  });
});

describe('openDatabase gated self-heal', () => {
  it('heals then retries ONCE → success', () => {
    let constructs = 0;
    const ctor = makeCtor(() => {
      constructs += 1;
      if (constructs === 1) throwAbi(); // first construct fails, retry succeeds
    });
    __setSqliteLoaderTestHooks({ ctor: ctor as never, heal: () => HEALED });
    const db = openDatabase(':memory:');
    expect(db).toBeTruthy();
    expect(constructs).toBe(2); // exactly one retry
  });

  it('heal fails → LOUD typed MemoryEngineUnusableError, never silent', () => {
    const ctor = makeCtor(() => throwAbi()); // always fails
    __setSqliteLoaderTestHooks({ ctor: ctor as never, heal: () => ({ healed: false, reason: 'heal-failed', detail: 'no compiler' }) });
    let caught: unknown;
    try {
      openDatabase(':memory:');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MemoryEngineUnusableError);
    expect((caught as MemoryEngineUnusableError).reason).toBe('heal-failed');
    expect((caught as MemoryEngineUnusableError).remedy).toBe(NATIVE_DB_REMEDY);
  });

  it('heal succeeds but retry STILL fails → heal-failed loud error', () => {
    const ctor = makeCtor(() => throwAbi());
    __setSqliteLoaderTestHooks({ ctor: ctor as never, heal: () => HEALED });
    expect(() => openDatabase(':memory:')).toThrow(MemoryEngineUnusableError);
  });

  it('lock-contended heal (healed:false, contended:true) → still retries the load once (ARCH-01/R2)', () => {
    let constructs = 0;
    const ctor = makeCtor(() => {
      constructs += 1;
      if (constructs === 1) throwAbi(); // broken first; a "sibling" healed it by the retry
    });
    __setSqliteLoaderTestHooks({
      ctor: ctor as never,
      heal: () => ({ healed: false, contended: true, reason: 'heal-failed' }),
    });
    const db = openDatabase(':memory:');
    expect(db).toBeTruthy();
    expect(constructs).toBe(2);
  });

  it('selfHeal:false surfaces the loud error immediately WITHOUT healing (hook budget)', () => {
    let healCalled = false;
    const ctor = makeCtor(() => throwAbi());
    __setSqliteLoaderTestHooks({
      ctor: ctor as never,
      heal: () => {
        healCalled = true;
        return HEALED;
      },
    });
    expect(() => openDatabase(':memory:', { selfHeal: false })).toThrow(MemoryEngineUnusableError);
    expect(healCalled).toBe(false); // hooks never rebuild (P0-003)
  });

  it('MASSU_HOOK_RUNTIME=1 forces selfHeal off even for a default (selfHeal:true) open (P0-003)', () => {
    const prev = process.env.MASSU_HOOK_RUNTIME;
    process.env.MASSU_HOOK_RUNTIME = '1';
    let healCalled = false;
    const ctor = makeCtor(() => throwAbi());
    __setSqliteLoaderTestHooks({
      ctor: ctor as never,
      heal: () => {
        healCalled = true;
        return HEALED;
      },
    });
    try {
      // Default opts (selfHeal defaults true) — the hook-runtime marker must still veto healing.
      expect(() => openDatabase(':memory:')).toThrow(MemoryEngineUnusableError);
      expect(healCalled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MASSU_HOOK_RUNTIME;
      else process.env.MASSU_HOOK_RUNTIME = prev;
    }
  });

  it('a non-ABI (real DB) error is re-thrown UNCHANGED, not misclassified as a heal case', () => {
    let healCalled = false;
    const ctor = makeCtor(() => {
      throw new Error('SQLITE_CANTOPEN: unable to open database file');
    });
    __setSqliteLoaderTestHooks({
      ctor: ctor as never,
      heal: () => {
        healCalled = true;
        return HEALED;
      },
    });
    expect(() => openDatabase('/nope/x.db')).toThrow(/SQLITE_CANTOPEN/);
    expect(healCalled).toBe(false);
  });
});

describe('probeMemoryDbUsable', () => {
  it('healthy ctor → ok:true', () => {
    __setSqliteLoaderTestHooks({ ctor: makeCtor(() => {}) as never });
    expect(probeMemoryDbUsable().ok).toBe(true);
  });

  it('construct-throws (import-OK-construct-FAILS) → ok:false, reason abi-mismatch', () => {
    __setSqliteLoaderTestHooks({ ctor: makeCtor(() => throwAbi()) as never });
    const v = probeMemoryDbUsable({ selfHeal: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('abi-mismatch');
    expect(v.remedy).toBe(NATIVE_DB_REMEDY);
  });

  it('labels a NON-ABI :memory: failure as unreadable, not abi-mismatch (ARCH-03)', () => {
    __setSqliteLoaderTestHooks({
      ctor: makeCtor(() => {
        throw new Error('SQLITE_NOMEM: out of memory');
      }) as never,
    });
    const v = probeMemoryDbUsable({ selfHeal: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('unreadable');
  });

  it('never throws', () => {
    __setSqliteLoaderTestHooks({ ctor: makeCtor(() => throwAbi()) as never });
    expect(() => probeMemoryDbUsable({ selfHeal: false })).not.toThrow();
  });
});

describe('recordHealEvent telemetry (dual-safe, 0600, credentialsDir)', () => {
  let home: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'massu-heal-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('appends on success AND on terminal failure; file lives in credentialsDir with mode 0600', () => {
    recordHealEvent({ phase: 'success', method: 'prebuild-install', abiFrom: '127', abiTo: '147' });
    recordHealEvent({ phase: 'failed', reason: 'heal-failed' });

    const file = join(credentialsDir(home), 'native-heal-events.jsonl');
    expect(existsSync(file)).toBe(true);

    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).phase).toBe('success');
    expect(JSON.parse(lines[1]).phase).toBe('failed');
    // No secrets — only node/platform/arch/abi/duration.
    expect(JSON.parse(lines[0]).node).toBe(process.versions.node);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('a write error is swallowed — telemetry MUST NEVER throw', () => {
    process.env.HOME = join(home, 'a-file-not-a-dir');
    writeFileSync(process.env.HOME, 'x'); // HOME is now a file → mkdir under it fails (ENOTDIR)
    expect(() => recordHealEvent({ phase: 'attempt' })).not.toThrow();
  });
});
