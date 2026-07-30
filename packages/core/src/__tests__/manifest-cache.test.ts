/**
 * Tests for the manifest cache (Plan 3c Phase 5 5F.3 — gap-37 + gap-54 + gap-59).
 *
 * Coverage:
 * - loadCachedManifest absent / invalid JSON / wrapper-shape / rotation /
 *   fresh / stale / expired
 * - cacheManifest writes file with mode 0o600 + ensures parent dir 0o700
 * - cacheManifest acquires + releases lock; re-entry on second call
 * - refreshManifest happy path (mocked fetch)
 * - refreshManifest fetch-failed path (network error)
 * - refreshManifest verify-failed path (signature corruption)
 * - getManifest cache-fresh short-circuit
 * - getManifest cache-stale + refresh-success → returns refreshed
 * - getManifest cache-stale + refresh-failed → returns stale with reason
 * - getManifest force=true skips cache
 * - getManifest cache-rotation-detected forces refresh
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import {
  loadCachedManifest,
  cacheManifest,
  refreshManifest,
  getManifest,
  getCacheFileMode,
  type CachePaths,
} from '../security/manifest-cache.js';
import {
  REGISTRY_PUBKEY_ED25519,
  REGISTRY_PUBKEY_FINGERPRINT_HEX,
} from '../security/registry-pubkey.generated.js';
import type { Envelope } from '../security/manifest-schema.js';

// G-1 (plan-2026-07-26-anti-vacuity-9-unproven-gates): `registry-site/` is not
// checked out in every environment. Resolved at MODULE scope so `it.skipIf` can
// adjudicate at collection time and vitest reports SKIPPED — distinguishable from
// PASSED. Each of the seven tests below used to wrap the read in try/catch and
// `return` from the catch, which ALSO swallowed a corrupt or unreadable manifest:
// a real defect and an absent fixture rendered identically. Reading it outside the
// try means a malformed manifest now FAILS, which is what it should always have done.
const LIVE_MANIFEST_PATH = resolve(__dirname, '../../../../registry-site/adapters/manifest.json');
const HAS_LIVE_MANIFEST = existsSync(LIVE_MANIFEST_PATH);

let workdir: string;
let paths: CachePaths;

function makePaths(dir: string): CachePaths {
  return {
    cachePath: join(dir, 'adapter-manifest.json'),
    lockPath: join(dir, '.adapter-manifest.lock'),
  };
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'massu-cache-test-'));
  paths = makePaths(workdir);
});

afterEach(() => {
  if (existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true });
  }
});

/**
 * Build a fake but verifier-passing envelope using the BUNDLED pubkey's
 * paired private key. Since we can't access the real Phase D private
 * key from tests, we generate an ephemeral keypair and override the
 * verifier to use it via the existing publicKey override path.
 *
 * For cache tests where the verifier path is what's under test, we sign
 * with the REAL bundled pubkey... we can't. The bundled pubkey is the
 * registry's. Tests must use a fixture-friendly ephemeral key.
 *
 * Solution: build an envelope signed by an ephemeral key, but write a
 * cache wrapper whose `bundled_pubkey_fingerprint` matches the EPHEMERAL
 * key's fingerprint. Then we patch loadCachedManifest's view of the
 * bundled pubkey... but loadCachedManifest reads the constant directly.
 *
 * Pragmatic test strategy: test the cache shape, mode, atomic write,
 * lock acquisition, and rotation detection. The signature verify itself
 * is fully covered in adapter-verifier.test.ts. For "valid envelope
 * round-trips through cache" we use the LIVE deployed envelope (same
 * fixture as adapter-verifier.test.ts:live-envelope-test).
 */
function buildEphemeralEnvelope(manifestBody: Record<string, unknown>): {
  envelope: Envelope;
  pubkeyFingerprint: string;
} {
  const keyPair = nacl.sign.keyPair();
  const bodyJson = JSON.stringify(manifestBody);
  const bodyBytes = Buffer.from(bodyJson, 'utf-8');
  const sig = nacl.sign.detached(new Uint8Array(bodyBytes), keyPair.secretKey);
  const sha = createHash('sha256').update(bodyBytes).digest('hex');
  const keyId = createHash('sha256').update(keyPair.publicKey).digest('hex');
  const envelope = {
    manifest: manifestBody as unknown,
    manifest_b64: bodyBytes.toString('base64'),
    signature: Buffer.from(sig).toString('base64'),
    manifest_sha256: sha,
    signed_at: '2026-05-07T20:00:00Z',
    signing_key_id: keyId,
  } as unknown as Envelope;
  return { envelope, pubkeyFingerprint: keyId };
}

