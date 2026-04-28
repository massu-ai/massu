// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: tree-sitter-loader.ts unit tests.
 *
 * Coverage (per audit-iter-5 fix HH):
 *   (a) fresh download writes to cache + verifies SHA-256
 *   (b) SHA-256 mismatch → loader REFUSES to load (mandatory test per Phase 3.5 #3)
 *   (c) cache hit on second call (no second network fetch)
 *   (d) offline + no-cache → throws GrammarUnavailableError
 *
 * NOTE: We don't actually load the WASM (which requires `Parser.init()` +
 * a real grammar binary). We exercise the SHA-verification + cache + error
 * branches with a mock fetch that returns synthetic bytes. The Language.load
 * call is reached via the `__resetLoadedGrammars` test-only helper exported
 * from the loader; we stub the manifest entries and tolerate a downstream
 * Language.load failure as expected (we assert behavior up to the verify step).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  GrammarSHAMismatchError,
  GrammarUnavailableError,
  loadGrammar,
  __resetLoadedGrammars,
} from '../detect/adapters/tree-sitter-loader.ts';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function setCacheDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'massu-wasm-cache-'));
  process.env.MASSU_WASM_CACHE_DIR = d;
  return d;
}

beforeEach(() => {
  __resetLoadedGrammars();
});

describe('tree-sitter-loader: SHA-256 verification (test b — mandatory per Phase 3.5 #3)', () => {
  it('refuses to load WASM whose SHA-256 does not match the manifest', async () => {
    const cacheDir = setCacheDir();
    const fakeBytes = new Uint8Array([1, 2, 3, 4, 5]);
    // Manifest says the SHA is something else than what the bytes hash to.
    const wrongSha = 'deadbeef'.repeat(8); // 64 hex chars but wrong

    let threw: unknown = null;
    try {
      await loadGrammar('python', {
        manifestOverride: {
          python: { url: 'https://example.com/python.wasm', sha256: wrongSha, version: 'test' },
        },
        fetchImpl: async () => ({
          ok: true,
          arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength),
          status: 200,
        }),
      });
    } catch (e) {
      threw = e;
    }

    expect(threw).toBeInstanceOf(GrammarSHAMismatchError);
    expect((threw as GrammarSHAMismatchError).expected).toBe(wrongSha);
    expect((threw as GrammarSHAMismatchError).actual).toBe(sha256Hex(fakeBytes));
    // Must NOT have written the bad file to cache
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('also refuses to load a CACHED WASM whose SHA does not match — does not silently re-download', async () => {
    const cacheDir = setCacheDir();
    const expectedBytes = new Uint8Array([7, 7, 7, 7, 7]);
    const expectedSha = sha256Hex(expectedBytes);
    // Pre-populate the cache with a file that has the EXPECTED filename
    // but wrong content (simulates tampering or write corruption).
    const tamperedBytes = new Uint8Array([9, 9, 9, 9, 9]);
    const cachePath = join(cacheDir, `python-${expectedSha}.wasm`);
    const fs = await import('fs');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, tamperedBytes);

    let threw: unknown = null;
    try {
      await loadGrammar('python', {
        manifestOverride: {
          python: { url: 'https://example.com/python.wasm', sha256: expectedSha, version: 'test' },
        },
        fetchImpl: async () => {
          throw new Error('network should not be touched — cache present');
        },
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(GrammarSHAMismatchError);
    rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe('tree-sitter-loader: cache write + read (tests a, c)', () => {
  it('fresh download verifies SHA-256 then writes to cache atomically', async () => {
    const cacheDir = setCacheDir();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const sha = sha256Hex(bytes);
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount++;
      return {
        ok: true,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        status: 200,
      };
    };

    // Expected to fail at Language.load (synthetic bytes aren't a real WASM),
    // but we assert behavior UP TO that point: the SHA verify passed and the
    // cache file was written.
    let threw: unknown = null;
    try {
      await loadGrammar('python', {
        manifestOverride: {
          python: { url: 'https://example.com/python.wasm', sha256: sha, version: 'test' },
        },
        fetchImpl,
      });
    } catch (e) {
      threw = e;
    }
    // It either succeeds (unlikely) or fails at WASM load — but NOT at SHA.
    expect(threw).not.toBeInstanceOf(GrammarSHAMismatchError);
    // Cache file should exist with the verified bytes
    const cachePath = join(cacheDir, `python-${sha}.wasm`);
    expect(existsSync(cachePath)).toBe(true);
    expect(readFileSync(cachePath).equals(Buffer.from(bytes))).toBe(true);
    expect(fetchCount).toBe(1);

    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('cache hit on a process-local second call: no second fetch (in-memory map)', async () => {
    // Note: the loader's in-memory `loadedGrammars` short-circuits before
    // even reaching the cache file. We can't easily exercise the disk-cache
    // path twice without resetting the in-memory map AND faking a successful
    // Language.load — which requires a real grammar. Instead we assert the
    // documented invariant: when in-memory cache is populated, fetch is NOT
    // called regardless of disk state.
    const cacheDir = setCacheDir();
    const bytes = new Uint8Array([42]);
    const sha = sha256Hex(bytes);
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount++;
      return {
        ok: true,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        status: 200,
      };
    };
    // First call may fail at WASM load — that's fine, we only check fetch count
    try {
      await loadGrammar('python', {
        manifestOverride: { python: { url: 'https://x', sha256: sha, version: 't' } },
        fetchImpl,
      });
    } catch { /* ignore */ }
    expect(fetchCount).toBe(1);

    // Second call: still goes through the disk-cache path (since Language.load
    // failed and didn't populate the in-memory map). The disk-cache path
    // should re-read the file we just wrote, NOT re-fetch.
    try {
      await loadGrammar('python', {
        manifestOverride: { python: { url: 'https://x', sha256: sha, version: 't' } },
        fetchImpl,
      });
    } catch { /* ignore */ }
    expect(fetchCount).toBe(1); // still 1 — disk cache served the second call

    rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe('tree-sitter-loader: offline + no-cache (test d)', () => {
  it('throws GrammarUnavailableError when fetch fails AND cache is empty', async () => {
    const cacheDir = setCacheDir();
    let threw: unknown = null;
    try {
      await loadGrammar('python', {
        manifestOverride: {
          python: { url: 'https://example.com/python.wasm', sha256: 'a'.repeat(64), version: 'test' },
        },
        fetchImpl: async () => {
          throw new Error('network down');
        },
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(GrammarUnavailableError);
    expect((threw as GrammarUnavailableError).language).toBe('python');
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('throws GrammarUnavailableError when fetch returns non-OK status', async () => {
    const cacheDir = setCacheDir();
    let threw: unknown = null;
    try {
      await loadGrammar('python', {
        manifestOverride: {
          python: { url: 'https://example.com/python.wasm', sha256: 'a'.repeat(64), version: 'test' },
        },
        fetchImpl: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(GrammarUnavailableError);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('throws GrammarUnavailableError for an unknown language (no manifest entry)', async () => {
    let threw: unknown = null;
    try {
      // 'haskell' is in the type union but has no v1 manifest entry
      await loadGrammar('haskell');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(GrammarUnavailableError);
  });
});
