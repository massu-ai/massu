/**
 * Adapter manifest cache (Plan 3c Phase 5 5F.3 — gap-37 + gap-54 + gap-59).
 *
 * Persists the verified registry manifest at `~/.massu/adapter-manifest.json`
 * so subsequent `npx massu adapters *` invocations do NOT re-fetch (and the
 * watcher daemon's auto-refresh-on-quiescence path is fast). The cache is
 * self-validating: every read goes back through verifyManifest against the
 * bundled Ed25519 pubkey, so a tampered cache file refuses to load.
 *
 * Concurrency model (gap-59):
 * - Reader path: NO lock acquired. POSIX renameSync inside atomicWrite
 *   guarantees readers see EITHER old OR new content, never torn. Multiple
 *   parallel readers (CLI + watcher + coverage) read concurrently with no
 *   serialization cost.
 * - Writer path: acquires `~/.massu/.adapter-manifest.lock` via the shared
 *   `withFileLockSync` primitive. Two concurrent `refreshManifest` invocations
 *   both perform the async fetch in parallel (independent network operations),
 *   then serialize on the lock for the brief atomicWrite call. The later
 *   write wins; both contents are equally valid (manifest is signed; the
 *   later signed-at timestamp is fresher).
 * - Lock is held ONLY for the sync atomicWrite — never around the async
 *   fetch — so contention bounded to ~1ms even under heavy load.
 *
 * Rotation drift detection (gap-54):
 * - Cache wrapper records `bundled_pubkey_fingerprint` at write time
 *   (sha256 hex of REGISTRY_PUBKEY_ED25519 the writer was bundling).
 * - On read, if the cache's recorded fingerprint != currently-running
 *   @massu/core's bundled pubkey fingerprint, mark cache STALE-DUE-TO-
 *   ROTATION (separate from staleness-by-age). Caller must force refresh
 *   to pick up the new pubkey's signed manifest.
 *
 * Staleness model:
 * - `fetched_at` records the cache write time (NOT the manifest's
 *   `signed_at`, which the publisher controls).
 * - `MAX_FRESH_MS` (24h) — cache is considered fresh; reads short-circuit.
 * - `MAX_STALE_MS` (7 days) — cache may be used offline. Caller surfaces
 *   the staleness in UX.
 * - Beyond 7 days — refuse to use any new adapter from this cache; require
 *   manual `npx massu adapters refresh`.
 *
 * File mode (gap-37): cache file is mode 0o600; ~/.massu/ parent dir is 0o700.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './atomic-write.js';
import { withFileLockSync } from '../lib/fileLock.js';
import { verifyManifest, type VerifyManifestResult } from './adapter-verifier.js';
import { EnvelopeSchema, PrintableAsciiStringSchema, type Envelope } from './manifest-schema.js';
import {
  REGISTRY_PUBKEY_ED25519,
  REGISTRY_PUBKEY_FINGERPRINT_HEX,
} from './registry-pubkey.generated.js';
import { fetchUrl } from './fetcher.js';

export const MAX_FRESH_MS = 24 * 60 * 60 * 1000;       // 24h
export const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
export const REGISTRY_MANIFEST_URL = 'https://registry.massu.ai/adapters/manifest.json';

/**
 * Wrapper format persisted to ~/.massu/adapter-manifest.json. The envelope
 * is the verified registry envelope (post-verifyManifest); fetched_at is the
 * client-side timestamp; bundled_pubkey_fingerprint records which @massu/core
 * pubkey signed this cache entry (rotation detection per gap-54).
 */
