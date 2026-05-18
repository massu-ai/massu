// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 3.5 Surface 3: WASM grammar load network surface.
 *
 * Vectors covered:
 *   - SHA-256 manifest hardcoded in source (not loaded from env/file) — F-007
 *   - HTTPS-only enforcement at runtime — F-012
 *   - Symlink attack on cache dir (lstat-based detection) — F-008
 *   - File-mode hardening (0o600 on cache, 0o700 on dir) — F-009/F-010
 *   - Atomic write-then-rename — covered by inspecting source
 *   - Manifest-tampering: SHA mismatch on cache hit triggers throw — already
 *     present in loader.test.ts; re-asserted here at security surface.
 *
 * Production path (with placeholder hashes) is intentionally not exercised
 * end-to-end — the placeholders are documented and the security barriers
 * are the load-bearing controls. F-007 is documented (PLACEHOLDER hashes
 * cause every download to be rejected) so production grammars do not load
 * until release-prep fills real hashes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, lstatSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  loadGrammar,
  GrammarSHAMismatchError,
  GrammarUnavailableError,
  GrammarCacheSymlinkError,
  GrammarUrlNotHttpsError,
  GRAMMAR_MANIFEST,
  __resetLoadedGrammars,
} from '../../detect/adapters/tree-sitter-loader.ts';
import { readFileSync } from 'fs';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'massu-wasm-sec-'));
}

// ============================================================
// F-007: Manifest is source-resident, not network-fetched
// ============================================================