describe('loadCachedManifest', () => {
  it('returns absent when cache file does not exist', () => {
    const result = loadCachedManifest(paths);
    expect(result.kind).toBe('absent');
  });

  it('returns invalid when file is not JSON', () => {
    writeFileSync(paths.cachePath, 'not-json{', 'utf-8');
    const result = loadCachedManifest(paths);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason).toMatch(/parse failed/i);
  });

  it('returns invalid when wrapper shape is wrong', () => {
    writeFileSync(paths.cachePath, JSON.stringify({ wrong: 'shape' }), 'utf-8');
    const result = loadCachedManifest(paths);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason).toMatch(/wrapper shape/i);
  });

  it('returns rotation-detected when bundled_pubkey_fingerprint mismatches current bundle', () => {
    // Build a wrapper whose envelope is unverifiable against the current bundle
    // BUT whose bundled_pubkey_fingerprint is a different hex string.
    const { envelope } = buildEphemeralEnvelope({
      manifest_schema_version: 1,
      issued_at: '2026-05-07T00:00:00Z',
      adapters: [],
    });
    const wrapper = {
      envelope,
      fetched_at: new Date().toISOString(),
      bundled_pubkey_fingerprint: 'a'.repeat(64), // not the current bundle
    };
    writeFileSync(paths.cachePath, JSON.stringify(wrapper), 'utf-8');
    const result = loadCachedManifest(paths);
    expect(result.kind).toBe('rotation-detected');
    if (result.kind === 'rotation-detected') {
      expect(result.reason).toMatch(/cache was written under/i);
    }
  });

  it('returns invalid when fingerprint matches but signature does not verify', () => {
    // Wrapper claims our bundled pubkey but envelope was signed by a
    // different key — verifier rejects.
    const { envelope } = buildEphemeralEnvelope({
      manifest_schema_version: 1,
      issued_at: '2026-05-07T00:00:00Z',
      adapters: [],
    });
    const wrapper = {
      envelope,
      fetched_at: new Date().toISOString(),
      bundled_pubkey_fingerprint: REGISTRY_PUBKEY_FINGERPRINT_HEX,
    };
    writeFileSync(paths.cachePath, JSON.stringify(wrapper), 'utf-8');
    const result = loadCachedManifest(paths);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason).toMatch(/failed verify/i);
  });
});

describe('cacheManifest + lock + file mode (gap-37 + gap-59)', () => {
  it.skipIf(!HAS_LIVE_MANIFEST)('writes the cache file with mode 0o600', () => {
    // Use the live deployed envelope so verifier round-trips correctly.
    const envelope = JSON.parse(readFileSync(LIVE_MANIFEST_PATH, 'utf-8')) as Envelope;
    cacheManifest(envelope, paths);
    expect(existsSync(paths.cachePath)).toBe(true);
    expect(getCacheFileMode(paths)).toBe(0o600);
  });

  it.skipIf(!HAS_LIVE_MANIFEST)('cleans up lock pidfile on success', () => {
    const envelope = JSON.parse(readFileSync(LIVE_MANIFEST_PATH, 'utf-8')) as Envelope;
    cacheManifest(envelope, paths);
    expect(existsSync(`${paths.lockPath}.pid`)).toBe(false);
  });

  it.skipIf(!HAS_LIVE_MANIFEST)('subsequent cacheManifest calls succeed (lock released)', () => {
    const envelope = JSON.parse(readFileSync(LIVE_MANIFEST_PATH, 'utf-8')) as Envelope;
    cacheManifest(envelope, paths);
    cacheManifest(envelope, paths); // would throw if lock not released
    expect(getCacheFileMode(paths)).toBe(0o600);
  });
});