const CacheWrapperSchema = z.object({
  envelope: EnvelopeSchema,
  // CR-9 iter-6 audit LOW-NEW6-1 fix: fetched_at flows into the
  // 'fetched_at not parseable as Date' reason render at line 163 → wrapped
  // by getManifest into 'cache invalid: ...' → reaches stderr in
  // commands/adapters.ts. Same control-char log-injection vector iter-3
  // closed for InstallEntrySchema.ts AND iter-5 closed for
  // FingerprintSentinelSchema.ts. Third sibling closure; the new AST
  // drift-guard test (test_security_schemas_printable_ascii_drift.test.ts)
  // makes this class of bug structurally impossible to recur.
  fetched_at: PrintableAsciiStringSchema,
  bundled_pubkey_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type CacheWrapper = z.infer<typeof CacheWrapperSchema>;

export type CacheReadResult =
  | { kind: 'fresh'; envelope: Envelope; ageMs: number; warnings: string[] }
  | { kind: 'stale'; envelope: Envelope; ageMs: number; warnings: string[]; reason: string }
  | { kind: 'expired'; ageMs: number; reason: string }
  | { kind: 'rotation-detected'; reason: string }
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string };

export interface CachePaths {
  cachePath: string;
  lockPath: string;
}

/**
 * Compute the canonical cache + lock paths under the user's home directory.
 * Exported so tests can reuse the same logic with a sandboxed home.
 */
export function defaultCachePaths(): CachePaths {
  const dir = resolve(homedir(), '.massu');
  return {
    cachePath: resolve(dir, 'adapter-manifest.json'),
    lockPath: resolve(dir, '.adapter-manifest.lock'),
  };
}

/**
 * Read + validate the cached manifest. Returns a tagged result the caller
 * dispatches on:
 *   - 'fresh'             — cache is valid + signed + age < MAX_FRESH_MS
 *   - 'stale'             — cache is valid + signed + age < MAX_STALE_MS
 *                            (caller may use; should surface staleness in UX)
 *   - 'expired'           — age > MAX_STALE_MS; caller MUST refresh
 *   - 'rotation-detected' — bundled_pubkey_fingerprint mismatch; caller MUST
 *                            refresh under the new bundled pubkey
 *   - 'absent'            — no cache file
 *   - 'invalid'           — file exists but failed parse / signature verify;
 *                            treat as 'absent' but surface reason for logs
 */
export function loadCachedManifest(paths: CachePaths = defaultCachePaths()): CacheReadResult {
  if (!existsSync(paths.cachePath)) {
    return { kind: 'absent' };
  }

  let raw: unknown;
  try {
    const content = readFileSync(paths.cachePath, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    return {
      kind: 'invalid',
      reason: `cache JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const wrapperParsed = CacheWrapperSchema.safeParse(raw);
  if (!wrapperParsed.success) {
    const issues = wrapperParsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { kind: 'invalid', reason: `cache wrapper shape invalid: ${issues}` };
  }
  const wrapper = wrapperParsed.data;

  // Rotation detection (gap-54): if the cache's recorded bundled-pubkey
  // fingerprint does NOT match the currently-running @massu/core's pubkey,
  // the cache was signed under a different key and we can't verify it
  // with our current bundle. Caller MUST refresh.
  if (wrapper.bundled_pubkey_fingerprint !== REGISTRY_PUBKEY_FINGERPRINT_HEX) {
    return {
      kind: 'rotation-detected',
      reason:
        `cache was written under @massu/core bundled pubkey ` +
        `${wrapper.bundled_pubkey_fingerprint.slice(0, 16)}... but this @massu/core ` +
        `bundles ${REGISTRY_PUBKEY_FINGERPRINT_HEX.slice(0, 16)}.... Cache must be ` +
        `refreshed under the current bundled pubkey.`,
    };
  }

  // Verify the envelope via the canonical 9-step verifier. Pure, no I/O.
  const verifyResult: VerifyManifestResult = verifyManifest({
    envelope: wrapper.envelope,
    publicKey: REGISTRY_PUBKEY_ED25519,
  });
  if (!verifyResult.ok) {
    return { kind: 'invalid', reason: `cached envelope failed verify: ${verifyResult.reason}` };
  }

  const fetchedAtMs = Date.parse(wrapper.fetched_at);
  if (!Number.isFinite(fetchedAtMs)) {
    return { kind: 'invalid', reason: `fetched_at not parseable as Date: ${wrapper.fetched_at}` };
  }
  const ageMs = Date.now() - fetchedAtMs;
  if (ageMs < MAX_FRESH_MS) {
    return { kind: 'fresh', envelope: verifyResult.envelope, ageMs, warnings: verifyResult.warnings };
  }
  if (ageMs < MAX_STALE_MS) {
    return {
      kind: 'stale',
      envelope: verifyResult.envelope,
      ageMs,
      warnings: verifyResult.warnings,
      reason: `cache is ${Math.floor(ageMs / 3600_000)}h old; consider refreshing`,
    };
  }
  return {
    kind: 'expired',
    ageMs,
    reason: `cache is ${Math.floor(ageMs / 86400_000)}d old (> 7d); refusing to use`,
  };
}

/**
 * Atomic write of a verified envelope to the cache file under the writer
 * lock. Returns void on success; throws if (a) the lock cannot be acquired
 * within the configured block, or (b) the atomicWrite fails.
 *
 * Caller is responsible for ensuring the envelope is verified BEFORE
 * calling this function — cacheManifest does NOT re-verify (the verify
 * already happens inside refreshManifest before writing).
 */
export function cacheManifest(envelope: Envelope, paths: CachePaths = defaultCachePaths()): void {
  const wrapper: CacheWrapper = {
    envelope,
    fetched_at: new Date().toISOString(),
    bundled_pubkey_fingerprint: REGISTRY_PUBKEY_FINGERPRINT_HEX,
  };
  withFileLockSync(paths.lockPath, () => {
    const result = atomicWrite(paths.cachePath, JSON.stringify(wrapper, null, 2), {
      mode: 0o600,
      ensureParentDirMode: 0o700,
    });
    if (!result.written) {
      throw new Error(`cacheManifest: atomicWrite failed: ${result.error}`);
    }
  });
}

export type RefreshResult =
  | { kind: 'refreshed'; envelope: Envelope; warnings: string[] }
  | { kind: 'fetch-failed'; reason: string }
  | { kind: 'verify-failed'; reason: string };

/**
 * Fetch + verify the live registry manifest, write to cache. Returns a
 * tagged result. The caller decides whether to surface refresh failures
 * as fatal (stale-cache > 7d) or non-fatal (cache fresh but stale-by-age).
 */
export async function refreshManifest(
  paths: CachePaths = defaultCachePaths(),
  fetchFn: typeof fetchUrl = fetchUrl,
): Promise<RefreshResult> {
  let body: string;
  try {
    const response = await fetchFn(REGISTRY_MANIFEST_URL);
    if (response.status !== 200) {
      return { kind: 'fetch-failed', reason: `registry returned HTTP ${response.status}` };
    }
    body = response.body;
  } catch (err) {
    return {
      kind: 'fetch-failed',
      reason: `fetch ${REGISTRY_MANIFEST_URL} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      kind: 'fetch-failed',
      reason: `registry response not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const verified = verifyManifest({ envelope: parsed, publicKey: REGISTRY_PUBKEY_ED25519 });
  if (!verified.ok) {
    return { kind: 'verify-failed', reason: verified.reason };
  }

  cacheManifest(verified.envelope, paths);
  return { kind: 'refreshed', envelope: verified.envelope, warnings: verified.warnings };
}

/**
 * High-level getter: try cache → if fresh, return. Else refresh + return new
 * envelope. If `force=true`, skip cache entirely. If refresh fails AND a
 * stale cache is available (< 7d), return it with a `staleAcceptedReason`.
 * If everything fails, returns null + error reasons in the result object.
 */
export interface GetManifestOpts {
  paths?: CachePaths;
  force?: boolean;
  fetchFn?: typeof fetchUrl;
}

export type GetManifestResult =
  | { kind: 'ok'; envelope: Envelope; source: 'cache-fresh' | 'cache-stale' | 'refreshed'; warnings: string[]; staleReason?: string }
  | { kind: 'fail'; reasons: string[] };

export async function getManifest(opts: GetManifestOpts = {}): Promise<GetManifestResult> {
  const paths = opts.paths ?? defaultCachePaths();
  const fetchFn = opts.fetchFn ?? fetchUrl;
  const reasons: string[] = [];

  if (!opts.force) {
    const cacheRead = loadCachedManifest(paths);
    if (cacheRead.kind === 'fresh') {
      return { kind: 'ok', envelope: cacheRead.envelope, source: 'cache-fresh', warnings: cacheRead.warnings };
    }
    if (cacheRead.kind === 'stale') {
      // Try refresh first; fall back to stale cache if refresh fails.
      const refreshed = await refreshManifest(paths, fetchFn);
      if (refreshed.kind === 'refreshed') {
        return { kind: 'ok', envelope: refreshed.envelope, source: 'refreshed', warnings: refreshed.warnings };
      }
      reasons.push(`refresh failed: ${refreshed.kind === 'fetch-failed' ? refreshed.reason : refreshed.reason}`);
      return {
        kind: 'ok',
        envelope: cacheRead.envelope,
        source: 'cache-stale',
        warnings: cacheRead.warnings,
        staleReason: cacheRead.reason,
      };
    }
    if (cacheRead.kind === 'invalid') {
      reasons.push(`cache invalid: ${cacheRead.reason}`);
    } else if (cacheRead.kind === 'rotation-detected') {
      reasons.push(`rotation: ${cacheRead.reason}`);
    } else if (cacheRead.kind === 'expired') {
      reasons.push(`expired: ${cacheRead.reason}`);
    }
  }

  // Fall through to refresh (force=true OR cache absent/invalid/rotation/expired).
  const refreshed = await refreshManifest(paths, fetchFn);
  if (refreshed.kind === 'refreshed') {
    return { kind: 'ok', envelope: refreshed.envelope, source: 'refreshed', warnings: refreshed.warnings };
  }
  reasons.push(`refresh failed: ${refreshed.kind === 'fetch-failed' ? refreshed.reason : refreshed.reason}`);
  return { kind: 'fail', reasons };
}

/**
 * Helper for tests + telemetry observability: returns the on-disk file
 * mode of the cache file (or null if absent). Used to assert gap-37
 * file-mode discipline post-write.
 */
export function getCacheFileMode(paths: CachePaths = defaultCachePaths()): number | null {
  if (!existsSync(paths.cachePath)) return null;
  return statSync(paths.cachePath).mode & 0o777;
}