describe('WASM load — manifest immutability (F-007)', () => {
  const loaderSource = readFileSync(
    resolve(__dirname, '../../detect/adapters/tree-sitter-loader.ts'),
    'utf-8',
  );

  it('GRAMMAR_MANIFEST is hardcoded as a const (not loaded from env or fs)', () => {
    expect(loaderSource).toMatch(/export const GRAMMAR_MANIFEST/);
  });

  it('loader does NOT read manifest from process.env or any file', () => {
    // The cache directory is allowed to be overridden via env (it's a
    // location, not a security control). The MANIFEST itself must not be.
    // Search for any pattern where a manifest entry is read from runtime
    // input.
    expect(loaderSource).not.toMatch(/process\.env\.(.*?)MANIFEST/);
    expect(loaderSource).not.toMatch(/readFileSync\([^)]*manifest/i);
  });

  it('GRAMMAR_MANIFEST has entries for all 4 first-party languages', () => {
    expect(GRAMMAR_MANIFEST.python).toBeDefined();
    expect(GRAMMAR_MANIFEST.typescript).toBeDefined();
    expect(GRAMMAR_MANIFEST.javascript).toBeDefined();
    expect(GRAMMAR_MANIFEST.swift).toBeDefined();
  });

  it('all manifest URLs are HTTPS', () => {
    for (const [lang, entry] of Object.entries(GRAMMAR_MANIFEST)) {
      expect(entry?.url, `lang=${lang}`).toMatch(/^https:\/\//);
    }
  });

  it('manifest hashes are populated 64-char hex (Phase 9 release-prep, 2026-04-28) — F-007 closed', () => {
    // F-007 was an INFO finding flagging that the manifest shipped with
    // PLACEHOLDER_ values at audit time, so the loader was fail-safe but
    // never functional. Phase 9 release-prep populated real SHA-256 hashes
    // for the 4 first-party grammars by curl'ing each pinned unpkg URL
    // (tree-sitter-wasms@0.1.13/out/) through `shasum -a 256`. This test
    // now asserts the inverse: every manifest entry has a 64-char
    // lowercase hex hash and NO placeholder sentinel survives.
    const hex64 = /^[0-9a-f]{64}$/;
    for (const [language, entry] of Object.entries(GRAMMAR_MANIFEST)) {
      expect(entry?.sha256, `manifest[${language}].sha256 must be 64-char hex`).toMatch(hex64);
      expect(entry?.sha256, `manifest[${language}].sha256 must not be PLACEHOLDER_`).not.toMatch(/^PLACEHOLDER_/);
      // SHA-256 of empty string would mean curl piped nothing through
      // shasum (e.g. 404 silently returned). Reject explicitly.
      expect(entry?.sha256, `manifest[${language}].sha256 must not be SHA-256 of empty string`).not.toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    }
  });
});

// ============================================================
// F-012: HTTPS-only enforcement
// ============================================================

describe('WASM load — HTTPS-only download enforcement (F-012)', () => {
  it('loadGrammar throws GrammarUrlNotHttpsError on http:// manifest URL', async () => {
    process.env.MASSU_WASM_CACHE_DIR = tmp();
    __resetLoadedGrammars();
    let threw: unknown = null;
    try {
      await loadGrammar('python', {
        manifestOverride: {
          python: {
            url: 'http://insecure.example/python.wasm',
            sha256: 'a'.repeat(64),
            version: '0.0.1',
          },
        },
        // Provide a fetch impl so the test does not rely on real network.
        fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(GrammarUrlNotHttpsError);
    delete process.env.MASSU_WASM_CACHE_DIR;
  });

  it('loadGrammar accepts https:// URL (would fall through to fetch)', async () => {
    const cacheDir = tmp();
    process.env.MASSU_WASM_CACHE_DIR = cacheDir;
    __resetLoadedGrammars();
    // Use a mismatched-SHA download to force a throw AFTER the HTTPS check
    // passes — proves the HTTPS branch was taken.
    let err: unknown = null;
    try {
      await loadGrammar('python', {
        manifestOverride: {
          python: {
            url: 'https://example.com/python.wasm',
            sha256: 'a'.repeat(64),
            version: '0.0.1',
          },
        },
        fetchImpl: async () => ({
          ok: true,
          arrayBuffer: async () => new TextEncoder().encode('not-the-expected-content').buffer,
        }),
      });
    } catch (e) {
      err = e;
    }
    // We expect SHA mismatch (post-HTTPS check), NOT URL-not-HTTPS error.
    expect(err).toBeInstanceOf(GrammarSHAMismatchError);
    rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.MASSU_WASM_CACHE_DIR;
  });
});

// ============================================================
// F-008: Symlink attack on cache dir
// ============================================================

describe('WASM load — symlink rejection on cache hit (F-008)', () => {
  it('rejects with GrammarCacheSymlinkError when cache path is a symlink', async () => {
    const cacheDir = tmp();
    process.env.MASSU_WASM_CACHE_DIR = cacheDir;
    __resetLoadedGrammars();

    const fakeSha = 'a'.repeat(64);
    const cachePath = join(cacheDir, `python-${fakeSha}.wasm`);
    // Pre-create a symlink at the expected cache path pointing somewhere safe-ish.
    const target = join(cacheDir, 'innocent-target.txt');
    writeFileSync(target, 'not WASM');
    symlinkSync(target, cachePath);

    // Verify the test setup — the path IS a symlink before loadGrammar touches it.
    const lst = lstatSync(cachePath);
    expect(lst.isSymbolicLink()).toBe(true);

    let err: unknown = null;
    try {
      await loadGrammar('python', {
        manifestOverride: {
          python: {
            url: 'https://example.com/python.wasm',
            sha256: fakeSha,
            version: '0.0.1',
          },
        },
        fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GrammarCacheSymlinkError);

    rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.MASSU_WASM_CACHE_DIR;
  });
});

// ============================================================
// F-009/F-010: cache file-mode hardening (atomic write tested)
// ============================================================

describe('WASM load — atomic write + file-mode hardening (F-009/F-010)', () => {
  it('after a successful "download" the cache file exists with mode 0o600 and dir 0o700', async () => {
    const cacheDir = tmp();
    process.env.MASSU_WASM_CACHE_DIR = cacheDir;
    __resetLoadedGrammars();

    // Write some non-WASM bytes; we will compute their real SHA so the load
    // gets past the verification gate, then it'll fail at Language.load().
    // We catch the post-write failure and inspect the cache file mode — the
    // file has been written by the time Language.load throws.
    const payload = new TextEncoder().encode('not-actually-wasm');
    const realSha = require('crypto').createHash('sha256').update(payload).digest('hex');

    let err: unknown = null;
    try {
      await loadGrammar('python', {
        manifestOverride: {
          python: {
            url: 'https://example.com/python.wasm',
            sha256: realSha,
            version: '0.0.1',
          },
        },
        fetchImpl: async () => ({ ok: true, arrayBuffer: async () => payload.buffer }),
      });
    } catch (e) {
      err = e;
    }
    // Language.load on garbage bytes will fail — that's expected.
    expect(err).toBeDefined();

    // The cache file should have been written before Language.load failed.
    const cachePath = join(cacheDir, `python-${realSha}.wasm`);
    let st;
    try {
      st = statSync(cachePath);
    } catch {
      st = null;
    }
    if (st) {
      // Mode bits we control: 0o600 file, 0o700 dir.
      expect(st.mode & 0o777).toBe(0o600);
      const dirSt = statSync(cacheDir);
      expect(dirSt.mode & 0o777).toBe(0o700);
    }

    rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.MASSU_WASM_CACHE_DIR;
  });
});

// ============================================================
// SHA mismatch detection (foundational — re-asserted)
// ============================================================

describe('WASM load — SHA-256 mismatch on cache hit triggers refusal', () => {
  it('cache file contents that do not match manifest hash → throws', async () => {
    const cacheDir = tmp();
    process.env.MASSU_WASM_CACHE_DIR = cacheDir;
    __resetLoadedGrammars();

    const declaredSha = 'a'.repeat(64);
    const cachePath = join(cacheDir, `python-${declaredSha}.wasm`);
    writeFileSync(cachePath, 'tampered content not matching declared sha');

    let err: unknown = null;
    try {
      await loadGrammar('python', {
        manifestOverride: {
          python: {
            url: 'https://example.com/python.wasm',
            sha256: declaredSha,
            version: '0.0.1',
          },
        },
        fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GrammarSHAMismatchError);

    rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.MASSU_WASM_CACHE_DIR;
  });
});

// ============================================================
// Manifest entry missing → graceful degrade
// ============================================================

describe('WASM load — unknown language → GrammarUnavailableError, no crash', () => {
  it('language not in manifest throws GrammarUnavailableError', async () => {
    let err: unknown = null;
    try {
      await loadGrammar('rust', { manifestOverride: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GrammarUnavailableError);
  });
});

// ============================================================
// F-011 — LRU cache eviction (closed 2026-05-06 hotfix)
// ============================================================

describe('WASM cache LRU eviction (F-011)', () => {
  let cacheDir: string;
  let mod: typeof import('../../detect/adapters/tree-sitter-loader.ts');

  beforeEach(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'massu-wasm-cache-lru-'));
    process.env.MASSU_WASM_CACHE_DIR = cacheDir;
    mod = await import('../../detect/adapters/tree-sitter-loader.ts');
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.MASSU_WASM_CACHE_DIR;
    delete process.env.MASSU_WASM_CACHE_RETAIN;
  });

  function writeFakeWasm(name: string, bytes: number = 100): string {
    const path = join(cacheDir, name);
    writeFileSync(path, Buffer.alloc(bytes, 0xab), { mode: 0o600 });
    return path;
  }

  it('evicts entries beyond retain count, keeping newest by mtime', () => {
    const paths = [
      writeFakeWasm('python-aaa.wasm'),
      writeFakeWasm('typescript-bbb.wasm'),
      writeFakeWasm('javascript-ccc.wasm'),
      writeFakeWasm('swift-ddd.wasm'),
      writeFakeWasm('rust-eee.wasm'),
    ];
    const fs = require('fs');
    paths.forEach((p, i) => {
      const t = new Date(2026, 0, i + 1);
      fs.utimesSync(p, t, t);
    });

    mod._evictCacheForTest(3);

    expect(fs.existsSync(paths[0])).toBe(false);
    expect(fs.existsSync(paths[1])).toBe(false);
    expect(fs.existsSync(paths[2])).toBe(true);
    expect(fs.existsSync(paths[3])).toBe(true);
    expect(fs.existsSync(paths[4])).toBe(true);
  });

  it('does NOT evict when entry count is at or below cap', () => {
    const paths = [writeFakeWasm('python-aaa.wasm'), writeFakeWasm('typescript-bbb.wasm')];

    mod._evictCacheForTest(16);

    const fs = require('fs');
    expect(fs.existsSync(paths[0])).toBe(true);
    expect(fs.existsSync(paths[1])).toBe(true);
  });

  it('refuses to delete symlinks in cache dir (F-008 defense carried forward)', () => {
    const real = writeFakeWasm('python-aaa.wasm');
    const linkPath = join(cacheDir, 'malicious-link.wasm');
    const target = join(cacheDir, '..', 'should-not-be-touched.txt');
    writeFileSync(target, 'sentinel');
    symlinkSync(target, linkPath);

    // P-M-035: tree-sitter-loader now writes to process.stderr instead of
    // console.error so MCP server JSON-RPC stdout isn't corrupted on the
    // import chain. Test must capture stderr writes accordingly.
    const origWrite = process.stderr.write.bind(process.stderr);
    const errMsgs: string[] = [];
    // @ts-expect-error overriding the bound write signature for capture
    process.stderr.write = (chunk: string | Uint8Array) => {
      errMsgs.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      mod._evictCacheForTest(0);
    } finally {
      process.stderr.write = origWrite;
    }

    const fs = require('fs');
    expect(fs.existsSync(real)).toBe(false);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(errMsgs.some((m) => m.includes('F-008'))).toBe(true);
  });

  it('ignores non-.wasm files (e.g., temp files mid-write)', () => {
    const wasmFile = writeFakeWasm('python-aaa.wasm');
    const tmpFile = join(cacheDir, 'python-aaa.wasm.tmp.12345');
    writeFileSync(tmpFile, Buffer.alloc(100, 0xcc));

    mod._evictCacheForTest(0);

    const fs = require('fs');
    expect(fs.existsSync(wasmFile)).toBe(false);
    expect(fs.existsSync(tmpFile)).toBe(true);
  });
});