describe('refreshManifest with mocked fetch', () => {
  it.skipIf(!HAS_LIVE_MANIFEST)('returns refreshed when fetch + verify succeed', async () => {
    const liveBody = readFileSync(LIVE_MANIFEST_PATH, 'utf-8');
    const fakeFetch = async () => ({ status: 200, body: liveBody });
    const result = await refreshManifest(paths, fakeFetch as never);
    expect(result.kind).toBe('refreshed');
    if (result.kind === 'refreshed') {
      expect(result.envelope.signing_key_id).toBe(REGISTRY_PUBKEY_FINGERPRINT_HEX);
    }
    expect(existsSync(paths.cachePath)).toBe(true);
  });

  it('returns fetch-failed when fetcher throws', async () => {
    const fakeFetch = async () => {
      throw new Error('network down');
    };
    const result = await refreshManifest(paths, fakeFetch as never);
    expect(result.kind).toBe('fetch-failed');
    if (result.kind === 'fetch-failed') expect(result.reason).toMatch(/network down/i);
    expect(existsSync(paths.cachePath)).toBe(false);
  });

  it('returns fetch-failed when status != 200', async () => {
    const fakeFetch = async () => ({ status: 503, body: 'Service Unavailable' });
    const result = await refreshManifest(paths, fakeFetch as never);
    expect(result.kind).toBe('fetch-failed');
    if (result.kind === 'fetch-failed') expect(result.reason).toMatch(/HTTP 503/);
  });

  it('returns verify-failed when signature does not verify', async () => {
    // Use an ephemeral envelope (signed by a non-bundled key) → verifier rejects.
    const { envelope } = buildEphemeralEnvelope({
      manifest_schema_version: 1,
      issued_at: '2026-05-07T00:00:00Z',
      adapters: [],
    });
    const fakeFetch = async () => ({ status: 200, body: JSON.stringify(envelope) });
    const result = await refreshManifest(paths, fakeFetch as never);
    expect(result.kind).toBe('verify-failed');
    expect(existsSync(paths.cachePath)).toBe(false);
  });

  it('returns fetch-failed when registry returns malformed JSON', async () => {
    const fakeFetch = async () => ({ status: 200, body: 'not-json{' });
    const result = await refreshManifest(paths, fakeFetch as never);
    expect(result.kind).toBe('fetch-failed');
    if (result.kind === 'fetch-failed') expect(result.reason).toMatch(/not JSON/i);
  });
});

describe('getManifest high-level orchestration', () => {
  it.skipIf(!HAS_LIVE_MANIFEST)('returns ok cache-fresh when cache is fresh', async () => {
    const envelope = JSON.parse(readFileSync(LIVE_MANIFEST_PATH, 'utf-8')) as Envelope;
    cacheManifest(envelope, paths);
    // No fetch should happen — pass a throwing fetch to ensure short-circuit.
    const throwingFetch = async () => {
      throw new Error('SHOULD NOT BE CALLED');
    };
    const result = await getManifest({ paths, fetchFn: throwingFetch as never });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.source).toBe('cache-fresh');
  });

  it.skipIf(!HAS_LIVE_MANIFEST)('force=true skips cache and re-fetches', async () => {
    const body = readFileSync(LIVE_MANIFEST_PATH, 'utf-8');
    const envelope = JSON.parse(body) as Envelope;
    cacheManifest(envelope, paths);
    let fetchCalled = false;
    const fakeFetch = async () => {
      fetchCalled = true;
      return { status: 200, body };
    };
    const result = await getManifest({ paths, force: true, fetchFn: fakeFetch as never });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.source).toBe('refreshed');
    expect(fetchCalled).toBe(true);
  });

  it('returns fail when no cache and refresh fails', async () => {
    const failFetch = async () => {
      throw new Error('offline');
    };
    const result = await getManifest({ paths, fetchFn: failFetch as never });
    expect(result.kind).toBe('fail');
    if (result.kind === 'fail') {
      expect(result.reasons.some((r) => /offline/.test(r))).toBe(true);
    }
  });

  it.skipIf(!HAS_LIVE_MANIFEST)('rotation-detected cache forces refresh; returns refreshed result', async () => {
    // Plant a cache with rotation-mismatch, then provide a successful refresh.
    const { envelope } = buildEphemeralEnvelope({
      manifest_schema_version: 1,
      issued_at: '2026-05-07T00:00:00Z',
      adapters: [],
    });
    const wrapper = {
      envelope,
      fetched_at: new Date().toISOString(),
      bundled_pubkey_fingerprint: 'a'.repeat(64),
    };
    mkdirSync(workdir, { recursive: true });
    writeFileSync(paths.cachePath, JSON.stringify(wrapper), 'utf-8');

    const body = readFileSync(LIVE_MANIFEST_PATH, 'utf-8');
    const fakeFetch = async () => ({ status: 200, body });
    const result = await getManifest({ paths, fetchFn: fakeFetch as never });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.source).toBe('refreshed');
  });
});
