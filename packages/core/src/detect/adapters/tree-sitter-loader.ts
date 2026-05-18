// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 1: Tree-sitter WASM grammar loader (Strategy A).
 *
 * Strategy A: grammars are NOT bundled in the npm tarball. The loader downloads
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
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
  chmodSync,
  utimesSync,
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
  // ----------------------------------------------------------------
  // Plan 3c Phase 7 expansion (2026-05-07):
  //
  // Six additional grammars to support the registry-verified framework
  // adapters (go-chi, rails, aspnet, spring, ktor, phoenix) plus the
  // bundled adapters in the same language families (gin/echo/fiber,
  // sinatra, etc.). All entries use the SAME pinned tree-sitter-wasms
  // version (0.1.13) as the v1 four to keep the dependency surface
  // single-source.
  //
  // SHA-256s computed 2026-05-07 via:
  //   curl -fsSL <url> | shasum -a 256
  //
  // The unpkg filename for C# uses an underscore (`c_sharp`) while the
  // TreeSitterLanguage identifier uses no separator (`csharp`); the map
  // key is the type identifier, the URL is the storage path — they do
  // NOT need to match, the same as how `python` maps to `tree-sitter-
  // python.wasm`. This is intentional and validated by the manifest
  // shape test in tree-sitter-loader-manifest.test.ts.
  // ----------------------------------------------------------------
  go: {
    url: 'https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-go.wasm',
    sha256: '9963ca89b616eaf04b08a43bc1fb0f07b85395bec313330851f1f1ead2f755b6',
    version: '0.1.13',
  },
  ruby: {
    url: 'https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-ruby.wasm',
    sha256: '93a5022855314cdb45458c7bb026a24a0ebc3a5ff6439e542e881f14dfa13a39',
    version: '0.1.13',
  },
  csharp: {
    url: 'https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-c_sharp.wasm',
    sha256: '6266a7e32d68a3459104d994dc848df15d5672b0ea8e86d327274b694f8e6991',
    version: '0.1.13',
  },
  java: {
    url: 'https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-java.wasm',
    sha256: '637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f',
    version: '0.1.13',
  },
  kotlin: {
    url: 'https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-kotlin.wasm',
    sha256: 'b5cb00c8d06ed0f10f1dbe497205b437809d7e87db1f638721a8cfb30e044449',
    version: '0.1.13',
  },
  elixir: {
    url: 'https://unpkg.com/tree-sitter-wasms@0.1.13/out/tree-sitter-elixir.wasm',
    sha256: '82e91b9759ddca30d8978ebbfa8e347b4451b64c931f9ae62112e6db9b8fac20',
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

// ============================================================
// LRU cache eviction (Phase 3.5 audit F-011 — closed 2026-05-06)
// ============================================================
//
// F-011 was deferred at v1 ("at ~3MB per grammar, full cache footprint is
// <100MB — not an attack vector"). The 2026-05-06 audit-leak retrospective
// elevated it: now that the cache path + naming convention are publicly
// known (the security audit doc was visible for 9 days), opportunistic
// disk-fill attacks become slightly less hypothetical, AND the cost of
// retrofitting LRU once Plan 3c expands the supported grammar set is
// strictly higher than doing it now while only 4 grammars exist.
//
// Eviction rule: keep the N most-recently-USED entries (mtime, updated by
// the cache-hit path on every read). Default cap = 16 — leaves headroom
// for Plan 3c's 31-grammar expansion plus dev-time version churn, while
// bounding total cache to ~50MB at 3MB/grammar.

const DEFAULT_CACHE_RETAIN_COUNT = 16;

function getCacheRetainCount(): number {
  const env = process.env.MASSU_WASM_CACHE_RETAIN;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 1 && n <= 1024) return Math.floor(n);
  }
  return DEFAULT_CACHE_RETAIN_COUNT;
}

/**
 * Touch a cache file's mtime to mark "most recently used." Called on every
 * cache-hit. Best-effort: any failure is silently swallowed — touching is
 * an optimization signal for eviction, not load-bearing.
 *
 * Uses utimes via writeFileSync round-trip would be expensive; instead we
 * use the same filesystem touch trick as `touch -a`: open + close. On
 * macOS/Linux Node, `chmodSync` to the same mode does NOT update mtime,
 * so we do a no-op write of empty content via a tmp marker file. Cheaper
 * approach: just rely on atime if filesystem records it. Most modern
 * filesystems are mounted with `relatime` so atime updates only when
 * older than mtime — which means after our first eviction-relevant
 * read, atime IS the right signal.
 *
 * Decision: use mtime via `utimesSync` — explicit and portable.
 */
function touchCacheFile(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // best-effort
  }
}

/**
 * Evict cache entries beyond the retain count, keeping the N most recently
 * used (by mtime). Called after every successful cache write. Best-effort:
 * eviction failure never blocks a load.
 *
 * Rejects symlinks and non-regular files via lstat — the same defense as
 * the cache-hit path (F-008 fix). A symlink in the cache dir is logged
 * as a security warning but not deleted (don't act on attacker-controlled
 * paths automatically).
 */
function evictBeyondRetainCount(retain: number = getCacheRetainCount()): void {
  const dir = getCacheDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // Dir doesn't exist yet; nothing to evict.
  }

  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith('.wasm')) continue; // Don't touch non-grammar files.
    const path = join(dir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      // Skip — never automatically delete what could be an attacker-placed
      // symlink. Surface via stderr; user's cache dir is suspect.
      // P-M-035: stderr write, no console.* on hot paths.
      process.stderr.write(
        `[tree-sitter-loader] cache eviction skipped non-regular file: ${path} ` +
          `(possible symlink attack — see Phase 3.5 finding F-008).\n`,
      );
      continue;
    }
    candidates.push({ path, mtimeMs: stat.mtimeMs });
  }

  if (candidates.length <= retain) return;

  // Sort newest-first; everything beyond `retain` is evictable.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const victim of candidates.slice(retain)) {
    try {
      unlinkSync(victim.path);
    } catch {
      // best-effort
    }
  }
}

/** Test-injection hook: lets tests force eviction without writing a new grammar. */
export function _evictCacheForTest(retain?: number): void {
  evictBeyondRetainCount(retain);
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
      // F-011 LRU: mark this entry as most-recently-used so it survives
      // future evictions.
      touchCacheFile(cachePath);
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
    // F-011 LRU: prune cache to retain count after every successful write.
    // Best-effort — eviction failure never blocks a load.
    evictBeyondRetainCount();
  } catch (e) {
    // Cache write failure is non-fatal — we still have `body` in memory and
    // can load directly. Log to stderr per VR-USER-ERROR-MESSAGES style.
    // P-M-035: stderr write, no console.* on hot paths.
    process.stderr.write(
      `[tree-sitter-loader] cache write failed for ${language}: ${e instanceof Error ? e.message : String(e)} — loading directly from memory.\n`,
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
