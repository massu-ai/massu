// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: Tree-sitter WASM grammar loader (Strategy A).
 *
 * Strategy A — locked at Phase 0 (`docs/internal/2026-04-26-ast-lsp-spec.md`
 * §1, §8): grammars are NOT bundled in the npm tarball. The loader downloads
 * each requested grammar at first use from a pinned URL, verifies SHA-256
 * against a hardcoded manifest, caches under `~/.massu/wasm-cache/`.
 *
 * Security model (Phase 3.5 #3):
 *   - SHA-256 manifest hardcoded HERE — never network-fetched.
 *   - Mismatch → throw `GrammarSHAMismatchError`. NO silent fallback.
 *   - Atomic cache write: `<lang>-<sha>.wasm.tmp.<pid>` → rename → final.
 *   - Offline + no-cache → throw `GrammarUnavailableError` so the runner can
 *     translate to a regex-fallback path with a stderr note.
 *
 * Phase 1 ships the CODE PATH; the actual SHA-256 values for each grammar
 * URL are placeholders pending Phase 9 release-prep (`curl <url> | shasum
 * -a 256`). The placeholder string is intentionally non-empty so the
 * verification logic exercises the comparison branch in tests.
 */

import { createHash } from 'crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
  chmodSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { Language, Parser } from 'web-tree-sitter';
import type { TreeSitterLanguage } from './types.ts';

// ============================================================
// Typed errors
// ============================================================

/** Thrown when downloaded WASM SHA-256 doesn't match the hardcoded manifest. */
export class GrammarSHAMismatchError extends Error {
  public readonly language: TreeSitterLanguage;
  public readonly expected: string;
  public readonly actual: string;
  constructor(language: TreeSitterLanguage, expected: string, actual: string) {
    super(
      `[tree-sitter-loader] SHA-256 mismatch for grammar "${language}". ` +
        `Expected ${expected}, got ${actual}. ` +
        `REFUSING to load — see Phase 3.5 audit attack vector #3.`,
    );
    this.name = 'GrammarSHAMismatchError';
    this.language = language;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Thrown when a grammar can't be obtained: download failed AND cache empty. */
export class GrammarUnavailableError extends Error {
  public readonly language: TreeSitterLanguage;
  public readonly cause?: unknown;
  constructor(language: TreeSitterLanguage, cause?: unknown) {
    const causeMsg =
      cause instanceof Error ? cause.message : cause ? String(cause) : 'no cached grammar and download failed';
    super(
      `[tree-sitter-loader] Grammar for "${language}" is unavailable: ${causeMsg}. ` +
        `Falling back to regex introspection for files in ${language}.`,
    );
    this.name = 'GrammarUnavailableError';
    this.language = language;
    this.cause = cause;
  }
}

/**
 * Thrown when the cache path resolves to a symlink (or any non-regular
 * file). Pre-creating a symlink at the expected cache path is a known
 * vector for redirecting reads/writes elsewhere on the filesystem.
 * (Phase 3.5 finding #3 — symlink attack on cache dir.)
 */
export class GrammarCacheSymlinkError extends Error {
  public readonly cachePath: string;
  constructor(cachePath: string) {
    super(
      `[tree-sitter-loader] Refusing to load grammar — cache path "${cachePath}" is a symlink ` +
        `or non-regular file. (Phase 3.5 finding #3 — symlink attack vector.)`,
    );
    this.name = 'GrammarCacheSymlinkError';
    this.cachePath = cachePath;
  }
}

/**
 * Thrown when a manifest URL is not HTTPS. The manifest is hardcoded in
 * source, but defense in depth: any future edit that introduces an http://
 * URL is rejected at load time, not at code review.
 * (Phase 3.5 finding #3 — MITM on download.)
 */
export class GrammarUrlNotHttpsError extends Error {
  public readonly url: string;
  constructor(url: string) {
    super(
      `[tree-sitter-loader] Refusing to download grammar from non-HTTPS URL: ${url}. ` +
        `Only https:// URLs are accepted. (Phase 3.5 finding #3.)`,
    );
    this.name = 'GrammarUrlNotHttpsError';
    this.url = url;
  }
}

// ============================================================
// Pinned manifest
// ============================================================

interface ManifestEntry {
  url: string;
  sha256: string;
  version: string;
}

/**
 * Hardcoded grammar manifest. Source-code-resident; tampering requires a
 * release.
 *
 * Source: `tree-sitter-wasms` npm package (https://npm.im/tree-sitter-wasms)
 * — pre-built WASM binaries for Tree-sitter language parsers. NOT added as
 * a dependency (per plan §Phase 0 ban on bundling); fetched from unpkg at
 * first use. The individual `tree-sitter-<lang>` packages on npm do NOT
 * ship `.wasm` files, only C source + native .node prebuilds — confirmed
 * by inspecting unpkg `?meta` listings during Phase 9 release-prep.
 *
 * SHA-256 hashes computed 2026-04-28 via:
 *   curl -fsSL <url> | shasum -a 256
 *
 * The verification code path is exercised in `tree-sitter-loader.test.ts`
 * by injecting test manifest entries that intentionally mismatch.
 */
export const GRAMMAR_MANIFEST: Partial<Record<TreeSitterLanguage, ManifestEntry>> = {
  python: {
    url: 'https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-python.wasm',
    sha256: '9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b',
    version: '0.1.13',
  },
  typescript: {
    url: 'https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-typescript.wasm',
    sha256: '8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f',
    version: '0.1.13',
  },
  javascript: {
    url: 'https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-javascript.wasm',
    sha256: '63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5',
    version: '0.1.13',
  },
  swift: {
    url: 'https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-swift.wasm',
    sha256: '41c4fdb2249a3aa6d87eed0d383081ff09725c2248b4977043a43825980ffcc7',
    version: '0.1.13',
  },
};

// ============================================================
// Cache + Parser init
// ============================================================

function getCacheDir(): string {
  return process.env.MASSU_WASM_CACHE_DIR ?? join(homedir(), '.massu', 'wasm-cache');
}

function getCachedPath(language: TreeSitterLanguage, sha: string): string {
  return join(getCacheDir(), `${language}-${sha}.wasm`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let parserInitPromise: Promise<void> | null = null;

/**
 * `Parser.init()` is async and must be called once before any `new Parser()`.
 * This function is idempotent — repeated calls return the same promise.
 *
 * Test harnesses can mock this by stubbing `Parser.init`.
 */
export async function ensureParserInitialized(): Promise<void> {
  if (parserInitPromise) return parserInitPromise;
  parserInitPromise = Parser.init();
  return parserInitPromise;
}

// ============================================================
// Loader (the main entry point)
// ============================================================

interface LoaderOptions {
  /**
   * Test-injection: override the manifest entry for a language. Production
   * callers leave this undefined; tests use it to exercise SHA-mismatch and
   * download-failure paths.
   */
  manifestOverride?: Partial<Record<TreeSitterLanguage, ManifestEntry>>;
  /**
   * Test-injection: override the fetch implementation. Defaults to global
   * `fetch`. Tests pass a mock that returns a fixed body or throws.
   */
  fetchImpl?: (url: string) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer>; status?: number }>;
}

const loadedGrammars = new Map<TreeSitterLanguage, Language>();

/**
 * Lazy-load a Tree-sitter grammar. Only fetches/caches the grammar for
 * `language`; other languages are unaffected.
 *
 * Order:
 *   1. In-memory cache hit → return.
 *   2. Disk cache hit + SHA verify pass → load from disk.
 *   3. Disk cache hit + SHA mismatch → throw GrammarSHAMismatchError.
 *   4. Cache miss → fetch from pinned URL → SHA verify → atomic write → load.
 *   5. Fetch fails AND no cache → throw GrammarUnavailableError.
 */
export async function loadGrammar(
  language: TreeSitterLanguage,
  options: LoaderOptions = {},
): Promise<Language> {
  await ensureParserInitialized();

  const cached = loadedGrammars.get(language);
  if (cached) return cached;

  const manifest = options.manifestOverride?.[language] ?? GRAMMAR_MANIFEST[language];
  if (!manifest) {
    throw new GrammarUnavailableError(
      language,
      new Error(`No manifest entry for language "${language}". v1 supports: ${Object.keys(GRAMMAR_MANIFEST).join(', ')}.`),
    );
  }

  const cachePath = getCachedPath(language, manifest.sha256);

  // 2/3: disk cache check. Use lstatSync (NOT statSync) so a symlink at
  // the cache path is detected and rejected — never followed.
  // (Phase 3.5 finding #3 — symlink attack on cache dir.)
  let cacheLstat;
  try {
    cacheLstat = lstatSync(cachePath);
  } catch {
    cacheLstat = null;
  }
  if (cacheLstat) {
    if (cacheLstat.isSymbolicLink() || !cacheLstat.isFile()) {
      throw new GrammarCacheSymlinkError(cachePath);
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(cachePath);
    } catch (e) {
      // Treat read failure as cache miss; fall through to download.
      bytes = new Uint8Array(0);
    }
    if (bytes.byteLength > 0) {
      const actualSha = sha256(bytes);
      if (actualSha !== manifest.sha256) {
        // Refuse to load. Don't silently re-download — that would mask
        // tampering of the on-disk cache.
        throw new GrammarSHAMismatchError(language, manifest.sha256, actualSha);
      }
      const lang = await Language.load(bytes);
      loadedGrammars.set(language, lang);
      return lang;
    }
  }

  // 4/5: download. Defense in depth: refuse non-HTTPS URLs.
  if (!/^https:\/\//i.test(manifest.url)) {
    throw new GrammarUrlNotHttpsError(manifest.url);
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as LoaderOptions['fetchImpl']);
  if (!fetchImpl) {
    throw new GrammarUnavailableError(
      language,
      new Error('No fetch implementation available (Node < 18?)'),
    );
  }

  let body: Uint8Array;
  try {
    const res = await fetchImpl(manifest.url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status ?? 'unknown'} from ${manifest.url}`);
    }
    body = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new GrammarUnavailableError(language, e);
  }

  const downloadedSha = sha256(body);
  if (downloadedSha !== manifest.sha256) {
    throw new GrammarSHAMismatchError(language, manifest.sha256, downloadedSha);
  }

  // Atomic cache write. Always create the dir first.
  // Mode 0o700 on the dir + 0o600 on files — owner-only access prevents
  // local information disclosure of cached grammars.
  // (Phase 3.5 finding #3 — file-mode hardening.)
  try {
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(cachePath), 0o700); } catch { /* best effort */ }
    const tmpPath = `${cachePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, body, { mode: 0o600 });
    try { chmodSync(tmpPath, 0o600); } catch { /* best effort */ }
    try {
      renameSync(tmpPath, cachePath);
      try { chmodSync(cachePath, 0o600); } catch { /* best effort */ }
    } catch (e) {
      // Try to clean up the tmp file on rename failure
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw e;
    }
  } catch (e) {
    // Cache write failure is non-fatal — we still have `body` in memory and
    // can load directly. Log to stderr per VR-USER-ERROR-MESSAGES style.
    console.error(
      `[tree-sitter-loader] cache write failed for ${language}: ${e instanceof Error ? e.message : String(e)} — loading directly from memory.`,
    );
  }

  const lang = await Language.load(body);
  loadedGrammars.set(language, lang);
  return lang;
}

/**
 * Test-only: clear in-memory loaded grammar cache. Disk cache persists.
 * Production code never needs this; the in-memory map lives for the process.
 */
export function __resetLoadedGrammars(): void {
  loadedGrammars.clear();
}
